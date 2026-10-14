import { DomainError, TENANT_WIDE_SCOPE_ID, errorCodes } from '@erp/contracts';

import type { RoleScopeValue } from '../../../request-context/request-context.js';

/**
 * Per-role scope enforcement (2026-09 RBAC reorganisation + AUD-03).
 *
 * Semantics:
 * - Tenant-wide access for a `scopeType` (`branch` | `warehouse` | `cash_location` | `pos_terminal`)
 *   is granted **ONLY** when at least one held role is explicitly configured with
 *   `scopeId === TENANT_WIDE_SCOPE_ID` (`00000000-0000-0000-0000-000000000000`).
 * - A `(membership, role)` grant with NO rows for `scopeType` is **unconfigured** for that
 *   scope dimension: it grants zero scopes (`[]`) and never implies tenant-wide access or
 *   widens restrictions on another held role.
 * - Across multiple held roles, explicit `scopeId` grants combine via **UNION** (`W1 ∪ W2`).
 * - Legacy/existing baseline role grants are migrated via `0117_explicit_tenant_wide_role_scopes.sql`
 *   to carry explicit `TENANT_WIDE_SCOPE_ID` rows, while newly created/assigned roles remain
 *   unconfigured until explicitly granted specific scopes or `TENANT_WIDE_SCOPE_ID`.
 */
export type ScopeType = RoleScopeValue['scopeType'];

export { TENANT_WIDE_SCOPE_ID };

export function scopeAuthorises(
  scopes: readonly RoleScopeValue[],
  roleIds: readonly string[],
  scopeType: ScopeType,
  scopeId: string,
): boolean {
  const allowed = allowedScopeIds(scopes, roleIds, scopeType);
  return allowed === undefined || allowed.includes(scopeId);
}

/** Throws `FORBIDDEN` when none of the caller's grants covers the scope. */
export function assertScope(
  scopes: readonly RoleScopeValue[],
  roleIds: readonly string[],
  scopeType: ScopeType,
  scopeId: string,
): void {
  if (!scopeAuthorises(scopes, roleIds, scopeType, scopeId)) {
    throw new DomainError(
      errorCodes.FORBIDDEN,
      `role grant does not cover ${scopeType} ${scopeId}`,
      403,
      { field: 'scope', message: `${scopeType}:${scopeId}` },
    );
  }
}

/**
 * AUD-03 — Allowed resource IDs for `scopeType` across the caller's held roles.
 *
 * - Returns `undefined` (tenant-wide access) **ONLY** when at least one held role is
 *   explicitly configured with `scopeId === TENANT_WIDE_SCOPE_ID`.
 * - Otherwise returns the deduplicated **UNION** of explicit `scopeId`s configured on the
 *   held roles. When no held role has any `scopeType` rows, returns `[]` (no access —
 *   missing scope settings never grant implicit tenant-wide access).
 */
export function allowedScopeIds(
  scopes: readonly RoleScopeValue[],
  roleIds: readonly string[],
  scopeType: ScopeType,
): string[] | undefined {
  const held = Array.from(new Set(roleIds));
  if (held.length === 0) return [];

  const union = new Set<string>();

  for (const roleId of held) {
    const restrictions = scopes.filter(
      (scope) => scope.roleId === roleId && scope.scopeType === scopeType,
    );
    for (const row of restrictions) {
      if (row.scopeId === TENANT_WIDE_SCOPE_ID) {
        return undefined;
      }
      union.add(row.scopeId);
    }
  }

  return Array.from(union);
}
