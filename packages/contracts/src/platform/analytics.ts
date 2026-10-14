import { z } from 'zod';

/**
 * P-C12 — «التحليلات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * «أن ترى المنصة نفسها كما يراها عملاؤها». وهذا الجزء **لا يخترع أرقاماً جديدة**: كل رقم فيه
 * يُقرأ من مسارٍ قائم، و**التعريفات تُسافِر مع الأرقام** (`definitions` في كل شكل) لأن الرقم
 * بلا تعريفه يصير دعاية. وثلاثة قرارات تُقرأ من هذه العقود:
 *
 *   1. **MRR/ARR ليسا هنا.** يُقرآن من `platformRevenueSchema` (P-C4) نفسه — تعريفٌ واحد
 *      للسطحين، فلا يظهر في اللوحة رقمان لـ«الإيراد الشهري» يختلفان باختلاف الشاشة.
 *   2. **التسرّب يُقاس مرّتين**: بالشعارات (`logo`) وبالمال (`revenue`) — لأن عميلاً واحداً
 *      كبيراً يسقط فيُظهر تسرّباً مالياً لا يوازيه تسرّبٌ في العدد، والعكس.
 *   3. **القمع يُقاس بالمهل لا بالأعداد وحدها**: عدد من وصل كل خطوة **ووسيط الأيام** من
 *      التسجيل إليها — فقمعٌ يعبره الجميع في شهرٍ ليس كقمعٍ يعبره نصفهم في يوم.
 */

// ─────────────────────────────────────────────────────────────────────────────
// التنبيهات — إشاراتٌ من بياناتٍ قائمة، ولكلٍّ سببُه ورابطُه
// ─────────────────────────────────────────────────────────────────────────────

export const analyticsAlertSeverities = ['info', 'warning', 'critical'] as const;
export type AnalyticsAlertSeverity = (typeof analyticsAlertSeverities)[number];

/**
 * أنواع التنبيه — كل نوع **له مُنتِجٌ في القاعدة** (لا نوعٌ بلا مصدر):
 *
 *   * `trial_ending` من `tenant_subscriptions.trial_ends_at`
 *   * `past_due` من حالة الترخيص + `platform_invoices.due_date`
 *   * `quota_near_limit` من `usage_counters` مقابل `billing_plan_entitlements` (P-C5)
 *   * `never_activated` من `tenants.created_at` بلا ترخيصٍ حَيّ
 *   * `silent_tenant` من غياب أي فاتورة مبيعاتٍ مرحَّلة خلال النافذة
 *   * `webhook_failing` من `webhook_deliveries.status = 'failed'` (P-C11)
 */
export const analyticsAlertKinds = [
  'trial_ending',
  'past_due',
  'quota_near_limit',
  'never_activated',
  'silent_tenant',
  'webhook_failing',
] as const;
export type AnalyticsAlertKind = (typeof analyticsAlertKinds)[number];

export const analyticsAlertSchema = z.object({
  kind: z.enum(analyticsAlertKinds),
  severity: z.enum(analyticsAlertSeverities),
  count: z.number().int().nonnegative(),
  /** ما يعنيه التنبيه بالعربية كما سيُعرض — يُكتب هنا ليُقاس في السبيك لا في الشاشة. */
  title: z.string(),
  /** حيث يُتصرَّف: مسارٌ في اللوحة (`/tenants` أو `/dunning` …) لا نصٌّ عام. */
  href: z.string(),
  /** أمثلةٌ بأسمائها (حتى خمسة) — تنبيهٌ بلا اسمٍ لا يُتابَع. */
  examples: z.array(z.object({ label: z.string(), detail: z.string() })).max(5),
});
export type AnalyticsAlert = z.infer<typeof analyticsAlertSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// النظرة العامة
// ─────────────────────────────────────────────────────────────────────────────

export const analyticsMrrPointSchema = z.object({
  month: z.string(),
  mrr: z.string(),
  newValue: z.string(),
  churnedValue: z.string(),
  netValue: z.string(),
});
export type AnalyticsMrrPoint = z.infer<typeof analyticsMrrPointSchema>;

