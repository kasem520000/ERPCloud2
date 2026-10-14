import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { PlatformModule } from '../platform/platform.module.js';
import { JobHandlerRegistry } from '../platform-services/jobs/job-handlers.js';
import { PlatformServicesModule } from '../platform-services/platform-services.module.js';

import { ContentService } from './content.service.js';
import { PlatformContentController } from './platform-content.controller.js';
import { PublicContentController } from './public-content.controller.js';

/**
 * P-M5 — وحدة المحتوى (`docs/roadmap/MARKETING_SITE_PLAN.md` §6).
 *
 * وحدةٌ واحدة تحمل السطحين عمداً: **العامّ** (`/public/*` بلا جلسة) و**اللوحة**
 * (`/platform/content/*` برمزين). الفصل بينهما كان سيُنشئ خدمتين تقرآن الجدول نفسه وتختلفان
 * في تعريف «منشور» — وهو بالضبط ما يجب أن يسكن مكاناً واحداً (`publishedWhere` في الخدمة).
 * ويُقاس ذلك في السبيك: المسوّدة لا تظهر من العامّ، وتظهر من اللوحة.
 *
 * `PlatformServicesModule` يجلب `AuditService` (كل كتابة تُدقَّق)، و`PlatformModule` يجلب
 * حارس سطح المنصّة. والوحدة المستهلكة: `apps/marketing` عبر `/public/*`.
 */
@Module({
  imports: [PlatformModule, PlatformServicesModule],
  controllers: [PublicContentController, PlatformContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule implements OnModuleInit {
  private readonly logger = new Logger(ContentModule.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly content: ContentService,
  ) {}

  /**
   * نشرُ المجدول في وقته — على طابور «الصيانة» (أسماء الطوابير الخمسة مجمّدة في
   * TARGET_ARCHITECTURE §6، ونشر صفحةٍ ليس تسليم رسالة). التسجيل هنا لا في
   * `PlatformJobHandlers` لأن كل وحدةٍ تسجّل معالجها، كما فعلت `AnnouncementsModule`.
   */
  onModuleInit(): void {
    this.registry.register('maintenance', jobTypes.CONTENT_PUBLISH, (context) =>
      this.content.publishFromJob(context),
    );
    this.logger.log('content.publish handler registered on the maintenance queue');
  }
}
