import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  emailLocaleSchema,
  emailMessageListQuerySchema,
  emailSettingsUpdateSchema,
  emailSuppressionCreateSchema,
  emailRetrySchema,
  emailTestSendSchema,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
  uuidSchema,
  type EmailMessage,
  type EmailMessageListResponse,
  type EmailSettings,
  type EmailSuppression,
  type EmailTemplate,
  type EmailTemplateListResponse,
  type EmailTestResult,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';
import { EmailService } from '../../email/email.service.js';
import { EmailSettingsService } from '../../email/email-settings.service.js';
import { EmailTemplatesService } from '../../email/email-templates.service.js';

/**
 * P-C6 — «خدمة البريد» على مستوى المنصة: القوالب والسجلّ والإعدادات والحجر.
 *
 * الرمزان يفصلان ما يجب فصله: **القراءة** (`console.email.view`) لمن يتابع تسليم البريد —
 * الدعم والمدقّق — و**الكتابة** (`console.email.manage`) لمن يغيّر نصوصاً تُرسَل باسم المنصة
 * إلى عملاء حقيقيين: قالبٌ فيه خطأ مطبعيّ يخرج إلى كل العملاء، فليس قراراً يومياً للدعم.
 *
 * و`POST …/test` تحت رمز الكتابة أيضاً، لأن اختباره رسالةٌ تخرج فعلاً (إلى عنوانٍ يختاره
 * المشغّل) — وليست قراءةً.
 */
@ApiTags('platform-email')
@ApiBearerAuth()
@Controller('platform/email')
@UseGuards(PlatformAdminGuard)
export class PlatformEmailController {
  constructor(
    private readonly email: EmailService,
    private readonly templates: EmailTemplatesService,
    private readonly settings: EmailSettingsService,
  ) {}

  // ══════════════════════════════════════════════════ القوالب

  @Get('templates')
  @RequiresPlatformRole('console.email.view')
  @ApiQuery({ name: 'event', required: false, description: 'حدثٌ واحد من فهرس الأحداث الـ17' })
  @ApiQuery({ name: 'locale', required: false, description: 'ar أو en' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'تجاوزات عميلٍ بعينه' })
  @ApiOperation({ summary: 'القوالب الفعّالة لكل حدث (قالب المنصة أو تجاوز العميل)' })
  @ApiOkResponse({ description: 'Effective templates per event and locale' })
  async listTemplates(
    @Query('event', new ZodValidationPipe(emailMessageListQuerySchema.shape.event))
    event?: string,
    @Query('locale', new ZodValidationPipe(emailLocaleSchema.optional())) locale?: 'ar' | 'en',
    @Query('tenantId', new ZodValidationPipe(uuidSchema.optional())) tenantId?: string,
  ): Promise<EmailTemplateListResponse> {
    const data = await this.templates.effective(tenantId ?? null, {
      ...(event ? { event: event as never } : {}),
      ...(locale ? { locale } : {}),
    });
    // قائمةٌ تُعاد كما هي (بلا غلاف `{data}` ثانٍ) — نفس ما تفعله `/jobs/outbox`: الغلاف
    // نفسه هو الجسم، والقراءة من الشاشة `res.data` لا `res.data.data`.
    return { data, meta: { total: data.length, event: event ?? null, locale: locale ?? null } };
  }

