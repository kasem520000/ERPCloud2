import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { weeklyReportRunInputSchema, type WeeklyReportRunInput } from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { WeeklyReportService } from './weekly-report.service.js';

/**
 * التقرير الأسبوعي للمنصة — مساران لا أكثر.
 *
 * `GET /platform/reports/weekly` **قراءة** (`console.analytics.view`): ما سيُرسل، ولمن، ومتى،
 * وأرقامه كما ستُصيَّر — فالمعاينة تُغني عن انتظار أسبوعٍ لتُقرأ الأرقام.
 *
 * `POST /platform/reports/weekly/run` **كتابة** (`console.email.manage`): إرسالٌ الآن. وجهةُ
 * الإعداد تكفي للتشغيل الدوري، وهذا المسار للمشغّل الذي يضبط العناوين ويريد أن يرى الرسالة
 * (و`to` لتجربةٍ لعنوانٍ واحد بلا مسّ القائمة). ولذلك رمزُه رمز البريد لا رمز التحليلات: من
 * يقرأ التحليلات لا يُرسل بريداً بالنيابة عن المنصة.
 */
@ApiTags('platform-reports')
@ApiBearerAuth()
@Controller('platform/reports/weekly')
@UseGuards(PlatformAdminGuard)
export class PlatformReportsController {
  constructor(private readonly report: WeeklyReportService) {}

  @Get()
  @RequiresPlatformRole('console.analytics.view')
  @ApiOperation({ summary: 'معاينة التقرير الأسبوعي: النافذة · المستلمون · الموعد · المتغيّرات' })
  @ApiOkResponse({ description: 'Weekly report preview (window, recipients, schedule, variables)' })
  async preview() {
    return { data: await this.report.preview() };
  }

  @Post('run')
  @RequiresPlatformRole('console.email.manage')
  @ApiOperation({ summary: 'إرسال التقرير الأسبوعي الآن (تجاوز الجدول — للحجر على سجلّ البريد)' })
  async run(@Body(new ZodValidationPipe(weeklyReportRunInputSchema)) input: WeeklyReportRunInput) {
    return { data: await this.report.run(input) };
  }
}
