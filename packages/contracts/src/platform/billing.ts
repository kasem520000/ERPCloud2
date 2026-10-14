import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { platformSettingDefinitions, platformSettingScopesOf } from './console.js';
import { tenantFlagLabels } from './tenants.js';

/**
 * P-C4 — «الباقات والتراخيص والفوترة»: عقود اشتراكات المنصة على عملائها.
 *
 * قسمة هذا الملف تُشبه `identity.ts` (P-C3): ما هو **عقد** (شكل الطلب والردّ) هنا، وما هو
 * **قاعدة حساب** (تسعير، تقويم، ضريبة) هنا أيضاً لأن الطرفين يحتاجانها — الخدمة تحسب،
 * والشاشة تعرض النتيجة قبل الحفظ. وما هو **تسمية** (عربية) هنا كذلك، لأن صفحة الطباعة تُبنى
 * في الخدمة لا في الواجهة، ولا يجوز أن يكون للفاتورة المطبوعة اسمُ حالةٍ مختلف عن الشاشة.
 *
 * ثلاثة أرقام تحكم كل ما في هذا الملف، وكلّها نصّية لأن المال في هذا المستودع `numeric`
 * يُقرأ نصًّا (`amount::text`) ولا يُمرَّر `number` في JSON:
 *
 *   1. **المبلغ الشهري المكافئ** (`platformMonthlyAmount`) — أساس MRR/ARR: باقة سنوية
 *      بـ4990 تُسهم بـ415.83 شهريًّا، لا بـ4990.
 *   2. **التقويم** (`platformProration`) — الأيام المتبقية من المدة، ورصيد الباقة القديمة غير
 *      المستخدم، ومقابل الباقة الجديدة عن الأيام نفسها، والفرق بينهما.
 *   3. **الضريبة** — 15٪ افتراضاً (قيمة مضافة سعودية)، وتُحسب **لكل سطر ثم تُجمع** عبر
 *      `calculateInvoiceTotals` المشتركة مع فواتير المستأجرين (`invoice-math.ts`)، فلا
 *      يختلف تقريب الضريبة بين السطحين.
 */

// ------------------------------------------------------------------ vocabulary

export const platformSubscriptionStatusSchema = z.enum([
  'pending',
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'expired',
  'incomplete',
]);
export type PlatformSubscriptionStatus = z.infer<typeof platformSubscriptionStatusSchema>;

export const platformSubscriptionStatusLabels: Record<PlatformSubscriptionStatus, string> = {
  pending: 'بانتظار التفعيل',
  trialing: 'تجربة',
  active: 'فعّال',
  past_due: 'متأخر',
  paused: 'موقوف مؤقتاً',
  canceled: 'ملغى',
  expired: 'منتهٍ',
  incomplete: 'غير مكتمل',
};

/** الحالات التي لا يزال الاشتراك فيها «حَيّاً» — عليها يُحسب MRR وتُمنع تراخيص ثانية. */
export const platformLiveSubscriptionStatuses: readonly PlatformSubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'paused',
];

export const platformInvoiceStatusSchema = z.enum(['draft', 'issued', 'paid', 'void']);
export type PlatformInvoiceStatus = z.infer<typeof platformInvoiceStatusSchema>;

export const platformInvoiceStatusLabels: Record<PlatformInvoiceStatus, string> = {
  draft: 'مسودّة',
  issued: 'صادرة',
  paid: 'مدفوعة',
  void: 'ملغاة',
};

export const platformInvoiceKindSchema = z.enum(['invoice', 'credit_note']);
export type PlatformInvoiceKind = z.infer<typeof platformInvoiceKindSchema>;

export const platformInvoiceKindLabels: Record<PlatformInvoiceKind, string> = {
  invoice: 'فاتورة',
  credit_note: 'إشعار دائن',
};

export const platformInvoiceLineKindSchema = z.enum([
  'subscription',
  'proration',
  'discount',
  'adjustment',
]);
export type PlatformInvoiceLineKind = z.infer<typeof platformInvoiceLineKindSchema>;

export const platformInvoiceLineKindLabels: Record<PlatformInvoiceLineKind, string> = {
  subscription: 'اشتراك',
  proration: 'تقويم فترة',
  discount: 'خصم',
  adjustment: 'تسوية',
};

export const platformPaymentMethodSchema = z.enum(['bank_transfer', 'cash', 'card', 'other']);
export type PlatformPaymentMethod = z.infer<typeof platformPaymentMethodSchema>;

export const platformPaymentMethodLabels: Record<PlatformPaymentMethod, string> = {
  bank_transfer: 'تحويل بنكي',
  cash: 'نقداً',
  card: 'بطاقة',
  other: 'أخرى',
};

export const platformDunningChannelSchema = z.enum(['email', 'sms', 'manual']);
export type PlatformDunningChannel = z.infer<typeof platformDunningChannelSchema>;

