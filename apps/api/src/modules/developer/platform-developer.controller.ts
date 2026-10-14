import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  developerCatalogueSchema,
  webhookDeliveryQuerySchema,
  webhookEndpointCreateSchema,
  webhookEndpointQuerySchema,
  webhookEndpointUpdateSchema,
  type ApiKeyCreate,
  type ApiKeyCreated,
  type ApiKeyRevoke,
  type ApiKeyRotate,
  type ApiKeyRow,
  type DeveloperCatalogue,
  type ListEnvelope,
  type WebhookAttempt,
  type WebhookDeliveryQuery,
  type WebhookDeliveryRow,
  type WebhookEndpointCreate,
  type WebhookEndpointCreated,
  type WebhookEndpointQuery,
  type WebhookEndpointRow,
  type WebhookEndpointUpdate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { getAuthContext } from '../../request-context/request-context.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { DeveloperService } from './developer.service.js';

/**
 * P-C11 — سطح «بوابة المطوّر» في اللوحة (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * أسماء المسارات هي أسماء الخطة حرفاً بحرف: `GET/POST/DELETE /platform/tenants/:id/api-keys`
 * · `GET/POST/PATCH/DELETE /platform/tenants/:id/webhooks` · `POST /platform/webhooks/:id/test`
 * · `GET /platform/webhooks/:id/deliveries`.
 *
 * وثلاثة مساراتٍ زائدة، ولكلٍّ سببٌ لا يُستغنى عنه:
 *
 *   * `POST /platform/tenants/:id/api-keys/:keyId/rotate` — الخطة تطلب «تدوير» في الشاشة،
 *     والتدوير **ليس** إنشاءً ثانياً: القديم يُبطَل والجديد يرث الاسم والنطاقات. فمسارٌ
 *     واحد يفعل الاثنين في معاملةٍ واحدة، أو يرث العميل مفتاحين صالحين بلا أن يدري.
 *   * `POST /platform/webhooks/:id/deliveries/:deliveryId/retry` — «إعادة الإرسال» في الشاشة
 *     تحتاج عنواناً صريحاً؛ والإعادة إجراءٌ يُنفَّذ الآن لا صفٌّ يُعاد جدولته.
 *   * `GET /platform/developer/catalogue` — النطاقات والأحداث وصيغة التوقيع كما تُنفَّذ فعلاً.
 *     الشاشة تقرأ العقود مباشرة (المستودع واحد)، وهذا المسار يقيس ما يقوله الخادم نفسه.
 *
 * والصلاحيات: مفاتيح الـAPI بـ`console.apikeys.manage`، والعناوين بـ`console.webhooks.manage`،
 * وقائمة التسليمات بـ`console.webhooks.manage` أيضاً (من يقرأ التسليمات يقرأ ما أُرسل).
 */
@ApiTags('platform-developer')
@ApiBearerAuth()
@Controller('platform')
@UseGuards(PlatformAdminGuard)
export class PlatformDeveloperController {
  constructor(private readonly developer: DeveloperService) {}

  // ───────────────────────────────────────────────────────────────────────────
  // الكتالوج
  // ───────────────────────────────────────────────────────────────────────────

