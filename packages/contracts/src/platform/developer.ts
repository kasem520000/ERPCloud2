import { z } from 'zod';

import { uuidSchema } from '../ids.js';

/**
 * P-C11 — «بوابة المطوّر» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * عقودُ التكامل الرسمي: **مفاتيح الـAPI** (لكل مستأجر) و**الويب هوكس** (الأحداث والعنوان
 * والسرّ وسجلّ التسليم). وثلاثة قرارات تُقرأ من هذه العقود نفسها:
 *
 *   1. **المفتاح لا يُخزَّن نصّاً.** ما يُعرض مرّةً واحدةً عند الإنشاء (`secret`) هو النصّ
 *      الوحيد الذي يراه أحد؛ والقاعدة تحتفظ بـ`prefix` (للتعرّف في السجلّات) و`hash` فقط.
 *      فمن نسي مفتاحه يُنشئ غيره — ولا «أرسل لي المفتاح مرّة أخرى».
 *   2. **السرّ يُشتقّ من الإصدار والحرف.** `secretPrefix` هو أوّل ما يُقرأ منه، و`scopes`
 *      قدراتٌ صريحة (`invoices:read` …) لا «كل شيء» — لأن مفتاحاً بلا سقفٍ ثغرةٌ مؤجَّلة.
 *   3. **التسليم يُقاس بأرقامه**: رمز الاستجابة، والمحاولات، والزمن، والخطأ — والحكم
 *      (`delivered`/`failed`) شيءٌ يكتبه المُرسِل الفعلي لا شيءٌ يفترضه العارض.
 */

// ─────────────────────────────────────────────────────────────────────────────
// مفاتيح الـAPI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * نطاقات المفتاح — قدراتٌ على موارد المستأجر، مكتوبةً `resource:action`.
 *
 * وهي **لا تشمل** `console.*` بحال: مفتاحُ عميلٍ يُعرّف نفسه لمنشأته، ولا يفتح سطح
 * المنصة. وهذا ما يجعل النطاق قابلاً للقراءة في الطلب نفسه (`invoices:write` تعني
 * «POST/PATCH على فواتيرك»)، بخلاف رمزٍ عامّ اسمه `write`.
 */
export const apiKeyScopes = [
  'invoices:read',
  'invoices:write',
  'inventory:read',
  'inventory:write',
  'parties:read',
  'parties:write',
  'reporting:read',
  'webhooks:manage',
] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

export const apiKeyStatuses = ['active', 'revoked'] as const;
export type ApiKeyStatus = (typeof apiKeyStatuses)[number];

/** بادئة المفتاح المطبوع: تُقرأ في السجلّات لتعرف أن الطلب جاء بمفتاح لا بجلسة. */
export const API_KEY_PREFIX = 'erp_live_';

export const apiKeyRowSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  /** `erp_live_ab12cd34` — يُخزَّن ويُعرض؛ أمّا ما بعده فلا يُرى بعد الإنشاء. */
  prefix: z.string(),
  scopes: z.array(z.enum(apiKeyScopes)),
  status: z.enum(apiKeyStatuses),
  /** آخر استخدام فعلي: يُحدَّث عند كل طلب، وهو أول ما يُسأل عنه في السجلّ. */
  lastUsedAt: z.string().nullable(),
  lastUsedIp: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  createdBy: uuidSchema.nullable(),
  createdByLabel: z.string().nullable(),
  createdAt: z.string(),
  /** عدّاد الطلبات المقبولة بالمفتاح — يُقرأ من `api_key_uses`. */
  uses: z.number().int(),
});
export type ApiKeyRow = z.infer<typeof apiKeyRowSchema>;

export const apiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(3).max(60),
    scopes: z.array(z.enum(apiKeyScopes)).min(1).max(apiKeyScopes.length),
    /** `null` = بلا انتهاء؛ والاختيار المحدَّد يكتب تاريخاً يُقرأ في الشاشة. */
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();
export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

/** النصّ الصريح يُعاد **مرّة واحدة** في هذا الشكل، ولا يُقرأ بعدها من أي مكان. */
export const apiKeyCreatedSchema = apiKeyRowSchema.extend({ secret: z.string() });
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;

export const apiKeyRevokeSchema = z
  .object({ reason: z.string().trim().min(5).max(200) })
  .strict();
export type ApiKeyRevoke = z.infer<typeof apiKeyRevokeSchema>;

/** التدوير: مفتاحٌ جديد بنفس الاسم والنطاقات، والقديم يُبطَل في نفس المعاملة. */
export const apiKeyRotateSchema = z
  .object({ reason: z.string().trim().min(5).max(200).optional() })
  .strict();
