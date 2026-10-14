import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  DomainError,
  emailLocaleSchema,
  emailMessageListQuerySchema,
  emailSettingsUpdateSchema,
  emailTestSendSchema,
  errorCodes,
  isEmailEvent,
  tenantEmailTemplateUpdateSchema,
  type EmailMessageListResponse,
  type EmailSettings,
  type EmailTemplateListResponse,
  type EmailTestResult,
  type EmailTestSend,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { EmailService } from './email.service.js';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailTemplatesService } from './email-templates.service.js';

/**
 * P-C6 — البريد في سطح العميل: نصوصه، سجلّه، وهُويته.
 *
 * قاعدتان تحكمان هذا المتحكّم:
 *
 * 1. **المستأجر يأتي من الرمز لا من الطلب.** لا `tenantId` في أي جسم أو استعلام هنا؛ كل
 *    نداء يقرأ `getTenantContext().tenantId`، فالعزل في القاعدة (RLS) لا في الشاشة.
 * 2. **لا كود يُكتب من الشاشة** — وهذا ما تقوله الخطة حرفياً («تجاوز لكل مستأجر: نصّه فقط»).
 *    لذلك الحدث في المسار، واللغة في الاستعلام، والجسم نصّان. وقائمة الأحداث تأتي من الفهرس
 *    في الكود لا من جدول، فعميلٌ لا يستطيع اختراع حدثٍ يُنشئ له قالباً.
 */
@ApiTags('email')
@ApiBearerAuth()
@Controller('email')
export class EmailController {
  constructor(
    private readonly email: EmailService,
    private readonly templates: EmailTemplatesService,
    private readonly settings: EmailSettingsService,
  ) {}

  @Get('templates')
  @RequiresPermission('tenant.email.template.manage')
  @ApiQuery({ name: 'locale', required: false, description: 'ar (افتراضاً) أو en' })
  @ApiOperation({ summary: 'قوالب منشأتي الفعّالة — نصّ المنصة أو تجاوزي، ومن أين جاء' })
  @ApiOkResponse({ description: 'Effective templates for the calling tenant' })
  async listTemplates(
    @Query('locale', new ZodValidationPipe(emailLocaleSchema.optional())) locale?: 'ar' | 'en',
  ): Promise<EmailTemplateListResponse> {
    const tenant = getTenantContext();
    const data = await this.templates.effective(tenant.tenantId, { ...(locale ? { locale } : {}) });
    return {
      data,
      meta: {
        total: data.length,
        overridden: data.filter((template) => template.source === 'tenant').length,
        platformTexts: data.filter((template) => template.source !== 'tenant').length,
      },
    };
  }

  @Put('templates/:event')
  @RequiresPermission('tenant.email.template.manage')
  @ApiQuery({ name: 'locale', required: false, description: 'ar (افتراضاً) أو en' })
  @ApiOperation({ summary: 'كتابة تجاوزي على نصّ حدثٍ بعينه (النصّ وحده، بلا كود)' })
  @ApiOkResponse({ description: 'Tenant override saved' })
  async updateTemplate(
    @Param('event') event: string,
    @Body(new ZodValidationPipe(tenantEmailTemplateUpdateSchema))
    body: { subject?: string | null; body?: string | null; reason?: string },
    @Query('locale', new ZodValidationPipe(emailLocaleSchema.optional())) locale?: 'ar' | 'en',
  ): Promise<{ data: Awaited<ReturnType<EmailTemplatesService['upsertTenantOverride']>> }> {
    if (!isEmailEvent(event)) {
      throw new DomainError(errorCodes.NOT_FOUND, `حدث بريدٍ غير معروف: ${event}`, 404);
    }
    const tenant = getTenantContext();
    return {
      data: await this.templates.upsertTenantOverride(tenant.tenantId, event, locale ?? 'ar', body),
    };
  }

