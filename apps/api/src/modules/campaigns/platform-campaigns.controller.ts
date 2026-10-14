import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  campaignCancelSchema,
  campaignCreateSchema,
  campaignListQuerySchema,
  campaignPatchSchema,
  campaignScheduleSchema,
  campaignSegments,
  campaignStatuses,
  campaignTestSchema,
  idParamSchema,
  type CampaignCancel,
  type CampaignCreate,
  type CampaignDispatch,
  type CampaignListQuery,
  type CampaignPatch,
  type CampaignReport,
  type CampaignSchedule,
  type CampaignSegmentInfo,
  type CampaignTest,
  type CampaignTestResult,
  type CampaignView,
  type IdParam,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { CampaignsService } from './campaigns.service.js';

/**
 * P-M7 — الحملات البريدية في لوحة المنصّة.
 *
 * **رمزٌ واحد** (`console.campaigns.manage`) على كل مسارٍ هنا، وسببُه مكتوب في العقد: من
 * يقرأ لوحة الحملات يقرأ قائمةَ أشخاصٍ حقيقيين بعناوينهم وتقارير فتحهم — ولا معنى لقراءةٍ
 * بلا قرار إرسال. ومن لا يحمله لا يرى `/campaigns` في الشريط ولا يفتح مساراً منها، والحاكم
 * الـAPI لا الشاشة.
 *
 * ومساران **غير مقيَّدين بمعرّف حملة** يأتيان أوّلاً في الترتيب (`segments`) لأن `:id` في
 * نهاية الملف يبتلعهما — ترتيبُ التعريف في NestJS هو ترتيبُ المطابقة.
 */
