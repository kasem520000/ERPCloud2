import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  permissionRegistry,
  type MeResponse,
  type PermissionDto,
} from '@erp/contracts';
import {
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  tenants,
  users,
  withPlatformAdminTx,
  withTenantTx,
  withTx,
  type DatabaseHandle,
} from '@erp/database';

import type { AuthContextValue } from '../../../request-context/request-context.js';
import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { resolvePlatformAccess } from '../auth/platform-access.js';
import { toMembershipDto, toUserDto } from '../mappers.js';

import { PlatformRolePermissionsService } from './platform-role-permissions.service.js';

/** `GET /me` and `GET /permissions` — API_CONTRACT §1. */
@Injectable()
export class IdentityService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly rolePermissions: PlatformRolePermissionsService,
  ) {}

  async me(auth: AuthContextValue): Promise<MeResponse> {
    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          phone: users.phone,
          status: users.status,
          isPlatformAdmin: users.isPlatformAdmin,
          mustChangePassword: users.mustChangePassword,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1);
      return rows[0];
    });

    if (!user) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'User not found', 401);
    }

    const platform = await resolvePlatformAccess(this.database, user.id, user.isPlatformAdmin);
    const userRow = {
      ...user,
      isPlatformAdmin: platform.isPlatformAdmin,
      platformRoles: platform.platformRoles,
    };
    // P-C1: the union of the console codes the operator's platform roles carry. The
    // console sidebar renders from this list, so it never offers a link the API will
    // refuse — and it is a *separate* list from `permissions` because `pam`/`*` must never
    // satisfy a `console.*` code (SECURITY_ARCHITECTURE §3).
    //
    // P-C3: the same overrides the guard reads, so the sidebar and the API cannot disagree
    // after the roles matrix is edited (`platform-role-permissions.service.ts`).
    const platformPermissions = await this.rolePermissions.effectiveFor(platform.platformRoles);

    // P-C8 — إن كان الرمز رمزَ دخولٍ مؤقّت، فالشاشة تحتاج أن تقول: من دخل، ولماذا، وإلى متى.
    // يُقرأ صفُّ الجلسة بمعاملة المنصة (الجلسة صفُّ منصة لا يراه سياق العميل) بلا وسيط:
    // خدمة الدعم تعتمد على هذه الوحدة، فلا تُستورد هنا كي لا تدور الحلقة.
    const impersonation = auth.impersonationId
      ? await withPlatformAdminTx(this.database.db, async (tx) => {
          const result = await tx.execute(sql`
            SELECT s.id, s.operator_user_id, s.reason, s.started_at, s.expires_at,
                   COALESCE(u.full_name, u.email) AS operator_label
              FROM support_sessions s
              LEFT JOIN users u ON u.id = s.operator_user_id
             WHERE s.id = ${auth.impersonationId}
             LIMIT 1
          `);
          const row = result.rows[0] as
            | {
                id: string;
                operator_user_id: string;
                operator_label: string | null;
                reason: string;
                started_at: Date | string;
                expires_at: Date | string;
              }
            | undefined;
          if (!row) return null;
          return {
            sessionId: row.id,
            operatorUserId: row.operator_user_id,
            operatorLabel: row.operator_label,
            reason: row.reason,
            startedAt: new Date(row.started_at).toISOString(),
            expiresAt: new Date(row.expires_at).toISOString(),
          };
        })
      : null;

    return withTenantTx(this.database.db, auth.claimedTenantId, async (tx) => {
      const rows = await tx
        .select({
          id: memberships.id,
          tenantId: memberships.tenantId,
          tenantCode: tenants.code,
          tenantName: tenants.name,
          displayName: memberships.displayName,
          status: memberships.status,
          isOwner: memberships.isOwner,
          branchScope: memberships.branchScope,
          kind: memberships.kind,
          maxDiscountPct: memberships.maxDiscountPct,
          maxDiscountAmount: memberships.maxDiscountAmount,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.id, auth.membershipId), isNull(memberships.deletedAt)))
        .limit(1);

      const membership = rows[0];
      if (!membership) {
        throw new DomainError(errorCodes.FORBIDDEN, 'Membership not found', 403);
      }

      const permissionRows = await tx
        .selectDistinct({ code: rolePermissions.permissionCode })
        .from(membershipRoles)
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
        .where(and(eq(membershipRoles.membershipId, membership.id), isNull(roles.deletedAt)));

      return {
        user: toUserDto(userRow),
        membership: await toMembershipDto(tx, membership),
        permissions: permissionRows.map((row) => row.code).sort(),
        platformPermissions: [...platformPermissions].sort(),
        branchScope: (membership.branchScope as string[] | null) ?? null,
        impersonation,
      };
    });
  }

  /** The registry the `permissions` table is seeded from (SECURITY_ARCHITECTURE §3). */
  async listPermissions(): Promise<PermissionDto[]> {
    const rows = await withTx(this.database.db, async (tx) =>
      tx
        .select({ code: permissions.code, module: permissions.module, description: permissions.description })
        .from(permissions),
    );

    const seeded = new Map(rows.map((row) => [row.code, row]));
    // The code list is authoritative; the table only proves the seed ran.
    return permissionRegistry.map((entry) => ({
      code: entry.code,
      module: entry.module,
      description: seeded.get(entry.code)?.description ?? entry.description,
    }));
  }
}