  @Post('templates')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'قالبٌ جديد (صفٌّ عامّ، أو تجاوزٌ لعميل) — الموجود يُرفض بـ422' })
  @ApiOkResponse({ description: 'Template created' })
  async createTemplate(
    @Body(new ZodValidationPipe(emailTemplateCreateSchema)) body: {
      event: never;
      locale: 'ar' | 'en';
      subject: string;
      body: string;
      tenantId?: string | null;
      reason: string;
    },
  ): Promise<{ data: EmailTemplate }> {
    return { data: await this.templates.create(body) };
  }

  @Put('templates/:id')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'تحرير نصّ قالب (النسخة تزيد، والتدقيق يحفظ قبل/بعد)' })
  @ApiOkResponse({ description: 'Template updated' })
  async updateTemplate(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emailTemplateUpdateSchema))
    body: { subject: string; body: string; reason: string },
  ): Promise<{ data: EmailTemplate }> {
    return { data: await this.templates.update(id, body, { tenantId: null }) };
  }

  @Delete('templates/:id')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'حذف تجاوز عميل (يعود نصّ المنصة) — صفّ المنصة لا يُحذف' })
  @ApiOkResponse({ description: 'Override removed' })
  async clearOverride(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: EmailTemplate }> {
    return { data: await this.templates.clearOverride(id) };
  }

  @Post('templates/:id/test')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'إرسال الرسالة نفسها إلى عنوان اختبار — تُسجَّل بوسم «اختبار»' })
  @ApiOkResponse({ description: 'Test message delivered (or suppressed)' })
  async testTemplate(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emailTestSendSchema))
    body: { to: string; locale: 'ar' | 'en'; variables: Record<string, string | number> },
  ): Promise<{ data: EmailTestResult }> {
    return { data: await this.email.testTemplate(id, body) };
  }

  // ══════════════════════════════════════════════════ السجلّ

  @Get('messages')
  @RequiresPlatformRole('console.email.view')
  @ApiQuery({ name: 'tenantId', required: false, description: 'عميلٌ بعينه' })
  @ApiQuery({ name: 'event', required: false, description: 'حدثٌ واحد' })
  @ApiQuery({ name: 'status', required: false, description: 'queued · sent · failed · suppressed · bounced' })
  @ApiQuery({ name: 'search', required: false, description: 'بحثٌ في العنوان والموضوع' })
  @ApiOperation({ summary: 'سجلّ الرسائل (مرشَّحاً بالمستأجر والحدث والحالة والبحث)' })
  @ApiOkResponse({ description: 'Paged message log with per-status counts' })
  async listMessages(
    @Query(new ZodValidationPipe(emailMessageListQuerySchema))
    query: Parameters<EmailService['list']>[0],
  ): Promise<EmailMessageListResponse> {
    return this.email.list(query, { tenantId: null });
  }

  // 200 لا 201: إعادة المحاولة لا تُنشئ مورداً، بل تُرجع صفّاً قائماً إلى الطابور.
  @Post('messages/:id/retry')
  @HttpCode(200)
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'إعادة محاولة رسالة فاشلة أو متوقّفة الآن (لا يُعاد ما أُرسل)' })
  @ApiOkResponse({ description: 'Message queued again' })
  async retryMessage(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emailRetrySchema)) body: { reason: string },
  ): Promise<{ data: EmailMessage }> {
    return { data: await this.email.retry(id, body.reason) };
  }

  // ══════════════════════════════════════════════════ الإعدادات

  @Get('settings')
  @RequiresPlatformRole('console.email.view')
  @ApiOperation({ summary: 'إعدادات المُرسِل العامة (والمزوّد الفعّال)' })
  @ApiOkResponse({ description: 'Effective platform e-mail settings' })
  async getSettings(): Promise<{ data: EmailSettings }> {
    return { data: await this.settings.effective(null) };
  }

  @Put('settings')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'تعديل المُرسِل أو المزوّد أو السقفين — بلا إعادة نشر' })
  @ApiOkResponse({ description: 'Settings updated' })
  async updateSettings(
    @Body(new ZodValidationPipe(emailSettingsUpdateSchema))
    body: Parameters<EmailSettingsService['update']>[1] & { reason?: string },
  ): Promise<{ data: EmailSettings }> {
    const { reason, ...patch } = body as Record<string, unknown> & { reason?: string };
    return { data: await this.settings.update(null, patch, reason) };
  }

  @Post('settings/test')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'فحص اتصال: رسالةٌ واحدة بالمزوّد والإعدادات الحالية' })
  @ApiOkResponse({ description: 'Connection test result' })
  async testSettings(
    @Body(new ZodValidationPipe(emailTestSendSchema))
    body: { to: string; locale: 'ar' | 'en' },
  ): Promise<{ data: EmailTestResult }> {
    return { data: await this.email.testSettings({ to: body.to, locale: body.locale }) };
  }

  // ══════════════════════════════════════════════════ الحجر

  @Get('suppressions')
  @RequiresPlatformRole('console.email.view')
  @ApiOperation({ summary: 'قائمة الحجر (عامّة الصفوف + صفوف كل العملاء)' })
  @ApiOkResponse({ description: 'Suppression list' })
  async listSuppressions(): Promise<{ data: EmailSuppression[] }> {
    return { data: await this.email.suppressions({ tenantId: null }) };
  }

  @Post('suppressions')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'حجب عنوان (ارتداد · شكوى · إلغاء اشتراك · يدوي)' })
  @ApiOkResponse({ description: 'Address suppressed' })
  async addSuppression(
    @Body(new ZodValidationPipe(emailSuppressionCreateSchema))
    body: Parameters<EmailService['addSuppression']>[0],
  ): Promise<{ data: EmailSuppression }> {
    return { data: await this.email.addSuppression(body) };
  }

  @Delete('suppressions/:id')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'رفع الحجر (يُعيد العنوان إلى الإرسال)' })
  @ApiOkResponse({ description: 'Suppression removed' })
  async removeSuppression(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: { removed: true } }> {
    await this.email.removeSuppression(id);
    return { data: { removed: true } };
  }
}
