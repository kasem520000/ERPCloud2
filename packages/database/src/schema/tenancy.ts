import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseSoftDeleteColumns } from '../columns.js';

import { permissions, tenants, users } from './platform.js';

/**
 * Tenancy & access tables — DATABASE_DESIGN §2 and §3.
 * Every table here is tenant-scoped and carries an RLS policy (MULTI_TENANCY §3.5).
 */

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** MULTI_TENANCY §2 — NULL means "all branches"; otherwise an array of branch ids. */
    branchScope: jsonb('branch_scope').$type<string[] | null>(),
    /** CHECK(active,invited,suspended) */
    status: text('status').notNull().default('invited'),
    isOwner: boolean('is_owner').notNull().default(false),
    /**
     * Audience of the membership (migration 0032) — CHECK(staff,portal).
     * `portal` memberships belong to external customers (see `portal_accounts`):
     * they resolve their party from the token and are denied on every
     * `@RequiresPermission` route even if a role were mis-granted. Defaults to
     * `staff`; migration 0032 backfills portal rows from `portal_accounts`.
     */
    kind: text('kind').notNull().default('staff'),
    /**
     * R1 — حدّ الخصم لكل عضوية (بديل `OperMaxDiscount` في الديسكتوب).
     * `null` = بلا حدّ · `0` = حدٌّ صريح يمنع أي خصم · `pct` نسبة من إجمالي الفاتورة،
     * و`amount` قيمةٌ مطلقة، وكلاهما يُفحص في `sales`/`pos` عند كتابة الخصم.
     */
    maxDiscountPct: numeric('max_discount_pct', { precision: 7, scale: 4 }),
    maxDiscountAmount: numeric('max_discount_amount', { precision: 20, scale: 4 }),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    membershipsTenantUserUnique: uniqueIndex('memberships_tenant_user_key')
      .on(table.tenantId, table.userId)
      .where(sql`deleted_at IS NULL`),
    membershipsTenantIdx: index('memberships_tenant_id_idx').on(table.tenantId),
    membershipsUserIdx: index('memberships_user_id_idx').on(table.userId),
  }),
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    description: text('description'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    rolesTenantNameUnique: uniqueIndex('roles_tenant_id_name_key')
      .on(table.tenantId, table.name)
      .where(sql`deleted_at IS NULL`),
    rolesTenantIdx: index('roles_tenant_id_idx').on(table.tenantId),
  }),
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (table) => ({
    rolePermissionsPk: primaryKey({ columns: [table.roleId, table.permissionCode] }),
  }),
);

export const membershipRoles = pgTable(
  'membership_roles',
  {
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    membershipRolesPk: primaryKey({ columns: [table.membershipId, table.roleId] }),
    membershipRolesRoleIdx: index('membership_roles_role_id_idx').on(table.roleId),
  }),
);

/**
 * Per-role scope restrictions (migration 0032).
 *
 * A membership may hold several roles (UNION semantics, DATABASE_DESIGN §2); each
 * `(membership, role)` grant can additionally be restricted to a scope: the whole
 * tenant (no row), one branch, one warehouse, one cash location or one POS
 * terminal. `TenantGuard` publishes the scopes on the request context; enforcement
 * is opt-in per endpoint through `ScopePolicy` (branch scope keeps its dedicated
 * `branch_scope` + `X-Branch-Id` mechanism unchanged).
 */
export const membershipRoleScopes = pgTable(
  'membership_role_scopes',
  {
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    /** CHECK(branch,warehouse,cash_location,pos_terminal) */
    scopeType: text('scope_type').notNull(),
    /** Id of the branch / warehouse / cash location / POS terminal. */
    scopeId: uuid('scope_id').notNull(),
    ...baseAuditColumns(),
  },
  (table) => ({
    membershipRoleScopesPk: primaryKey({
      columns: [table.membershipId, table.roleId, table.scopeType, table.scopeId],
    }),
    membershipRoleScopesRoleIdx: index('membership_role_scopes_role_idx').on(table.roleId),
    membershipRoleScopesScopeIdx: index('membership_role_scopes_scope_idx').on(
      table.scopeType,
      table.scopeId,
    ),
  }),
);

export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<string | boolean | number | null>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantSettingsPk: primaryKey({ columns: [table.tenantId, table.key] }),
  }),
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type MembershipRole = typeof membershipRoles.$inferSelect;
export type TenantSetting = typeof tenantSettings.$inferSelect;
