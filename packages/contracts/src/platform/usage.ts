import { z } from 'zod';

import { uuidSchema } from '../ids.js';

/**
 * P-C5 — «الاستخدام والحصص» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * هذا الملف هو **فهرس المقاييس** الذي يقرأ منه الطرفان: الخدمة تقيس به، والشاشات تعرض به،
 * والاختبارات تتحقّق من أن كل مقياسٍ له حدٌّ في فهرس الإعدادات (P-C1) ومن أن الحدود الافتراضية
 * داخلة في مداها. فلا يوجد مقياس في الشاشة لا يعرفه الـAPI، ولا حدّ في الـAPI لا تعرضه الشاشة.
 *
 * **ثلاثة قرارات تحكم الملف** (وكلّها مصرَّح بها في تقرير الجزء):
 *
 *   1. **القياس مصدره الحقيقة لا عدّاد موازٍ.** ستة مقاييس تُقرأ **حيّةً** من جداولها
 *      (`memberships` · `branches` · `items` · `sales_invoices` · `whatsapp_messages` ·
 *      `files`)، فلا يمكن أن يختلف «المستخدمون» في شاشة الحصص عن دليل المستخدمين. والمقياسان
 *      اللذان لا جدول لهما (`api_calls_per_day` · `email_sends_per_month`) يُقاسان بعدّادٍ في
 *      `usage_counters` يزيده الطلب نفسه (اعتراضٌ عام) — والبريد يبقى صفراً حتى P-C6، ولا
 *      ندّعي إرسالاً لم يقع.
 *   2. **الحدّ الافتراضي يُبلَّغ عنه ولا يُطبَّق.** `limits.max_branches` الافتراضي في الفهرس
 *      هو `1`: لو طبّقناه لَمُنع الفرع الثاني على كل عميلٍ قائم لحظة نشر P-C5 — والفهرس
 *      يصف **مغلّف منشأةٍ جديدة**، لا قراراً وضعه مشغّل. فالتطبيق يبدأ عند حدٍّ له مصدر
 *      (`tenant` تجاوز العميل، أو `platform` افتراضٌ كتبه المشغّل)، والافتراضي يُعرض كنسبةٍ
 *      ووصفٍ فقط. `enforced` في كل بند يقول أيّهما هذا.
 *   3. **النسب واحدة في كل الأسطح**: 80٪ ناعم (إشعار + راية) و100٪ صلب (رفض برمز
 *      `USAGE_LIMIT_REACHED`) — والرمز واحد لكل المقاييس، والفرق في الرسالة لا في العقد.
 */

export const usageMetricKeys = [
  'users',
  'branches',
  'items',
  'invoices_per_month',
  'storage_mb',
  'api_calls_per_day',
  'whatsapp_per_month',
  'email_sends_per_month',
] as const;

export type UsageMetricKey = (typeof usageMetricKeys)[number];

/** `derived` — تُقرأ من جدول الحقيقة وقت السؤال. `counter` — من `usage_counters`. */
export type UsageMetricSource = 'derived' | 'counter';

/** `total` تراكمي · `day` يُصفَّر كل يوم · `month` يُصفَّر كل شهر. */
export type UsageMetricPeriod = 'day' | 'month' | 'total';

export type UsageMetricDefinition = {
  key: UsageMetricKey;
  labelAr: string;
  labelEn: string;
  /** الوحدة المعروضة بعد الرقم. */
  unitAr: string;
  period: UsageMetricPeriod;
  /** مفتاح الحدّ في `platform_settings` (P-C1) — لكل مقياسٍ حدٌّ يضبطه المشغّل. */
  limitKey: string;
  source: UsageMetricSource;
  /** أين يقع الرفض فعلاً — وصفٌ للشاشة يمنع وعداً لا وجود له. */
  enforcedAtAr: string;
};

/**
 * الفهرس الثمانية — الترتيب نفسه في الشاشات الثلاث (شبكة اللوحة · بطاقة العميل ·
 * إعدادات العميل)، فلا تتفق شاشتان على ترتيبٍ مختلف لنفس الأرقام.
 */
