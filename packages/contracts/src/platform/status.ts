import { z } from 'zod';

/**
 * P-M9 — **حالة الخدمة العلنية** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * صفحة `/status` في الموقع تقرأ **مجسّات P-C9 نفسها** التي يقرأها فريق التشغيل في اللوحة،
 * وتعرض نتيجتها على العملاء. وهذا الملف يقفل ثلاثة قرارات لا يجوز أن تُخترع في الشاشة:
 *
 *   1. **مفردات الحالة أربع لا ثلاث**: `up` · `degraded` · `down` · `not_configured`.
 *      و«غير مُهيّأ» **ليست عطلاً**: بيئةُ تطويرٍ بلا Redis وتخزينٍ كائني ليست «متوقّفة»،
 *      وقولُ «متوقّفة» عنها كذبٌ يُقلق العميل، وقولُ «تعمل» كذبٌ يُخفي حقيقةَ ما يُقاس.
 *   2. **المكوّنات العلنية خمسة، وتسمياتها عربيةٌ مكتوبة هنا لا في الشاشة**: المنصّة ·
 *      قاعدة البيانات · المهام الخلفية · البريد والتذكيرات · الملفات. وما لا يخصّ العميل
 *      (طابورٌ داخلي، عامل، دلو تخزين، مزوّد بريد) لا يُسمّى باسمه هنا.
 *   3. **الشرح العلني ثابتٌ لكل حالة، ولا تُمرَّر تفاصيل المجسّ الداخلية أبداً.** المجسّ
 *      الداخلي يحمل رسالة خطأ القاعدة واسم الدلو وسائق الطابور؛ تمريرُها إلى صفحةٍ عامة
 *      تسريبٌ لا شفافية. فالشفافية هنا في **الصدق عن الحالة**، لا في نشر الأعطال الداخلية.
 *
 * والوعد المطبوع تحت الجدول: «ما يُعرض هنا الحالةُ لا التفاصيل، والصفحة تقرأ المنصّة نفسها
 * ولا تُخزَّن زيارتك».
 */

// ─────────────────────────────────────────────────────────────────────────────
// المفردات
// ─────────────────────────────────────────────────────────────────────────────

export const publicStatusLevels = ['up', 'degraded', 'down', 'not_configured'] as const;
export type PublicStatusLevel = (typeof publicStatusLevels)[number];

/** مفاتيح المكوّنات العلنية — تُستعمل في المسار الحيّ (`verify`) وفي الشاشة معاً. */
export const publicComponentKeys = ['platform', 'database', 'jobs', 'email', 'files'] as const;
export type PublicComponentKey = (typeof publicComponentKeys)[number];

export type PublicStatusLevelLabel = {
  labelAr: string;
  labelEn: string;
  /** صنف العرض في الموقع — نفس أصناف الشارات المستعملة في بقيّة اللوحة. */
  tone: 'ready' | 'pending' | 'failed' | 'muted';
  /** ما تعنيه الحالة للعميل — جملةٌ واحدة بلا تفاصيل داخلية. */
  noteAr: string;
  noteEn: string;
};

/**
 * معنى كل حالة **كما يُقال للعميل**. و`not_configured` مكتوبٌ فيها صراحةً أنها ليست عطلاً:
 * «غير مُهيّأة في هذه البيئة» — تُقال حين لا يكون المُحسّس مضبوطاً أصلاً.
 */
