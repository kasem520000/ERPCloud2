import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import type { PublicStatus } from '@erp/contracts';

import { Public } from '../platform/decorators/public.decorator.js';
import { RateLimit } from '../platform/decorators/rate-limit.decorator.js';

import { PublicStatusService } from './public-status.service.js';

/**
 * `/api/v1/public/status` — حالة الخدمة كما يراها العميل (P-M9).
 *
 * **نفس المجسّات، وقراءةٌ ثانية:** اللوحة (`GET /platform/health/detailed`) تعرض للفريق ما
 * لا يُقال للعميل (دلو · سائق · مزوّد · رسائل أخطاء)، وهذه تعرض الحالة وحدها. والفصل
 * مقصود: لو أُريد للعميل أن يرى تفاصيلَ اللوحة لكان الحلّ منحه صلاحية اللوحة، وهو عكس
 * المطلوب — العميل يريد أن يعرف «هل تعمل؟» لا أن يعرف من أين يأتي الخلل.
 */
@ApiTags('public-status')
@Controller('public')
export class PublicStatusController {
  constructor(private readonly status: PublicStatusService) {}

  @Public()
  @Get('status')
  @RateLimit({ name: 'public-status', limit: env.RATE_LIMIT_PUBLIC_STATUS_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({ summary: 'حالة الخدمة علناً: خمسة مكوّنات، والحادث المفتوح إن وُجد' })
  @ApiOkResponse({ description: 'Public component states with the declared incident, if any' })
  @ApiResponse({ status: 429, description: 'تجاوز حدّ المعدّل (RATE_LIMITED)' })
  async statusPage(): Promise<{ data: PublicStatus }> {
    return { data: await this.status.snapshot() };
  }
}
