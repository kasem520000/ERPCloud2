import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { uuidSchema, usagePeriodSchema, type PlatformUsageGridResponse, type UsageSnapshot } from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';
import { UsageService } from '../../usage/index.js';

/**
 * P-C5 — «الاستخدام والحصص» على مستوى المنصة.
 *
 * مسارَان لا أكثر، لأن كل ما تحسبه اللوحة موجودٌ في الشبكة نفسها:
 *
 *   - `GET /platform/usage?tenantId=&period=` — بلا `tenantId` تُعيد الشبكة كلها (كل عميل ×
 *     ثمانية مقاييس)، وبـ`tenantId` تُعيد لقطة عميلٍ واحد (تبويب «الاستخدام» في بطاقته).
 *   - `GET /platform/usage/export.csv` — البيان نفسه ملفًّا للمحاسبة.
 *
 * **الرمزان مختلفان عمداً**: قراءة الشبكة `console.tenants.view` (الدعم يرى عملاءه بلا
 * صلاحية مال)، وتصدير البيان `console.billing.manage` (الملف الذي تُبنى عليه مطالبةٌ مالية
 * ليس تقريرًا تشغيليًا). وهذا القرار في تقرير الجزء، لا في تعليقٍ لا يُقرأ.
 */
@ApiTags('platform-usage')
@ApiBearerAuth()
@Controller('platform/usage')
@UseGuards(PlatformAdminGuard)
export class PlatformUsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequiresPlatformRole('console.tenants.view')
  @ApiQuery({ name: 'tenantId', required: false, description: 'عميلٌ واحد؛ وبغيابه الشبكة كلها' })
  @ApiQuery({ name: 'period', required: false, description: 'الشهر بصيغة YYYY-MM' })
  @ApiOperation({ summary: 'شبكة الاستخدام عبر العملاء، أو لقطة عميلٍ واحد' })
  @ApiOkResponse({ description: 'Usage grid (or a single tenant snapshot when tenantId is given)' })
  async grid(
    @Query('tenantId', new ZodValidationPipe(uuidSchema.optional())) tenantId?: string,
    @Query('period', new ZodValidationPipe(usagePeriodSchema.optional())) period?: string,
  ): Promise<{ data: PlatformUsageGridResponse | UsageSnapshot }> {
    if (tenantId) return { data: await this.usage.snapshotForPlatform(tenantId, period) };
    return { data: await this.usage.grid(period) };
  }

  @Get('export.csv')
  @RequiresPlatformRole('console.billing.manage')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="platform-usage.csv"')
  @ApiProduces('text/csv')
  @ApiQuery({ name: 'period', required: false, description: 'الشهر بصيغة YYYY-MM' })
  @ApiOperation({ summary: 'بيان الاستخدام الشهري (كل عميل × كل مقياس) ملفَّ CSV' })
  async exportCsv(
    @Query('period', new ZodValidationPipe(usagePeriodSchema.optional())) period?: string,
  ): Promise<string> {
    const rows = await this.usage.exportRows(period);
    // BOM في الأول: بدونه يقرأ Excel أسماء العملاء العربية رموزاً.
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }
}

/** خلية CSV: تُحيط بالفاصلة والتنصيص والسطر الجديد، وتُضاعف التنصيص (RFC 4180). */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
