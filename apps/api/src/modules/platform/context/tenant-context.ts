import { DomainError, errorCodes } from '@erp/contracts';

import { getRequestContext, type TenantContextValue } from '../../../request-context/request-context.js';

export { getAuthContext, tryGetAuthContext } from '../../../request-context/request-context.js';
export type { AuthContextValue } from '../../../request-context/request-context.js';

/**
 * Tenant context accessor (PHASE_03 §5.4: "TenantGuard … attaches TenantContext").
 *
 * Services read the tenant from here — never from a request body, query string or
 * header. PROJECT_CONTRACT §8: "Tenant context comes from the access token; it cannot
 * be supplied by the client."
 */

export function tryGetTenantContext(): TenantContextValue | undefined {
  return getRequestContext().tenant;
}

export function getTenantContext(): TenantContextValue {
  const tenant = getRequestContext().tenant;
  if (!tenant) {
    throw new DomainError(
      errorCodes.TENANT_CONTEXT_MISSING,
      'This operation requires an authenticated tenant context',
      400,
    );
  }
  return tenant;
}

export function getTenantId(): string {
  return getTenantContext().tenantId;
}

/** Validated `X-Branch-Id`, or undefined when the caller did not scope the request. */
export function getBranchScopeFilter(): string | undefined {
  return getRequestContext().branchId;
}