export type ApiKeyRotate = z.infer<typeof apiKeyRotateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// الويب هوكس
// ─────────────────────────────────────────────────────────────────────────────

/**
 * الأحداث التي يمكن الاشتراك بها — **وما لا مُنتِجَ له غير موجود هنا**.
 *
 * القاعدة المكتوبة في P-C7 تُطبَّق هنا أيضاً: حدثٌ في الكتالوج بلا مُنتِج = خانةٌ تُشترى
 * ولا تأتي. فالقائمة تحمل ما يُنتَج فعلاً من مسارٍ حقيقي، وكلُّ حدثٍ يزيد لاحقاً يُنتَج
 * من موضعه ثم يُضاف إلى هذه القائمة — لا العكس.
 */
export const webhookEvents = [
  'invoice.posted',
  'invoice.paid',
  'invoice.voided',
  'stock.below_reorder',
  'einvoice.submission_failed',
  'shift.closed',
  'subscription.activated',
  'subscription.plan_changed',
  'subscription.suspended',
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

/** حدثُ الاختبار: يُرسل من زرّ «اختبار» ولا يُشترك به (فلا يظهر في قائمة الاشتراك). */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export const webhookEndpointStatuses = ['active', 'paused'] as const;
export type WebhookEndpointStatus = (typeof webhookEndpointStatuses)[number];

export const webhookDeliveryStatuses = ['pending', 'delivered', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

/**
 * العنوان: `https` إلزاماً، و`http` مسموحٌ للعنوان المحلّي وحده.
 *
 * السبب عمليّ لا نظريّ: الويب هوك يحمل بيانات عميل، و`http` على شبكةٍ عامّة تعني أن كل
 * من على الطريق يقرؤها — والسرّ يمنع التزوير لا التنصّت. ويُستثنى `localhost` لأن بيئة
 * التطوير تجرّب على جهازها، والاستثناء مكتوبٌ هنا لا في الشاشة.
 */
export const webhookUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^https:\/\/[^\s]+$/.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value), {
    message: 'The webhook URL must be https, or http on localhost',
  });

export const webhookEndpointRowSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  url: z.string(),
  events: z.array(z.enum(webhookEvents)),
  status: z.enum(webhookEndpointStatuses),
  /** أوّل محارف من السرّ — للتعرّف عليه في الشاشة بلا كشفه. */
  secretPrefix: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  createdBy: uuidSchema.nullable(),
  createdByLabel: z.string().nullable(),
  stats: z.object({
    delivered: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
    lastDeliveryAt: z.string().nullable(),
    lastResponseCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
  }),
});
export type WebhookEndpointRow = z.infer<typeof webhookEndpointRowSchema>;

export const webhookEndpointCreateSchema = z
  .object({
    url: webhookUrlSchema,
    events: z.array(z.enum(webhookEvents)).min(1).max(webhookEvents.length),
    description: z.string().trim().min(3).max(200).optional(),
  })
  .strict();
export type WebhookEndpointCreate = z.infer<typeof webhookEndpointCreateSchema>;

export const webhookEndpointUpdateSchema = z
  .object({
    events: z.array(z.enum(webhookEvents)).min(1).max(webhookEvents.length).optional(),
    status: z.enum(webhookEndpointStatuses).optional(),
    description: z.string().trim().min(3).max(200).nullable().optional(),
  })
  .strict();
export type WebhookEndpointUpdate = z.infer<typeof webhookEndpointUpdateSchema>;

/** الإنشاء يعيد السرّ نصّاً **مرّة واحدة** — و`secretPrefix` وحده يبقى بعدها. */
export const webhookEndpointCreatedSchema = webhookEndpointRowSchema.extend({ secret: z.string() });
export type WebhookEndpointCreated = z.infer<typeof webhookEndpointCreatedSchema>;

export const webhookDeliveryRowSchema = z.object({
  id: uuidSchema,
  endpointId: uuidSchema,
  tenantId: uuidSchema,
  event: z.string(),
  status: z.enum(webhookDeliveryStatuses),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  /** رمز الاستجابة كما ردّه العنوان — وقد يكون `null` إن لم يُجب أصلاً. */
  responseCode: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
  /** **مفاتيح** الحمولة لا قيمها — نفس قرار شبكة المهام في P-C9. */
  payloadKeys: z.array(z.string()),
  payloadBytes: z.number().int(),
});
export type WebhookDeliveryRow = z.infer<typeof webhookDeliveryRowSchema>;

