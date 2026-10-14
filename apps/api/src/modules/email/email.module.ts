import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { JobHandlerRegistry } from '../platform-services/jobs/job-handlers.js';

import { EmailController } from './email.controller.js';
import { EMAIL_MAILER_FACTORY, defaultEmailMailerFactory } from './email-mailer.factory.js';
import { EmailService } from './email.service.js';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailTemplatesService } from './email-templates.service.js';

/**
 * P-C6 — وحدة البريد: القوالب والإعدادات والمُرسِل، وسطح العميل (`/email`).
 *
 * **معالج الطابور يُسجَّل من هنا** لا من `PlatformJobHandlers`، ولهذا سببٌ مكتوب في
 * `job-handlers.ts` نفسه: «الوحدات اللاحقة تسجّل معالجاتها من إقلاعها بدل تعديل هذا الملف».
 * والتسجيل في `onModuleInit` يضمن أن مزوّد `EmailService` جاهز، وأن الإقلاع لا يمرّ بلا
 * معالجٍ لمهمّة `email.send` (وإلا لبقي كل بريدٍ في الطابور بلا مُسلِّم — صامتاً).
 *
 * الوحدة ليست `@Global` (خلاف `UsageModule`): لا أحد يسأل «هل أرسل بريداً؟» في منتصف مسار
 * كتابةٍ آخر اليوم. وحين تحتاجها وحدة أخرى — تفعيل الحساب أو الفاتورة — تُستورد صراحةً،
 * فيظهر الاعتماد في الوحدة المُستورِدة لا في الفراغ.
 * والمنصة تصل إليها عبر `PlatformModule` (يستوردها لمنح `PlatformEmailController` خدماته).
 */
@Module({
  controllers: [EmailController],
  providers: [
    EmailTemplatesService,
    EmailSettingsService,
    EmailService,
    // المصنّع يُحقَن بدل أن يُستدعى: الاختبار يستبدله بمُسلِّمٍ يفشل ليُثبت سلّم التراجع.
    { provide: EMAIL_MAILER_FACTORY, useValue: defaultEmailMailerFactory },
  ],
  exports: [EmailService, EmailTemplatesService, EmailSettingsService],
})
export class EmailModule implements OnModuleInit {
  private readonly logger = new Logger(EmailModule.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly email: EmailService,
  ) {}

  onModuleInit(): void {
    this.registry.register('notifications', jobTypes.EMAIL_SEND, (context) =>
      this.email.deliverFromJob(context),
    );
    this.logger.log('email.send handler registered on the notifications queue');
  }
}