export const usageMetricRegistry: readonly UsageMetricDefinition[] = [
  {
    key: 'users',
    labelAr: 'المستخدمون',
    labelEn: 'Users',
    unitAr: 'مستخدم',
    period: 'total',
    limitKey: 'limits.max_users',
    source: 'derived',
    enforcedAtAr: 'عند إنشاء عضوية جديدة',
  },
  {
    key: 'branches',
    labelAr: 'الفروع',
    labelEn: 'Branches',
    unitAr: 'فرع',
    period: 'total',
    limitKey: 'limits.max_branches',
    source: 'derived',
    enforcedAtAr: 'عند إنشاء فرع',
  },
  {
    key: 'items',
    labelAr: 'الأصناف',
    labelEn: 'Items',
    unitAr: 'صنف',
    period: 'total',
    limitKey: 'limits.max_items',
    source: 'derived',
    enforcedAtAr: 'عند إنشاء صنف',
  },
  {
    key: 'invoices_per_month',
    labelAr: 'فواتير الشهر',
    labelEn: 'Invoices / month',
    unitAr: 'فاتورة',
    period: 'month',
    limitKey: 'limits.max_invoices_per_month',
    source: 'derived',
    enforcedAtAr: 'عند إنشاء فاتورة بيع',
  },
  {
    key: 'storage_mb',
    labelAr: 'التخزين',
    labelEn: 'Storage',
    unitAr: 'م.ب',
    period: 'total',
    limitKey: 'limits.max_storage_mb',
    source: 'derived',
    enforcedAtAr: 'عند طلب رفع ملف',
  },
  {
    key: 'api_calls_per_day',
    labelAr: 'استدعاءات الـAPI',
    labelEn: 'API calls / day',
    unitAr: 'استدعاء',
    period: 'day',
    limitKey: 'limits.max_api_calls_per_day',
    source: 'counter',
    enforcedAtAr: 'عند كل طلب بعد الحدّ',
  },
  {
    key: 'whatsapp_per_month',
    labelAr: 'رسائل واتساب',
    labelEn: 'WhatsApp messages / month',
    unitAr: 'رسالة',
    period: 'month',
    limitKey: 'limits.max_whatsapp_per_month',
    source: 'derived',
    enforcedAtAr: 'عند إرسال رسالة',
  },
  {
    key: 'email_sends_per_month',
    labelAr: 'إرسالات البريد',
    labelEn: 'E-mails / month',
    unitAr: 'رسالة',
    period: 'month',
    limitKey: 'limits.max_emails_per_month',
    source: 'counter',
    enforcedAtAr: 'عند إرسال بريد (P-C6)',
  },
];

export function usageMetricDefinition(key: UsageMetricKey): UsageMetricDefinition {
  const found = usageMetricRegistry.find((entry) => entry.key === key);
  // الفهرس ثابت في هذا الملف، والمفتاح مُشتقٌّ منه، فهذا لا يقع إلا بخطأ تحرير.
  if (!found) throw new Error(`unknown usage metric: ${key}`);
  return found;
}

/** الحدّ الناعم في خطة §4: 80٪. */
export const usageSoftThresholdPercent = 80;

export const usageMetricStateSchema = z.enum(['ok', 'soft', 'hard', 'unlimited']);
export type UsageMetricState = z.infer<typeof usageMetricStateSchema>;

/** `used / limit` بالنسبة المئوية مقرَّبة — و`null` حين لا حدّ. */
export function usagePercentUsed(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  // حدٌّ صفر: أي استهلاك يعني التجاوز، وصفر استهلاك يعني الوقوف على الحدّ بالضبط.
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.round((used / limit) * 100);
}

/**
 * الحالة من الرقمين وحدهما: لا شيء آخر يقرّر «ناعم» أو «صلب»، فالاختبار يمكنه أن يقيس
 * الحالة بلا شاشة، والشاشة لا تجتهد في حسابها.
 */
