import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { siteAnalyticsDaysSchema, type SiteAnalytics } from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { SiteAnalyticsService } from './site-analytics.service.js';

/**
 * `/api/v1/platform/analytics/site` — قمعُ الموقع ونتائج أ/ب في اللوحة (P-M10).
 *
 * **ورمزٌ قائم لا جديد**: `console.analytics.view` (P-C12). وهذا اختيارٌ واعٍ: الرمز الجديد
 * يعني رمزاً يُنسى إدراجُه في الأدوار، ويعني أن مدقّقاً يرى إيراد المنصّة ولا يرى قمعَ
 * موقعها — وهو تفريقٌ لا يخدم أحداً. والقراءة هنا **بلا تعديل**: كل نهايات الملف `GET`،
 * ولا مسار فيه يكتب صفّاً (والأحداث تكتبها نقطةٌ عامّة).
 */
@ApiTags('platform-site-analytics')
@ApiBearerAuth()
@Controller('platform/analytics')
@UseGuards(PlatformAdminGuard)
export class PlatformSiteAnalyticsController {
  constructor(private readonly analytics: SiteAnalyticsService) {}

  @Get('site')
  @RequiresPlatformRole('console.analytics.view')
  @ApiQuery({ name: 'days', required: false, description: 'نافذة القياس بالأيام (7..365، والافتراضي 30)' })
  @ApiOperation({ summary: 'قياس الموقع: الزوّار · الأهداف والقمع · المنحنى · المصادر · المسارات · تجارب أ/ب' })
  @ApiOkResponse({ description: 'Anonymous, aggregated marketing-site analytics (definitions travel with the numbers)' })
  async site(@Query('days', new ZodValidationPipe(siteAnalyticsDaysSchema.optional())) days?: number): Promise<{ data: SiteAnalytics }> {
    return { data: await this.analytics.analytics(days ?? 30) };
  }
}
