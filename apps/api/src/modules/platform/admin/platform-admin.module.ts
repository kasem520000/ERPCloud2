import { Module } from '@nestjs/common';

import { AnnouncementsModule } from '../../announcements/announcements.module.js';
import { SupportModule } from '../../support/support.module.js';
import { OrganizationModule } from '../../organization/organization.module.js';
import { PlatformModule } from '../platform.module.js';
import { DeveloperModule } from '../../developer/developer.module.js';
import { EmailModule } from '../../email/email.module.js';
import { SignupVerificationController } from '../signup/signup-verification.controller.js';
import { SignupService } from '../signup/signup.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { PlatformLeadsController } from '../leads/platform-leads.controller.js';
import { PublicLeadsController } from '../leads/public-leads.controller.js';

import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAnalyticsController } from './platform-analytics.controller.js';
import { PlatformAnalyticsService } from './platform-analytics.service.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlatformConsoleController } from './platform-console.controller.js';
import { PlatformIdentityController } from './platform-identity.controller.js';
import { PlatformIdentityService } from './platform-identity.service.js';
import { PlatformConsoleService } from './platform-console.service.js';
import { PlatformTenantsController } from './platform-tenants.controller.js';
import { PlatformUsageController } from './platform-usage.controller.js';
import { PlatformTenantsService } from './platform-tenants.service.js';

/**
 * The SaaS control plane lives in its own module rather than inside `PlatformModule`
 * because it needs `OrgProvisioningService` from `OrganizationModule` — and
 * `OrganizationModule` already depends on the platform guards. Keeping the dependency
 * one-directional here avoids a module cycle.
 */
@Module({
  imports: [PlatformModule, OrganizationModule, EmailModule, AnnouncementsModule, SupportModule, DeveloperModule],
  controllers: [
    PlatformAdminController,
    PlatformAnalyticsController,
    PlatformBillingController,
    PlatformConsoleController,
    PlatformIdentityController,
    PlatformTenantsController,
    PlatformUsageController,
    SignupVerificationController,
    // P-M6: صندوق العملاء المتوقّعين (لوحة) واستمارات الموقع (عامّ) — والخدمة واحدة:
    // قاعدةُ التحويل هي قاعدةُ الالتقاط، وقرارُ «من يُسنَد إليه» لا يفترق بين البابين.
    PlatformLeadsController,
    PublicLeadsController,
  ],
  providers: [
    PlatformAdminService,
    PlatformAnalyticsService,
    PlatformBillingService,
    PlatformConsoleService,
    PlatformIdentityService,
    PlatformTenantsService,
    SignupService,
    LeadsService,
  ],
  exports: [
    PlatformAdminService,
    PlatformAnalyticsService,
    PlatformBillingService,
    PlatformConsoleService,
    PlatformIdentityService,
    PlatformTenantsService,
  ],
})
export class PlatformAdminModule {}
