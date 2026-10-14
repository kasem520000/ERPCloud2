import { Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, errorCodes, platformPermissionsForRoles } from '@erp/contracts';

import { getAuthContext, getRequestContext } from '../../../request-context/request-context.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';
import { PlatformRolePermissionsService } from '../identity/platform-role-permissions.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRED_PLATFORM_PERMISSION_KEY } from '../decorators/requires-platform-role.decorator.js';

const SAFE_HEADER_TEXT = /^[^\r\n]{1,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readSafeReason(request: Request | undefined): string | null {
  const raw = request?.headers?.['x-platform-reason'] ?? request?.headers?.['x-break-glass-reason'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return SAFE_HEADER_TEXT.test(trimmed) ? trimmed : null;
}

function resolveTargetTenantId(request: Request | undefined): string | null {
  const params = request?.params as Record<string, unknown> | undefined;
  const query = request?.query as Record<string, unknown> | undefined;
  const candidate =
    params?.tenantId ??
    query?.tenantId ??
    (typeof request?.url === 'string' && /\/platform\/tenants\/([0-9a-f-]{36})/i.exec(request.url)?.[1]);
  return typeof candidate === 'string' && UUID_RE.test(candidate) ? candidate : null;
}

/**
 * Guard for the platform-admin (ops) plane.
 *
 * MULTI_TENANCY §4: platform admin access is a separate plane, always audited, never
 * implied by tenant permissions (SECURITY_ARCHITECTURE §3).
 *
 * 2026-09: effective platform access = legacy `users.is_platform_admin` flag OR any
 * `platform_memberships` row, resolved at login into the token (`pam` / `proles`
 * claims). Routes carrying `@RequiresPlatformRole('console.…')` additionally require
 * the matching platform permission; routes without it keep the legacy rule (any
 * effective platform administrator passes) for compatibility.
 *
 * 2026-09 (P-C3): the *permissions* of those roles are no longer read from the catalogue
 * alone. `PUT /platform/roles/:code/permissions` writes overrides, and this guard reads
 * them on every guarded request — so a revoked console code stops working **immediately**,
 * not at the next login. The alternative (baking permissions into the token at sign-in)
 * would have made the roles screen a picture of something the API does not honour.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rolePermissions: PlatformRolePermissionsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const auth = getAuthContext();
    if (!auth.isPlatformAdmin) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'platform-admin plane requires a platform membership',
        403,
      );
    }

    const required = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_PLATFORM_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required) {
      const overrides = await this.rolePermissions.overrides();
      const granted = new Set(platformPermissionsForRoles(auth.platformRoles ?? [], overrides));
      if (!granted.has(required)) {
        throw new DomainError(
          errorCodes.FORBIDDEN,
          `platform permission ${required} required`,
          403,
          { field: 'permission', message: required },
        );
      }
    }

    // SH-07 — break-glass / platform-plane audit row (actor, reason, target tenant) without secrets.
    if (this.audit) {
      const request = context.switchToHttp().getRequest<Request | undefined>();
      const reason = readSafeReason(request);
      const targetTenantId = resolveTargetTenantId(request);
      // Record on explicit break-glass reason OR cross-tenant read (`GET` targeting a tenant),
      // while mutating endpoints remain covered by `AuditInterceptor` / service `recordInTx`.
      const method = (request?.method ?? 'GET').toUpperCase();
      if (reason !== null || (method === 'GET' && targetTenantId !== null)) {
        const reqCtx = getRequestContext();
        await this.audit.record({
          tenantId: null,
          actorUserId: auth.userId,
          membershipId: null,
          action: 'platform.break_glass.access',
          entity: 'platform_admin_plane',
          entityId: targetTenantId,
          meta: {
            method,
            path: (request?.originalUrl ?? request?.url ?? '').split('?')[0] ?? '',
            requiredPermission: required ?? null,
            platformRoles: auth.platformRoles ?? [],
            reason,
            targetTenantId,
            traceId: reqCtx.traceId,
            ip: reqCtx.clientIp ?? null,
          },
        });
      }
    }

    return true;
  }
}