export const publicStatusLevelLabels: Record<PublicStatusLevel, PublicStatusLevelLabel> = {
  up: {
    labelAr: 'تعمل',
    labelEn: 'Operational',
    tone: 'ready',
    noteAr: 'المكوّن يعمل، وهذا آخر قياس.',
    noteEn: 'This component is healthy as of the last check.',
  },
  degraded: {
    labelAr: 'تعمل ببطء',
    labelEn: 'Degraded',
    tone: 'pending',
    noteAr: 'المكوّن يعمل لكن بعض العمليات قد تتأخّر — والفريق يرى الحالة نفسها في لوحته.',
    noteEn: 'Working, but some operations may be slower — the team sees the same state on its operations dashboard.',
  },
  down: {
    labelAr: 'متوقّفة',
    labelEn: 'Down',
    tone: 'failed',
    noteAr: 'المكوّن لا يستجيب الآن. لا تنتظر إصلاحاً من هذه الصفحة — تابع اللافتة أدناه أو راسل الدعم.',
    noteEn: 'This component is not responding now. Watch the banner below or contact support.',
  },
  not_configured: {
    labelAr: 'غير مُهيّأة',
    labelEn: 'Not configured',
    tone: 'muted',
    noteAr: 'هذه الميزة غير مُهيّأة في هذه البيئة، فلا يُقاس لها شيء — وليس هذا عطلاً.',
    noteEn: 'This capability is not configured in this environment, so nothing is measured — not an outage.',
  },
};

/** ما يقيسه كل مكوّن — يُكتب للعميل لا للمشغّل (بلا اسم محرّكٍ ولا مزوّد). */
export const publicComponentLabels: Record<
  PublicComponentKey,
  { labelAr: string; labelEn: string; whatAr: string; whatEn: string }
> = {
  platform: {
    labelAr: 'المنصّة والواجهات',
    labelEn: 'Platform and APIs',
    whatAr: 'الشاشات ونقاط النهاية التي تستعملها أنت وفريقك.',
    whatEn: 'The screens and endpoints your team uses.',
  },
  database: {
    labelAr: 'قاعدة البيانات',
    labelEn: 'Database',
    whatAr: 'حفظ الفواتير والحركات والأرصدة — وهو المكوّن الذي لا يُتسامح معه.',
    whatEn: 'Invoices, movements and balances — the component with no tolerance.',
  },
  jobs: {
    labelAr: 'المهام الخلفية',
    labelEn: 'Background jobs',
    whatAr: 'التقارير المجدولة والحملات ورسائل التنبيه التي تُنفَّذ بلا انتظار.',
    whatEn: 'Scheduled reports, campaigns and notification emails that run in the background.',
  },
  email: {
    labelAr: 'البريد والتذكيرات',
    labelEn: 'Email and reminders',
    whatAr: 'رسائل التذكير والتعريف بالدخول والفواتير البريدية.',
    whatEn: 'Reminder, verification and invoice emails.',
  },
  files: {
    labelAr: 'الملفات والمرفقات',
    labelEn: 'Files and attachments',
    whatAr: 'رفع الشعارات ومرفقات الفواتير والملفات المرفقة بالمستندات.',
    whatEn: 'Logos, invoice attachments and document files.',
  },
};

/**
 * ترتيب الأسوأ — يُحسب منه حكم الصفحة الأعلى.
 *
 * و**`not_configured` لا تُسقط الحكم**: لو حُسبت «أسوأ من `up`» لظهر في كل بيئة تطوير
 * «حالةٌ متعثّرة» بسبب ميزةٍ لم تُهيّأ بعد. والشيء الوحيد الذي يسقط الحكم هو `down`،
 * و`degraded` تسقط إلى «تعمل ببطء».
 */
export function publicStatusRollUp(levels: PublicStatusLevel[]): PublicStatusLevel {
  const measured = levels.filter((level) => level !== 'not_configured');
  if (measured.length === 0) return 'not_configured';
  if (measured.includes('down')) return 'down';
  if (measured.includes('degraded')) return 'degraded';
  return 'up';
}

/** حكم الصفحة كما تقرؤه الشاشة — والخالي من المجسّات ليس «تعمل» بل «لا شيء يُقاس». */
export const publicStatusRollUpLabels: Record<
  PublicStatusLevel,
  { labelAr: string; labelEn: string; tone: 'ready' | 'pending' | 'failed' | 'muted' }
