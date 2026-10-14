import { Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module.js';

import { PlatformEmailController } from './admin/platform-email.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { PublicPlansController } from './billing/public-plans.controller.js';
import { PublicPlansService } from './billing/public-plans.service.js';
import { AuthService } from './auth/auth.service.js';
import { MfaController } from './auth/mfa.controller.js';
import { MfaService } from './auth/mfa.service.js';
import { PasswordService } from './auth/password.service.js';
import { TokenService } from './auth/token.service.js';
import { IdentityController } from './identity/identity.controller.js';
import { IdentityService } from './identity/identity.service.js';
import { PlatformRolePermissionsService } from './identity/platform-role-permissions.service.js';
import { RateLimiterService } from './rate-limit/rate-limiter.service.js';
import { MembershipsController } from './tenancy/memberships.controller.js';
import { MembershipsService } from './tenancy/memberships.service.js';
import { RolesController } from './tenancy/roles.controller.js';
import { RolesService } from './tenancy/roles.service.js';
import { SettingsController } from './tenancy/settings.controller.js';
import { SettingsService } from './tenancy/settings.service.js';
import { TenantController } from './tenancy/tenant.controller.js';
import { TenantService } from './tenancy/tenant.service.js';

/**
 * Platform module — tenancy, identity and access (TARGET_ARCHITECTURE §3).
 * Everything later phases need to authorise a request is exported from `./index.js`.
 */
@Module({
  imports: [EmailModule],
  controllers: [
    AuthController,
    MfaController,
    BillingController,
    PublicPlansController,
    PlatformEmailController,
    IdentityController,
    TenantController,
    MembershipsController,
    RolesController,
    SettingsController,
  ],
  providers: [
    AuthService,
    BillingService,
    PublicPlansService,
    IdentityService,
    PlatformRolePermissionsService,
    MembershipsService,
    RolesService,
    SettingsService,
    TenantService,
    MfaService,
    PasswordService,
    TokenService,
    RateLimiterService,
  ],
  exports: [
    AuthService,
    IdentityService,
    PlatformRolePermissionsService,
    MfaService,
    PasswordService,
    TokenService,
    RateLimiterService,
    BillingService,
    // Exported for module-level reuse of the *official* membership/role writers: a feature
    // that has to hand a user a login (van sales reps) must go through the same services
    // the `/memberships` and `/roles` endpoints use, never through its own SQL — one
    // invitation flow, one role model, one set of scope rules.
    MembershipsService,
    RolesService,
    // P-M4: التسجيل الذاتي يسكن `PlatformAdminModule` (يحتاج التجهيز والتفعيل)، وهو يقرأ
    // الباقات من هنا فلا تُنسخ الخدمة مرّتين ولا تفترق قائمةُ الباقات عن صفحة الأسعار.
    PublicPlansService,
  ],
})
export class PlatformModule {}
