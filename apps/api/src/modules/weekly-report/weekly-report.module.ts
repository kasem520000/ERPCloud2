import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { EmailModule } from '../email/email.module.js';
import { PlatformAdminModule } from '../platform/admin/platform-admin.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { JobHandlerRegistry } from '../platform-services/jobs/job-handlers.js';

import { PlatformReportsController } from './platform-reports.controller.js';
import { WeeklyReportScheduler } from './weekly-report.scheduler.js';
import { WeeklyReportService } from './weekly-report.service.js';

/**
 * وحدة التقرير الأسبوعي — التسليم الدوري المؤجَّل من P-C12.
 *
 * `PlatformAdminModule` تُعطينا مالكَ الأرقام (`PlatformAnalyticsService`) ومالكَ الإعدادات
 * (`PlatformConsoleService`)، و`EmailModule` المُرسِل. ولا حسابَ ثانٍ هنا: الوحدة تُنسّق
 * وتُجدول وتُسلّم، لا تُعيد إنتاج رقمٍ تعرضه شاشة.
 *
 * ومعالِج الطابور يُسجَّل من هنا (نمط `ContentModule` و`AnnouncementsModule`): مهمّة
 * `report.weekly` على طابور «الصيانة» ينفّذها من يعرف كيف يبني التقرير — لا في
 * `PlatformJobHandlers` العامّ.
 */
@Module({
  imports: [PlatformModule, PlatformAdminModule, EmailModule],
  controllers: [PlatformReportsController],
  providers: [WeeklyReportService, WeeklyReportScheduler],
  exports: [WeeklyReportService],
})
export class WeeklyReportModule implements OnModuleInit {
  private readonly logger = new Logger(WeeklyReportModule.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly report: WeeklyReportService,
  ) {}

  onModuleInit(): void {
    this.registry.register('maintenance', jobTypes.REPORT_WEEKLY, (context) =>
      this.report.runFromJob(context),
    );
    this.logger.log('report.weekly handler registered on the maintenance queue');
  }
}
