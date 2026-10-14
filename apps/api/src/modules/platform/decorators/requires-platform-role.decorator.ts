import { SetMetadata } from '@nestjs/common';

/**
 * Declares the platform-console permission a route requires
 * (2026-09 architecture/RBAC reorganisation).
 *
 * Codes come from `platformPermissionRegistry` in `@erp/contracts` (`console.*`
 * namespace) and are enforced by `PlatformAdminGuard` against the token's
 * `proles` claim. Tenant permissions (`tenant.*`, …) and the `*` wildcard NEVER
 * satisfy this decorator — the planes are disjoint by construction.
 *
 * Routes without this decorator but behind `PlatformAdminGuard` keep the legacy
 * rule: any effective platform administrator passes (compatibility).
 */
export const REQUIRED_PLATFORM_PERMISSION_KEY = 'erp:requiredPlatformPermission';

export const RequiresPlatformRole = (code: string) =>
  SetMetadata(REQUIRED_PLATFORM_PERMISSION_KEY, code);