export const platformDunningStatusSchema = z.enum(['scheduled', 'sent', 'failed', 'skipped']);
export type PlatformDunningStatus = z.infer<typeof platformDunningStatusSchema>;

export const platformDunningStatusLabels: Record<PlatformDunningStatus, string> = {
  scheduled: 'مجدولة',
  sent: 'أُرسلت',
  failed: 'فشلت',
  skipped: 'متجاوَزة',
};

export const platformDunningChannelLabels: Record<PlatformDunningChannel, string> = {
  email: 'بريد',
  sms: 'رسالة نصية',
  manual: 'اتصال يدوي',
};

/** نصّ المحاولة كما يُسجَّل ويُرسل — يعيش هنا ليقرأه الاختبار والتحقّق الحيّ والشاشة. */
export function platformDunningMessage(input: {
  attemptNo: number;
  tenantName: string;
  invoiceNumber: string | null;
  total: string;
  currency: string;
  dueDate: string | null;
}): string {
  const invoice = input.invoiceNumber ? `الفاتورة ${input.invoiceNumber}` : 'فاتورة الاشتراك';
  const due = input.dueDate ? ` المستحقة في ${input.dueDate}` : '';
  return `تذكير ${input.attemptNo}: ${invoice}${due} بمبلغ ${input.total} ${input.currency} على «${input.tenantName}».`;
}

// ------------------------------------------------------------------ entitlements

export const platformEntitlementKindSchema = z.enum(['module', 'limit', 'flag']);
export type PlatformEntitlementKind = z.infer<typeof platformEntitlementKindSchema>;

export const platformEntitlementKindLabels: Record<PlatformEntitlementKind, string> = {
  module: 'وحدة',
  limit: 'حدّ',
  flag: 'راية',
};

/** القيم الممكنة لحقٍّ: منطقي لراية/وحدة، وعدد لِحدّ. */
export const platformEntitlementValueSchema = z.union([z.boolean(), z.number(), z.string()]);
export type PlatformEntitlementValue = z.infer<typeof platformEntitlementValueSchema>;

export const platformPlanEntitlementInputSchema = z.object({
  kind: platformEntitlementKindSchema,
  /** مفتاح من سجلّات الإعدادات المعروفة (`feature.pos` · `limits.max_branches` · …). */
  key: z.string().trim().min(1).max(120),
  value: platformEntitlementValueSchema,
});
export type PlatformPlanEntitlementInput = z.infer<typeof platformPlanEntitlementInputSchema>;

/** حقٌّ كما يُعرض: مع اسمه العربي وبأي سجلٍّ عُرف. */
export const platformPlanEntitlementSchema = platformPlanEntitlementInputSchema.extend({
  labelAr: z.string(),
  /** الاسم الإنجليزي من السجلّ نفسه — تقرؤه صفحة `/pricing` العامة (P-M3). */
  labelEn: z.string(),
  /** من أين جاء المفتاح: `tenant_settings` أم إعدادات المنصة ذات نطاق العميل. */
  registry: z.enum(['tenant', 'platform']),
});
export type PlatformPlanEntitlement = z.infer<typeof platformPlanEntitlementSchema>;

/**
 * كل مفتاح حقٍّ معروف في المستودع، مع نوعه واسمه العربي.
 *
 * المصدران: سجلّات إعدادات العميل (`@erp/config`) وإعدادات المنصة ذات نطاق العميل
 * (`platformSettingDefinitions`). الخدمة ترفض مفتاحاً خارج هذه الخريطة — فلا تُدخل باقةٌ
 * حقًّا لا وجود له في المنتج، وهو أشهر خطأ في صفحات الأسعار.
 */
export type PlatformEntitlementKey = {
  key: string;
  kind: PlatformEntitlementKind;
  labelAr: string;
  /**
   * الاسم الإنجليزي — ليس ترفاً: الأمم المتحدة للسوق السعودي **تسعّر بالإنجليزية أيضاً**
   * (P-M3 في `docs/roadmap/MARKETING_SITE_PLAN.md` يطلب `GET /public/plans` «الحقوق بلغتين»).
   * والمصدر هو السجلّ نفسه: `labelEn` في `platformSettingDefinitions`، وتسمية الحزمة في
   * `tenantFlagLabels`، ولا يُترجَم اسمٌ هنا ترجمةً حرّة.
   */
  labelEn: string;
  valueKind: 'boolean' | 'number' | 'string';
  registry: 'tenant' | 'platform';
  /** السقف إن كان حدًّا عددياً — يُعرض في الشاشة كتلميح. */
  max?: number;
};

export function platformEntitlementKindOf(key: string): PlatformEntitlementKind {
  if (key.startsWith('limit') || key.startsWith('limits.')) return 'limit';
  if (key.startsWith('feature.')) return 'module';
  return 'flag';
}

