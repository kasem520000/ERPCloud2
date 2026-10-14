import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { EmailModule } from '../email/email.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { JobHandlerRegistry } from '../platform-services/jobs/job-handlers.js';
import { PlatformServicesModule } from '../platform-services/platform-services.module.js';

import { CampaignsService } from './campaigns.service.js';
import { PlatformCampaignsController } from './platform-campaigns.controller.js';
import { PublicCampaignsController } from './public-campaigns.controller.js';

/**
 * P-M7 — وحدة الحملات البريدية (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * وحدةٌ واحدة تحمل السطحين عمداً، كما في المحتوى (P-M5):
 *   * **العامّ** `/public/track/*` و`/public/unsubscribe/*` — تُفتح من بريدٍ لا من متصفّح
 *     جلسة، والرمز هو التصريح (`@Public()` + محدّد معدّل على دلو `campaign-track`).
 *   * **اللوحة** `/platform/campaigns/*` — برمزٍ واحد `console.campaigns.manage`، وحارس
 *     سطح المنصّة.
 * ولو فُصلا لصار للزحف والإلغاء عقلان: واحدٌ يكتب الحجر والآخر لا يعرفه.
 *
 * `EmailModule` يجلب مُرسِل المنصّة (القوالب والحجر والحصص والطابور)، و`PlatformServicesModule`
 * يجلب `AuditService` و`OutboxService`. والوحدة تسجّل معالج الطابور بنفسها كما تفعل
 * `ContentModule` و`AnnouncementsModule` و`WeeklyReportModule` — وحدةٌ واحدة تملك مسارها.
 */
@Module({
  imports: [EmailModule, PlatformModule, PlatformServicesModule],
  controllers: [PublicCampaignsController, PlatformCampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule implements OnModuleInit {
  private readonly logger = new Logger(CampaignsModule.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly campaigns: CampaignsService,
  ) {}

  /**
   * دفعةُ حملةٍ على طابور «الصيانة»: أسماء الطوابير الخمسة مجمّدة في TARGET_ARCHITECTURE §6،
   * وإرسالٌ مجدول ليس رسالةَ عميلٍ عاجلة (تماماً كما `content.publish` و`report.weekly`).
   * والمهمّة تُعيد جدولة نفسها حتى تنفد الشريحة، والمسح شبكةُ أمانٍ لها في بيئةٍ بلا عامل.
   */
  onModuleInit(): void {
    this.registry.register('maintenance', jobTypes.CAMPAIGN_SEND, (context) =>
      this.campaigns.dispatchFromJob(context),
    );
    this.logger.log('campaign.send handler registered on the maintenance queue');
  }
}