export function usageStateFor(used: number, limit: number | null): UsageMetricState {
  if (limit === null) return 'unlimited';
  if (used >= limit) return 'hard';
  const percent = usagePercentUsed(used, limit) ?? 0;
  return percent >= usageSoftThresholdPercent ? 'soft' : 'ok';
}

/** «2026-09» — الشهر الذي يخصّه القياس. */
export const usagePeriodSchema = z.string().regex(/^\d{4}-\d{2}$/);

export function usagePeriodOf(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** حدود الشهر كما تعيدها القاعدة عند قراءة الفترة (`YYYY-MM-DD`). */
export const usagePeriodRangeSchema = z.object({
  period: usagePeriodSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
});

export const usageSeriesPointSchema = z.object({
  day: z.string(),
  count: z.number().int(),
});

/**
 * بندٌ واحد في شبكة الاستخدام. `limitSource` هي مفردات P-C2 نفسها، و`enforced` تقول أيقع
 * الرفض عند هذا الحدّ أم أنّه مغلّفٌ افتراضي يُبلَّغ عنه فقط (القرار 2 أعلاه).
 */
export const usageMetricUsageSchema = z.object({
  key: z.enum(usageMetricKeys),
  labelAr: z.string(),
  unitAr: z.string(),
  period: z.enum(['day', 'month', 'total']),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  limitSource: z.enum(['tenant', 'platform', 'default']),
  percentUsed: z.number().int().nonnegative().nullable(),
  state: usageMetricStateSchema,
  enforced: z.boolean(),
  /** إشعارٌ عربي جاهز حين تكون الحالة `soft` (أو `hard`) — نصٌّ واحد لا يكتبه كل سطح. */
  noticeAr: z.string().nullable(),
  /** أين يقع الرفض فعلاً (وصفٌ من الفهرس). */
  enforcedAtAr: z.string(),
});
export type UsageMetricUsage = z.infer<typeof usageMetricUsageSchema>;

/** لقطة استخدام منشأةٍ واحدة — تخدم سطح المنصة وسطح العميل بالشكل نفسه. */
export const usageSnapshotSchema = z.object({
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  /** حالة المنشأة (`active` · `suspended` · `archived`) — البطاقة تعرضها بجانب الأرقام. */
  tenantStatus: z.string(),
  period: usagePeriodSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  metrics: z.array(usageMetricUsageSchema),
  /** سلسلة استدعاءات الـAPI لثلاثين يوماً — الرسم الوحيد الذي له سلسلة زمنية بمصدرٍ حقيقي. */
  apiCallsPerDay: z.array(usageSeriesPointSchema),
  generatedAt: z.string(),
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

/** صفّ عميلٍ في شبكة `/usage`. */
export const platformUsageGridRowSchema = z.object({
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  status: z.string(),
  metrics: z.array(usageMetricUsageSchema),
  /** أسوأ حالة في الصفّ — ترتيب العرض في الشاشة يقوم عليها. */
  worst: usageMetricStateSchema,
  softCount: z.number().int().nonnegative(),
  hardCount: z.number().int().nonnegative(),
});
export type PlatformUsageGridRow = z.infer<typeof platformUsageGridRowSchema>;

export const platformUsageGridResponseSchema = z.object({
  period: usagePeriodSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  tenants: z.array(platformUsageGridRowSchema),
  totals: z.object({
    tenants: z.number().int().nonnegative(),
    soft: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    apiCallsToday: z.number().int().nonnegative(),
    invoicesThisMonth: z.number().int().nonnegative(),
  }),
  generatedAt: z.string(),
});
export type PlatformUsageGridResponse = z.infer<typeof platformUsageGridResponseSchema>;

/**
 * أفعال التدقيق التي يكتبها هذا الجزء. الاسم بصيغة `usage.*` لأن التدقيق العابر للمستأجرين
 * (P-C1) يبحث بالفعل، ولأن الرفض يجب أن يُقرأ لا أن يُخمَّن.
 */
export const usageAuditActions = {
  softLimit: 'usage.soft_limit',
  limitReached: 'usage.limit_reached',
} as const;
