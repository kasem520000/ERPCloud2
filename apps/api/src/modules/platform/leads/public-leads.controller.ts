import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import {
  leadCreateSchema,
  subscriberCreateSchema,
  type LeadAccepted,
  type LeadCreate,
  type SubscriberAccepted,
  type SubscriberConfirm,
  type SubscriberCreate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { Public } from '../decorators/public.decorator.js';
import { RateLimit } from '../decorators/rate-limit.decorator.js';

import { LeadsService } from './leads.service.js';

/**
 * `/api/v1/public` — استمارات الموقع التسويقي (P-M6): تواصل · طلب عرض · نشرة بريدية.
 *
 * **ثلاثة أبواب تكتب بلا جلسة**، وهذا أخطر ما في الموقع: كلٌّ منها يُنشئ صفّاً ويُرسل بريداً.
 * فحمايتها ثلاث طبقات، وكلٌّ منها هنا ظاهرة لا مخفيّة:
 *
 *   1. **مصيدة** (honeypot) — حقلٌ مخفيّ في الاستمارة (`website`) لا يملؤه إنسان. الطلب الذي
 *      يملؤه يُقابَل بـ202 و**لا يُكتب له صفّ** ولا يُرسل له بريد: لا نُعلّم الآلة أنها كُشِفت.
 *   2. **محدّد معدّل** على دلو `public-form` لكل عنوان IP — وحمايةُ البريد المزعج في الخطة
 *      تقول إن الدلو يصير مشتركاً بين الأسطح بعد نقل محدّد المعدّل إلى Redis
 *      (`INCOMPLETE_INVENTORY.md` §5)، فاليوم هو محدّد المعدّل نفسه المستعمل للدخول.
 *   3. **القيد الفريد** في القاعدة (`leads_dedupe_key_key`): عنوانٌ واحد = طلبٌ واحد، مهما
 *      تكرّرت المحاولات حول محدّد المعدّل.
 *
 * والجواب **لا يكشف شيئاً**: `202` مع مرجعٍ قصير — سواءٌ سُجّل الطلب أو كان عنوانه مسجَّلاً من
 * قبل (فيُقرأ: أُلحقت رسالته ملاحظةً، ولصاحبه مرجعُه القديم). ولا يُعاد رمزُ تأكيد النشرة أبداً:
 * يذهب بالبريد وحده، ومخزَّنٌ مُجزَّأً (sha256).
 */
@ApiTags('public-leads')
@Controller('public')
export class PublicLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Public()
  @Post('leads')
  @HttpCode(202)
  @RateLimit({ name: 'public-form', limit: env.RATE_LIMIT_PUBLIC_FORM_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'استمارة تواصل أو طلب عرض (بلا جلسة)',
    description:
      'يُقبَل الطلب بـ202 ويُعاد مرجعٌ قصير يُقال للزائر. والحقل المخفيّ `website` مصيدة: ' +
      'من يملؤه لا يُكتب له صفّ. والعنوان المكرَّر لا يُنشئ طلباً ثانياً — تُلحَق رسالته ' +
      'ملاحظةً على الطلب القائم.',
  })
  @ApiAcceptedResponse({ description: 'Lead accepted (or silently discarded as automated)' })
  @ApiResponse({ status: 422, description: 'حقلٌ ناقص أو غير صالح (VALIDATION_FAILED)' })
  @ApiResponse({ status: 429, description: 'تجاوز حدّ المعدّل (RATE_LIMITED)' })
  async create(@Body(new ZodValidationPipe(leadCreateSchema)) body: LeadCreate): Promise<{ data: LeadAccepted }> {
    return { data: await this.leads.capture(body) };
  }

  @Public()
  @Post('subscribe')
  @HttpCode(202)
  @RateLimit({ name: 'public-form', limit: env.RATE_LIMIT_PUBLIC_FORM_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'الاشتراك في النشرة البريدية (تأكيدٌ مزدوج)',
    description:
      'يُرسل رابطُ تأكيدٍ إلى العنوان، ولا يُضاف أحدٌ إلى القائمة قبل فتحه. والجواب واحد ' +
      'للمشترك الجديد والمؤكَّد من قبل — فلا يصير الحقل أداةَ تحقّقٍ من العناوين.',
  })
  @ApiAcceptedResponse({ description: 'طلب اشتراكٍ مسجَّل (أو تأكيدٌ سابق)' })
  async subscribe(
    @Body(new ZodValidationPipe(subscriberCreateSchema)) body: SubscriberCreate,
  ): Promise<{ data: SubscriberAccepted }> {
    return { data: await this.leads.subscribe(body) };
  }

  @Public()
  @Get('subscribe/confirm/:token')
  @RateLimit({ name: 'public-form', limit: env.RATE_LIMIT_PUBLIC_FORM_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'تأكيد الاشتراك من رابط البريد',
    description: 'يُفتح الرابط من الرسالة فيُؤكَّد العنوان. والتأكيد idempotent: الفتحة الثانية لا تغيّر شيئاً.',
  })
  @ApiOkResponse({ description: 'Subscription confirmed' })
  @ApiResponse({ status: 404, description: 'رابطٌ غير معروف أو استُبدل بغيره (NOT_FOUND)' })
  async confirm(@Param('token') token: string): Promise<{ data: SubscriberConfirm }> {
    return { data: await this.leads.confirmSubscription(token) };
  }
}
