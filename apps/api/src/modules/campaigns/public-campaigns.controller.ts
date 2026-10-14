import { Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import { campaignMessageToken } from '@erp/contracts';
import type { Response } from 'express';

import { Public } from '../platform/decorators/public.decorator.js';
import { RateLimit } from '../platform/decorators/rate-limit.decorator.js';

import { CampaignsService } from './campaigns.service.js';

/** بكسلٌ شفّاف 1×1 (GIF): أخفّ ما يُحمَّل، ويعمل في كل عميل بريد. */
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * P-M7 — مسارات الحملة العامّة: الفتح والنقر وإلغاء الاشتراك.
 *
 * **ثلاثة أبوابٍ تُفتَح من بريدٍ لا من متصفّح جلسة**، ولذلك ثلاثة حرّاس ظاهرة هنا:
 *
 *   1. **الرمز هو التصريح**: ٢٥٦-بت عشوائيّة، مخزَّنٌ sha256 منها، ولا يُعاد في أي استجابة.
 *      ومن لا يملكه لا يستطيع تسجيل فتحٍ ولا نقرةٍ ولا إلغاءِ اشتراكِ غيره.
 *   2. **لا تحويل مفتوح**: وجهة النقرة تُقرأ من صفّ الرسالة بترتيبها (`:index`)، فلا يستطيع
 *      أحدٌ أن يجعل نطاق المنصّة يُحوّل إلى موقعٍ خارجي — ونقرةٌ إلى وجهةٍ ليست في الحملة 404.
 *   3. **محدّد معدّل** على دلو `campaign-track`: عملاء البريد تحمّل البكسل آليّاً، فالسقف
 *      أعلى من سقف الاستمارات (`RATE_LIMIT_CAMPAIGN_TRACK_PER_MINUTE`) — والكتابة محدودة
 *      أصلاً بالفهارس الفريدة لكل حدث.
 *
 * والإلغاء يقبل `GET` (من رابط البريد) و`POST` (نقرة العميل الواحدة، RFC 8058): العميل الذي
 * يعرض زرّ «إلغاء الاشتراك» يرسل POST إلى الترويسة نفسها، ويجب أن يُقبَل بلا صفحةٍ وسيطة.
 */
@ApiTags('public-campaigns')
@Controller('public')
export class PublicCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Public()
  @Get('track/open/:token')
  @Header('Content-Type', 'image/gif')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  @Header('Pragma', 'no-cache')
  @RateLimit({ name: 'campaign-track', limit: env.RATE_LIMIT_CAMPAIGN_TRACK_PER_MINUTE, windowMs: 60_000 })
  @ApiParam({ name: 'token', description: 'رمز الرسالة (٣٢ بايتاً بصيغة base64url)' })
  @ApiOperation({
    summary: 'بكسل الفتح (يُعاد GIF شفّاف دائماً)',
    description:
      'يُسجَّل الفتح **الأوّل** مرّةً واحدة، وتُعاد الصورة في كل حال — ومنعُ الصور في عميل ' +
      'البريد يعني «لم يُعرف» لا «لم يُقرأ»، وهذا ما يقوله التقرير.',
  })
  @ApiOkResponse({ description: 'A 1×1 transparent GIF' })
  async open(@Param('token') token: string, @Res({ passthrough: true }) response: Response): Promise<Buffer> {
    if (campaignMessageToken(token)) {
      // لا ننتظر التسجيل: بكسلٌ يُبطئ عرض الرسالة أسوأ من فتحٍ يُسجَّل بعد ميلي ثانية.
      await this.campaigns.trackOpen(token).catch(() => undefined);
    }
    response.setHeader('Content-Length', String(TRANSPARENT_GIF.length));
    return TRANSPARENT_GIF;
  }

  @Public()
  @Get('track/click/:token/:index')
  @RateLimit({ name: 'campaign-track', limit: env.RATE_LIMIT_CAMPAIGN_TRACK_PER_MINUTE, windowMs: 60_000 })
  @ApiParam({ name: 'token', description: 'رمز الرسالة' })
  @ApiParam({ name: 'index', description: 'ترتيب الوجهة داخل روابط الحملة' })
  @ApiOperation({
    summary: 'تتبّع النقرة ثم التوجيه إلى الوجهة (302)',
    description:
      'الوجهة تُقرأ من صفّ الرسالة لا من الرابط: لا تحويلَ مفتوحاً. ونقرةٌ إلى وجهةٍ ليست في ' +
      'الحملة، أو برمزٍ مجهول ⇒ 404.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the campaign link' })
  @ApiResponse({ status: 404, description: 'رمزٌ أو وجهةٌ غير معروفة (NOT_FOUND)' })
  async click(
    @Param('token') token: string,
    @Param('index', new ParseIntPipe()) index: number,
    @Res() response: Response,
  ): Promise<void> {
    const target = await this.campaigns.trackClick(token, index);
    response.redirect(302, target);
  }

  @Public()
  @Get('unsubscribe/:token')
  @RateLimit({ name: 'campaign-track', limit: env.RATE_LIMIT_CAMPAIGN_TRACK_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'إلغاء الاشتراك من رابط البريد',
    description:
      'يُسجِّل حجراً في `email_suppressions` فيمنع **كل** بريدٍ لاحق لهذا العنوان لا هذه ' +
      'الحملة وحدها، ويُعلّم المشترك `unsubscribed` إن كان في النشرة. و idempotent: الفتحة ' +
      'الثانية لا تغيّر شيئاً.',
  })
  @ApiOkResponse({ description: 'The address is suppressed' })
  @ApiResponse({ status: 404, description: 'رابطٌ غير معروف (NOT_FOUND)' })
  async unsubscribe(@Param('token') token: string) {
    const outcome = await this.campaigns.unsubscribe(token);
    return {
      data: {
        email: outcome.email,
        unsubscribed: true,
        // «fresh: false» = كان ملغى من قبل — والجواب واحد حتى لا يصير المسار أداة سرد.
        message: outcome.fresh
          ? 'أُلغي اشتراكك، ولن تصلك رسائل تسويقية بعد اليوم.'
          : 'هذا العنوان مُلغى الاشتراك من قبل — لا شيء يُغيَّر.',
      },
    };
  }

  @Public()
  @Post('unsubscribe/:token')
  @HttpCode(200)
  @RateLimit({ name: 'campaign-track', limit: env.RATE_LIMIT_CAMPAIGN_TRACK_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'نقرة الإلغاء الواحدة (RFC 8058 — List-Unsubscribe-Post)',
    description:
      'عميل البريد يرسل POST إلى `List-Unsubscribe` مُصرَّحاً بالنقرة الواحدة، ويجب أن يُقبَل ' +
      'بلا صفحةٍ وسيطة ولا تأكيد. والجواب 200 بلا نصّ كما تطلب التوصية.',
  })
  @ApiOkResponse({ description: 'One-click unsubscribe accepted' })
  async oneClick(@Param('token') token: string, @Res() response: Response): Promise<void> {
    await this.campaigns.unsubscribe(token);
    response.status(200).json({ data: { unsubscribed: true } });
  }
}
