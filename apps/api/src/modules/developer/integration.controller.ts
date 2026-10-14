import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS, type ApiKeyIdentity, type ApiKeyInvoiceSample } from '@erp/contracts';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { Public } from '../platform/decorators/public.decorator.js';

import { ApiKeyGuard } from './api-key.guard.js';
import { DeveloperService } from './developer.service.js';
import { RequiresApiKeyScope } from './requires-api-key-scope.decorator.js';

/**
 * P-C11 — سطح التكامل: `/integration/v1/*`، يُصادَق عليه بمفتاح الـAPI وحده.
 *
 * **ولماذا سطحٌ جديد بدل تمرير المفتاح على مسارات العميل القائمة؟** لأن لكل سطحٍ عقداً:
 * مسارات العميل (`/sales/*` …) عقدُ **واجهة المستخدم**: تتبع جلسةً، وتتغيّر بتغيّر الشاشة،
 * وتسقط بانتهاء الرمز. والتكامل عقدٌ آخر: يعيش سنوات، ولا يعرف الجلسات، ويُقاس بالسقف الذي
 * اشتراه العميل. فالفصل هنا صيانةٌ لا تفخيم — ولذلك سُمّي `v1` صراحةً.
 *
 * `@Public()` على الصنف **لا يعني مفتوحاً**: الحارس `ApiKeyGuard` هو البوابة، ويمرّ كل طلب
 * على `verifyKey` (بصمة + إبطال + انتهاء)، ثم على النطاق المطلوب. وحين ينجح ينشر سياق
 * المستأجر، فتُقرأ البيانات تحت سياسة العزل نفسها التي يقرأ بها الموظّف.
 */
@ApiTags('integration')
@ApiBearerAuth('api-key')
@Controller('integration')
@Public()
@UseGuards(ApiKeyGuard)
export class IntegrationController {
  constructor(private readonly developer: DeveloperService) {}

  @Get('v1/me')
  @ApiOperation({
    summary: 'هوية المفتاح: منشأته ونطاقاته',
    description: 'أول نداءٍ يجرّبه المطوّر: يقول له هذا المفتاح لمن، وماذا يفتح.',
  })
  @ApiOkResponse({ description: 'The key identity, its scopes and the permissions they map to.' })
  @ApiResponse({ status: 401, description: 'المفتاح مجهول أو مُبطَل أو منتهٍ.' })
  me(): Promise<ApiKeyIdentity> {
    return this.developer.identity(getTenantContext().tenantId, getTenantContext().userId);
  }

  @Get('v1/invoices')
  @RequiresApiKeyScope('invoices:read')
  @ApiOperation({
    summary: 'آخر فواتير المنشأة',
    description: 'عيّنةٌ للقراءة تُثبت أن النطاق يعمل على بياناتٍ حقيقية — لا خانةً في الشاشة.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1..50، الافتراضي 10' })
  @ApiOkResponse({ description: 'A tenant-scoped sample of posted invoices.' })
  @ApiResponse({ status: 403, description: 'المفتاح لا يحمل نطاق invoices:read.' })
  invoices(@Query('limit') limit?: string): Promise<ApiKeyInvoiceSample[]> {
    return this.developer.invoiceSample(getTenantContext().tenantId, Number(limit ?? 10));
  }

  /** الحدود التي يُقاس بها التوقيع — تُقرأ من نفس الثابت الذي يوقّع به المُرسِل. */
  @Get('v1/signature')
  @ApiOperation({ summary: 'صيغة توقيع الويب هوك ونافذة القبول' })
  signature(): { header: string; algorithm: string; toleranceSeconds: number } {
    return {
      header: 'x-erp-signature',
      algorithm: 'HMAC-SHA256 over "<timestamp>.<body>", hex, sent as t=<seconds>,v1=<hex>',
      toleranceSeconds: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
    };
  }
}
