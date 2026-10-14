/**
 * Public API of the platform module (TARGET_ARCHITECTURE §4.1: a module exports a public
 * `index.ts`; everything else is private and enforced by `eslint-plugin-boundaries`).
 *
 * Later phases import guards/decorators/context from here — never from the deep paths.
 */
export { PlatformModule } from './platform.module.js';

export { AuthGuard } from './guards/auth.guard.js';
export { TenantGuard } from './guards/tenant.guard.js';
export { BranchScopeGuard } from './guards/branch-scope.guard.js';
export { PermissionsGuard } from './guards/permissions.guard.js';
export { PlatformAdminGuard } from './guards/platform-admin.guard.js';
export { RateLimitGuard } from './guards/rate-limit.guard.js';
export { RateLimiterService } from './rate-limit/rate-limiter.service.js';

export { Public, IS_PUBLIC_KEY } from './decorators/public.decorator.js';
export { RequiresPermission, REQUIRED_PERMISSION_KEY } from './decorators/requires-permission.decorator.js';
export { RequiresPlatformRole, REQUIRED_PLATFORM_PERMISSION_KEY } from './decorators/requires-platform-role.decorator.js';
export { RateLimit, RATE_LIMIT_KEY } from './decorators/rate-limit.decorator.js';
export type { RateLimitRule } from './decorators/rate-limit.decorator.js';
export { CurrentAuth, CurrentTenant } from './decorators/current-context.decorator.js';

export {
  getAuthContext,
  getBranchScopeFilter,
  getTenantContext,
  getTenantId,
  tryGetAuthContext,
  tryGetTenantContext,
} from './context/tenant-context.js';

export { AuthService } from './auth/auth.service.js';
export { IdentityService } from './identity/identity.service.js';
export { PasswordService } from './auth/password.service.js';
export { TokenService } from './auth/token.service.js';
export type { AccessTokenClaims } from './auth/token.service.js';
export {
  DENY_LIST,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  evaluatePasswordPolicy,
} from './auth/password-policy.js';
export type { PasswordPolicyIssue, PasswordPolicyResult } from './auth/password-policy.js';
