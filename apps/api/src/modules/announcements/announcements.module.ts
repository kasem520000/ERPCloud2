import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { EmailModule } from '../email/email.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { JobHandlerRegistry } from '../platform-services/jobs/job-handlers.js';
import { PlatformServicesModule } from '../platform-services/platform-services.module.js';

import { AnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';

/**
 * P-C7 — وحدة الإعلانات. تعتمد على `NotificationsService` (الإشعار داخل التطبيق) و
 * `EmailService` (رسالة المالك) و`OutboxService` (جدولة النشر) و`AuditService`.
 */
@Module({
  // `PlatformModule` يجلب `PlatformRolePermissionsService` لحارس سطح المنصة، و
  // `PlatformServicesModule` يجلب الإشعارات والمهامّ والتدقيق، و`EmailModule` البريد.
  imports: [PlatformModule, PlatformServicesModule, EmailModule],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule implements OnModuleInit {
  private readonly logger = new Logger(AnnouncementsModule.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly announcements: AnnouncementsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('notifications', jobTypes.ANNOUNCEMENT_PUBLISH, (context) =>
      this.announcements.publishFromJob(context),
    );
    this.logger.log('announcement.publish handler registered on the notifications queue');
  }
}
