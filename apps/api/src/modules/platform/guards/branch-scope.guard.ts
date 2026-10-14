import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BRANCH_ID_HEADER, DomainError, errorCodes, isUuid } from '@erp/contracts';

import { getRequestContext, setBranchId } from '../../../request-context/request-context.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { scopeAuthorises } from '../scopes/scope-policy.js';

type ScopedRequest = Request & { branchId?: string };

/**
 * Pipeline position: after TenantGuard, before PermissionsGuard (API_ARCHITECTURE §2).
 *
 * Validates the optional `X-Branch-Id` request scope. MULTI_TENANCY §2 is explicit that
 * a branch is a *scoping* device, not a security boundary: an unknown or out-of-scope
 * branch is rejected with 403 rather than silently widening the query.
 */
@Injectable()
export class BranchScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const header = request.headers[BRANCH_ID_HEADER];
    if (header === undefined) return true;

    const branchId = Array.isArray(header) ? header[0] : header;
    if (typeof branchId !== 'string' || !isUuid(branchId)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'X-Branch-Id must be a UUID', 400, {
        field: BRANCH_ID_HEADER,
      });
    }

    const tenant = getRequestContext().tenant;
    const scope = tenant?.branchScope;
    if (Array.isArray(scope) && !scope.includes(branchId)) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'Membership branch scope does not include the requested branch',
        403,
        { field: BRANCH_ID_HEADER },
      );
    }

    if (
      tenant &&
      !tenant.isOwner &&
      Array.isArray(tenant.roleIds) &&
      !scopeAuthorises(tenant.scopes, tenant.roleIds, 'branch', branchId)
    ) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'Role branch scope does not include the requested branch',
        403,
        { field: BRANCH_ID_HEADER },
      );
    }

    request.branchId = branchId;
    setBranchId(branchId);
    return true;
  }
}
