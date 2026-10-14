import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, bytea, citext, inet } from '../columns.js';

/**
 * Platform tables — DATABASE_DESIGN §1. These carry **no** `tenant_id`
 * (PROJECT_CONTRACT §6: "Platform tables without tenant_id: tenants, users,
 * permissions, migrations_log") and therefore no RLS policy.
 *
 * `refresh_tokens` also lives in §1. It keeps a nullable `tenant_id` for auditing, but
 * isolation is capability-based (an unguessable 256-bit token, SHA-256 hashed at rest):
 * the login and refresh flows must resolve a token *before* a tenant context exists,
 * so an RLS policy on this table would be both unusable and unnecessary. Recorded in
 * docs/STATUS.md (Phase 03 notes).
 */

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** CHECK(active,suspended,archived) — MULTI_TENANCY §2. */
    status: text('status').notNull().default('active'),
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('SAR'),
    timezone: text('timezone').notNull().default('Asia/Riyadh'),
    locale: text('locale').notNull().default('ar'),
    countryCode: char('country_code', { length: 2 }).notNull().default('SA'),
    meta: jsonb('meta').notNull().default({}),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    tenantsCodeUnique: uniqueIndex('tenants_code_key').on(table.code),
  }),
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull(),
    phone: text('phone'),
    /** Argon2id PHC string. NULL for invited users that have not set a password yet. */
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    /** CHECK(active,invited,suspended) */
    status: text('status').notNull().default('invited'),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    /** AES-256-GCM ciphertext of the TOTP secret (SECURITY_ARCHITECTURE §2). */
    mfaSecretEnc: bytea('mfa_secret_enc'),
    /** True once the user confirmed the secret with a valid code — login now demands TOTP. */
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** SECURITY_ARCHITECTURE §2 — exponential lockout on repeated failures. */
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** PROJECT_CONTRACT §9 — imported legacy users must reset before first use. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (table) => ({
    usersEmailUnique: uniqueIndex('users_email_key').on(table.email),
  }),
);

export const permissions = pgTable('permissions', {
  /** `module.entity.action` — PROJECT_CONTRACT §1. */
  code: text('code').primaryKey(),
  module: text('module').notNull(),
  description: text('description').notNull().default(''),
});

/**
 * AUD-08 — رمز تسليم جلسة لمرة واحدة بين واجهات المنصة.
 *
 * بديل تمرير `access`/`refresh` في query string: الواجهة المصدر تُصدر الرمز، والواجهة
 * الهدف تستبدله بجلسةٍ جديدة عبر `POST /auth/handoff/redeem`. يُخزَّن **الهاش** فقط،
 * ويُستهلك ذرّياً (`redeemed_at IS NULL`) فلا يصلح استبدالان متزامنان لرمزٍ واحد.
 */
export const sessionHandoffCodes = pgTable(
  'session_handoff_codes',
  {
    id: uuid('id').primaryKey(),
    codeHash: text('code_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** العضوية التي ستُبنى لها الجلسة الجديدة — تُختار وقت الإصدار لا وقت الاستبدال. */
    membershipId: uuid('membership_id').notNull(),
    /** كود المنشأة، ليحفظه العميل مع الجلسة كما يفعل عند الدخول العادي. */
    tenantCode: text('tenant_code').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionHandoffCodesCodeKey: uniqueIndex('session_handoff_codes_code_key').on(table.codeHash),
    sessionHandoffCodesExpiryIdx: index('session_handoff_codes_expiry_idx').on(table.expiresAt),
  }),
);

export type SessionHandoffCode = typeof sessionHandoffCodes.$inferSelect;

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the opaque token. The plaintext is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Rotation family — reuse detection revokes the whole family. */
    family: uuid('family').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    /** Tenant the token was issued for (audit only; see the note at the top). */
    tenantId: uuid('tenant_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    refreshTokensHashUnique: uniqueIndex('refresh_tokens_token_hash_key').on(table.tokenHash),
    refreshTokensUserIdx: index('refresh_tokens_user_id_family_idx').on(table.userId, table.family),
  }),
);

/**
 * One-time 2FA recovery codes — migration 0031. Platform table (no `tenant_id`) for the
 * same reason `users` is one: they belong to the person and must be verifiable before any
 * tenant context exists. Only SHA-256 hashes are stored.
 */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mfaRecoveryCodesUserIdx: index('mfa_recovery_codes_user_idx').on(table.userId),
  }),
);

