import { z } from 'zod';

import { paginationQuerySchema } from '../pagination.js';

/**
 * P-M7 — «الحملات البريدية» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5، السطر P-M7):
 * *رعاية العملاء المتوقّعين والتجريبيين حتى يشتركوا*.
 *
 * ثلاثة قرارات في هذا العقد قبل أي سطرِ خدمة:
 *
 *   1. **الحملة ليست رسالةً واحدة، بل شريحةٌ ونصٌّ وقرارُ إرسال.** فالكيان ثلاثة جداول:
 *      الحملة (النصّ والقرار)، ورسائلها (صفٌّ لكل مستلم — به يُعرف من وصلته الرسالة)،
 *      وأحداثها (فتحٌ ونقرٌ وإلغاءٌ — به يُعرف ما فعل). ولا يُقاس التقرير من عدّادٍ يُزاد
 *      في الذاكرة، بل من هذه الصفوف.
 *   2. **الإرسال إلى شرائحَ مختلفة ليس سواءً في الامتثال.** من اشترك في النشرة أو ملأ
 *      استمارةً ووافق على التسويق ⇒ يجوز تسويقٌ مباشر. وأصحابُ الحسابات (تجريبيّون ·
 *      نشطون · متأخّرون · متسربون) ⇒ رسائلُ خدمةٍ عن حسابهم، لا عرضُ بيعٍ جديد. فالعقد
 *      يُعلن أيّ شريحةٍ «أشخاص» وأيّها «حساب».
 *   3. **إلغاءُ الاشتراك بنقرة لا يُلتمس.** كل رسالة تحمل رابطَ إلغاءٍ واحداً يعمل بنقرة،
 *      و`List-Unsubscribe` ترويسةً (RFC 8058) — والنصّ لا يُبنى بلا هذا الرابط (انظر
 *      `campaignBodyProblems`): بنودُ الامتثال ليست اختيارية في حملة.
 *
 * والنصوص العربية في العقد لا في الشاشة، كما في P-M6: اللوحة والسكربت الحيّ والبريد
 * يقولون الشيء نفسه عن الحالة نفسها.
 */

// ═══════════════════════════════════════════════════ الشرائح

export const campaignSegments = [
  'leads',
  'subscribers',
  'trialing',
  'active',
  'past_due',
  'churned',
] as const;
export const campaignSegmentSchema = z.enum(campaignSegments);
export type CampaignSegment = z.infer<typeof campaignSegmentSchema>;

export const campaignSegmentLabelsAr: Record<CampaignSegment, string> = {
  leads: 'عملاء متوقّعون',
  subscribers: 'مشتركو النشرة',
  trialing: 'تجريبيون',
  active: 'عملاء نشطون',
  past_due: 'متأخّرون',
  churned: 'متسربون',
};

export const campaignSegmentDescriptionsAr: Record<CampaignSegment, string> = {
  leads: 'من ملأ استمارةً أو طلب عرضٍ ولم يُتابَع بعد، ووافق على التسويق.',
  subscribers: 'من أكّد اشتراكه في النشرة البريدية (تأكيدٌ مزدوج) ولم يُلغِه.',
  trialing: 'منشآتٌ في فترة التجربة — رسالةُ رعايةٍ عن حسابهم لا عرضُ بيع.',
  active: 'منشآتٌ بترخيصٍ فعّال.',
  past_due: 'منشآتٌ تأخّرت دفعاتها — رسالةُ تحصيلٍ لا ترويج.',
  churned: 'منشآتٌ أُلغيت أو انتهت — استرجاعٌ برسالةٍ واحدة.',
};

/** شرائحُ **أشخاص**: من اشترك أو وافق على التسويق. والباقي حساباتٌ مُتعاقدة. */
export const campaignPeopleSegments = ['leads', 'subscribers'] as const satisfies readonly CampaignSegment[];

export function campaignSegmentIsPeople(segment: CampaignSegment): boolean {
  return (campaignPeopleSegments as readonly CampaignSegment[]).includes(segment);
}

/** رسالةُ الحملة إلى شريحة أشخاصٍ تُشترط بموافقةٍ صريحة (`accepts_marketing`). */
export function campaignSegmentRequiresConsent(segment: CampaignSegment): boolean {
  return campaignSegmentIsPeople(segment);
}

// ═══════════════════════════════════════════════════ حالات الحملة

