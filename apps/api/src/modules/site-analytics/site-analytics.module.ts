import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module.js';

import { PlatformSiteAnalyticsController } from './platform-site-analytics.controller.js';
import { PublicEventsController } from './public-events.controller.js';
import { SiteAnalyticsService } from './site-analytics.service.js';

/**
 * P-M10 — وحدة قياس الموقع.
 *
 * **وحدة واحدة بسطحين** كما في `ContentModule`: النقطة العامّة (‏`POST /public/events` بلا
 * جلسة) ولوحة المشغّل (‏`GET /platform/analytics/site` برمز التحليلات). والفصل بينهما كان
 * سيُنشئ خدمتين تقرآن الجدول نفسه وتختلفان في تعريف «زائر» — وهو بالضبط ما يجب أن يسكن
 * مكاناً واحداً.
 *
 * ولا `PlatformServicesModule` هنا: **لا تدقيق** في هذه الوحدة عمداً (صفّ التدقيق يحمل
 * عنوان الزائر، والأحداث مجهولة الهوية — والاستثناء مصرَّحٌ به في `audit.interceptor.ts`)،
 * ولا مهمّة طابور: الاحتفاظ يُنفَّذ عند الكتابة (لا يحتاج عاملاً).
 */
@Module({
  imports: [PlatformModule],
  controllers: [PublicEventsController, PlatformSiteAnalyticsController],
  providers: [SiteAnalyticsService],
})
export class SiteAnalyticsModule {}
