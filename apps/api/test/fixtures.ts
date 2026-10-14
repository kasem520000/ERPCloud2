import { permissionRegistry } from '@erp/contracts';
import {
  assignRoleFixture,
  createMembershipFixture,
  createRoleFixture,
  createTenantFixture,
  createUserFixture,
  grantPlatformRoleFixture,
  setMembershipStatusFixture,
  setTenantStatusFixture,
  setTenantSettingFixture,
  setUserStatusFixture,
} from '@erp/testing';

import { PasswordService, TokenService } from '../src/modules/platform/index.js';

import type { TestApp } from './test-app.js';

/**
 * @deprecated Use `ALL_TENANT_PERMISSIONS`. The `platform.*` codes are the legacy
 * spelling of tenant self-administration; they stay seeded and stay honoured through
 * the alias map, so suites that grant them keep passing unchanged.
 */
export const ALL_PLATFORM_PERMISSIONS = permissionRegistry
  .filter((entry) => entry.module === 'platform')
  .map((entry) => entry.code);

/** Canonical tenant self-administration codes (`tenant.*`, non-deprecated). */
export const ALL_TENANT_PERMISSIONS = permissionRegistry
  .filter((entry) => entry.module === 'tenant' && !entry.deprecated)
  .map((entry) => entry.code);

/** Every PHASE_05 permission — the organization suites need all of them (PHASE_05 §7). */
export const ALL_ORGANIZATION_PERMISSIONS = permissionRegistry
  .filter((entry) => entry.module === 'organization')
  .map((entry) => entry.code);

export type ActorOptions = {
  tenantCode: string;
  /**
   * Reuses an existing tenant instead of creating one. This is what lets a suite put two
   * memberships — e.g. an unrestricted admin and a branch-scoped user — inside the same
   * tenant, which is the only way to test `branch_scope` filtering.
   */
  tenantId?: string;
  tenantName?: string;
  email: string;
  fullName?: string;
  password?: string;
  permissions?: readonly string[];
  roleNames?: readonly string[];
  /**
   * أدوار المنصّة (`platform_owner` · `platform_support` · …) — تُمنح في `platform_memberships`
   * وحدها فيصير للفاعل `pam` ورموز `console.*`. وكانت تُستعمل في أجنحة اللوحة بلا تعريفٍ في
   * هذا النوع ⇒ `tsc` يشتكي من كل نداءٍ يمرّرها (P-M6).
   */
  platformRoles?: readonly string[];
  /**
   * نوع العضويّة (`memberships.kind`، افتراضه `staff`) — يُستعمل في `createActor` منذ
   * RBAC-REORG لتوليد عضويّات البوابة (بوّابة العميل تصل بـ`portal`)، ولم يكن معلناً في هذا
   * النوع. يُعلَن هنا فيسكت `tsc` عن استعمالٍ مشروع.
   */
  kind?: 'staff' | 'portal';
  tenantStatus?: 'active' | 'suspended' | 'archived';
  membershipStatus?: 'active' | 'invited' | 'suspended';
  userStatus?: 'active' | 'invited' | 'suspended';
  branchScope?: string[] | null;
  /**
   * AUD-03 — when `true`, skips seeding `TENANT_WIDE_SCOPE_ID` on the actor's role grants
   * so tests can verify that a newly created/assigned role with no `membership_role_scopes`
   * rows does NOT receive implicit tenant-wide access.
   */
  unconfiguredScopes?: boolean;
  /** R1 — حدّ الخصم على العضوية (`null`/غائب = بلا حدّ). */
  maxDiscountPct?: string | null;
  maxDiscountAmount?: string | null;
  isOwner?: boolean;
  isPlatformAdmin?: boolean;
};

export type Actor = {
  label: string;
  tenantId: string;
  tenantCode: string;
  userId: string;
  email: string;
  password?: string;
  membershipId: string;
  roleIds: string[];
  token: string;
  branchScope: string[] | null;
};

/** Hashes with the frozen Argon2id parameters (PROJECT_CONTRACT §9). */
export function hashPassword(password: string): Promise<string> {
  // A standalone instance: fixtures run outside the DI container.
  return new PasswordService().hash(password);
}

/**
 * Creates a tenant + user + membership + role and returns an actor with a valid access
 * token signed by the application's own TokenService.
 */
export async function createActor(ctx: TestApp, options: ActorOptions): Promise<Actor> {
  const tenant = options.tenantId
    ? { id: options.tenantId, code: options.tenantCode }
    : await createTenantFixture(ctx.db.ownerUrl, {
        code: options.tenantCode,
        name: options.tenantName,
        status: options.tenantStatus ?? 'active',
      });

  const permissionCodes = options.permissions ?? ALL_PLATFORM_PERMISSIONS;
  const roleIds: string[] = [];
  for (const [index, roleName] of (options.roleNames ?? ['Admin']).entries()) {
    const role = await createRoleFixture(ctx.db.ownerUrl, {
      tenantId: tenant.id,
      name: roleName,
      permissionCodes: index === 0 ? permissionCodes : [],
    });
    roleIds.push(role.id);
  }

  const passwordHash = options.password ? await new PasswordService().hash(options.password) : null;
  const user = await createUserFixture(ctx.db.ownerUrl, {
    email: options.email,
    fullName: options.fullName ?? options.email.split('@')[0],
    passwordHash,
    status: options.userStatus ?? 'active',
    isPlatformAdmin: options.isPlatformAdmin,
  });

  const membership = await createMembershipFixture(ctx.db.ownerUrl, {
    tenantId: tenant.id,
    userId: user.id,
    displayName: options.fullName ?? options.email.split('@')[0] ?? 'Actor',
    status: options.membershipStatus ?? 'active',
    isOwner: options.isOwner ?? true,
    branchScope: options.branchScope === undefined ? null : options.branchScope,
    kind: options.kind,
    maxDiscountPct: options.maxDiscountPct ?? null,
    maxDiscountAmount: options.maxDiscountAmount ?? null,
  });

  for (const roleId of roleIds) {
    await assignRoleFixture(ctx.db.ownerUrl, membership.id, roleId, {
      tenantWideScopes: !options.unconfiguredScopes,
    });
  }

  // Mirrors login semantics: explicit platform roles are granted, and a legacy-flag
  // administrator without explicit roles is treated as `platform_owner` (the same
  // equivalence `resolvePlatformAccess` and migration 0032 apply).
  const platformRoles =
    options.platformRoles ?? (options.isPlatformAdmin ? ['platform_owner'] : []);
  for (const roleCode of platformRoles) {
    await grantPlatformRoleFixture(ctx.db.ownerUrl, { userId: user.id, roleCode });
  }

  const tokens = ctx.app.get(TokenService);
  const { token } = await tokens.signAccessToken({
    sub: user.id,
    tid: tenant.id,
    mid: membership.id,
    scope: ['erp'],
    pam: (options.isPlatformAdmin ?? false) || platformRoles.length > 0,
    proles: [...platformRoles],
  });

  return {
    label: options.tenantCode,
    tenantId: tenant.id,
    tenantCode: tenant.code,
    userId: user.id,
    email: user.email,
    password: options.password,
    membershipId: membership.id,
    roleIds,
    token,
    branchScope: options.branchScope === undefined ? null : options.branchScope,
  };
}

export {
  assignRoleFixture,
  createMembershipFixture,
  createRoleFixture,
  createTenantFixture,
  createUserFixture,
  grantPlatformRoleFixture,
  setMembershipStatusFixture,
  setTenantSettingFixture,
  setTenantStatusFixture,
  setUserStatusFixture,
};
