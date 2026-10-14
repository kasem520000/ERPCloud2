import { Pool, type PoolClient } from 'pg';
import { baselineRoles, env, tenantSettingsRegistry } from '@erp/config';
import {
  ALL_PERMISSIONS,
  canonicalizePermissionCode,
  findPermission,
  permissionRegistry,
  platformPermissionRegistry,
  platformRoleCatalog,
} from '@erp/contracts';

import { newId } from './ids.js';

/**
 * Idempotent platform seed (PHASE_03 §5.7 "Idempotent seeds: run twice-safe").
 *
 * Seeding writes tenant-scoped tables, which are protected by RLS with FORCE. The
 * seeding connection therefore binds `app.tenant_id` for the whole session before
 * inserting — the same rule the API follows, so the seed can never write outside the
 * tenant it is seeding.
 */

export type SeedOptions = {
  tenantCode?: string;
  tenantName?: string;
  ownerEmail?: string;
  ownerFullName?: string;
  /** Argon2id PHC string produced by the platform password service. */
  ownerPasswordHash?: string;
  /**
   * Platform operator (super admin). Created only when an email is supplied. This account
   * belongs to no tenant: it carries `is_platform_admin` and can only reach `/platform/*`.
   */
  platformAdminEmail?: string;
  platformAdminFullName?: string;
  platformAdminPasswordHash?: string;
  /** Internal tenant the operator logs into. Defaults to `platform`. */
  platformTenantCode?: string;
  platformTenantName?: string;
  log?: (message: string) => void;
};

export type SeedReport = {
  permissions: number;
  tenantId: string;
  userId: string;
  membershipId: string;
  roles: string[];
  settingsInserted: number;
  platformAdminUserId?: string;
  platformTenantCode?: string;
};

export const DEMO_TENANT_CODE = 'demo';

/**
 * Upserts the code-list permission registry (PHASE_03 §5.6: "permission registry seeded
 * from a code list"). Idempotent, and independent of any tenant, so a freshly migrated
 * database — including an integration-test database — has the codes that
 * `role_permissions.permission_code` references.
 */