export const analyticsChurnPointSchema = z.object({
  month: z.string(),
  /** المتعاقدون في أوّل الشهر — المقام، ويُعرض ليُتأكَّد من القسمة لا ليُخفى. */
  baseCount: z.number().int().nonnegative(),
  baseValue: z.string(),
  churnedCount: z.number().int().nonnegative(),
  churnedValue: z.string(),
  /**
   * `churnedCount / baseCount` — كنسبةٍ مئوية بمنزلتين، و**`null` حين لا مقام**: شهرٌ لم يكن
   * فيه متعاقدٌ واحد لا «تسرّب 0%» فيه بل «لا نسبة». والصفر هنا كذبٌ صغير يُتّخذ قراراً.
   */
  logoRate: z.number().nullable(),
  revenueRate: z.number().nullable(),
});
export type AnalyticsChurnPoint = z.infer<typeof analyticsChurnPointSchema>;

export const analyticsUsageMetricSchema = z.object({
  metric: z.string(),
  label: z.string(),
  unit: z.string(),
  limit: z.number().nullable(),
  average: z.number().nonnegative(),
  peak: z.number().nonnegative(),
  /** `average / limit` كنسبةٍ مئوية — `null` حين لا حدّ (باقةٌ بلا سقفٍ لهذا المقياس). */
  utilization: z.number().nullable(),
});
export type AnalyticsUsageMetric = z.infer<typeof analyticsUsageMetricSchema>;

export const analyticsUsageByPlanSchema = z.object({
  planCode: z.string(),
  planName: z.string(),
  tenants: z.number().int().nonnegative(),
  metrics: z.array(analyticsUsageMetricSchema),
});
export type AnalyticsUsageByPlan = z.infer<typeof analyticsUsageByPlanSchema>;

export const analyticsOverviewSchema = z.object({
  generatedAt: z.string(),
  currency: z.string(),
  /** من `platformRevenueSchema` (P-C4) — لا حسابٌ ثانٍ في هذه الوحدة. */
  mrr: z.string(),
  arr: z.string(),
  /** `mrr / المتعاقدين` — صفرٌ إن لم يكن ثمة متعاقد. */
  arpu: z.string(),
  // أعدادٌ لا تقبل السالب — و`netThisMonth` وحده يُسمح له بالسالب (مغادرةٌ أكثر من انضمام).
  counts: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    trialing: z.number().int().nonnegative(),
    pastDue: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
  }),
  growth: z.object({
    newThisMonth: z.number().int().nonnegative(),
    newLastMonth: z.number().int().nonnegative(),
    churnedThisMonth: z.number().int().nonnegative(),
    churnedLastMonth: z.number().int().nonnegative(),
    netThisMonth: z.number().int(),
  }),
  collection: z.object({
    outstanding: z.string(),
    overdue: z.string(),
    overdueCount: z.number().int().nonnegative(),
    collectedThisMonth: z.string(),
  }),
  trials: z.object({
    windowDays: z.number().int().positive(),
    started: z.number().int().nonnegative(),
    converted: z.number().int().nonnegative(),
    conversionRate: z.number().nonnegative().nullable(),
    endingInSevenDays: z.number().int().nonnegative(),
  }),
  mrrSeries: z.array(analyticsMrrPointSchema),
  churn: z.object({ windowMonths: z.number().int(), points: z.array(analyticsChurnPointSchema) }),
  usageByPlan: z.array(analyticsUsageByPlanSchema),
  alerts: z.array(analyticsAlertSchema),
  /** التعريفات كما حُسبت بها الأرقام — تُعرض في الشاشة، ويقيسها السبيك. */
  definitions: z.object({
    mrr: z.string(),
    churn: z.string(),
    trial: z.string(),
    activity: z.string(),
  }),
});
export type AnalyticsOverview = z.infer<typeof analyticsOverviewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// قمع التفعيل
// ─────────────────────────────────────────────────────────────────────────────

/**
 * خطوات القمع — والثالثة والرابعة **فعلُ العميل لا فعلُنا**:
 * سجّل ← فعّلنا له ترخيصاً ← رحّل أوّل فاتورة مبيعات ← أرسل أوّل مستند زاتكا.
 *
 * ولو قِيست الخطوة الثالثة بفاتورة المنصة (فاتورتنا عليه) لقِسنا **تحصيلنا** لا **تفعيله**،
 * وهو ما تشير إليه الخطة بقمع التفعيل؛ ولذلك تُقرأ الفاتورة من `sales_invoices` (بيانات
 * المستأجر) والزاتكا من `einvoice_submissions`.
 */
export const analyticsFunnelSteps = ['signed_up', 'activated', 'first_invoice', 'first_einvoice'] as const;
export type AnalyticsFunnelStep = (typeof analyticsFunnelSteps)[number];