@ApiTags('platform-campaigns')
@ApiBearerAuth()
@Controller('platform/campaigns')
@UseGuards(PlatformAdminGuard)
export class PlatformCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiQuery({ name: 'status', required: false, enum: campaignStatuses })
  @ApiQuery({ name: 'segment', required: false, enum: campaignSegments })
  @ApiQuery({ name: 'q', required: false, description: 'بحثٌ في اسم الحملة وعنوانها' })
  @ApiOperation({
    summary: 'الحملات وعدّاداتها',
    description:
      'مرتّبةً بالمُرسَل أوّلاً ثم المجدولة: سؤالُ المشغّل «ما الذي يخرج الآن؟». ومعها عدّادات ' +
      'كل حالة. **وقبل القراءة نبضةُ مسحٍ** للحملات المجدولة التي حان وقتها — فبيئةٌ بلا عامل ' +
      'تُرسل حملاتها المجدولة من هنا.',
  })
  @ApiOkResponse({ description: 'Campaigns with per-status counts' })
  async list(@Query(new ZodValidationPipe(campaignListQuerySchema)) query: CampaignListQuery) {
    return this.campaigns.list(query);
  }

  @Get('segments')
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'الشرائح وأعدادها الحقيقية',
    description:
      'ستة شرائح بأعدادٍ تُقرأ من الجداول الآن — لا تقدير: الشاشة تقول كم سيصل. وكل شريحة ' +
      'معلومٌ فيها أهي «أشخاص» (تسويقٌ بموافقة) أم «حسابات» (رسالة خدمة).',
  })
  @ApiOkResponse({ description: 'Segments with live counts' })
  async segments(): Promise<{ data: CampaignSegmentInfo[] }> {
    return { data: await this.campaigns.segments() };
  }

  @Post()
  @HttpCode(201)
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'إنشاء حملة (مسوّدة)',
    description:
      'الحملة تُولد مسوّدة: تُكتب ثم تُراجَع ثم تُجدَّل. ومتغيّرٌ غير معروف في النصّ يُرفض ' +
      'من الآن (`CAMPAIGN_BODY_INVALID`) — فلا تُحفظ مسوّدةٌ لا يمكن إرسالها.',
  })
  @ApiCreatedResponse({ description: 'The created draft' })
  @ApiResponse({ status: 422, description: 'نصٌّ فيه متغيّرٌ غير معروف (CAMPAIGN_BODY_INVALID)' })
  async create(
    @Body(new ZodValidationPipe(campaignCreateSchema)) body: CampaignCreate,
  ): Promise<{ data: CampaignView }> {
    return { data: await this.campaigns.create(body) };
  }

  @Get(':id')
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({ summary: 'الحملة بنصّها وروابطها وأرقامها' })
  @ApiResponse({ status: 404, description: 'الحملة غير موجودة (NOT_FOUND)' })
  async detail(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: CampaignView }> {
    return { data: await this.campaigns.detail(params.id) };
  }

  @Patch(':id')
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'تعديل حملةٍ لم يبدأ إرسالها',
    description: 'من `sending` فصاعداً لا تعديل: النصّ الذي خرج نصٌّ خرج (CAMPAIGN_LOCKED).',
  })
  @ApiOkResponse({ description: 'The updated campaign' })
  @ApiResponse({ status: 422, description: 'حملةٌ مقفلة أو نصٌّ غير صالح (CAMPAIGN_LOCKED · CAMPAIGN_BODY_INVALID)' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(campaignPatchSchema)) body: CampaignPatch,
  ): Promise<{ data: CampaignView }> {
    return { data: await this.campaigns.update(params.id, body) };
  }

  @Post(':id/schedule')
  @HttpCode(200)
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'جدولة الإرسال أو إرساله الآن',
    description:
      '`scheduledAt` وقتٌ صريح (بتوقيت الخادم)، و`null` يعني **الإرسال الآن**. وقبل أي كتابة: ' +
      'النصّ صالح والشريحة فيها أحد — وإلا فـ422 لا حملةٌ إلى صفر.',
  })
  @ApiOkResponse({ description: 'The scheduled (or now-sending) campaign' })
  @ApiResponse({ status: 422, description: 'شريحةٌ فارغة أو نصٌّ غير صالح أو حملةٌ مقفلة' })
  async schedule(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(campaignScheduleSchema)) body: CampaignSchedule,
  ): Promise<{ data: CampaignView }> {
    return { data: await this.campaigns.schedule(params.id, body) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'إلغاء حملة (بسببٍ مكتوب)',
    description:
      'ما لم يخرج بعد يُوسَم «لم تُرسل» بسبب الإلغاء؛ وما خرج لا يُستدعى. والحملة المُرسلة لا ' +
      'تُلغى (`CAMPAIGN_LOCKED`): الإلغاء قرارٌ قبل النهاية لا بعدها.',
  })
  @ApiOkResponse({ description: 'The canceled campaign' })
  async cancel(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(campaignCancelSchema)) body: CampaignCancel,
  ): Promise<{ data: CampaignView }> {
    return { data: await this.campaigns.cancel(params.id, body) };
  }

  @Post(':id/send-test')
  @HttpCode(201)
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'إرسال نسخة اختبار إلى عنوانٍ واحد',
    description:
      'برمزٍ غير مسجَّل: **لا صفَّ في تقرير الحملة ولا حدث**، والرسالة موسومة تجربةً فلا ' +
      'تُحتسب على حصّة أحد. ومن جرّب نصّه لا يُفسد أرقام حملته.',
  })
  @ApiCreatedResponse({ description: 'The queued test message' })
  async sendTest(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(campaignTestSchema)) body: CampaignTest,
  ): Promise<{ data: CampaignTestResult }> {
    return { data: await this.campaigns.sendTest(params.id, body) };
  }

  @Post(':id/dispatch')
  @HttpCode(200)
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'دفعُ دفعةِ إرسالٍ يدوياً (استئناف)',
    description:
      'لحملةٍ توقّفت في المنتصف (خادمٌ أُعيد تشغيله بلا عامل). تُعاد بعدها المهمّة تلقائياً إن ' +
      'بقيت بقيّة، والقائمة تقرأ البقية من نفس تعريف الشريحة.',
  })
  @ApiOkResponse({ description: 'What this batch did' })
  async dispatch(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: CampaignDispatch }> {
    return { data: await this.campaigns.dispatch(params.id) };
  }

  @Get(':id/report')
  @RequiresPlatformRole('console.campaigns.manage')
  @ApiOperation({
    summary: 'تقرير الحملة: الأرقام والروابط والناس والأحداث',
    description:
      'أربعة أقسام: المجاميع (أُرسل · مُسلَّم · مفتوح · منقور · ملغٍ)، والروابط بترتيب نقراتها، ' +
      'وصفٌّ لكل مستلم بحالته، والأحداث الزمنية. وكلها من الصفوف لا من عدّادٍ في الذاكرة.',
  })
  @ApiOkResponse({ description: 'The campaign report' })
  async report(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: CampaignReport }> {
    return { data: await this.campaigns.report(params.id) };
  }
}
