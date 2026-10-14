import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { usagePeriodSchema, type UsageSnapshot } from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { UsageService } from './usage.service.js';

/**
 * P-C5 — استخدام العميل في سطح العميل (`GET /usage`).
 *
 * شاشة `apps/staff/app/settings/usage` تقرأ من هنا، ولا تقرأ شبكة المنصة: العميل يرى أرقامه
 * وحدودَه هو، لا عملاء المنصة. والقراءة تمرّ بمعاملة مستأجر (`withTenantTx`) فالعزل في
 * القاعدة لا في الشاشة، ومعها قراءةُ الحدود من الطائرة الإدارية وحدها (0066).
 *
 * الرمز `tenant.view` («اقرأ سجلّ منشأتك وإعداداتها الفعّالة») هو أضيق رمزٍ قائم يصف القراءة:
 * شاشة الحصص ليست كتابة إعدادات، فلا تطلب `tenant.settings.manage`.
 */
@ApiTags('usage')
@ApiBearerAuth()
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequiresPermission('tenant.view')
  @ApiQuery({ name: 'period', required: false, description: 'الشهر بصيغة YYYY-MM (افتراضاً: هذا الشهر)' })
  @ApiOperation({ summary: 'استهلاك منشأتي مقابل حدودها' })
  @ApiOkResponse({ description: 'Usage snapshot for the calling tenant' })
  async snapshot(
    @Query('period', new ZodValidationPipe(usagePeriodSchema.optional())) period?: string,
  ): Promise<{ data: UsageSnapshot }> {
    const tenant = getTenantContext();
    return { data: await this.usage.snapshotForTenant(tenant.tenantId, period) };
  }
}