export type MfaRecoveryCode = typeof mfaRecoveryCodes.$inferSelect;
export type NewMfaRecoveryCode = typeof mfaRecoveryCodes.$inferInsert;

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantCode: text('tenant_code'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    passwordResetTokensHashKey: uniqueIndex('password_reset_tokens_token_hash_key').on(table.tokenHash),
    passwordResetTokensUserIdx: index('password_reset_tokens_user_idx').on(table.userId, table.createdAt),
    passwordResetTokensExpiryIdx: index('password_reset_tokens_expiry_idx').on(table.expiresAt),
  }),
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

/**
 * Platform roles — 2026-09 architecture/RBAC reorganisation (migration 0032).
 *
 * Family A of the role catalogue (`@erp/contracts` `platformRoleCatalog`).
 * Platform tables: no `tenant_id`, no RLS — a platform operator is a person, not a
 * membership, exactly like `users`. This replaces the `users.is_platform_admin`
 * boolean with a real role model; the flag stays as a deprecated equivalent of
 * `platform_owner` (see `AuthService.resolvePlatformRoles`) and migration 0032
 * backfills it into `platform_memberships`, so nothing is lost in either direction.
 */
export const platformRoles = pgTable('platform_roles', {
  /** `platform_owner`, `platform_operations`, … — see `platformRoleCatalog`. */
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ...baseAuditColumns(),
});

export const platformMemberships = pgTable(
  'platform_memberships',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleCode: text('role_code')
      .notNull()
      .references(() => platformRoles.code, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid('granted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    platformMembershipsUserRoleUnique: uniqueIndex('platform_memberships_user_role_key').on(
      table.userId,
      table.roleCode,
    ),
    platformMembershipsUserIdx: index('platform_memberships_user_idx').on(table.userId),
  }),
);

/**
 * `platform_settings` — P-C1 (migration 0066).
 *
 * The first platform table that carries a **nullable** `tenant_id`, and the reason is
 * deliberate: one row shape serves two scopes. `tenant_id IS NULL` is a platform-wide
 * setting (the eight rows the console's إعدادات المنصة screen writes); a non-null
 * `tenant_id` is a per-customer override of the same key, which P-C2 reads when it opens a
 * tenant card. Because the column exists, the table carries the canonical isolation policy
 * (`ENABLE` + `FORCE` + `tenant_id`) instead of being exempted from the rule.
 *
 * `value` stays `jsonb` so a setting's type is a property of its definition
 * (`platformSettingDefinitions` in `@erp/contracts`), not of the table.
 */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: uuid('id').primaryKey(),
    /** NULL = platform-wide · non-null = one customer's override of the same key. */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    ...baseAuditColumns(),
    // No `baseLegacyColumns()`: this table has no desktop provenance to carry — the
    // desktop had no platform to configure.
  },
  (table) => ({
    // The unique index itself is declared in the migration with `NULLS NOT DISTINCT`,
    // which Drizzle's builder cannot express yet (`platform_settings_scope_key`).
    platformSettingsTenantIdx: index('platform_settings_tenant_idx').on(table.tenantId, table.key),
  }),
);

/**
 * Platform operators' notes about one customer (migration 0067, P-C2).
 *
 * The console's «الملاحظات» tab is the only reader. It is deliberately *not* tenant data:
 * a note like "called about the unpaid invoice, asked for a 30-day extension" is written
 * by the platform about the customer, so the table carries a `tenant_id` (for the cascade
 * and for the isolation policy) but is visible only on the platform plane.
 */
export const tenantNotes = pgTable(
  'tenant_notes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    authorUserId: uuid('author_user_id'),
    /** The author's name as it must read in the console, even after the user is gone. */
    authorLabel: text('author_label').notNull().default(''),
    ...baseAuditColumns(),
  },
  (table) => ({
    tenantNotesTenantIdx: index('tenant_notes_tenant_idx').on(table.tenantId, table.createdAt),
  }),
);

export type TenantNote = typeof tenantNotes.$inferSelect;
export type NewTenantNote = typeof tenantNotes.$inferInsert;

export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
export type PlatformRole = typeof platformRoles.$inferSelect;
export type NewPlatformRole = typeof platformRoles.$inferInsert;
export type PlatformMembership = typeof platformMemberships.$inferSelect;
export type NewPlatformMembership = typeof platformMemberships.$inferInsert;
