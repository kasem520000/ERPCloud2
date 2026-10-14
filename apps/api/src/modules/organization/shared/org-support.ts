import { sql } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import type { DrizzleTx } from '@erp/database';

import { getRequestContext } from '../../../request-context/request-context.js';
import { getBranchScopeFilter } from '../../platform/context/tenant-context.js';
import { allowedScopeIds, type ScopeType } from '../../platform/scopes/scope-policy.js';

/**
 * Small helpers shared by every organization resource. They exist so the ten services
 * express the *same* rule the same way — optimistic concurrency, default-flag switching
 * and branch scoping are exactly the places where a per-resource variation becomes a
 * data-integrity bug.
 */

/** ISO-8601 or null, the shape every DTO field of this module uses. */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Optimistic concurrency (DATABASE_DESIGN §0 `version`, API_ARCHITECTURE §3).
 * The client may omit `version`; when it sends one it is a promise about the row it
 * read, and a stale promise is refused rather than silently overwritten.
 */
export function assertVersion(currentVersion: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== currentVersion) {
    throw new DomainError(
      errorCodes.VERSION_CONFLICT,
      `The record was modified by someone else (expected version ${expected}, current ${currentVersion})`,
      409,
      { field: 'version' },
    );
  }
}

/**
 * Serialises default-flag switching per (tenant, resource).
 *
 * The partial unique indexes (`… WHERE is_default AND deleted_at IS NULL`) make two
 * defaults *impossible*, but under READ COMMITTED two concurrent switchers would race:
 * each clears the default it can see and then sets its own, and the loser dies on a
 * unique violation. A transaction-scoped advisory lock turns that race into a queue, so
 * a burst of concurrent "make me the default" requests all succeed and exactly one
 * default survives (PHASE_05 §11).
 */
export async function lockDefaultSwitch(tx: DrizzleTx, tenantId: string, resource: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${resource}:default`}))`);
}

/**
 * PostgreSQL unique-violation. Every uniqueness rule in this module is also pre-checked
 * in SQL, but the index is the authority: under concurrency the pre-check can pass and
 * the insert still lose, and the caller deserves the same 422 either way.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return constraint === undefined || candidate.constraint === constraint;
    }
    current = candidate.cause;
  }

  return false;
}

export type ActorStamp = {
  actorUserId: string | null;
  now: Date;
};

export function actorStamp(): ActorStamp {
  return { actorUserId: getRequestContext().auth?.userId ?? null, now: new Date() };
}

/**
 * The branch ids this request may see: the membership's `branch_scope` narrowed by an
 * explicit `X-Branch-Id` (MULTI_TENANCY §2 — a branch is a scoping device, and the guard
 * has already rejected a header outside the membership scope).
 *
 * `undefined` means "no restriction".
 */
export function visibleBranchIds(): string[] | undefined {
  const tenant = getRequestContext().tenant;
  const scope = tenant?.branchScope;
  const header = getBranchScopeFilter();
  let scoped = Array.isArray(scope) ? scope : undefined;

  const roleBranchScope =
    tenant && !tenant.isOwner && Array.isArray(tenant.roleIds)
      ? allowedScopeIds(tenant.scopes, tenant.roleIds, 'branch')
      : undefined;

  if (roleBranchScope) {
    scoped = scoped ? scoped.filter((id) => roleBranchScope.includes(id)) : roleBranchScope;
  }

  if (header) return scoped ? scoped.filter((id) => id === header) : [header];
  return scoped;
}

/**
 * AUD-03 — Allowed resource IDs for a per-role scope (`warehouse` / `cash_location`).
 * Returns `undefined` when access is unrestricted across the tenant.
 */
export function visibleRoleScopeIds(scopeType: Exclude<ScopeType, 'branch'>): string[] | undefined {
  const tenant = getRequestContext().tenant;
  if (!tenant || tenant.isOwner || !Array.isArray(tenant.roleIds)) return undefined;
  return allowedScopeIds(tenant.scopes, tenant.roleIds, scopeType);
}

/**
 * True when the request may act on `branchId`. A branch outside the membership scope is
 * reported as *not found* rather than forbidden: the caller must not learn that a branch
 * it cannot see exists (MULTI_TENANCY §7.1).
 */
export function assertBranchVisible(branchId: string): void {
  const visible = visibleBranchIds();
  if (visible && !visible.includes(branchId)) {
    throw new DomainError(errorCodes.NOT_FOUND, 'Branch not found', 404);
  }
}

/** Uniform 404 for "absent, soft-deleted, or owned by another tenant". */
export function notFound(resource: string): DomainError {
  return new DomainError(errorCodes.NOT_FOUND, `${resource} not found`, 404);
}

export function validationFailed(detail: string, field: string, status = 422): DomainError {
  return new DomainError(errorCodes.VALIDATION_FAILED, detail, status, { field });
}