/**
 * بناء خريطة المفاتيح من السجلّين. `configuration` تأتي من `@erp/config` بحقنٍ من الطبقة
 * الأعلى (`packages/config` لا يعتمد على `@erp/contracts`)، فلا يستورد هذا الملف مشروعاً
 * آخر؛ ومناديه في الـAPI هو من يمرّر السجلّات.
 */
export function buildPlatformEntitlementKeys(
  tenantRegistry: readonly {
    key: string;
    description: string;
    defaultValue: string | boolean | number | null;
  }[],
): PlatformEntitlementKey[] {
  const keys: PlatformEntitlementKey[] = [];
  for (const definition of tenantRegistry) {
    // `feature.*` are the product packs (`feature.pos`, `feature.projects`, …): a plan opens
    // them or does not. The rest of the tenant registry is configuration (locale, fiscal
    // year, numbering) — a plan never sells that.
    if (!definition.key.startsWith('feature.')) continue;
    // اسم الحزمة من `tenantFlagLabels` (تسمياتٌ مكتوبة مرّةً واحدة هناك، ومصدرها الملفّ الأصلي
    // في `Desktop_ERP`)، وسجلّ `@erp/config` يحمل وصفاً إنجليزياً لا اسمَ عرض — فيُقدَّم الاسم
    // المكتوب على الوصف، ويبقى الوصف احتياطاً لمفتاحٍ جديد لم تُكتب تسميته بعد.
    const flag = tenantFlagLabels[definition.key];
    keys.push({
      key: definition.key,
      kind: platformEntitlementKindOf(definition.key),
      labelAr: flag?.labelAr ?? definition.description,
      labelEn: flag?.labelEn ?? definition.description,
      valueKind: 'boolean',
      registry: 'tenant',
    });
  }
  for (const definition of platformSettingDefinitions) {
    // `limits.*` are the only platform settings a plan can grant; `branding.*` belongs to the
    // customer and `platform.*` to the operator, so neither is a plan entitlement.
    if (!definition.key.startsWith('limits.')) continue;
    if (!platformSettingScopesOf(definition.key).includes('tenant')) continue;
    const valueKind = definition.kind === 'boolean' ? 'boolean' : definition.kind === 'integer' ? 'number' : 'string';
    keys.push({
      key: definition.key,
      kind: platformEntitlementKindOf(definition.key),
      labelAr: definition.labelAr,
      labelEn: definition.labelEn,
      valueKind,
      registry: 'platform',
      ...('max' in definition && typeof definition.max === 'number' ? { max: definition.max } : {}),
    });
  }
  return keys.sort((a, b) => a.key.localeCompare(b.key));
}

/** هل يطابق نوعُ القيمة نوعَ المفتاح المتوقّع؟ تُستعمل في التحقّق وفي الاختبار. */
export function platformEntitlementValueFits(
  expected: PlatformEntitlementKey['valueKind'],
  value: PlatformEntitlementValue,
): boolean {
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

// ------------------------------------------------------------------ plans

export const platformPlanIntervalSchema = z.enum(['month', 'year']);
export type PlatformPlanInterval = z.infer<typeof platformPlanIntervalSchema>;

const decimalString = z.string().regex(/^-?\d+(?:\.\d{1,4})?$/, 'مبلغ غير صالح');

export const platformPlanSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  interval: platformPlanIntervalSchema,
  amount: z.string(),
  currency: z.string(),
  stripePriceId: z.string().nullable(),
  active: z.boolean(),
  activeSubscriptions: z.number().int(),
  /** المكافئ الشهري — أساس لوحة الإيراد. */
  monthlyAmount: z.string(),
  entitlements: z.array(platformPlanEntitlementSchema),
  createdAt: z.string(),
});
export type PlatformPlan = z.infer<typeof platformPlanSchema>;

/** `POST /platform/plans` — يبقى «حفظ بنفس الرمز يحدّث» كما كان؛ الشكل صار موصوفاً. */
export const platformPlanInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'الرمز بحروف صغيرة وأرقام وشرطات'),
  name: z.string().trim().min(2).max(120),
  interval: platformPlanIntervalSchema,
  amount: decimalString,
  currency: z.string().trim().length(3).default('SAR'),
  stripePriceId: z.string().trim().max(120).nullable().optional(),
  active: z.boolean().default(true),
});
export type PlatformPlanInput = z.infer<typeof platformPlanInputSchema>;

