import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import {
  PUBLIC_EVENTS_ACCEPTED_AR,
  publicEventsBatchSchema,
  type PublicEventsAccepted,
  type PublicEventsBatch,
} from '@erp/contracts';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { Public } from '../platform/decorators/public.decorator.js';
import { RateLimit } from '../platform/decorators/rate-limit.decorator.js';

import { SiteAnalyticsService } from './site-analytics.service.js';

/**
 * `/api/v1/public/events` — استقبال أحداث الموقع (P-M10).
 *
 * **ثلاثة قرارات في هذا الملف:**
 *
 *   1. **`202` لا `200`**: الحدث خُبِر وليس مطلوباً — الصفحة لا تنتظر جوابه ولا تتوقّف عليه،
 *      و`200` توحي بأن شيئاً اكتمل. والجسم يقول ما قُبل فقط (`accepted`).
 *   2. **الكتابة الوحيدة في الواجهة العامة بعد صوت المساعدة** — وهي كالصوت مستثناة من صفّ
 *      التدقيق: الصفّ يحمل عنوان الزائر ووسيط متصفّحه، وتدقيقه يحوّل «عددُ زيارة» إلى «سجلّ
 *      زائر» مقابل صفر فائدة (لا فاعلٌ يُسأل ولا قرارٌ يُبنى على الصف).
 *   3. **دلوٌ مستقلّ** (`public-events`): دفقُ أحداثٍ لا يجوز أن يُغلق بابَ التعاقد ولا صوتَ
 *      المساعدة — لكل سطحٍ سقفه، والدلو المشترك يجعل أسوأ عملٍ في الموقع يمنع أفضله.
 *
 * والمُحيل يُختصر هنا إلى **عائله** (`new URL(referer).host`) قبل أن يصل القاعدة: الرابط
 * الكامل يحمل معاملاتٍ ونصوص بحث، والعائل يكفي لسؤال «من أين جاء الزائر؟».
 */
@ApiTags('public-events')
@Controller('public')
export class PublicEventsController {
  constructor(private readonly analytics: SiteAnalyticsService) {}

  @Public()
  @Post('events')
  @HttpCode(202)
  @RateLimit({ name: 'public-events', limit: env.RATE_LIMIT_PUBLIC_EVENTS_PER_MINUTE, windowMs: 60_000 })
  @ApiBody({ description: '{ events: [{ name, path, locale, visitor, meta? }] } — دفعةٌ من ١ إلى ٢٠ حدثاً' })
  @ApiOperation({ summary: 'تسجيل دفعة أحداثٍ مجهولة من الموقع التسويقي' })
  @ApiResponse({ status: 202, description: 'قُبلت الأحداث (بلا إرجاع ما كُتب)' })
  @ApiResponse({ status: 400, description: 'حدثٌ خارج العقد (VALIDATION_FAILED)' })
  @ApiResponse({ status: 429, description: 'تجاوز حدّ المعدّل (RATE_LIMITED)' })
  async events(
    @Body(new ZodValidationPipe(publicEventsBatchSchema)) body: PublicEventsBatch,
    @Req() request: Request,
  ): Promise<{ data: PublicEventsAccepted; messageAr: string }> {
    const accepted = await this.analytics.record(body, referrerHostOf(request));
    return { data: { accepted }, messageAr: PUBLIC_EVENTS_ACCEPTED_AR };
  }
}

/** عائلُ المُحيل وحده — أو `null` إن لم يكن ثمّة مُحيل أو كان رابطاً غير صالح. */
function referrerHostOf(request: Request): string | null {
  const header = request.headers.referer ?? request.headers.referrer;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length > 500) return null;
  try {
    const host = new URL(value).host.trim().toLowerCase();
    return host.length > 0 && host.length <= 120 ? host : null;
  } catch {
    return null;
  }
}