export const campaignStatuses = ['draft', 'scheduled', 'sending', 'sent', 'canceled'] as const;
export const campaignStatusSchema = z.enum(campaignStatuses);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const campaignStatusLabelsAr: Record<CampaignStatus, string> = {
  draft: 'مسوّدة',
  scheduled: 'مجدولة',
  sending: 'قيد الإرسال',
  sent: 'أُرسلت',
  canceled: 'ملغاة',
};

/**
 * الانتقالات — والحملة المرسلة لا تُعدَّل ولا تُلغى: صفوفُ رسائلها شواهدُ على ما خرج، ونسخةٌ
 * أُرسلت لا تُعاد كتابتها. ومن أراد نصاً آخر فليُنشئ حملةً أخرى (وهذا أيضاً ما يحفظ التقرير).
 */
export const campaignTransitions: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ['scheduled', 'sending', 'canceled'],
  scheduled: ['sending', 'canceled'],
  sending: ['sent', 'canceled'],
  sent: [],
  canceled: [],
};

export function campaignTransitionAllowed(from: CampaignStatus, to: CampaignStatus): boolean {
  return from === to || campaignTransitions[from].includes(to);
}

/** النصّ والجدولة يُعدَّلان ما لم يبدأ الإرسال. */
export function campaignIsEditable(status: CampaignStatus): boolean {
  return status === 'draft' || status === 'scheduled';
}

export function campaignIsCancelable(status: CampaignStatus): boolean {
  return campaignTransitions[status].includes('canceled');
}

// ═══════════════════════════════════════════════════ حالات الرسائل والأحداث

export const campaignMessageStatuses = ['pending', 'sent', 'failed', 'skipped'] as const;
export const campaignMessageStatusSchema = z.enum(campaignMessageStatuses);
export type CampaignMessageStatus = z.infer<typeof campaignMessageStatusSchema>;

export const campaignMessageStatusLabelsAr: Record<CampaignMessageStatus, string> = {
  pending: 'في الانتظار',
  sent: 'أُرسلت',
  failed: 'فشلت',
  /** لم تُرسل **عن قصد**: محجوبٌ، أو بلا موافقةٍ تسويقية، أو أُلغيت الحملة. */
  skipped: 'لم تُرسل',
};

export const campaignEventKinds = [
  'queued',
  'sent',
  'failed',
  'suppressed',
  'opened',
  'clicked',
  'unsubscribed',
  'canceled',
] as const;
export const campaignEventKindSchema = z.enum(campaignEventKinds);
export type CampaignEventKind = z.infer<typeof campaignEventKindSchema>;

export const campaignEventLabelsAr: Record<CampaignEventKind, string> = {
  queued: 'في الطابور',
  sent: 'خرجت',
  failed: 'فشل التسليم',
  suppressed: 'محجوب',
  opened: 'فُتحت',
  clicked: 'نُقر فيها',
  unsubscribed: 'إلغاء اشتراك',
  canceled: 'أُلغيت الحملة',
};

/** أزواج (سبب، نصّ) للحالات التي «لم تُرسل» — تُكتب في التقرير فيُعرف السبب لا الحالة. */
export const campaignSkipReasonsAr = {
  suppressed: 'محجوب في قائمة الحجر (P-C6)',
  unsubscribed: 'ألغى الاشتراك',
  no_consent: 'بلا موافقةٍ تسويقية',
  canceled: 'أُلغيت الحملة قبل الإرسال',
  left_segment: 'خرج من الشريحة',
} as const;

// ═══════════════════════════════════════════════════ المتغيّرات والروابط

/**
 * متغيّرات نصّ الحملة: ما يكتبه المشغّل بين `{{ }}` ويُستبدل لكل مستلم.
 * `unsubscribe_url` محجوزٌ ولا يُكتب بيد: يُبنى لكل مستلمٍ من رمزه، فلا يُمكن أن يُرسل
 * نصٌّ بلا رابط إلغاءٍ حقيقي (تحقّقه `campaignBodyProblems`).
 */
export const campaignVariables = ['name', 'company', 'email'] as const;
export const campaignReservedVariables = ['unsubscribe_url'] as const;
export const campaignKnownVariables: readonly string[] = [...campaignVariables, ...campaignReservedVariables];

export type CampaignVariables = Partial<
  Record<(typeof campaignVariables)[number] | 'unsubscribe_url', string>
>;