/** `PATCH /platform/plans/:id` — تعديل باقة قائمة بسببٍ مكتوب (السعر يمسّ عملاء حاليين). */
export const platformPlanUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    interval: platformPlanIntervalSchema.optional(),
    amount: decimalString.optional(),
    currency: z.string().trim().length(3).optional(),
    stripePriceId: z.string().trim().max(120).nullable().optional(),
    active: z.boolean().optional(),
    reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.interval !== undefined ||
      value.amount !== undefined ||
      value.currency !== undefined ||
      value.stripePriceId !== undefined ||
      value.active !== undefined,
    { message: 'لا تغيير في الطلب' },
  );
export type PlatformPlanUpdate = z.infer<typeof platformPlanUpdateSchema>;

/** `PUT /platform/plans/:id/entitlements` — المجموعة الكاملة الجديدة بسببه. */
export const platformPlanEntitlementsUpdateSchema = z.object({
  entitlements: z.array(platformPlanEntitlementInputSchema).max(64),
  reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
});
export type PlatformPlanEntitlementsUpdate = z.infer<typeof platformPlanEntitlementsUpdateSchema>;

// ------------------------------------------------------------------ public pricing (P-M3)

/**
 * P-M3 — «الباقات والأسعار» في الموقع التسويقي (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * `GET /public/plans` يجيب سؤال الزائر الوحيد: **ماذا أحصل عليه بهذا السعر؟** ولذلك هو
 * `billing_plans` **مع** `billing_plan_entitlements` — لا أسعارٌ بلا حقوق، وهو الخطأ الذي
 * يجعل صفحة أسعارٍ تُقرأ ولا تُقنع.
 *
 * وثلاثة قرارات في هذا العقد:
 *
 *   1. **بلا معرّفات داخلية**: لا `stripePriceId` ولا `active` ولا عدّاد التراخيص — العام لا
 *      يرى أسرار المنصة، وما يُعرض على `/pricing` هو السعر والحقوق.
 *   2. **الباقات النشطة وحدها**: باقةٌ أوقفها المشغّل لا تظهر لعميل (الفلترة في الخدمة، وهذا
 *      العقد لا يحمل حقل «نشطة» أصلاً — فلا يظهر في الردّ ما لا يُعرض).
 *   3. **الحقوق بلغتين**: `labelAr` و`labelEn` من سجلّ المنتج (`tenantFlagLabels` ·
 *      `platformSettingDefinitions`) لا من ترجمةٍ في الواجهة، فتبقى صفحة الأسعار تقول ما
 *      تقوله لوحة المنصة عن الباقة نفسها.
 */
export const publicPlanEntitlementSchema = z.object({
  kind: platformEntitlementKindSchema,
  key: z.string(),
  value: platformEntitlementValueSchema,
  labelAr: z.string(),
  labelEn: z.string(),
});
export type PublicPlanEntitlement = z.infer<typeof publicPlanEntitlementSchema>;

export const publicPlanSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  interval: platformPlanIntervalSchema,
  /** السعر كما هو مكتوب في المنصة (نصٌّ لا `number` — المال في هذا المستودع نصّ). */
  amount: z.string(),
  currency: z.string(),
  /** المكافئ الشهري: أساس مقارنة الشهري بالسنوي وترتيب البطاقات. */
  monthlyAmount: z.string(),
  /** ما يُدفع فعلاً في السنة: مبلغ السنوية، أو الشهرية × 12 — تُقاس عليه نسبة التوفير. */
  annualAmount: z.string(),
  entitlements: z.array(publicPlanEntitlementSchema),
});
export type PublicPlan = z.infer<typeof publicPlanSchema>;

// ------------------------------------------------------------------ subscriptions

