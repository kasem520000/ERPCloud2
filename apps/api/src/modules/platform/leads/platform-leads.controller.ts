import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  idParamSchema,
  leadConvertSchema,
  leadListQuerySchema,
  leadNoteCreateSchema,
  leadPatchSchema,
  subscriberListQuerySchema,
  subscriberStatuses,
  subscriberStatusUpdateSchema,
  type IdParam,
  type LeadConversion,
  type LeadConvert,
  type LeadListQuery,
  type LeadNoteCreate,
  type LeadNoteView,
  type LeadPatch,
  type LeadView,
  type SubscriberListQuery,
  type SubscriberStatusUpdate,
  type SubscriberView,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { LeadsService } from './leads.service.js';

/**
 * P-M6 — صندوق العملاء المتوقّعين في لوحة المنصّة.
 *
 * **سبعةُ مسارات** برمزين: **`console.leads.view`** يفتح الصندوق (الطلب وملاحظاته وأثره،
 * والمشتركون)، و**`console.leads.manage`** وحده يُنفّذ: الإسناد وتغيير الحالة والملاحظات
 * و**التحويل إلى منشأة** وإدارة حالة المشترك. والفصل ليس تنظيمياً: التحويل يُنشئ مستأجراً
 * ومديراً وترخيصاً بتجربة — أي يفتح باباً إلى النظام — فلا يملكه من يجيب على الاستفسار.
 *
 * ولا مسار حذف: الطابور سجلّ، والإلغاء حالةٌ (`rejected`) لها سببٌ مكتوب.
 */
@ApiTags('platform-leads')
@ApiBearerAuth()
@Controller('platform/leads')
@UseGuards(PlatformAdminGuard)
export class PlatformLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequiresPlatformRole('console.leads.view')
  @ApiQuery({ name: 'status', required: false, enum: ['new', 'contacted', 'qualified', 'won', 'rejected'] })
  @ApiQuery({ name: 'source', required: false, description: 'form | demo | newsletter | campaign | manual' })
  @ApiQuery({ name: 'assignedTo', required: false, description: 'معرّف مشغّل' })
  @ApiQuery({ name: 'unassigned', required: false, description: 'true = غير المُسنَد وحده' })
  @ApiQuery({ name: 'mine', required: false, description: 'true = المُسنَد إليّ' })
  @ApiQuery({ name: 'q', required: false, description: 'بحثٌ في الاسم والشركة والبريد والمرجع' })
  @ApiOperation({
    summary: 'طابور العملاء المتوقّعين',
    description:
      'مرتّبٌ بالمفتوح أوّلاً ثم بالأحدث، ومعه عدّادات كل حالة وعدد غير المُسنَد — فسؤال ' +
      '«كم طلباً جديداً لم يُتابع؟» يُجاب من الصفحة الأولى بلا نداءٍ ثانٍ.',
  })
  @ApiOkResponse({ description: 'Lead queue' })
  async list(@Query(new ZodValidationPipe(leadListQuerySchema)) query: LeadListQuery) {
    return this.leads.list(query);
  }

  @Get('subscribers')
  @RequiresPlatformRole('console.leads.view')
  @ApiQuery({ name: 'status', required: false, enum: subscriberStatuses })
  @ApiOperation({ summary: 'المشتركون في النشرة البريدية' })
  @ApiOkResponse({ description: 'Newsletter subscribers' })
  async subscribers(@Query(new ZodValidationPipe(subscriberListQuerySchema)) query: SubscriberListQuery) {
    return this.leads.listSubscribers(query);
  }

  @Patch('subscribers/:id')
  @RequiresPlatformRole('console.leads.manage')
  @ApiOperation({
    summary: 'تأكيد مشتركٍ يدوياً أو إلغاء اشتراكه',
    description: 'لا يُحذف صفّ: الحالة تتغيّر (`confirmed` · `unsubscribed`) واللحظة تُسجَّل.',
  })
  @ApiOkResponse({ description: 'The updated subscriber' })
  @ApiResponse({ status: 404, description: 'المشترك غير موجود (NOT_FOUND)' })
  async updateSubscriber(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(subscriberStatusUpdateSchema)) body: SubscriberStatusUpdate,
  ): Promise<{ data: SubscriberView }> {
    return { data: await this.leads.updateSubscriber(params.id, body.status) };
  }

  @Get(':id')
  @RequiresPlatformRole('console.leads.view')
  @ApiOperation({ summary: 'الطلب وملاحظاته وأثره' })
  @ApiResponse({ status: 404, description: 'الطلب غير موجود (LEAD_NOT_FOUND)' })
  async detail(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
    return { data: await this.leads.detail(params.id) };
  }

  @Patch(':id')
  @RequiresPlatformRole('console.leads.manage')
  @ApiOperation({
    summary: 'تغيير الحالة أو الإسناد',
    description:
      'الانتقالات محدودة كما في العقد: من `won` أو `rejected` لا رجوع — الحالة النهائية ' +
      'قرارٌ يبقى، والرجوع عنه ملاحظةٌ أو طلبٌ جديد.',
  })
  @ApiOkResponse({ description: 'The updated lead' })
  @ApiResponse({ status: 422, description: 'انتقالٌ غير مسموح (LEAD_STATUS_LOCKED)' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(leadPatchSchema)) body: LeadPatch,
  ): Promise<{ data: LeadView }> {
    return { data: await this.leads.update(params.id, body) };
  }

  @Post(':id/notes')
  @HttpCode(201)
  @RequiresPlatformRole('console.leads.manage')
  @ApiOperation({ summary: 'إضافة ملاحظة إلى الطلب' })
  @ApiCreatedResponse({ description: 'The stored note' })
  async note(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(leadNoteCreateSchema)) body: LeadNoteCreate,
  ): Promise<{ data: LeadNoteView }> {
    return { data: await this.leads.addNote(params.id, body) };
  }

  @Post(':id/convert')
  @HttpCode(201)
  @RequiresPlatformRole('console.leads.manage')
  @ApiOperation({
    summary: 'تحويل الطلب إلى منشأة (ومنحها فترة تجريبية)',
    description:
      'ينشئ المنشأة والمدير ودليل الحسابات، ويمنح ترخيصاً بحالة `trialing` مدّته من إعداد ' +
      '`billing.trial_days`، ويُغلق الطلب `won`. وكلمة المرور المؤقتة تُعاد **مرّةً واحدة** ' +
      'ولا تُخزَّن خاماً ولا تُرسل بالبريد.',
  })
  @ApiCreatedResponse({ description: 'Tenant, licence and the one-time temporary password' })
  @ApiResponse({ status: 409, description: 'الطلب حُوّل من قبل (LEAD_ALREADY_CONVERTED)' })
  @ApiResponse({ status: 422, description: 'رمز منشأةٍ مأخوذ أو باقةٌ مجهولة (VALIDATION_FAILED)' })
  async convert(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(leadConvertSchema)) body: LeadConvert,
  ): Promise<{ data: LeadConversion }> {
    return { data: await this.leads.convert(params.id, body) };
  }
}