export async function seedPermissionRegistry(connectionString?: string): Promise<number> {
  const pool = new Pool({
    connectionString: connectionString ?? env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL,
  });
  const client = await pool.connect();
  try {
    return await upsertPermissions(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function upsertPermissions(client: PoolClient): Promise<number> {
  // Tenant registry (canonical + deprecated spellings) plus the platform-console
  // registry — both live in the `permissions` table; the registries stay separate
  // in code so tenant flows can never enumerate `console.*`.
  const catalog = [...permissionRegistry, ...platformPermissionRegistry];
  for (const permission of catalog) {
    await client.query(
      `INSERT INTO permissions (code, module, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description`,
      [permission.code, permission.module, permission.description],
    );
  }
  // Platform role catalogue (family A) — idempotent, mirrors migration 0032.
  for (const role of platformRoleCatalog) {
    await client.query(
      `INSERT INTO platform_roles (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
      [role.code, role.nameEn, role.description],
    );
  }
  return catalog.length;
}

/**
 * Resolves a baseline role's permission list to storable canonical codes.
 * `*` expands to the canonical tenant codes only — never deprecated spellings
 * (deduped by construction) and never `console.*`.
 */
function resolveSeedCodes(permissions: readonly string[]): string[] {
  if (permissions.includes(ALL_PERMISSIONS)) {
    return permissionRegistry.filter((entry) => !entry.deprecated).map((entry) => entry.code);
  }
  const out = new Set<string>();
  for (const code of permissions) {
    const canonical = canonicalizePermissionCode(code);
    if (findPermission(canonical) && !canonical.startsWith('console.')) out.add(canonical);
  }
  return [...out];
}

export async function seedPlatform(
  connectionString?: string,
  options: SeedOptions = {},
): Promise<SeedReport> {
  const log = options.log ?? (() => undefined);
  const tenantCode = options.tenantCode ?? DEMO_TENANT_CODE;
  const tenantName = options.tenantName ?? 'Demo Trading Co.';
  const ownerEmail = options.ownerEmail ?? `owner@${tenantCode}.test`;
  const ownerFullName = options.ownerFullName ?? 'Tenant Owner';

  const pool = new Pool({
    connectionString: connectionString ?? env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL,
  });

  // A single client for the whole seed: `set_config(..., false)` below binds the tenant
  // for the *session*, and `pool.end()` would hang on a client that was never released.
  const client = await pool.connect();
  try {
    // 1. permission registry (platform table — no RLS)
    const permissionCount = await upsertPermissions(client);
    log(`seed  permissions: ${permissionCount}`);

    // 2. tenant
    const tenantRow = await client.query<{ id: string }>(
      `INSERT INTO tenants (id, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [newId(), tenantCode, tenantName],
    );
    const tenantId = tenantRow.rows[0]?.id as string;

    // RLS on the tenant-scoped tables below applies to the seeding role too
    // (FORCE ROW LEVEL SECURITY), so bind the tenant for this session.
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

    // 3. owner user (platform table)
    const userRow = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, full_name, status, password_hash, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [
        newId(),
        ownerEmail,
        ownerFullName,
        options.ownerPasswordHash ? 'active' : 'invited',
        options.ownerPasswordHash ?? null,
        !options.ownerPasswordHash,
      ],
    );
    const userId = userRow.rows[0]?.id as string;

    // 4. membership (owner)
    const membershipRow = await client.query<{ id: string }>(
      `INSERT INTO memberships (id, tenant_id, user_id, display_name, status, is_owner)
       VALUES ($1, $2, $3, $4, 'active', true)
       ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL
         DO UPDATE SET is_owner = true, status = 'active'
       RETURNING id`,
      [newId(), tenantId, userId, ownerFullName],
    );
    const membershipId = membershipRow.rows[0]?.id as string;

    // 5. baseline roles + their permissions
    const roleNames: string[] = [];
    for (const role of baselineRoles) {
      const roleRow = await client.query<{ id: string }>(
        `INSERT INTO roles (id, tenant_id, name, is_system, description)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, name) WHERE deleted_at IS NULL
           DO UPDATE SET is_system = EXCLUDED.is_system, description = EXCLUDED.description
         RETURNING id`,
        [newId(), tenantId, role.name, role.isSystem, role.description],
      );
      const roleId = roleRow.rows[0]?.id as string;
      roleNames.push(role.name);

      const codes = resolveSeedCodes(role.permissions);

      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      for (const code of codes) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, code],
        );
      }

      if (role.code === 'owner') {
        await client.query(
          `INSERT INTO membership_roles (membership_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [membershipId, roleId],
        );
        for (const scopeType of ['branch', 'warehouse', 'cash_location'] as const) {
          await client.query(
            `INSERT INTO membership_role_scopes (membership_id, role_id, scope_type, scope_id)
             VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid)
             ON CONFLICT DO NOTHING`,
            [membershipId, roleId, scopeType],
          );
        }
      }
    }
    log(`seed  roles: ${roleNames.join(', ')}`);

    // 6. default tenant settings — inserted only when absent so a re-run never
    //    overwrites an operator change. Skip `feature.*` keys so core services
    //    (POS, HRM, etc.) are not explicitly written as `false` in `tenant_settings`.
    let settingsInserted = 0;
    for (const definition of tenantSettingsRegistry) {
      if (definition.key.startsWith('feature.')) continue;
      const inserted = await client.query(
        `INSERT INTO tenant_settings (tenant_id, key, value)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId, definition.key, JSON.stringify(definition.defaultValue)],
      );
      settingsInserted += inserted.rowCount ?? 0;
    }
    await client.query(
      `DELETE FROM tenant_settings
       WHERE tenant_id = $1
         AND key IN ('feature.pos', 'feature.hrm', 'feature.projects', 'feature.niche')
         AND value = 'false'::jsonb`,
      [tenantId],
    );
    log(`seed  tenant_settings: ${settingsInserted} new`);

    // 7. platform operator — the control-plane account. Optional on purpose: a deployment
    //    that manages tenants by hand should not get a super admin it never asked for.
    let platformAdminUserId: string | undefined;
    if (options.platformAdminEmail) {
      const adminRow = await client.query<{ id: string }>(
        `INSERT INTO users (id, email, full_name, status, password_hash, must_change_password,
                            password_changed_at, is_platform_admin)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, true)
         ON CONFLICT (email) DO UPDATE SET is_platform_admin = true,
                                           full_name = EXCLUDED.full_name,
                                           password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
                                           status = EXCLUDED.status
         RETURNING id`,
        [
          newId(),
          options.platformAdminEmail,
          options.platformAdminFullName ?? 'Platform Operator',
          options.platformAdminPasswordHash ? 'active' : 'invited',
          options.platformAdminPasswordHash ?? null,
          !options.platformAdminPasswordHash,
        ],
      );
      platformAdminUserId = adminRow.rows[0]?.id as string;

      // The operator still needs a home tenant to obtain a token: `POST /auth/login` always
      // authenticates *into* a tenant. A dedicated internal tenant keeps the control-plane
      // account out of every customer's user list.
      const opsTenantCode = options.platformTenantCode ?? 'platform';
      const opsTenantRow = await client.query<{ id: string }>(
        `INSERT INTO tenants (id, code, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [newId(), opsTenantCode, options.platformTenantName ?? 'Platform Operations'],
      );
      const opsTenantId = opsTenantRow.rows[0]?.id as string;
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [opsTenantId]);

      // Platform role grant: the operator holds `platform_owner` in the role model
      // (the legacy `is_platform_admin` flag above stays as its deprecated twin).
      await client.query(
        `INSERT INTO platform_memberships (id, user_id, role_code)
         VALUES ($1, $2, 'platform_owner')
         ON CONFLICT (user_id, role_code) DO NOTHING`,
        [newId(), platformAdminUserId],
      );

      const opsMembershipRow = await client.query<{ id: string }>(
        `INSERT INTO memberships (id, tenant_id, user_id, display_name, status, is_owner)
         VALUES ($1, $2, $3, $4, 'active', true)
         ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL
           DO UPDATE SET is_owner = true, status = 'active'
         RETURNING id`,
        [newId(), opsTenantId, platformAdminUserId, options.platformAdminFullName ?? 'Platform Operator'],
      );
      const opsMembershipId = opsMembershipRow.rows[0]?.id as string;

      for (const role of baselineRoles) {
        const opsRoleRow = await client.query<{ id: string }>(
          `INSERT INTO roles (id, tenant_id, name, is_system, description)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, name) WHERE deleted_at IS NULL
             DO UPDATE SET is_system = EXCLUDED.is_system
           RETURNING id`,
          [newId(), opsTenantId, role.name, role.isSystem, role.description],
        );
        const opsRoleId = opsRoleRow.rows[0]?.id as string;
        const opsCodes = resolveSeedCodes(role.permissions);
        for (const code of opsCodes) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [opsRoleId, code],
          );
        }
        if (role.code === 'owner') {
          await client.query(
            `INSERT INTO membership_roles (membership_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [opsMembershipId, opsRoleId],
          );
          for (const scopeType of ['branch', 'warehouse', 'cash_location'] as const) {
            await client.query(
              `INSERT INTO membership_role_scopes (membership_id, role_id, scope_type, scope_id)
               VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid)
               ON CONFLICT DO NOTHING`,
              [opsMembershipId, opsRoleId, scopeType],
            );
          }
        }
      }

      log(`seed  platform admin: ${options.platformAdminEmail} (tenant ${opsTenantCode})`);
    }

    return {
      permissions: permissionCount,
      tenantId,
      userId,
      membershipId,
      roles: roleNames,
      settingsInserted,
      platformAdminUserId,
      platformTenantCode: platformAdminUserId ? (options.platformTenantCode ?? 'platform') : undefined,
    };
  } finally {
    client.release();
    await pool.end();
  }
}