export const platformSubscriptionSchema = z.object({
  id: uuidSchema,
  status: platformSubscriptionStatusSchema,
  provider: z.string(),
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  tenantStatus: z.string(),
  planId: uuidSchema,
  planCode: z.string(),
  planName: z.string(),
  amount: z.string(),
  currency: z.string(),
  interval: platformPlanIntervalSchema,
  monthlyAmount: z.string(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  resumedAt: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canceledReason: z.string().nullable(),
  billingEmail: z.string().nullable(),
  notes: z.string().nullable(),
  activatedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  createdAt: z.string(),
  /** فواتير هذا الترخيص غير المسدَّدة — يراها المشغّل قبل أن يبقي أو يلغي. */
  dueInvoiceCount: z.number().int(),
});
export type PlatformSubscription = z.infer<typeof platformSubscriptionSchema>;

export const platformSubscriptionGrantSchema = z.object({
  tenantId: uuidSchema,
  planId: uuidSchema,
  /** مدة الترخيص بالأشهر — تُضاف إلى اليوم. */
  months: z.number().int().min(1).max(60).default(12),
  /** بدءٌ بتجربة بلا فاتورة: أيام التجربة قبل أن يصير الترخيص فعّالاً. */
  trialDays: z.number().int().min(0).max(90).default(0),
  billingEmail: z.string().trim().email().max(160).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type PlatformSubscriptionGrant = z.infer<typeof platformSubscriptionGrantSchema>;

export const platformSubscriptionChangePlanSchema = z.object({
  planId: uuidSchema,
  reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
});
export type PlatformSubscriptionChangePlan = z.infer<typeof platformSubscriptionChangePlanSchema>;

export const platformSubscriptionPauseSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type PlatformSubscriptionPause = z.infer<typeof platformSubscriptionPauseSchema>;

export const platformSubscriptionResumeSchema = platformSubscriptionPauseSchema;
export type PlatformSubscriptionResume = z.infer<typeof platformSubscriptionResumeSchema>;

export const platformSubscriptionCancelSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  /** `true` = ينتهي بانتهاء المدة المدفوعة، لا فوراً. */
  atPeriodEnd: z.boolean().default(false),
});
export type PlatformSubscriptionCancel = z.infer<typeof platformSubscriptionCancelSchema>;

/** نتيجة تغيير الباقة: ما حُسب، وما أُصدر من مستند، وكيف صار الترخيص. */
export const platformProrationSchema = z.object({
  periodDays: z.number().int(),
  remainingDays: z.number().int(),
  fromPlanCode: z.string(),
  toPlanCode: z.string(),
  /** رصيد الباقة القديمة عن الأيام التي لن تُستهلك. */
  credit: z.string(),
  /** سعر الباقة الجديدة كاملاً — المدة الجديدة تبدأ من الآن. */
  charge: z.string(),
  /** `charge − credit` — موجب ⇒ فاتورة، سالب ⇒ إشعار دائن، صفر ⇒ لا مستند. */
  net: z.string(),
  currency: z.string(),
});
export type PlatformProration = z.infer<typeof platformProrationSchema>;

export const platformPlanChangeResultSchema = z.object({
  subscription: platformSubscriptionSchema,
  proration: platformProrationSchema,
  invoiceId: uuidSchema.nullable(),
  invoiceNumber: z.string().nullable(),
  /** `null` حين يكون الفرق صفراً: لا مستند لحركةٍ لا مال فيها. */
  invoiceKind: platformInvoiceKindSchema.nullable(),
});
export type PlatformPlanChangeResult = z.infer<typeof platformPlanChangeResultSchema>;

// ------------------------------------------------------------------ audit

/**
 * أفعال هذا الجزء في سجل التدقيق — بنفس صيغة `operatorAuditActions`: الاسم `وحدة.فعل`،
 * والوحدة تصف **الشيء المتأثّر** لا الشاشة التي ضُغط فيها الزر. المستندات لها وحدة واحدة
 * (`platform_invoice`) لأن سؤال المدقّق «من ألغى هذه الفاتورة؟» لا يبدأ من الشاشة.
 */
export const billingAuditActions = {
  PLAN_CREATE: 'plan.create',
  PLAN_UPDATE: 'plan.update',
  PLAN_ENTITLEMENTS: 'plan.entitlements_update',
  SUBSCRIPTION_GRANT: 'subscription.grant',
  SUBSCRIPTION_CHANGE_PLAN: 'subscription.change_plan',
  SUBSCRIPTION_PAUSE: 'subscription.pause',
  SUBSCRIPTION_RESUME: 'subscription.resume',
  SUBSCRIPTION_CANCEL: 'subscription.cancel',
  INVOICE_CREATE: 'platform_invoice.create',
  INVOICE_ISSUE: 'platform_invoice.issue',
  INVOICE_PAY: 'platform_invoice.pay',
  INVOICE_VOID: 'platform_invoice.void',
  DUNNING_RUN: 'dunning.run',
} as const;

export type BillingAuditAction = (typeof billingAuditActions)[keyof typeof billingAuditActions];

// ------------------------------------------------------------------ invoices

export const platformInvoiceLineSchema = z.object({
  lineNo: z.number().int(),
  kind: platformInvoiceLineKindSchema,
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
});
export type PlatformInvoiceLine = z.infer<typeof platformInvoiceLineSchema>;

export const platformInvoiceSchema = z.object({
  id: uuidSchema,
  kind: platformInvoiceKindSchema,
  status: platformInvoiceStatusSchema,
  number: z.string().nullable(),
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  subscriptionId: uuidSchema.nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  subtotal: z.string(),
  taxRate: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  paidAmount: z.string(),
  /** ما بقي على العميل — محسوب لا مخزَّن، فلا يتفرّق عن `total − paid`. */
  remaining: z.string(),
  buyerName: z.string(),
  buyerTaxNumber: z.string().nullable(),
  buyerEmail: z.string().nullable(),
  sellerName: z.string(),
  sellerTaxNumber: z.string().nullable(),
  sellerAddress: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  note: z.string().nullable(),
  issuedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  /** أيام التأخير عن تاريخ الاستحقاق — صفر ما لم تتأخّر. */
  daysOverdue: z.number().int(),
  createdAt: z.string(),
  payments: z.array(
    z.object({
      id: uuidSchema,
      method: platformPaymentMethodSchema,
      amount: z.string(),
      reference: z.string().nullable(),
      receiptFileId: uuidSchema.nullable(),
      gateway: z.string().nullable(),
      status: z.string(),
      receivedAt: z.string(),
      recordedByLabel: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  lines: z.array(platformInvoiceLineSchema),
});
export type PlatformInvoice = z.infer<typeof platformInvoiceSchema>;

/**
 * صفُّ القائمة: كل ما تعرضه `/invoices` بلا سطور ولا دفعات. الفصل مقصود — القائمة تُقرأ
 * لكل فاتورة، والسطور تُقرأ لفاتورةٍ واحدة حين تُفتح (وهو أيضاً ما يجعل `platformInvoiceSchema`
 * صادقاً: كائنٌ يصرّح بأنه بلا سطورٍ أصدق من كائنٍ بسطورٍ فارغة).
 */
export const platformInvoiceSummarySchema = platformInvoiceSchema.omit({
  lines: true,
  payments: true,
});
export type PlatformInvoiceSummary = z.infer<typeof platformInvoiceSummarySchema>;

export const platformInvoiceListQuerySchema = z.object({
  status: platformInvoiceStatusSchema.optional(),
  kind: platformInvoiceKindSchema.optional(),
  tenantId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PlatformInvoiceListQuery = z.infer<typeof platformInvoiceListQuerySchema>;

/** `POST /platform/invoices` — مسودّة من فترة الترخيص (أو فترة صريحة) بلا رقم بعد. */
export const platformInvoiceCreateSchema = z.object({
  subscriptionId: uuidSchema,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * الرقم الضريبي للمشتري — حقلٌ يدخله المشغّل على الفاتورة. لا يُقرأ من `company_profiles`
   * لأن ملف العميل النظامي مستأجَرُ النطاق ولا تقرأه سياسة المنصة؛ فيُدخل صريحاً ويُنسخ
   * على المستند. الرقم 15 رقماً كما تشترط هيئة الزكاة والضريبة والجمارك.
   */
  buyerTaxNumber: z
    .string()
    .trim()
    .regex(/^\d{15}$/, 'الرقم الضريبي 15 رقماً')
    .optional(),
  note: z.string().trim().max(500).optional(),
  reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
});
export type PlatformInvoiceCreate = z.infer<typeof platformInvoiceCreateSchema>;

/** `POST /platform/invoices/:id/issue` — يُخصَّص الرقم ويصير المستند ضريبيًّا. */
export const platformInvoiceIssueSchema = z.object({
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** مهلة السداد بالأيام — الافتراضي من إعداد المنصة `billing.payment_terms_days`. */
  dueInDays: z.number().int().min(0).max(180).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(500).optional(),
});
export type PlatformInvoiceIssue = z.infer<typeof platformInvoiceIssueSchema>;

/** `POST /platform/invoices/:id/pay` — يبدأ يدوياً (تحويل بنكي + مرجع + إيصال مرفوع). */
export const platformInvoicePaySchema = z.object({
  method: platformPaymentMethodSchema,
  /** جزءٌ من المبلغ = دفعة جزئية؛ تركه = سداد كامل المتبقّي. */
  amount: decimalString.optional(),
  reference: z.string().trim().max(120).optional(),
  receiptFileId: uuidSchema.optional(),
  receivedAt: z.string().optional(),
  note: z.string().trim().max(500).optional(),
});
export type PlatformInvoicePay = z.infer<typeof platformInvoicePaySchema>;

export const platformInvoiceVoidSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type PlatformInvoiceVoid = z.infer<typeof platformInvoiceVoidSchema>;

// ------------------------------------------------------------------ dunning

export const platformDunningAttemptSchema = z.object({
  id: uuidSchema,
  subscriptionId: uuidSchema,
  invoiceId: uuidSchema.nullable(),
  invoiceNumber: z.string().nullable(),
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  attemptNo: z.number().int(),
  channel: platformDunningChannelSchema,
  status: platformDunningStatusSchema,
  scheduledAt: z.string(),
  sentAt: z.string().nullable(),
  message: z.string(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
});
export type PlatformDunningAttempt = z.infer<typeof platformDunningAttemptSchema>;

export const platformDunningRunSchema = z.object({
  /** فاتورة بعينها، أو كل فاتورة متأخّرة للترخيص. */
  invoiceId: uuidSchema.optional(),
  channel: platformDunningChannelSchema.default('email'),
  reason: z.string().trim().max(500).optional(),
});
export type PlatformDunningRun = z.infer<typeof platformDunningRunSchema>;

export const platformDunningRunResultSchema = z.object({
  subscriptionId: uuidSchema,
  subscriptionStatus: platformSubscriptionStatusSchema,
  created: z.array(platformDunningAttemptSchema),
  /** فواتير متأخّرة لم تُنشأ لها محاولة (بلغت السقف) — تُعلن ولا تُسكت. */
  skipped: z.array(z.object({ invoiceId: uuidSchema, reason: z.string() })),
});
export type PlatformDunningRunResult = z.infer<typeof platformDunningRunResultSchema>;

/** سقف محاولات المتابعة قبل أن يتحوّل العميل إلى «إيقاف يدوي» — قرار الصفحة لا القاعدة. */
export const PLATFORM_DUNNING_MAX_ATTEMPTS = 3;

/** جدول المحاولات بالأيام بعد الاستحقاق: تذكير، ثم تذكير ثانٍ، ثم إنذار أخير. */
export const platformDunningLadderDays: readonly number[] = [0, 3, 7];

/** صفٌّ في «جدول التحصيل»: فاتورة متأخّرة، ودورُها في السلّم. */
export const platformDunningScheduleRowSchema = z.object({
  invoiceId: uuidSchema,
  invoiceNumber: z.string().nullable(),
  subscriptionId: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  dueDate: z.string().nullable(),
  daysOverdue: z.number().int(),
  remaining: z.string(),
  currency: z.string(),
  attemptsMade: z.number().int(),
  nextAttemptNo: z.number().int(),
  /** تاريخ المحاولة القادمة بحسب السلّم — `null` إن استُنفدت المحاولات. */
  nextAttemptAt: z.string().nullable(),
  exhausted: z.boolean(),
});
export type PlatformDunningScheduleRow = z.infer<typeof platformDunningScheduleRowSchema>;

/** `GET /platform/dunning` — المحاولات، والجدول، والسلّم الفعّال من الإعدادات. */
export const platformDunningBoardSchema = z.object({
  attempts: z.array(platformDunningAttemptSchema),
  schedule: z.array(platformDunningScheduleRowSchema),
  ladderDays: z.array(z.number().int()),
  maxAttempts: z.number().int(),
  currency: z.string(),
});
export type PlatformDunningBoard = z.infer<typeof platformDunningBoardSchema>;

// ------------------------------------------------------------------ revenue

export const platformRevenueSchema = z.object({
  currency: z.string(),
  /**
   * الإيراد الشهري المتكرّر: مجموع المكافئ الشهري للتراخيص **المتعاقَدة** (`active` و
   * `past_due`). التجربة ليست إيراداً بعد، والموقوف مؤقتاً ليس تعاقداً قائماً — وكلاهما
   * محسوبٌ في `counts` حتى لا يضيع من القراءة.
   */
  mrr: z.string(),
  arr: z.string(),
  /** ما بقي غير مسدَّد على كل فاتورة صادرة (مخصوماً منه المدفوع جزئياً). */
  outstanding: z.string(),
  /** المتأخّر وحده: غير المسدَّد على فاتورة تجاوزت تاريخ استحقاقها. */
  overdue: z.string(),
  overdueCount: z.number().int(),
  /** حين تحمل الباقات أكثر من عملة: الأرقام تخصّ `currency` وحدها، وهذا الوسم يقول ذلك. */
  mixedCurrency: z.boolean(),
  /** ما حُصِّل فعلاً هذا الشهر. */
  collectedThisMonth: z.string(),
  counts: z.object({
    active: z.number().int(),
    trialing: z.number().int(),
    pastDue: z.number().int(),
    paused: z.number().int(),
    canceled: z.number().int(),
  }),
  upcoming: z.array(
    z.object({
      invoiceId: uuidSchema,
      number: z.string().nullable(),
      tenantName: z.string(),
      dueDate: z.string().nullable(),
      total: z.string(),
      remaining: z.string(),
      daysOverdue: z.number().int(),
    }),
  ),
});
export type PlatformRevenue = z.infer<typeof platformRevenueSchema>;

// ------------------------------------------------------------------ maths

/** مقياس المال في لوحة المنصة: فلسان (نفس ما تُطبع به الفاتورة الضريبية). */
export const PLATFORM_MONEY_SCALE = 2;

const ten = (scale: number): bigint => 10n ** BigInt(scale);

/** يقرأ نصًّا عشرّياً إلى وحدات صحيحة عند مقياسٍ، بتقريب HALF_UP (نمط `invoice-math`). */
export function platformParseAmount(value: string, scale = PLATFORM_MONEY_SCALE): bigint {
  const normalized = value.trim();
  const negative = normalized.startsWith('-');
  const [whole = '0', fraction = ''] = normalized.replace(/^[+-]/, '').split('.');
  const kept = fraction.padEnd(scale, '0').slice(0, scale);
  const base = BigInt(whole || '0') * ten(scale) + BigInt(kept || '0');
  const rounded = fraction.length > scale && Number(fraction[scale]) >= 5 ? base + 1n : base;
  return negative ? -rounded : rounded;
}

/** يعيد الوحدات الصحيحة نصًّا بمنزلتين دائماً — كي تُقرأ الأرقام في الشاشة بلا مفاجأة. */
export function platformFormatAmount(value: bigint, scale = PLATFORM_MONEY_SCALE): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const raw = absolute.toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
}

/** قسمةٌ بتقريب HALF_UP على قيمتين صحيحتين (بلا كسور عائمة). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('القسمة على صفر');
  const sign = numerator < 0n === denominator < 0n ? 1n : -1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  return sign * ((n + d / 2n) / d);
}

/** المكافئ الشهري لباقة: الشهرية كما هي، والسنوية على اثني عشر. */
// واسم المعامل `sum` لا `amount`: القيمة نصٌّ عشريّ (والقاعدة تمنع `number` للمال)، لكن
// حرس المال يطارد **الاسم** أيضاً — وتسميةٌ تُلبِس القارئ تُصحَّح لا تُستثنى.
export function platformMonthlyAmount(sum: string, interval: PlatformPlanInterval): string {
  const units = platformParseAmount(sum);
  if (interval === 'month') return platformFormatAmount(units);
  return platformFormatAmount(divideHalfUp(units, 12n));
}

/** سنويٌّ من شهريّ — تستعمله لوحة الإيراد (`ARR = MRR × 12`). */
export function platformAnnualAmount(monthly: string): string {
  return platformFormatAmount(platformParseAmount(monthly) * 12n);
}

/**
 * تقويم الفترة: كم يوماً في المدة، وكم بقي منها، ورصيد القديم غير المستخدم، ومقابل الجديد،
 * والفرق بينهما.
 *
 * القاعدة — وهي قاعدة المزوّدين المعتادة، ولها بديلٌ رفضناه:
 *
 * * **رصيدٌ** = سعر الباقة القديمة × الأيام المتبقية ÷ أيام المدة. العميل دفع المدة كاملة،
 *   فما لم يستهلكه منها يُردّ إليه كرصيد.
 * * **مقابلٌ** = **سعر الباقة الجديدة كاملاً**، لأن المدة الجديدة تبدأ من الآن (سنةٌ جديدة
 *   أو شهرٌ جديد بتاريخ اليوم). والبديل الذي رفضناه: تسعير الجديدة بأيامها المتبقية من
 *   المدة القديمة، وهو ما يُنتج شهرًا بـ251 ريالاً عند الترقية من سنوي إلى شهري في منتصف
 *   السنة — سعرٌ لا مقابل له في التسعير المعروض.
 * * **الفرق** = المقابل − الرصيد: موجب ⇒ فاتورة، سالب ⇒ إشعار دائن، صفر ⇒ بلا مستند.
 *
 * والأيام تُحسب كاملةً: يوم التغيير نفسه لا يُحتسب في الرصيد (لا نطالب بأجرة يومٍ لم يبدأ).
 */
export function platformProration(input: {
  periodStart: string;
  periodEnd: string;
  at: string;
  fromPlan: { code: string; amount: string; interval: PlatformPlanInterval };
  toPlan: { code: string; amount: string; interval: PlatformPlanInterval };
  currency: string;
}): PlatformProration {
  const day = 86_400_000;
  const start = Date.parse(`${input.periodStart.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${input.periodEnd.slice(0, 10)}T00:00:00Z`);
  const at = Date.parse(`${input.at.slice(0, 10)}T00:00:00Z`);
  const periodDays = Math.max(1, Math.round((end - start) / day));
  const remainingDays = Math.max(0, Math.min(periodDays, Math.round((end - at) / day)));

  const credit = divideHalfUp(platformParseAmount(input.fromPlan.amount) * BigInt(remainingDays), BigInt(periodDays));
  const charge = platformParseAmount(input.toPlan.amount);

  return {
    periodDays,
    remainingDays,
    fromPlanCode: input.fromPlan.code,
    toPlanCode: input.toPlan.code,
    credit: platformFormatAmount(credit),
    charge: platformFormatAmount(charge),
    net: platformFormatAmount(charge - credit),
    currency: input.currency,
  };
}

/** تاريخ الإصدار + مهلة السداد بالأيام → تاريخ الاستحقاق (`YYYY-MM-DD`). */
export function platformDueDate(issueDate: string, dueInDays: number): string {
  const base = Date.parse(`${issueDate.slice(0, 10)}T00:00:00Z`) + dueInDays * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** أيام التأخير عن الاستحقاق (سالب = لم يحن بعد). */
export function platformDaysOverdue(dueDate: string | null, at = new Date()): number {
  if (!dueDate) return 0;
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((today - due) / 86_400_000));
}