> = {
  up: { labelAr: 'كل المكوّنات تعمل', labelEn: 'All components operational', tone: 'ready' },
  degraded: { labelAr: 'تعمل ببطء', labelEn: 'Degraded performance', tone: 'pending' },
  down: { labelAr: 'عطل جارٍ', labelEn: 'Ongoing outage', tone: 'failed' },
  not_configured: { labelAr: 'لا شيء يُقاس', labelEn: 'Nothing measured', tone: 'muted' },
};

// ─────────────────────────────────────────────────────────────────────────────
// الحمولات
// ─────────────────────────────────────────────────────────────────────────────

export const publicStatusComponentSchema = z.object({
  key: z.enum(publicComponentKeys),
  labelAr: z.string(),
  labelEn: z.string(),
  whatAr: z.string(),
  whatEn: z.string(),
  status: z.enum(publicStatusLevels),
  /** الشرح العلني للحالة — من الجدول أعلاه لا من المجسّ. */
  noteAr: z.string(),
  noteEn: z.string(),
  /** زمن الاستجابة بالمليّ ثانية إن قِيس، و`null` إن كان المجسّ لا يقيس زمناً. */
  latencyMs: z.number().nullable(),
});
export type PublicStatusComponent = z.infer<typeof publicStatusComponentSchema>;

/**
 * الحادث المفتوح — يأتي من `platform.maintenance*` في الإعدادات (P-C9)، أي من نفس المصدر
 * الذي تقرؤه لافتة اللوحة. و`null` تعني «لا حادث معلَن»، لا «لا نعرف».
 */
export const publicStatusIncidentSchema = z.object({
  message: z.string().nullable(),
  since: z.string().nullable(),
});
export type PublicStatusIncident = z.infer<typeof publicStatusIncidentSchema>;

export const publicStatusSchema = z.object({
  status: z.enum(publicStatusLevels),
  statusLabelAr: z.string(),
  statusLabelEn: z.string(),
  statusTone: z.enum(['ready', 'pending', 'failed', 'muted']),
  checkedAt: z.string(),
  uptimeSeconds: z.number().int().min(0),
  incident: publicStatusIncidentSchema.nullable(),
  components: z.array(publicStatusComponentSchema),
  /** الوعد المطبوع: ما تُعرضه الصفحة وما لا تعرضه. */
  noteAr: z.string(),
  noteEn: z.string(),
});
export type PublicStatus = z.infer<typeof publicStatusSchema>;

/** يساعد الشاشة والسكربت الحيّ: هل الجواب مقبولٌ كحالةٍ عامّة؟ (يمنع `{}` ناجحاً) */
export function publicStatusIsMeasured(status: PublicStatus): boolean {
  return status.components.length > 0 && status.components.some((c) => c.status !== 'not_configured');
}

/**
 * الوعد الذي يظهر تحت الجدول — **ثابتٌ في العقد** لأن كل واجهةٍ جديدة يجب أن تحمله،
 * ولا يجوز أن تُصاغ الجملة في مكانٍ ثانٍ فتختلف.
 */
export const PUBLIC_STATUS_NOTE_AR =
  'هذه الصفحة تقرأ مجسّات المنصّة نفسها في اللحظة، وتعرض الحالة لا التفاصيل: لا أسماء أنظمةٍ ' +
  'داخلية ولا رسائل أخطاء. وما لا يُقاس في هذه البيئة يُعلَن «غير مُهيّأ» بدل أن يُجمَّل، ' +
  'ولا تُحفظ زيارتك.';
export const PUBLIC_STATUS_NOTE_EN =
  'This page reads the platform’s own probes at the moment of your visit and shows the state, not ' +
  'the internals: no internal system names and no error messages. What is not measured here is ' +
  'declared “not configured” instead of glossed over, and your visit is not stored.';

/** رسالة اللافتة حين لا يوجد حادث — تُعرض باهتةً أسفل الجدول. */
export const PUBLIC_STATUS_CALM_AR = 'لا حادث معلَناً الآن.';
export const PUBLIC_STATUS_CALM_EN = 'No incident is declared right now.';
