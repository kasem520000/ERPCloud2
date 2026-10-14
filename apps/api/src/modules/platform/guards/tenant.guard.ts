import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { DomainError, errorCodes } from '@erp/contracts';
import {
  membershipRoleScopes,
  membershipRoles,
  memberships,
  rolePermissions,
  roles,
  tenants,
  users,
  withTenantTx,
  withTx,
  type DatabaseHandle,
} from '@erp/database';

import {
  getAuthContext,
  setTenantContextValue,
  type AuthContextValue,
  type RoleScopeValue,
  type TenantContextValue,
} from '../../../request-context/request-context.js';
import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

type GuardedRequest = Request & { auth?: AuthContextValue; tenant?: TenantContextValue };

/**
 * Pipeline position: directly after AuthGuard (API_ARCHITECTURE §2).
 *
 * Asserts that the token's `tid`/`mid` pair really is an **active membership of an
 * active tenant**, loads the effective permission set, and publishes the
 * `TenantContext`. The membership lookup itself runs under the claimed tenant's GUC, so
 * even this bootstrap query is RLS-scoped — a forged `tid` finds nothing.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const auth: AuthContextValue = request.auth ?? getAuthContext();

    const tenant = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ id: tenants.id, code: tenants.code, name: tenants.name, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, auth.claimedTenantId))
        .limit(1);
      return rows[0];
    });

    if (!tenant) {
      throw new DomainError(errorCodes.FORBIDDEN, 'Tenant referenced by the token does not exist', 403);
    }
    if (tenant.status !== 'active') {
      throw new DomainError(
        errorCodes.TENANT_SUSPENDED,
        `Tenant '${tenant.code}' is ${tenant.status}; access is denied`,
        423,
      );
    }

    const membership = await withTenantTx(this.database.db, tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: memberships.id,
          tenantId: memberships.tenantId,
          userId: memberships.userId,
          userStatus: users.status,
          status: memberships.status,
          branchScope: memberships.branchScope,
          isOwner: memberships.isOwner,
          kind: memberships.kind,
          maxDiscountPct: memberships.maxDiscountPct,
          maxDiscountAmount: memberships.maxDiscountAmount,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.id, auth.membershipId),
            eq(memberships.tenantId, tenant.id),
            isNull(memberships.deletedAt),
          ),
        )
        .limit(1);
      return rows[0];
    });

    if (!membership || membership.userId !== auth.userId) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'No membership for this user in the tenant referenced by the token',
        403,
      );
    }
    if (membership.userStatus !== 'active') {
      throw new DomainError(
        errorCodes.UNAUTHENTICATED,
        `User account is ${membership.userStatus}`,
        401,
      );
    }
    if (membership.status !== 'active') {
      throw new DomainError(errorCodes.FORBIDDEN, `Membership is ${membership.status}`, 403);
    }

    const roleGrantRows = await withTenantTx(this.database.db, tenant.id, async (tx) => {
      return tx
        .selectDistinct({ roleId: membershipRoles.roleId })
        .from(membershipRoles)
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(and(eq(membershipRoles.membershipId, membership.id), isNull(roles.deletedAt)));
    });

    const permissionRows = await withTenantTx(this.database.db, tenant.id, async (tx) => {
      return tx
        .selectDistinct({ code: rolePermissions.permissionCode })
        .from(membershipRoles)
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
        .where(and(eq(membershipRoles.membershipId, membership.id), isNull(roles.deletedAt)));
    });

    const scopeRows = await withTenantTx(this.database.db, tenant.id, async (tx) => {
      return tx
        .select({
          roleId: membershipRoleScopes.roleId,
          scopeType: membershipRoleScopes.scopeType,
          scopeId: membershipRoleScopes.scopeId,
        })
        .from(membershipRoleScopes)
        .where(eq(membershipRoleScopes.membershipId, membership.id));
    });

    const tenantContext: TenantContextValue = {
      tenantId: tenant.id,
      tenantCode: tenant.code,
      tenantStatus: tenant.status,
      membershipId: membership.id,
      userId: membership.userId,
      roleIds: roleGrantRows.map((row) => row.roleId),
      permissions: permissionRows.map((row) => row.code),
      branchScope: (membership.branchScope as string[] | null) ?? null,
      isOwner: membership.isOwner,
      kind: membership.kind === 'portal' ? 'portal' : 'staff',
      maxDiscountPct: membership.maxDiscountPct,
      maxDiscountAmount: membership.maxDiscountAmount,
      scopes: scopeRows.map((row) => ({
        roleId: row.roleId,
        scopeType: row.scopeType as RoleScopeValue['scopeType'],
        scopeId: row.scopeId,
      })),
    };

    request.tenant = tenantContext;
    setTenantContextValue(tenantContext);
    return true;
  }
}