export const webhookDeliveryQuerySchema = z.object({
  filter: z
    .object({
      status: z.enum(webhookDeliveryStatuses).optional(),
      event: z.string().max(60).optional(),
    })
    .optional(),
  sort: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type WebhookDeliveryQuery = z.infer<typeof webhookDeliveryQuerySchema>;

export const webhookEndpointQuerySchema = z.object({
  filter: z
    .object({
      tenantId: uuidSchema.optional(),
      status: z.enum(webhookEndpointStatuses).optional(),
      event: z.enum(webhookEvents).optional(),
    })
    .optional(),
  sort: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type WebhookEndpointQuery = z.infer<typeof webhookEndpointQuerySchema>;

/**
 * توقيع التسليم: `X-ERP-Signature: t=<ثواني>,v1=<hex>`.
 *
 * وهو HMAC-SHA256 على `"<t>.<body>"` بسرّ العنوان — نفس شكل توقيعات Stripe/Svix، ولذلك
 * يُقرأ من مكتباتهم بلا كودٍ جديد. والطابع الزمني **داخل** المُوقَّع لا خارجه: بدونه يصحّ
 * التوقيع إلى الأبد، ومن التقط حمولةً مرّةً يعيد إرسالها كل يوم. ونافذة القبول 5 دقائق
 * (مكتوبة في الوثيقة، ويقيسها سكربت التحقّق الحيّ).
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-erp-signature';
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** نتيجة اختبار/تسليم كما تُعرض للمشغّل. */
export const webhookAttemptSchema = z.object({
  deliveryId: uuidSchema,
  event: z.string(),
  status: z.enum(webhookDeliveryStatuses),
  responseCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
});
export type WebhookAttempt = z.infer<typeof webhookAttemptSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// سطح التكامل (`/integration/v1/*`) — ما يراه حاملُ المفتاح
// ─────────────────────────────────────────────────────────────────────────────

/**
 * هويّة المفتاح كما يراها التكامل نفسه: لمن هذا المفتاح، وماذا يفتح، وآخر استعمال له.
 *
 * وفيها `permissions` بجانب `scopes` **عن قصد**: النطاق هو ما اشتراه العميل، والصلاحية هي
 * ما تُرجم إليه في الحارس. وعرضُهما معاً يجعل الخريطة قابلة للفحص من الخارج — لا سرّاً في
 * كود الخدمة (`modules/developer/api-key.ts` هو مصدرها).
 */
export const apiKeyIdentitySchema = z.object({
  keyId: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(apiKeyScopes)),
  permissions: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type ApiKeyIdentity = z.infer<typeof apiKeyIdentitySchema>;

/** عيّنة قراءة من فواتير المنشأة — تُثبت أن المفتاح يقرأ بياناتٍ حقيقية ضمن نطاقه. */
export const apiKeyInvoiceSampleSchema = z.object({
  id: uuidSchema,
  number: z.string().nullable(),
  status: z.string(),
  paymentStatus: z.string(),
  total: z.string(),
  currency: z.string(),
  postedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKeyInvoiceSample = z.infer<typeof apiKeyInvoiceSampleSchema>;

/**
 * كتالوج البوابة كما يقرؤه المشغّل وسكربت التحقّق: النطاقات والأحداث وصيغة التوقيع.
 * ويُقرأ من الخدمة لا من الشاشة — فالشاشة قد تُحدَّث ولا تُحدَّث أخرى، والكود واحد.
 */
export const developerCatalogueSchema = z.object({
  scopes: z.array(z.enum(apiKeyScopes)),
  events: z.array(z.enum(webhookEvents)),
  testEvent: z.string(),
  signature: z.object({
    header: z.string(),
    algorithm: z.string(),
    toleranceSeconds: z.number().int(),
  }),
  retryBackoffSeconds: z.array(z.number().int()),
});
export type DeveloperCatalogue = z.infer<typeof developerCatalogueSchema>;

/** الأفعال المُدقَّقة في هذا الجزء — تُقرأ في الاختبار وتُكتب في `audit_log`. */
export const developerAuditActions = {
  apiKeyCreate: 'platform.api-key.create',
  apiKeyRevoke: 'platform.api-key.revoke',
  apiKeyRotate: 'platform.api-key.rotate',
  webhookCreate: 'platform.webhook.create',
  webhookUpdate: 'platform.webhook.update',
  webhookDelete: 'platform.webhook.delete',
  webhookTest: 'platform.webhook.test',
  webhookRetry: 'platform.webhook.retry',
} as const;
export type DeveloperAuditAction = (typeof developerAuditActions)[keyof typeof developerAuditActions];