/** كل `{{var}}` في نصّ — بلا تكرار، بترتيبه. */
export function campaignVariablesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)) {
    const name = match[1]!.toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * استبدال المتغيّرات بقيمها — والفراغ يُستبدل بنصٍّ محايد لا بفراغ:
 * «مرحباً ،» تُقرأ خطأً، و«مرحباً عميلنا،» تُقرأ جيداً.
 */
export function renderCampaignText(text: string, variables: CampaignVariables): string {
  return text.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_whole, rawName: string) => {
    const name = rawName.toLowerCase();
    const value = (variables as Record<string, string | undefined>)[name];
    if (value && value.trim().length > 0) return value.trim();
    if (name === 'name') return 'عميلنا';
    if (name === 'company') return 'منشأتك';
    return '';
  });
}

/**
 * روابط الحملة كما تخرج في الرسالة. الشكل مقصود:
 *
 *   * **الزحف لا يُخفي الوجهة**: النصّ يعرض الرابط الحقيقي داخل العنوان المُتتبَّع، فمن
 *     ينسخ الرابط يرى إلى أين يذهب (ولا `bit.ly` ولا رابطٌ أعمى).
 *   * **والرابط المُتتبَّع من نطاق الموقع نفسه** (`site.url`)، فتمرّ النقرة بالـAPI الذي
 *     يسجّلها ثم يوجّه 302 إلى الوجهة الحقيقية.
 */
export const campaignPixelPath = '/api/v1/public/track/open';
export const campaignClickPath = '/api/v1/public/track/click';

export function campaignOpenUrl(base: string, token: string): string {
  return `${trimSlash(base)}${campaignPixelPath}/${encodeURIComponent(token)}`;
}

export function campaignClickUrl(base: string, token: string, index: number): string {
  return `${trimSlash(base)}${campaignClickPath}/${encodeURIComponent(token)}/${index}`;
}

