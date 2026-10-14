import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { contentLocales } from './content.js';

/**
 * P-M10 — **قياس الموقع** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): «أن يُقاس أثر الموقع لا
 * أن يُخمَّن».
 *
 * وهذا الملف يقفل خمسة قرارات لا يجوز أن تُخترع في الشاشة ولا في المتصفّح:
 *
 *   1. **لا طرف ثالث.** لا وسمٌ يعبر إلى نطاقٍ آخر ولا صورةٌ من شبكةٍ إعلانية: الأحداث تُجمع في
 *      قاعدتنا عبر نقطتنا (`POST /public/events`). البديل كان خدمةً مستضافة تُضيف كوكي طرفٍ ثالث
 *      وتُخرج بيانات الزوّار من نطاقنا مقابل لوحةٍ جاهزة — وهو ثمنٌ لا يُدفع في نظامٍ يُخزّن
 *      فواتير الناس.
 *   2. **المفردات مغلقة.** أسماء الأحداث وأهداف القمع **مكتوبة هنا** لا في الشاشة: حدثٌ باسمٍ
 *      حرّ يعني يوماً ما `Signup_Start` و`signup start` و`signupStart` في ثلاث لوحات، ولا
 *      يجمعها استعلامٌ واحد. و`meta` بلا مفاتيح حرّة أيضاً (`siteEventMetaKeys`).
 *   3. **لا ما يُعرّف الناس.** لا IP ولا بريد ولا اسم ولا رقم هاتف — العقد **لا يملك حقلها**،
 *      والـ`visitor` معرّفٌ عشوائي (UUID من المتصفّح) غرضه الوحيد تمييز الزيارة عن الزيارة.
 *      وهذا يُقاس: `siteEventSchema` صارم (`.strict()`) فمفتاحٌ غريب يُردّ 400.
 *   4. **الرقم بلا تعريفه يصير دعاية** (القاعدة نفسها في P-C12): `siteAnalyticsDefinitions`
 *      يسافر مع الاستجابة، و`privacy` يقول ما يُجمع وما لا يُجمع أبداً ومدة الاحتفاظ.
 *   5. **القمع لا يُخترع**: خطواته أربع (`signup_start` → `signup_complete` · `request_demo` ·
 *      `newsletter_subscribe`) وكلٌّ منها له مُنتِجٌ في الموقع (زرٌّ أو استمارة) — لا خطوةٌ
 *      تُحسب من فراغ.
 */

// ─────────────────────────────────────────────────────────────────────────────
// المفردات
// ─────────────────────────────────────────────────────────────────────────────

/**
 * أسماء الأحداث المسموحة. و`experiment_exposure` ليست هدفاً بل **عرضاً**: تُنسَب إلى متجرٍ
 * (‏`meta.experiment` + `meta.variant`) وتُقارَن بما بعدها — وهي التي تجعل اختبار أ/ب مقيساً
 * لا مُدَّعى.
 */
export const siteEventNames = [
  'page_view',
  'signup_start',
  'signup_complete',
  'request_demo',
  'newsletter_subscribe',
  'experiment_exposure',
] as const;
export type SiteEventName = (typeof siteEventNames)[number];

/** أهداف القمع — الأحداث التي «حدث شيء ذو معنى» لا مجرّد مشاهدة. */
export const siteGoalNames = [
  'signup_start',
  'signup_complete',
  'request_demo',
  'newsletter_subscribe',
] as const;
export type SiteGoalName = (typeof siteGoalNames)[number];

/** التسميات العربية **كما تُعرض في اللوحة** — تُكتب هنا ليُقاس النصّ في السبيك لا في الشاشة. */
export const siteEventLabelsAr: Record<SiteEventName, string> = {
  page_view: 'مشاهدة صفحة',
  signup_start: 'بدء اشتراك',
  signup_complete: 'إتمام اشتراك',
  request_demo: 'طلب عرض',
  newsletter_subscribe: 'اشتراك في النشرة',
  experiment_exposure: 'عرض تجربة',
};

/**
 * مفاتيح `meta` المسموحة — قائمةٌ مغلقة عمداً: الحقل الحرّ في قياسٍ مجهول يصير سجلاًّ
 * للبيانات الشخصية بعد أسبوعٍ من الاستعمال. والخمسة كلها وصفٌ للحدث لا للشخص.
 */
