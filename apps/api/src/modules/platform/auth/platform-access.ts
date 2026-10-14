import { and, eq, isNull } from 'drizzle-orm';
import { platformMemberships, withTx, type DatabaseHandle } from '@erp/database';

/**
 * Effective platform access (2026-09 architecture/RBAC reorganisation).
 *
 * A user is a platform administrator when the legacy `users.is_platform_admin`
 * flag is set OR when they hold any non-revoked `platform_memberships` row. A
 * flag-only user is treated as `platform_owner` — the exact equivalent of the
 * pre-reorganisation semantic — so deployments that never adopt the role model
 * keep working unchanged.
 */
export async function resolvePlatformAccess(
  database: DatabaseHandle,
  userId: string,
  legacyFlag: boolean,
): Promise<{ isPlatformAdmin: boolean; platformRoles: string[] }> {
  const rows = await withTx(database.db, async (tx) =>
    tx
      .select({ roleCode: platformMemberships.roleCode })
      .from(platformMemberships)
      .where(
        and(eq(platformMemberships.userId, userId), isNull(platformMemberships.revokedAt)),
      ),
  );

  const platformRoles = rows.map((row) => row.roleCode);
  if (platformRoles.length === 0 && legacyFlag) {
    return { isPlatformAdmin: true, platformRoles: ['platform_owner'] };
  }
  return { isPlatformAdmin: legacyFlag || platformRoles.length > 0, platformRoles };
}
