import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  analyticsCohortBasisSchema,
  analyticsDaysQuerySchema,
  analyticsExportQuerySchema,
  analyticsMonthsQuerySchema,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { PlatformAnalyticsService } from './platform-analytics.service.js';

/**
 * P-C12 — التحليلات على مستوى المنصة.
 *
 * أربعة مسارات، كلها **قراءة**: `overview` (الإيراد والتسرّب والقمع والاستخدام والتنبيهات في
 * نداءٍ واحد لأن الشاشة واحدة)، و`funnel` و`cohorts` (تفاصيل تُطلب عند الفتح)، و`export.csv`
 * (البيان نفسه ملفًّا).
 *
 * والرمز واحد للجميع: `console.analytics.view`. لا رمز تصديرٍ منفصل كما في الاستخدام
 * (`console.billing.manage` لملفه) لأن ملف هذا الجزء **ليس مستنداً مالياً جديداً**: هو الأرقام
 * نفسها التي يعرضها النداء الأول، فلا معنى لصلاحيةٍ تُخفي عنه ما يراه على الشاشة.
 */
@ApiTags('platform-analytics')
@ApiBearerAuth()
@Controller('platform/analytics')
@UseGuards(PlatformAdminGuard)
export class PlatformAnalyticsController {
  constructor(private readonly analytics: PlatformAnalyticsService) {}

  @Get('overview')
  @RequiresPlatformRole('console.analytics.view')
  @ApiQuery({ name: 'months', required: false, description: 'نافذة المنحنى بالأشهر (3..24، والافتراضي 6)' })
  @ApiOperation({ summary: 'نظرة المنصة: الإيراد · النمو · التسرّب · التجربة · الاستخدام · التنبيهات' })
  @ApiOkResponse({ description: 'Analytics overview (MRR/ARR mirror the billing revenue board)' })
  async overview(@Query('months', new ZodValidationPipe(analyticsMonthsQuerySchema.optional())) months?: number) {
    return { data: await this.analytics.overview({ windowMonths: months }) };
  }

  @Get('funnel')
  @RequiresPlatformRole('console.analytics.view')
  @ApiQuery({ name: 'days', required: false, description: 'نافذة التسجيل بالأيام (30..365، وبغيابها كل الفترات)' })
  @ApiOperation({ summary: 'قمع التفعيل: سجّل → فُعِّل → رحّل أوّل فاتورة → أوّل مستند زاتكا' })
  async funnel(@Query('days', new ZodValidationPipe(analyticsDaysQuerySchema.optional())) days?: number) {
    return { data: await this.analytics.funnel({ windowDays: days ?? null }) };
  }

  @Get('cohorts')
  @RequiresPlatformRole('console.analytics.view')
  @ApiQuery({ name: 'months', required: false, description: 'عدد الأفواج (3..12، والافتراضي 6)' })
  @ApiQuery({ name: 'basis', required: false, enum: ['signup', 'activation'], description: 'فوج التسجيل أم فوج التفعيل' })
  @ApiOperation({ summary: 'أفواج الاحتفاظ: متعاقدٌ ومستخدِم في كل شهرٍ تالٍ' })
  async cohorts(
    @Query('months', new ZodValidationPipe(analyticsMonthsQuerySchema.optional())) months?: number,
    @Query('basis', new ZodValidationPipe(analyticsCohortBasisSchema.optional())) basis?: 'signup' | 'activation',
  ) {
    return { data: await this.analytics.cohorts({ months, basis }) };
  }

  @Get('export.csv')
  @RequiresPlatformRole('console.analytics.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="platform-analytics.csv"')
  @ApiProduces('text/csv')
  @ApiQuery({ name: 'days', required: false, description: 'نافذة القياس بالأيام (1..365، والافتراضي 30)' })
  @ApiOperation({ summary: 'بيان التحليلات لكل منشأة ملفَّ CSV (يُبنى في الذاكرة)' })
  async exportCsv(@Query('days', new ZodValidationPipe(analyticsExportQuerySchema.shape.days)) days?: number) {
    // BOM في الأول: بدونه يقرأ Excel أسماء العملاء العربية رموزاً.
    return `\uFEFF${await this.analytics.exportCsv({ days })}`;
  }
}