export const siteEventMetaKeys = ['experiment', 'variant', 'plan', 'source', 'goal'] as const;
export type SiteEventMetaKey = (typeof siteEventMetaKeys)[number];

/** أقصى عددٍ من الأحداث في النداء الواحد — «مجمَّعة» لا حدثاً بحدث. */
export const SITE_EVENTS_MAX_BATCH = 20;

/**
 * مدة الاحتفاظ بالصفوف الخام. الأرقام المجمَّعة تعيش في اللوحة، والصفّ الخام يكفي أن يبقى
 * ما دام له معنى تشغيليّ (نصف سنة تغطّي المقارنات الموسمية الأساسية).
 */
export const SITE_EVENTS_RETENTION_DAYS = 180;

/** الوعد المطبوع في شاشة اللوحة — يُحمل في الاستجابة (`privacy`) ليُقاس لا ليُكتب في الشاشة. */
export const SITE_ANALYTICS_PRIVACY_NOTE_AR =
  'أحداثٌ مجهولة الهوية بعد موافقة الزائر: لا عنوان IP ولا بريد ولا اسم، ولا ملفٌّ شخصيّ.';

// ─────────────────────────────────────────────────────────────────────────────
// ما يُرسله المتصفّح
// ─────────────────────────────────────────────────────────────────────────────

/**
 * حدثٌ واحد — **صارمٌ بقصد**: مفتاحٌ خارج العقد (‏`email` مثلاً) يُردّ 400 بدل أن يُخزَّن
 * بصمتٍ ثم يُكتشف بعد شهور.
 */
export const siteEventSchema = z
  .object({
    name: z.enum(siteEventNames),
    /** المسار بلا نطاق ولا معاملات — `?utm_source=` قد يحمل ما لا نريده في القاعدة. */
    path: z.string().trim().min(1).max(200),
    locale: z.enum(contentLocales).default('ar'),
    /** معرّف المتصفّح العشوائي (‏UUID من `localStorage`) — ليس هوية. */
    visitor: uuidSchema,
    meta: z.record(z.enum(siteEventMetaKeys), z.string().trim().max(120)).optional(),
  })
  .strict();
export type SiteEvent = z.infer<typeof siteEventSchema>;

/** جسم النداء: دفعةٌ واحدة (١..٢٠ حدثاً) — والدفعة تحدّ الطلبات أيضاً. */
export const publicEventsBatchSchema = z
  .object({ events: z.array(siteEventSchema).min(1).max(SITE_EVENTS_MAX_BATCH) })
  .strict();
export type PublicEventsBatch = z.infer<typeof publicEventsBatchSchema>;

/** مخرج النداء: ما قُبل فقط — بلا عدّادٍ يُطمئن ولا صفٍّ يُعاد. */
export const publicEventsAcceptedSchema = z.object({ accepted: z.number().int().nonnegative() });
export type PublicEventsAccepted = z.infer<typeof publicEventsAcceptedSchema>;

/** رسالة القبول — تُعرض في السبيك ولا تُبنى في الشاشة. */
export const PUBLIC_EVENTS_ACCEPTED_AR = 'قُبلت الأحداث.';

// ─────────────────────────────────────────────────────────────────────────────
// ما يقرأه المشغّل
// ─────────────────────────────────────────────────────────────────────────────

/**
 * نافذة القياس بالأيام: ٧ حدّاً أدنى (فما دونها ضجيج) و٣٦٥ أقصى (وما فوقها خِزَمٌ لا تفاصيل).
 * والمخطّطان اثنان عن قصد: **حقلٌ** يُمرَّر إلى `@Query('days')` و**جسمٌ** يصف الاستعلام كله
 * — وخلطهما يعطي 400 على طلبٍ سليم (وقع فعلاً قبل أن يُصلَح).
 */
export const siteAnalyticsDaysSchema = z.coerce.number().int().min(7).max(365).default(30);
export const siteAnalyticsQuerySchema = z.object({ days: siteAnalyticsDaysSchema });
export type SiteAnalyticsQuery = z.infer<typeof siteAnalyticsQuerySchema>;