  @Get('developer/catalogue')
  @RequiresPlatformRole('console.apikeys.manage')
  @ApiOperation({ summary: 'النطاقات والأحداث وصيغة توقيع الويب هوك' })
  @ApiOkResponse({ description: 'The scopes, the event catalogue, the signature format and the retry backoff.' })
  async catalogue(): Promise<DeveloperCatalogue> {
    // يُتحقّق من الشكل عند الإرجاع أيضاً: مسارٌ يَعِد بواجهةٍ ويُرجع غيرها أسوأ من غيابه.
    return developerCatalogueSchema.parse(this.developer.catalogue());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // مفاتيح الـAPI — لكل مستأجر
  // ───────────────────────────────────────────────────────────────────────────

  @Get('tenants/:id/api-keys')
  @RequiresPlatformRole('console.apikeys.manage')
  @ApiOperation({ summary: 'مفاتيح منشأة: النطاقات وآخر استخدام والحالة' })
  @ApiOkResponse({ description: 'The tenant API keys with their scopes and last use.' })
  @ApiResponse({ status: 404, description: 'لا مستأجر بهذا المعرّف.' })
  keys(@Param('id') tenantId: string): Promise<ListEnvelope<ApiKeyRow>> {
    return this.developer.listKeys(tenantId);
  }

  @Post('tenants/:id/api-keys')
  @RequiresPlatformRole('console.apikeys.manage')
  @ApiOperation({
    summary: 'إنشاء مفتاح — النصّ الصريح يُعاد مرّة واحدة',
    description: 'المحفوظ بادئةٌ وبصمة؛ فمن ضاع منه مفتاحه دوّره ولم ينتظر إعادة العرض.',
  })
  @ApiBody({ schema: { type: 'object', required: ['name', 'scopes'] } })
  @ApiOkResponse({ description: 'The created key, with its plaintext secret included once.' })
  @ApiResponse({ status: 400, description: 'اسمٌ أو نطاقات غير مقبولة.' })
  createKey(@Param('id') tenantId: string, @Body(new ZodValidationPipe(apiKeyCreateSchema)) body: ApiKeyCreate) {
    return this.developer.createKey(tenantId, body, getAuthContext().userId);
  }

  @Post('tenants/:id/api-keys/:keyId/rotate')
  @RequiresPlatformRole('console.apikeys.manage')
  @ApiOperation({ summary: 'تدوير مفتاح: الجديد يرث الاسم والنطاقات، والقديم يُبطَل' })
  @ApiOkResponse({ description: 'The replacement key, with its plaintext secret included once.' })
  @ApiResponse({ status: 409, description: 'المفتاح مُبطَل — لا يُدوَّر ما لا يعمل.' })
  rotateKey(
    @Param('id') tenantId: string,
    @Param('keyId') keyId: string,
    @Body(new ZodValidationPipe(apiKeyRotateSchema)) body: ApiKeyRotate,
  ): Promise<ApiKeyCreated> {
    return this.developer.rotateKey(tenantId, keyId, body, getAuthContext().userId);
  }

  @Delete('tenants/:id/api-keys/:keyId')
  @RequiresPlatformRole('console.apikeys.manage')
  @ApiOperation({ summary: 'إبطال مفتاح بسببٍ يبقى في السجلّ' })
  @ApiQuery({ name: 'reason', required: false, description: 'السبب — يُقبل من الجسم أو من الاستعلام' })
  @ApiOkResponse({ description: 'The revoked key row.' })
  @ApiResponse({ status: 409, description: 'المفتاح مُبطَل من قبل.' })
  revokeKey(
    @Param('id') tenantId: string,
    @Param('keyId') keyId: string,
    @Body(new ZodValidationPipe(apiKeyRevokeSchema)) body: ApiKeyRevoke,
  ): Promise<ApiKeyRow> {
    return this.developer.revokeKey(tenantId, keyId, body, getAuthContext().userId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // الويب هوكس — لكل مستأجر
  // ───────────────────────────────────────────────────────────────────────────

  @Get('tenants/:id/webhooks')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({ summary: 'عناوين الويب هوك وأحداثها وحصيلة تسليماتها' })
  @ApiOkResponse({ description: 'The tenant webhook endpoints with per-status delivery counts.' })
  @ApiResponse({ status: 404, description: 'لا مستأجر بهذا المعرّف.' })
  endpoints(
    @Param('id') tenantId: string,
    @Query(new ZodValidationPipe(webhookEndpointQuerySchema)) query: WebhookEndpointQuery,
  ): Promise<ListEnvelope<WebhookEndpointRow>> {
    // معرّف المسار هو المصدر: الاستعلام يُفلتر داخل المستأجر لا يغيّره.
    return this.developer.listEndpoints({ ...query, filter: { ...query.filter, tenantId } });
  }

  @Post('tenants/:id/webhooks')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({
    summary: 'إضافة عنوان — سرّ التوقيع يُعاد مرّة واحدة',
    description: 'العنوان https إلزاماً، وhttp مسموحٌ على localhost وحده (بيئة التطوير).',
  })
  @ApiBody({ schema: { type: 'object', required: ['url', 'events'] } })
  @ApiOkResponse({ description: 'The created endpoint, with its signing secret included once.' })
  @ApiResponse({ status: 400, description: 'عنوان غير مقبول أو أحداثٌ فارغة.' })
  createEndpoint(
    @Param('id') tenantId: string,
    @Body(new ZodValidationPipe(webhookEndpointCreateSchema)) body: WebhookEndpointCreate,
  ): Promise<WebhookEndpointCreated> {
    return this.developer.createEndpoint(tenantId, body, getAuthContext().userId);
  }

  @Patch('tenants/:id/webhooks/:endpointId')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({ summary: 'تعديل الأحداث أو الحالة (تشغيل/إيقاف)' })
  @ApiOkResponse({ description: 'The updated endpoint.' })
  @ApiResponse({ status: 404, description: 'لا عنوان بهذا المعرّف.' })
  updateEndpoint(
    @Param('endpointId') endpointId: string,
    @Body(new ZodValidationPipe(webhookEndpointUpdateSchema)) body: WebhookEndpointUpdate,
  ): Promise<WebhookEndpointRow> {
    return this.developer.updateEndpoint(endpointId, body, getAuthContext().userId);
  }

  @Delete('tenants/:id/webhooks/:endpointId')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({ summary: 'حذف عنوان وتسليماته' })
  @ApiOkResponse({ description: 'The deleted endpoint id.' })
  deleteEndpoint(@Param('endpointId') endpointId: string): Promise<{ id: string }> {
    return this.developer.deleteEndpoint(endpointId, getAuthContext().userId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // التسليمات — بعنوانها
  // ───────────────────────────────────────────────────────────────────────────

  @Post('webhooks/:id/test')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({
    summary: 'حدث اختبار حقيقي',
    description: 'يمرّ من نفس مسار الإرسال: توقيع، POST، قياس — لا زرٌّ يوهم بالسلامة.',
  })
  @ApiOkResponse({ description: 'The attempt result: status code, duration and error if any.' })
  test(@Param('id') endpointId: string): Promise<WebhookAttempt> {
    return this.developer.sendTest(endpointId, getAuthContext().userId);
  }

  @Get('webhooks/:id/deliveries')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({ summary: 'سجلّ التسليم بأكواد الاستجابة والمحاولات' })
  @ApiOkResponse({ description: 'The delivery log, newest first.' })
  deliveries(
    @Param('id') endpointId: string,
    @Query(new ZodValidationPipe(webhookDeliveryQuerySchema)) query: WebhookDeliveryQuery,
  ): Promise<ListEnvelope<WebhookDeliveryRow>> {
    return this.developer.listDeliveries(endpointId, query);
  }

  @Post('webhooks/:id/deliveries/:deliveryId/retry')
  @RequiresPlatformRole('console.webhooks.manage')
  @ApiOperation({ summary: 'إعادة إرسال تسليمٍ فشل' })
  @ApiOkResponse({ description: 'The retry attempt result.' })
  @ApiResponse({ status: 409, description: 'التسليم نجح من قبل.' })
  retry(@Param('id') endpointId: string, @Param('deliveryId') deliveryId: string): Promise<WebhookAttempt> {
    return this.developer.retryDelivery(endpointId, deliveryId, getAuthContext().userId);
  }
}
