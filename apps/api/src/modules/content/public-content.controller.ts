import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import {
  publicHelpFeedbackSchema,
  publicHelpQuerySchema,
  publicPostsQuerySchema,
  type ContentBanner,
  type ContentPageDetail,
  type ContentSitemapRow,
  type ListEnvelope,
  type PublicFaq,
  type PublicHelpArticle,
  type PublicHelpFeedback,
  type PublicHelpFeedbackResult,
  type PublicHelpMeta,
  type PublicPost,
  type PublicSite,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { Public } from '../platform/decorators/public.decorator.js';
import { RateLimit } from '../platform/decorators/rate-limit.decorator.js';

import { ContentService } from './content.service.js';

/**
 * P-M1 · P-M2 · P-M5 — الواجهة العامة للموقع التسويقي.
 *
 * تسعة مسارات بلا جلسة، وثمانيةٌ منها **قراءة**: إعدادات الموقع، وقوائمه، ولافتته، وصفحةٌ
 * منشورة، وقائمة مقالات، ومركز مساعدة (قائمةً ومقالاً)، وأسئلة شائعة، وخريطة الموقع.
 * والزائر لا يكتب شيئاً هنا إلا **صوتاً واحداً** (P-M9): `POST public/help/:slug/feedback`
 * «هل أفادك هذا؟» — كتابةٌ واحدة لا تحمل هوية، عليها دلوُ المعدّل نفسه الذي على الاستمارات.
 *
 * والقاعدة الحاكمة: **`@Public()` لا تعني بلا عزل**. الخدمة تفتح معاملة بسياق المنصّة ثم
 * تُصفّي بـ`publishedWhere`، فالمسوّدة والمجدولة غير موجودتين من هنا بنيوياً — ويقيس ذلك
 * `apps/api/test/public-content.spec.ts` و`scripts/verify-content.mjs`.
 */
@ApiTags('public-content')
@Controller('public')
export class PublicContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get('site')
  @ApiOperation({ summary: 'هوية الموقع وقوائمه ولافتته المعروضة (نداءٌ واحد للقشرة)' })
  @ApiOkResponse({ description: 'Site identity, menus and the live banner' })
  async site(): Promise<{ data: PublicSite }> {
    return { data: await this.content.publicSite() };
  }

  @Public()
  @Get('sitemap')
  @ApiOperation({ summary: 'خريطة الموقع: مسارات المنشور فقط بلغاتها' })
  async sitemap(): Promise<{ data: ContentSitemapRow[] }> {
    return { data: await this.content.publicSitemap() };
  }

  @Public()
  @Get('posts')
  @ApiQuery({ name: 'kind', required: false, description: 'post (default) · case_study · …' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOperation({ summary: 'المحتوى المسرود المنشور: المدوّنة افتراضاً، ودراسات الحالة بترشيح النوع' })
  async posts(
    @Query(new ZodValidationPipe(publicPostsQuerySchema)) query: PublicPostsQueryShape,
  ): Promise<ListEnvelope<PublicPost>> {
    return this.content.publicPosts(query);
  }

  @Public()
  @Get('help')
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOperation({ summary: 'مقالات مركز المساعدة، مع بحثٍ في العنوان والملخّص، وفئاتُها في الغلاف' })
  async help(
    @Query(new ZodValidationPipe(publicHelpQuerySchema)) query: PublicHelpQueryShape,
  ): Promise<ListEnvelope<PublicPost> & { meta: PublicHelpMeta }> {
    return this.content.publicHelp(query);
  }

  /**
   * **`help/:slug` بعد `help` مباشرةً وقبل المسارات الأخرى** — الترتيب في Nest هو ترتيب
   * بناء الجداول، ومسارٌ عامّ (`:slug`) يسبق مساراً ثابتاً يبتلعه بصمت.
   *
   * والمسار لا يخدم إلا مقالات `help` المنشورة: مقالٌ من نوعٍ آخر أو مسوّدة يسقطان 404 من
   * الخدمة قبل قراءة الكتل — فالرسالة نفسها للمسوّدة ولغير الموجود، ولا يصير المسار أداةَ
   * استكشاف (`public-content.spec.ts` يقيس ذلك).
   */
  @Public()
  @Get('help/:slug')
  @ApiParam({ name: 'slug', description: 'رابط المقال (غير المنشور وغير الـhelp يُردّان 404)' })
  @ApiOperation({ summary: 'مقالُ مساعدةٍ منشور بكتله وفئته ومقالاتٍ مجاورة وعدّادَي التصويت' })
  async helpArticle(@Param('slug') slug: string): Promise<{ data: PublicHelpArticle }> {
    return { data: await this.content.publicHelpArticle(slug) };
  }

  /**
   * **صوت «هل أفادك هذا؟»** — الكتابة الوحيدة في هذه الواجهة.
   *
   * ودلو `public-help-feedback` منفصلٌ عن `public-form` (الاستمارات) وعن `public-verify`:
   * زرُّ تصويتٍ في صفحة مقال ليس استمارةَ طلبِ عرض، ولو شاركا دلوَ واحداً لأغلق سيلُ أحدهما
   * بابَ الآخر. والحدّ نفسه (`RATE_LIMIT_PUBLIC_FORM_PER_MINUTE`) لأن الفعل بلا حساب ولا
   * انتظار، ويُعاد 200 مع `recorded:false` لمن أعاد التصويت من المتصفّح نفسه.
   */
  @Public()
  @Post('help/:slug/feedback')
  @HttpCode(200)
  @RateLimit({ name: 'public-help-feedback', limit: env.RATE_LIMIT_PUBLIC_FORM_PER_MINUTE, windowMs: 60_000 })
  @ApiBody({ description: '{ helpful: boolean, visitor: uuid } — و`visitor` معرّف متصفّحٍ عشوائي' })
  @ApiOperation({ summary: 'تسجيل صوت «هل أفادك هذا؟» — صوتٌ واحد لكل مقالٍ لكل متصفّح' })
  async helpFeedback(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(publicHelpFeedbackSchema)) body: PublicHelpFeedback,
  ): Promise<{ data: PublicHelpFeedbackResult }> {
    return { data: await this.content.recordHelpFeedback(slug, body) };
  }

  @Public()
  @Get('faq')
  @ApiOperation({ summary: 'الأسئلة الشائعة مسطَّحة من كتل الصفحات المنشورة (وJSON-LD منها)' })
  async faq(): Promise<{ data: PublicFaq[] }> {
    return { data: await this.content.publicFaq() };
  }

  @Public()
  @Get('banners')
  @ApiOperation({ summary: 'اللافتات المعروضة الآن' })
  async banners(): Promise<{ data: ContentBanner[] }> {
    return { data: await this.content.publicBanners() };
  }

  @Public()
  @Get('content/:slug')
  @ApiParam({ name: 'slug', description: 'رابط الصفحة (المسوّدة والمجدولة تُردّ 404)' })
  @ApiOperation({ summary: 'صفحةٌ منشورة بكتلها' })
  async page(@Param('slug') slug: string): Promise<{ data: ContentPageDetail }> {
    return { data: await this.content.publicPage(slug) };
  }
}

type PublicPostsQueryShape = Parameters<ContentService['publicPosts']>[0];
type PublicHelpQueryShape = Parameters<ContentService['publicHelp']>[0];
