/**
 * `@erp/contracts` — the API↔UI shared contract package (TARGET_ARCHITECTURE §3):
 * zod DTOs, the stable error-code registry, permission codes, pagination and id rules.
 */
export { errorCodes, errorStatus, errorTitle, isErrorCode, statusForCode, titleForCode } from './errors.js';
export type { ErrorCode } from './errors.js';

export { DomainError, createProblemDetails, problemFromZodError } from './problem.js';
export type { ProblemDetails, ProblemError } from './problem.js';

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  buildMeta,
  listEnvelope,
  paginationQuerySchema,
  parseFilters,
  parseSort,
} from './pagination.js';
export type { ListEnvelope, ListMeta, PaginationQuery, SortClause, SortDirection } from './pagination.js';

export { idParamSchema, isUuid, newId, uuidSchema } from './ids.js';
export type { IdParam } from './ids.js';

export {
  AUTHORIZATION_HEADER,
  BRANCH_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  newRequestId,
} from './request-id.js';
export type { RequestId } from './request-id.js';

export {
  ALL_PERMISSIONS,
  VAN_SALES_CODES_IMPLIED_BY_SALES_INVOICE,
  VAN_SALES_CODES_NEVER_IMPLIED_BY_SALES,
  canonicalPermissionCodes,
  canonicalToLegacy,
  canonicalizePermissionCode,
  findPermission,
  isConsolePermissionCode,
  isKnownPermissionCode,
  isTenantGrantablePermissionCode,
  permissionAliases,
  permissionGrants,
  permissionModules,
  permissionRegistry,
  permissionsForModule,
  platformPermissionRegistry,
  seedablePermissionCodes,
} from './permissions.js';
export type { PermissionDefinition } from './permissions.js';

export {
  erpFunctionalRoleCatalog,
  findErpFunctionalRole,
  findPlatformRole,
  findTenantAdminRole,
  isPlatformRoleCode,
  platformPermissionsForRoles,
  platformRoleCatalog,
  tenantAdminRoleCatalog,
} from './rbac.js';
export type {
  ErpFunctionalRoleCode,
  PlatformRoleCode,
  RoleCatalogEntry,
  TenantAdminRoleCode,
} from './rbac.js';

export * from './zatca-qr.js';
export * from './platform/index.js';
export * from './organization/index.js';
export * from './devices.js';
export * from './approval.js';
export * from './custom-fields.js';
export * from './arabic-words.js';
export * from './invoice-math.js';
export * from './inventory-valuation.js';
export * from './inventory-lifecycle.js';
export * from './inventory-valuation.js';

export const contractVersion = '0.6.0';
