import { Client } from 'pg';
import { newId } from '@erp/database';

/**
 * Fixture factories (TESTING_STRATEGY §1: "Factories/fixtures in packages/testing —
 * tenant factories …"). Everything here writes through the **owner** connection so
 * fixtures can span tenants; the application under test must never be able to do that.
 *
 * Password hashes are supplied by the caller: hashing is a platform-module concern
 * (Argon2id, PROJECT_CONTRACT §9) and must not be duplicated in the test package.
 */

export type TenantFixture = {
  id: string;
  code: string;
  name: string;
};

export type UserFixture = {
  id: string;
  email: string;
  fullName: string;
};

export type MembershipFixture = {
  id: string;
  tenantId: string;
  userId: string;
};

export type RoleFixture = {
  id: string;
  tenantId: string;
  name: string;
};

export async function withOwnerClient<T>(ownerUrl: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates a tenant, or returns the one already registered under `code`.
 *
 * Tenant codes are globally unique (`tenants_code_key`), and a suite usually needs
 * several users inside the *same* tenant — so the fixture is keyed by code rather than
 * failing on the second call.
 */
export async function createTenantFixture(
  ownerUrl: string,
  options: { code: string; name?: string; status?: 'active' | 'suspended' | 'archived' },
): Promise<TenantFixture> {
  const id = newId();
  const name = options.name ?? `Tenant ${options.code.toUpperCase()}`;
  return withOwnerClient(ownerUrl, async (client) => {
    const row = await client.query<{ id: string; code: string; name: string }>(
      `INSERT INTO tenants (id, code, name, status) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET status = EXCLUDED.status
       RETURNING id, code, name`,
      [id, options.code, name, options.status ?? 'active'],
    );
    const tenant = row.rows[0] as { id: string; code: string; name: string };
    return { id: tenant.id, code: tenant.code, name: tenant.name };
  });
}

export async function createUserFixture(
  ownerUrl: string,
  options: {
    email: string;
    passwordHash?: string | null;
    fullName?: string;
    status?: string;
    isPlatformAdmin?: boolean;
  },
): Promise<UserFixture> {
  const id = newId();
  const fullName = options.fullName ?? options.email.split('@')[0] ?? 'Test User';
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO users (id, email, full_name, status, password_hash, must_change_password, password_changed_at, is_platform_admin)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $7)`,
      [
        id,
        options.email,
        fullName,
        options.status ?? (options.passwordHash ? 'active' : 'invited'),
        options.passwordHash ?? null,
        !options.passwordHash,
        options.isPlatformAdmin ?? false,
      ],
    );
  });
  return { id, email: options.email, fullName };
}

/** Grants a family-A platform role to a user (2026-09 RBAC reorganisation). */
export async function grantPlatformRoleFixture(
  ownerUrl: string,
  options: { userId: string; roleCode: string },
): Promise<void> {
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO platform_memberships (id, user_id, role_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_code) DO UPDATE SET revoked_at = NULL`,
      [newId(), options.userId, options.roleCode],
    );
  });
}

export async function createMembershipFixture(
  ownerUrl: string,
  options: {
    tenantId: string;
    userId: string;
    displayName?: string;
    status?: string;
    isOwner?: boolean;
    branchScope?: string[] | null;
    kind?: 'staff' | 'portal';
    /** R1 — حدّ الخصم على العضوية (`null`/غائب = بلا حدّ). */
    maxDiscountPct?: string | null;
    maxDiscountAmount?: string | null;
  },
): Promise<MembershipFixture> {
  const id = newId();
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO memberships (id, tenant_id, user_id, display_name, status, is_owner, branch_scope, kind, max_discount_pct, max_discount_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        id,
        options.tenantId,
        options.userId,
        options.displayName ?? 'Test Member',
        options.status ?? 'active',
        options.isOwner ?? false,
        options.branchScope === undefined ? null : JSON.stringify(options.branchScope),
        options.kind ?? 'staff',
        options.maxDiscountPct ?? null,
        options.maxDiscountAmount ?? null,
      ],
    );
  });
  return { id, tenantId: options.tenantId, userId: options.userId };
}