  @Get('messages')
  @RequiresPermission('tenant.email.log.view')
  @ApiQuery({ name: 'event', required: false, description: 'حدثٌ واحد' })
  @ApiQuery({ name: 'status', required: false, description: 'queued · sent · failed · suppressed · bounced' })
  @ApiQuery({ name: 'search', required: false, description: 'بحثٌ في العنوان والموضوع' })
  @ApiOperation({ summary: 'رسائل منشأتي (بلا رسائل العملاء الآخرين، ولا رسائل اختبار المنصة)' })
  @ApiOkResponse({ description: 'Paged message log of the calling tenant' })
  async listMessages(
    @Query(new ZodValidationPipe(emailMessageListQuerySchema))
    query: Parameters<EmailService['list']>[0],
  ): Promise<EmailMessageListResponse> {
    const tenant = getTenantContext();
    // المرشّحات تُنسخ حقلَ حقلٍ عمداً، والمرشّح `tenantId` **غائب من هذه القائمة**: العميل لا
    // يطلب رسائل عميلٍ آخر، والعزل أصلاً في `withTenantTx`. وغيابُه من النسخ ليس سهواً.
    const { event, status, search, limit, offset } = query;
    return this.email.list(
      { event, status, search, limit, offset } as Parameters<EmailService['list']>[0],
      { tenantId: tenant.tenantId },
    );
  }

  @Get('settings')
  @RequiresPermission('tenant.email.log.view')
  @ApiOperation({ summary: 'هوية المُرسِل الفعّالة لمنشأتي (وما ورثته من المنصة)' })
  @ApiOkResponse({ description: 'Effective e-mail settings for the calling tenant' })
  async getSettings(): Promise<{ data: EmailSettings }> {
    const tenant = getTenantContext();
    return { data: await this.settings.effective(tenant.tenantId) };
  }

  @Put('settings')
  @RequiresPermission('tenant.email.template.manage')
  @ApiOperation({ summary: 'تعديل اسم المُرسِل وعنوانه والسقفين — بلا تبديل المزوّد' })
  @ApiOkResponse({ description: 'Tenant sender identity updated' })
  async updateSettings(
    @Body(new ZodValidationPipe(emailSettingsUpdateSchema))
    body: Record<string, unknown> & { reason?: string },
  ): Promise<{ data: EmailSettings }> {
    // تبديل المزوّد قرار منصّة (اعتمادات SMTP في بيئة الخادم)، فلا يُمرَّر من سطح العميل —
    // رفضٌ صريح لا تجاهلٌ صامت: من أرسل الحقل يجب أن يعرف أنه لم يُطبَّق.
    if (body.provider !== undefined) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'مزوّد البريد يُختار من المنصة — راجع الدعم لتغييره',
        422,
        { field: 'provider' },
      );
    }
    const { reason, ...patch } = body;
    const tenant = getTenantContext();
    return {
      data: await this.settings.update(
        tenant.tenantId,
        patch as Parameters<EmailSettingsService['update']>[1],
        reason,
      ),
    };
  }

  @Put('settings/provider')
  @RequiresPermission('tenant.email.template.manage')
  @ApiOperation({ summary: 'تكوين مزوّد البريد الخاص بالمنشأة (Resend / SMTP / HTTP / Console)' })
  @ApiOkResponse({ description: 'Tenant email provider settings updated' })
  async updateProviderSettings(
    @Body(new ZodValidationPipe(emailSettingsUpdateSchema))
    body: Record<string, unknown> & { reason?: string },
  ): Promise<{ data: EmailSettings }> {
    const { reason, ...patch } = body;
    const tenant = getTenantContext();
    return {
      data: await this.settings.update(
        tenant.tenantId,
        patch as Parameters<EmailSettingsService['update']>[1],
        reason,
      ),
    };
  }

  @Post('settings/test')
  @HttpCode(200)
  @RequiresPermission('tenant.email.template.manage')
  @ApiOperation({ summary: 'إرسال رسالة بريد تجريبية للتحقق من إعدادات المزوّد' })
  @ApiOkResponse({ description: 'Test email sent or queued' })
  async sendTestEmail(
    @Body(new ZodValidationPipe(emailTestSendSchema)) body: EmailTestSend,
  ): Promise<{ data: EmailTestResult }> {
    const tenant = getTenantContext();
    return {
      data: await this.email.testSettings({
        to: body.to,
        locale: body.locale ?? 'ar',
        tenantId: tenant.tenantId,
      }),
    };
  }
}
