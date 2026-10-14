import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, errorCodes, permissionGrants } from '@erp/contracts';

import { getRequestContext } from '../../../request-context/request-context.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from '../decorators/requires-permission.decorator.js';

/**
 * Pipeline position: last guard, after validation-independent checks
 * (API_ARCHITECTURE §2). Effective permission set = UNION(roles) (DATABASE_DESIGN §2).
 *
 * 2026-09 hardening:
 *
 * - The check is alias-aware (`permissionGrants`): a grant under the legacy
 *   `platform.*` spelling authorises the canonical `tenant.*` spelling and vice
 *   versa, so the namespace reclassification breaks no existing role.
 * - The `*` wildcard satisfies every TENANT permission and never a platform
 *   (`console.*`) one — enforced inside `permissionGrants`, and structurally,
 *   because console routes use `PlatformAdminGuard`, never this guard.
 * - `portal` memberships (external customers) are denied on every permission-gated
 *   route explicitly, even if a role were mis-granted: their only surface is the
 *   `/portal/*` endpoints, which authorise through `portal_accounts` instead.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string | string[] | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // A route may declare several codes (`RequiresPermission('a', 'b')`) when it
    // spans two modules; every one of them must be granted.
    const codes = required === undefined ? [] : Array.isArray(required) ? required : [required];
    if (codes.length === 0) return true;
    const requiredLabel = codes.join(', ');

    const tenant = getRequestContext().tenant;
    if (tenant?.kind === 'portal') {
      throw new DomainError(errorCodes.FORBIDDEN, 'portal memberships cannot access staff endpoints', 403, {
        field: 'permission',
        message: requiredLabel,
      });
    }

    const granted = tenant?.permissions ?? [];
    for (const code of codes) {
      if (permissionGrants(granted, code)) continue;
      throw new DomainError(errorCodes.FORBIDDEN, `permission ${code} required`, 403, {
        field: 'permission',
        message: code,
      });
    }
    return true;
  }
}