/**
 * Creates a role with the given permission set.
 *
 * Role names are unique per tenant, so a second fixture with the same name is suffixed
 * rather than colliding: each actor must get *its own* role, otherwise one actor would
 * silently inherit another actor's permissions.
 */
export async function createRoleFixture(
  ownerUrl: string,
  options: { tenantId: string; name: string; permissionCodes?: readonly string[]; isSystem?: boolean },
): Promise<RoleFixture> {
  const id = newId();
  return withOwnerClient(ownerUrl, async (client) => {
    let name = options.name;
    for (let attempt = 0; ; attempt += 1) {
      const inserted = await client
        .query(
          `INSERT INTO roles (id, tenant_id, name, is_system, description)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, name) WHERE deleted_at IS NULL DO NOTHING
           RETURNING id`,
          [id, options.tenantId, name, options.isSystem ?? false, 'test fixture role'],
        )
        .catch(() => null);
      if (inserted && inserted.rowCount === 1) break;
      if (attempt > 3) throw new Error(`Unable to create role '${options.name}' in ${options.tenantId}`);
      name = `${options.name}-${(attempt + 1).toString(36)}`;
    }

    for (const code of options.permissionCodes ?? []) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, code],
      );
    }
    return { id, tenantId: options.tenantId, name };
  });
}

export async function assignRoleFixture(
  ownerUrl: string,
  membershipId: string,
  roleId: string,
  options?: { tenantWideScopes?: boolean },
): Promise<void> {
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO membership_roles (membership_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [membershipId, roleId],
    );
    if (options?.tenantWideScopes) {
      for (const scopeType of ['branch', 'warehouse', 'cash_location'] as const) {
        await client.query(
          `INSERT INTO membership_role_scopes (membership_id, role_id, scope_type, scope_id)
           VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid)
           ON CONFLICT DO NOTHING`,
          [membershipId, roleId, scopeType],
        );
      }
    }
  });
}

export async function setTenantStatusFixture(
  ownerUrl: string,
  tenantId: string,
  status: 'active' | 'suspended' | 'archived',
): Promise<void> {
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [tenantId, status]);
  });
}

/** AUD-01 — account lifecycle state (`users.status`) for login/refresh acceptance tests. */
export async function setUserStatusFixture(
  ownerUrl: string,
  userId: string,
  status: 'active' | 'invited' | 'suspended',
): Promise<void> {
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);
  });
}

export async function setMembershipStatusFixture(
  ownerUrl: string,
  membershipId: string,
  status: 'active' | 'invited' | 'suspended',
): Promise<void> {
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(`UPDATE memberships SET status = $2 WHERE id = $1`, [membershipId, status]);
  });
}

export async function setTenantSettingFixture(
  ownerUrl: string,
  tenantId: string,
  key: string,
  value: string | boolean | number | null,
): Promise<void> {
  await withOwnerClient(ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, key, value)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [tenantId, key, JSON.stringify(value)],
    );
  });
}

/** Counts rows through the BYPASSRLS connection — proves data really is there. */
export async function countRowsBypassingRls(
  migratorUrl: string,
  tableName: string,
  tenantId?: string,
): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`Refusing to interpolate '${tableName}' into SQL: not a safe identifier.`);
  }
  return withOwnerClient(migratorUrl, async (client) => {
    const result = tenantId
      ? await client.query(`SELECT count(*)::int AS total_rows FROM ${tableName} WHERE tenant_id = $1`, [
          tenantId,
        ])
      : await client.query(`SELECT count(*)::int AS total_rows FROM ${tableName}`);
    const rows = result.rows as Array<{ total_rows: number }>;
    return rows[0]?.total_rows ?? 0;
  });
}