/**
 * نسبةٌ مئوية بمنزلةٍ واحدة. وتُحسب في **العقد** لا في SQL ولا في الشاشة: تعريفٌ واحد للنسبة،
 * والصفر في المقام يعطي صفراً بدل `Infinity` أو `NaN` (وهو ما يُفسد لوحةً كاملة).
 */
export function siteConversionPct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export type SiteGoalRow = {
  name: SiteGoalName;
  labelAr: string;
  /** زوّارٌ مميّزون بلغوا هذه الخطوة — لا عددُ نقرات. */
  visitors: number;
  /** كل الأحداث، فالنقرُ المزدوج يظهر فرقاً بينه وبين الزوّار. */
  events: number;
  /** نسبة من رأى صفحةً إلى من بلغ الخطوة (`siteConversionPct`). */
  ratePct: number;
};

export type SiteSeriesPoint = { day: string; visitors: number; views: number };
export type SiteReferrerRow = { host: string; visitors: number };
export type SitePathRow = { path: string; visitors: number; views: number };
export type SiteVariantRow = {
  key: string;
  exposures: number;
  converters: number;
  ratePct: number;
};
export type SiteExperimentRow = { experiment: string; variants: SiteVariantRow[] };

/** تعريفٌ لكل رقم في الشاشة — «الرقم بلا تعريفه يصير دعاية». */
export type SiteAnalyticsDefinition = { key: string; labelAr: string; definitionAr: string };

export const siteAnalyticsDefinitions: SiteAnalyticsDefinition[] = [
  {
    key: 'visitors',
    labelAr: 'الزوّار',
    definitionAr: 'عدد المعرّفات العشوائية المختلفة التي أرسلت حدثاً واحداً على الأقل في النافذة.',
  },
  {
    key: 'views',
    labelAr: 'المشاهدات',
    definitionAr: 'عدد أحداث `page_view` — والزائر الواحد يُحسب في كل صفحة يزورها.',
  },
  {
    key: 'goals',
    labelAr: 'الأهداف',
    definitionAr: 'زوّارٌ بلغوا خطوةً ذات معنى (بدء اشتراك · إتمامه · طلب عرض · النشرة)، والنسبة من زوّار النافذة.',
  },
  {
    key: 'sources',
    labelAr: 'المصادر',
    definitionAr: 'عائل الموقع المُحيل (`referrer`) لا رابطه الكامل — ولا يُخزَّن ما بعده.',
  },
  {
    key: 'experiments',
    labelAr: 'تجارب أ/ب',
    definitionAr: 'من رأى نسخةً (`experiment_exposure`) ومَن بدأ اشتراكاً بعدها — التوزيع يحسبه المتصفّح من معرّفه العشوائي.',
  },
];

export type SiteAnalytics = {
  window: { days: number; from: string; to: string };
  visitors: { all: number; today: number };
  views: { all: number; today: number };
  goals: SiteGoalRow[];
  series: SiteSeriesPoint[];
  sources: SiteReferrerRow[];
  paths: SitePathRow[];
  experiments: SiteExperimentRow[];
  privacy: {
    noteAr: string;
    retentionDays: number;
    /** ما يُخزَّن حرفياً — يُقرأ من العقد في الشاشة فلا تتخلّف عن الواقع. */
    collected: string[];
    /** ما لا يُخزَّن أبداً — القائمة التي يُقاس عليها. */
    never: string[];
  };
  definitions: SiteAnalyticsDefinition[];
  generatedAt: string;
};

/** ما يُخزَّن وما لا يُخزَّن — تُحمل في الاستجابة وتُقاس في السبيك حرفياً. */
export const SITE_ANALYTICS_COLLECTED = [
  'اسم الحدث والمسار',
  'اللغة',
  'عائل الموقع المُحيل',
  'معرّف متصفّحٍ عشوائي (UUID)',
  'وصفٌ من مفاتيح مغلقة (تجربة · باقة · مصدر)',
] as const;

export const SITE_ANALYTICS_NEVER = [
  'عنوان IP',
  'البريد الإلكتروني أو الاسم أو الهاتف',
  'معرّفات أجهزة أو بصمات متصفّح',
  'إحداثيات أو بيانات دفع',
  'محتوى الحقول المكتوبة في الاستمارات',
] as const;