export function campaignUnsubscribeUrl(base: string, token: string): string {
  return `${trimSlash(base)}/unsubscribe?token=${encodeURIComponent(token)}`;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** نقرةٌ بلا وجهة = خطأٌ في الوسيط لا في القاعدة: الطلب الذي لا يُقرأ يُرفض صراحةً. */
export function campaignMessageToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

// ═══════════════════════════════════════════════════ المخطّطات

const nameSchema = z.string().trim().min(3, 'الاسم ثلاثة أحرف على الأقل').max(120);
const subjectSchema = z.string().trim().min(3, 'العنوان ثلاثة أحرف على الأقل').max(200);
const bodySchema = z.string().trim().min(20, 'النصّ عشرون حرفاً على الأقل').max(20_000);

export const campaignLocaleSchema = z.enum(['ar', 'en']);
export type CampaignLocale = z.infer<typeof campaignLocaleSchema>;

export const campaignCreateSchema = z
  .object({
    name: nameSchema,
    subject: subjectSchema,
    body: bodySchema,
    segment: campaignSegmentSchema,
    locale: campaignLocaleSchema.default('ar'),
  })
  .strict();
export type CampaignCreate = z.infer<typeof campaignCreateSchema>;

export const campaignPatchSchema = z
  .object({
    name: nameSchema.optional(),
    subject: subjectSchema.optional(),
    body: bodySchema.optional(),
    segment: campaignSegmentSchema.optional(),
    locale: campaignLocaleSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), 'لا شيء للتعديل');
export type CampaignPatch = z.infer<typeof campaignPatchSchema>;

/**
 * الجدولة: وقتٌ بالمنطقة الزمنية للخادم (كما في التقرير الأسبوعي)، أو `null` للإرسال
 * **الآن** — وهو ما يجعل الاختبار الحيّ ممكناً بلا انتظار.
 */
export const campaignScheduleSchema = z
  .object({
    scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type CampaignSchedule = z.infer<typeof campaignScheduleSchema>;

export const campaignCancelSchema = z
  .object({
    reason: z.string().trim().min(3, 'سبب الإلغاء مطلوب').max(500),
  })
  .strict();
export type CampaignCancel = z.infer<typeof campaignCancelSchema>;

export const campaignTestSchema = z
  .object({
    to: z.string().trim().toLowerCase().email().max(253),
  })
  .strict();
export type CampaignTest = z.infer<typeof campaignTestSchema>;

export const campaignListQuerySchema = paginationQuerySchema
  .extend({
    status: campaignStatusSchema.optional(),
    segment: campaignSegmentSchema.optional(),
    q: z.string().trim().max(120).optional(),
  })
  .strict();
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;

// ═══════════════════════════════════════════════════ الأشكال

export type CampaignTotals = {
  /** من وُجد في الشريحة لحظة الإرسال (لا من بقي بعدها). */
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
};

export type CampaignView = {
  id: string;
  name: string;
  subject: string;
  body: string;
  segment: CampaignSegment;
  segmentLabelAr: string;
  locale: CampaignLocale;
  status: CampaignStatus;
  statusLabelAr: string;
  /** متى تُرسل (للحملة المجدولة). */
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  canceledAt: string | null;
  canceledReason: string | null;
  /** المقدَّر لحظة الجدولة — والعدد النهائي من صفوف الرسائل لا من هذا العمود. */
  estimatedRecipients: number;
  variables: string[];
  hyperlinks: string[];
  createdBy: string | null;
  createdByLabel: string | null;
  totals: CampaignTotals;
  createdAt: string;
  updatedAt: string;
};

export type CampaignListResponse = {
  data: CampaignView[];
  meta: { total: number; limit: number; offset: number };
  counts: Record<CampaignStatus, number>;
};

export type CampaignSegmentInfo = {
  segment: CampaignSegment;
  labelAr: string;
  descriptionAr: string;
  /** عدٌّ حقيقي من الجدول الآن — لا تقدير، فالشاشة تقول كم سيصل. */
  count: number;
  /** `people` = أشخاصٌ بموافقةٍ تسويقية؛ `account` = منشآتٌ مُتعاقدة (رسالة خدمة). */
  audience: 'people' | 'account';
  /** تنبيهٌ يظهر في الشاشة قبل الإرسال (شرائح فارغة أو محجوبة كلياً). */
  warningAr: string | null;
};

export type CampaignMessageView = {
  id: string;
  email: string;
  fullName: string | null;
  companyName: string | null;
  status: CampaignMessageStatus;
  statusLabelAr: string;
  /** لماذا لم تُرسل (أو لماذا فشلت) — نصٌّ عربي لمشغّلٍ لا رمز. */
  detail: string | null;
  emailMessageId: string | null;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  unsubscribedAt: string | null;
  /** آخر رابطٍ نُقر فيه — يُظهر في التقرير «وماذا فتحوا؟». */
  lastClickedUrl: string | null;
  clickCount: number;
};

export type CampaignEventView = {
  id: string;
  kind: CampaignEventKind;
  kindLabelAr: string;
  email: string | null;
  url: string | null;
  detail: string | null;
  at: string;
};

export type CampaignLinkReport = {
  url: string;
  clicks: number;
};

export type CampaignReport = {
  campaign: CampaignView;
  totals: CampaignTotals;
  segmentsNoteAr: string;
  links: CampaignLinkReport[];
  messages: CampaignMessageView[];
  events: CampaignEventView[];
};

export type CampaignTestResult = {
  to: string;
  emailMessageId: string;
  status: string;
  /** ما في رسالة الاختبار من روابط الزحف — **تُعطَّل**: رسالة اختبارٍ لا تُشوّه تقرير حملة. */
  trackingDisabled: boolean;
  detail: string;
};

export type CampaignDispatch = {
  campaignId: string;
  status: CampaignStatus;
  /** ما جرى في هذه الدفعة: كم صفّاً أُنشئ، وكم بقي، وكم استُبعد ولماذا. */
  dispatched: number;
  remaining: number;
  skipped: Record<string, number>;
  finishedAt: string | null;
};

// ═══════════════════════════════════════════════════ التحقّق من النصّ

/**
 * مشاكل النصّ التي تمنع الإرسال (لا الإنشاء): النصّ يُكتب ثم يُراجَع، والمنع عند **الجدولة
 * أو الإرسال** لأن صاحب المسوّدة لم ينتهِ بعد.
 *
 * والمشكلة الأولى ليست تحسيناً بل امتثال: **رابط إلغاء الاشتراك** يُبنى لكل مستلم، ولا
 * تُرسل حملةٌ بلا طريقٍ للخروج.
 */
export function campaignBodyProblems(body: string): string[] {
  const problems: string[] = [];
  const variables = campaignVariablesIn(body);
  for (const variable of variables) {
    if (!campaignKnownVariables.includes(variable)) {
      problems.push(`المتغيّر «{{${variable}}}» غير معروف`);
    }
  }
  // `{{name}}` يُستبدل باسمٍ محايد عند الفراغ، فلا يُشترط وجوده؛ والتحقّق من الرابط ليس اختيارياً.
  return problems;
}

/**
 * روابط النصّ بعددها وترتيبها: `[نص](https://…)` أو رابطٌ عارٍ — **بمرورٍ واحد** على النصّ.
 *
 * والترتيب ليس تفصيلاً: رقمُ الرابط في المصفوفة هو معرّفه في رابط النقرة
 * (`/public/track/click/:token/:index`)، فمروران (الوسوم أوّلاً ثم العارية) كان يجعل الرقم
 * لا يطابق موضع الرابط في النصّ — وهو خطأٌ كشفه `platform-campaigns.spec.ts`.
 */
export function campaignHyperlinks(body: string): string[] {
  const found: string[] = [];
  const add = (url: string): void => {
    const clean = url.trim().replace(/[.,،؛)]+$/, '');
    if (!/^https?:\/\//i.test(clean)) return;
    if (!found.includes(clean)) found.push(clean);
  };
  const pattern = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s`]+)/gi;
  for (const match of body.matchAll(pattern)) {
    // المطابقة الأولى (وسمٌ) أقرب إلى الرابط من الثانية (رابطٌ عارٍ داخل عنوان الوسم).
    add((match[2] ?? match[3])!);
  }
  return found;
}

/**
 * وسم الحملة في الرسالة: يُكتب في آخر المتن ويحمل معرّف الحملة — فلا رسالةَ مجهولة المصدر
 * (ورسالةٌ مجهولة المصدر يُبلَّغ عنها كبريدٍ مزعج).
 *
 * **ورابطُ الإلغاء ليس هنا**: تكتبه ظرفُ القالب (`{{unsubscribe_url}}` في P-C6) فيصير رابطاً
 * واحداً في كل رسالة مهما كان متنُ المشغّل — لا يُنسى ولا يُزحف.
 */
export function campaignMessageFooter(campaign: { id: string; name: string }): string {
  return [
    '—',
    `هذه رسالةٌ من حملة «${campaign.name}» (${campaign.id.slice(0, 8)})، وصلتك لأنك تركت عنوانك عندنا.`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════ تركيب الرسالة

export type CampaignRecipient = {
  email: string;
  /** الاسم كما في الجدول؛ والتحية تُبنى بأوّل اسمٍ منه. */
  name?: string | null;
  company?: string | null;
};

export type CampaignTracking = {
  openUrl: string;
  unsubscribeUrl: string;
  /** رابط النقرة لوجهةٍ بترتيبها في `links` — الزحف لا يُخفي الوجهة في القاعدة. */
  clickUrl: (index: number) => string;
};

export type CampaignRenderedMessage = {
  subject: string;
  text: string;
  html: string;
  /** ترويسات الامتثال (RFC 8058) — تُسلَّم مع الرسالة وتُحفظ معها. */
  headers: Record<string, string>;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** التحية بأوّل اسمٍ: «سالم العمري» ⇒ «سالم»، و«عميلنا» عند الفراغ. */
function greetingName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : '';
}

/**
 * تركيب الرسالة التي تخرج فعلاً: النصّ المرئي **والنسخة الأخرى منه**.
 *
 *   * **النسختان من مصدرٍ واحد**: النصّ وHTML يُبنيان في المقطع نفسه، فلا تختلف رسالةُ
 *     قارئ HTML عن رسالة قارئ النصّ — وهو أشيع أخطاء الحملات (رابطٌ يظهر هنا ويغيب هناك).
 *   * **الزحف ظاهر**: الرابط المعروض في النصّ هو الرابط المُتتبَّع نفسه، فمن نسخه وفتحه
 *     مرّ بالمنصّة، ومن قرأه رأى إلى أين يذهب.
 *   * **بكسل الفتح في HTML وحده**: نصٌّ مجرّد لا يُحمّل صورة، فلا يُدَّعى قياسُ فتحٍ في نص.
 *   * **ترويسات النقرة الواحدة** (`List-Unsubscribe` · `List-Unsubscribe-Post`) تخرج مع كل
 *     رسالة: العميل الذي يعرض زرّ «إلغاء الاشتراك» يجد ما يبنيه عليه (RFC 8058).
 */
export function renderCampaignMessage(input: {
  campaign: { id: string; name: string; subject: string; body: string };
  recipient: CampaignRecipient;
  /** الوجهات بترتيب ظهورها (`campaignHyperlinks`) — ترتيبها هو المعرّف الذي في الرابط. */
  links: readonly string[];
  tracking: CampaignTracking;
}): CampaignRenderedMessage {
  const { campaign, recipient, links, tracking } = input;
  const variables: CampaignVariables = {
    name: greetingName(recipient.name),
    company: (recipient.company ?? '').trim(),
    email: recipient.email,
    unsubscribe_url: tracking.unsubscribeUrl,
  };

  /**
   * **الترتيب هو الحرس**: لفُّ الروابط أوّلاً ثم استبدالُ المتغيّرات.
   *
   * والعكس كان خطأً حقيقياً كشفه `campaigns.spec.ts`: `{{unsubscribe_url}}` يُستبدل
   * بالرابط الحقيقي، ثم يمرّ عليه لافُّ الروابط فيراه «رابطاً عارياً» ويلفّه برابط نقرةٍ
   * مُتتبَّع — فيصل زرُّ «إلغاء الاشتراك» إلى أوّل رابطٍ في الحملة (الأسعار!). وهذا أسوأ ما
   * يُنسب إلى حملة: طريقُ الخروج يعمل — ويُوجَّه إلى مكانٍ آخر.
   */
  const bodyWrapped = wrapCampaignLinks(campaign.body, links, tracking);
  const escapedVariables = Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, escapeHtml(value)]),
  ) as CampaignVariables;

  const bodyText = renderCampaignText(bodyWrapped.text, variables);
  const bodyHtml = renderCampaignText(bodyWrapped.html, escapedVariables);
  // الذيل لا يُزحف: رابط إلغاء الاشتراك يُعرض كما هو، ويُهرَّب لـHTML وحده.
  const footer = campaignMessageFooter(campaign);

  const text = `${bodyText}\n\n${footer}`;
  const html = [
    '<!doctype html>',
    '<html dir="rtl" lang="ar">',
    '<head><meta charset="utf-8" /></head>',
    '<body style="font-family:system-ui,Segoe UI,Tahoma,sans-serif;line-height:1.8;color:#111">',
    ...bodyHtml.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`),
    `<hr /><p style="font-size:13px;color:#555">${escapeHtml(footer).replace(/\n/g, '<br />')}</p>`,
    `<img src="${escapeHtml(tracking.openUrl)}" width="1" height="1" alt="" style="display:none" />`,
    '</body></html>',
  ].join('\n');

  return {
    subject: renderCampaignText(campaign.subject, variables),
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${tracking.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/**
 * لفُّ روابط النصّ في صفحتين من مصدرٍ واحد: النصّ المجرّد وHTML.
 *
 * `[عنوان](وجهة)` تُصير في النصّ «عنوان (رابط مُتتبَّع)» وفي HTML `<a>`، والرابط العاري
 * يصير مُتتبَّعاً في الحالين. والمقطع الواحد يُبنى مرّةً، فلا يظهر رابطٌ في نسخةٍ ويغيب في
 * الأخرى — وهو أشيع أخطاء الحملات.
 */
export function wrapCampaignLinks(
  source: string,
  links: readonly string[],
  tracking: CampaignTracking,
): { text: string; html: string } {
  const indexOf = (url: string): number => {
    const found = links.indexOf(url);
    return found === -1 ? 0 : found;
  };

  const pattern = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s`]+)/g;
  let text = '';
  let html = '';
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    const before = source.slice(cursor, at);
    text += before;
    html += escapeHtml(before);
    cursor = at + match[0].length;

    const isMarkup = match[1] !== undefined;
    const url = (isMarkup ? match[2] : match[3])!.replace(/[.,،؛)]+$/, '');
    const clickUrl = tracking.clickUrl(indexOf(url));
    const label = isMarkup ? (match[1] ?? url) : url;
    // النصّ: العنوان الظاهر ثم الرابط المُتتبَّع صريحاً — لا رابطَ أعمى.
    text += isMarkup ? `${label} (${clickUrl})` : clickUrl;
    html += `<a href="${escapeHtml(clickUrl)}">${escapeHtml(label)}</a>`;
  }

  const tail = source.slice(cursor);
  text += tail;
  html += escapeHtml(tail);
  return { text, html };
}


