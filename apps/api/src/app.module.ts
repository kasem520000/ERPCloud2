import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { REDACTED_LOG_PATHS, env } from '@erp/config';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { UuidParamPipe } from './common/pipes/uuid-param.pipe.js';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor.js';
import { RequestContextInterceptor } from './common/interceptors/request-context.interceptor.js';
import { DatabaseModule } from './database/database.module.js';
import { DomainEventsModule } from './events/domain-events.module.js';
import { HealthController } from './health/health.controller.js';
import {
  AuthGuard,
  BranchScopeGuard,
  PermissionsGuard,
  PlatformModule,
  RateLimitGuard,
  TenantGuard,
} from './modules/platform/index.js';
import { PlatformBackupsModule } from './modules/backups/platform-backups.module.js';
import { CampaignsModule } from './modules/campaigns/campaigns.module.js';
import { SiteAnalyticsModule } from './modules/site-analytics/site-analytics.module.js';
import { StatusModule } from './modules/status/status.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { VerifyModule } from './modules/verify/verify.module.js';
import { WeeklyReportModule } from './modules/weekly-report/weekly-report.module.js';
import { DeveloperModule } from './modules/developer/developer.module.js';
import { PlatformOperationsModule } from './modules/operations/platform-operations.module.js';
import { ImpersonationGuard } from './modules/support/impersonation.guard.js';
import { PlatformAdminModule } from './modules/platform/admin/platform-admin.module.js';
import { AccountingModule } from './modules/accounting/accounting.module.js';
import { ApprovalModule } from './modules/approvals/approvals.module.js';
import { OrganizationModule } from './modules/organization/index.js';
import { PartiesModule } from './modules/parties/parties.module.js';
import { CatalogModule } from './modules/organization/catalog/catalog.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { PurchasesModule } from './modules/purchases/purchases.module.js';
import { OcrModule } from './modules/ocr/ocr.module.js';
import { TreasuryModule } from './modules/treasury/treasury.module.js';
import { BankFeedsModule } from './modules/treasury/bank-feeds.module.js';
import { EinvoicingModule } from './modules/einvoicing/einvoicing.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { PortalModule } from './modules/portal/portal.module.js';
import { SupplierPortalModule } from './modules/supplier-portal/supplier-portal.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
import { DashboardsModule } from './modules/dashboards/dashboards.module.js';
import { MarketplaceModule } from './modules/marketplace/marketplace.module.js';
import { CrmModule } from './modules/crm/crm.module.js';
import { CommentsModule } from './modules/comments/comments.module.js';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module.js';
import { MigrationModule } from './modules/migration/migration.module.js';
import { CompatModule } from './modules/compat/compat.module.js';
import { DevicesModule } from './modules/devices/devices.module.js';
import { PosModule } from './modules/pos/pos.module.js';
import { HrmModule } from './modules/hrm/hrm.module.js';
import { InstallmentsModule } from './modules/installments/installments.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { FitmentModule } from './modules/fitment/fitment.module.js';
import { MarinaModule } from './modules/marina/marina.module.js';
import { OpticsModule } from './modules/optics/optics.module.js';
import { SallaModule } from './modules/integrations/salla/salla.module.js';
import { EcommerceModule } from './modules/ecommerce/ecommerce.module.js';
import { TailoringModule } from './modules/tailoring/tailoring.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { EmployeeModule } from './modules/employee/employee.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { WhatsappModule } from './modules/integrations/whatsapp/whatsapp.module.js';
import { VanSalesModule } from './modules/van-sales/van-sales.module.js';
import { AuditInterceptor, PlatformServicesModule } from './modules/platform-services/index.js';
import { UsageModule } from './modules/usage/index.js';
import { MetricsInterceptor } from './ops/metrics.interceptor.js';
import { OpsModule } from './ops/ops.module.js';

/**
 * Guard order is frozen by API_ARCHITECTURE §2:
 * `rate limit → AuthGuard → TenantGuard (+RLS GUC) → BranchScopeGuard → PermissionsGuard`.
 * `APP_GUARD` providers are applied in declaration order, so the array below *is* the
 * pipeline; reordering it is a contract change, not a refactor.
 *
 * Interceptor order matters just as much: `RequestContext` establishes the ALS store the
 * other two read, `Idempotency` may short-circuit with a stored response *before* the
 * handler (and before an audit row would be written for a request that never ran), and
 * `Audit` wraps the handler last so it observes the real outcome
 * (SECURITY_ARCHITECTURE §10: every mutating endpoint writes an audit row).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '.env.local'],
      validate: () => env,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        customProps: () => ({ service: 'erp-api' }),
        redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' },
        autoLogging: env.NODE_ENV !== 'test',
      },
    }),
    DatabaseModule,
    OpsModule,
    PlatformBackupsModule,
    DeveloperModule,
    CampaignsModule,
    ContentModule,
    VerifyModule,
    StatusModule,
    SiteAnalyticsModule,
    WeeklyReportModule,
    PlatformOperationsModule,
    DomainEventsModule,
    PlatformModule,
    PlatformServicesModule,
    UsageModule,
    OrganizationModule,
    PlatformAdminModule,
    CatalogModule,
    AccountingModule,
    ApprovalModule,
    PartiesModule,
    InventoryModule,
    SalesModule,
    PurchasesModule,
    OcrModule,
    TreasuryModule,
    BankFeedsModule,
    EinvoicingModule,
    OperationsModule,
    PortalModule,
    SupplierPortalModule,
    ReportingModule,
    DashboardsModule,
    MarketplaceModule,
    CrmModule,
    CommentsModule,
    CustomFieldsModule,
    MigrationModule,
    CompatModule,
    DevicesModule,
    PosModule,
    HrmModule,
    InstallmentsModule,
    ProjectsModule,
    OpticsModule,
    TailoringModule,
    MarinaModule,
    FitmentModule,
    SallaModule,
    EcommerceModule,
    PaymentsModule,
    AiModule,
    EmployeeModule,
    WhatsappModule,
    VanSalesModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // 🔑 R6 — كل معاملِ مسارٍ اسمه `id` أو ينتهي بـ`Id` يُفحَص هنا قبل أن يبلغ قاعدة
    // البيانات؛ الخطأ إعدادٌ في الطلب لا عطلٌ في الخادم.
    { provide: APP_PIPE, useClass: UuidParamPipe },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // P-C8: the break-glass guard sits *immediately after* authentication on purpose. The
    // `imp` claim is only known once AuthGuard has published the context, and a token that
    // came from `POST /platform/impersonate` must be limited on **every** route it can
    // reach, not only on the console's own. It returns at once for ordinary tokens, so the
    // frozen pipeline above keeps its meaning and its cost.
    { provide: APP_GUARD, useClass: ImpersonationGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: BranchScopeGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