export const analyticsFunnelRowSchema = z.object({
  step: z.enum(analyticsFunnelSteps),
  title: z.string(),
  tenants: z.number().int().nonnegative(),
  /** `tenants / tenants(الخطوة السابقة)` كنسبةٍ مئوية؛ الأولى `null`. */
  conversionFromPrevious: z.number().nullable(),
  /** من الخطوة الأولى إلى هذه — مقياسُ القمع الكلّي. */
  conversionFromStart: z.number().nullable(),
  /** وسيط الأيام من التسجيل إلى الخطوة (لا المتوسط — المتوسط يخفي من تأخّر شهراً). */
  medianDaysFromSignup: z.number().nullable(),
  p90DaysFromSignup: z.number().nullable(),
});
export type AnalyticsFunnelRow = z.infer<typeof analyticsFunnelRowSchema>;

export const analyticsFunnelSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number().int().positive().nullable(),
  rows: z.array(analyticsFunnelRowSchema),
});
export type AnalyticsFunnel = z.infer<typeof analyticsFunnelSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// أفواج الاحتفاظ
// ─────────────────────────────────────────────────────────────────────────────

export const analyticsCohortCellSchema = z.object({
  offset: z.number().int(),
  month: z.string(),
  /** الفوج كاملاً (مقام النسبة) — يُعرض ليُقرأ العدد لا النسبة وحدها. */
  size: z.number().int().nonnegative(),
  /** ما زال **متعاقداً** في ذلك الشهر (ترخيصٌ حَيّ في أوّله). */
  contracted: z.number().int().nonnegative(),
  /** ما **استعمل** فعلاً في ذلك الشهر: فاتورة مبيعاتٍ مرحَّلة واحدة على الأقل. */
  active: z.number().int().nonnegative(),
  contractedRate: z.number(),
  activeRate: z.number(),
});
export type AnalyticsCohortCell = z.infer<typeof analyticsCohortCellSchema>;

export const analyticsCohortRowSchema = z.object({
  cohort: z.string(),
  size: z.number().int().nonnegative(),
  cells: z.array(analyticsCohortCellSchema),
});
export type AnalyticsCohortRow = z.infer<typeof analyticsCohortRowSchema>;

export const analyticsCohortsSchema = z.object({
  generatedAt: z.string(),
  /** فوج التسجيل أم فوج التفعيل — الشاشة تقول أيّهما تعرض. */
  basis: z.enum(['signup', 'activation']),
  months: z.number().int().positive(),
  rows: z.array(analyticsCohortRowSchema),
});
export type AnalyticsCohorts = z.infer<typeof analyticsCohortsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// تصدير CSV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * أعمدة الملف — إنجليزيةٌ (ملفٌ يُفتح في جدول)، والعنوان العربي في الشاشة. وهي **نفس** ما
 * يُصدَّر فعلاً: يوجد اختبارٌ في السبيك يقارن هذه القائمة بسطر الترويسة الذي يخرج من الخدمة،
 * لأن عقداً يقول «هذه أعمدة الملف» وملفٌ يقول غيرها أسوأ من غياب العقد.
 *
 * ولا عمودَ إيرادٍ هنا عمداً: الإيراد مقياسُ منصةٍ لا مقياسُ منشأة، ومكانه `overview`.
 */
export const analyticsExportColumns = [
  'tenant_code',
  'tenant_name',
  'tenant_status',
  'plan_code',
  'subscription_status',
  'activated_at',
  'monthly_value',
  'currency',
  'invoice_count_window',
  'einvoice_count_window',
  'last_invoice_at',
  'days_since_last_invoice',
  'peak_utilization_percent',
  'open_alerts',
] as const;
export type AnalyticsExportColumn = (typeof analyticsExportColumns)[number];

/**
 * نوافذ الطلب — مُقنَّنة في العقد لا في كل سطح: الشاشة والسكربت والاختبار يطلبون الشيء نفسه،
 * وحدٌّ واحد يمنع طلب «كل التاريخ» الذي يجعل النداء ينمو بلا سقف.
 */
export const analyticsMonthsQuerySchema = z.coerce.number().int().min(3).max(24);
export const analyticsDaysQuerySchema = z.coerce.number().int().min(7).max(365);
export const analyticsCohortBasisSchema = z.enum(['signup', 'activation']);

export const analyticsExportQuerySchema = z.object({
  /** نافذة القياس بالأيام (1..365) — تُكتب في أوّل سطرٍ من الملف أيضاً. */
  days: z.coerce.number().int().min(1).max(365).optional(),
});
export type AnalyticsExportQuery = z.infer<typeof analyticsExportQuerySchema>;
