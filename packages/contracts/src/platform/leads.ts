import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * P-M6 — «التقاط العملاء المتوقّعين وإدارتهم» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * العقد يحرس قرارين قبل أن يُكتب سطرُ خدمةٍ واحد:
 *
 *   1. **العميل المتوقَّع ليس مستأجراً**: له حالاتُ متابعةٍ (جديد · قيد التواصل · مؤهَّل ·
 *      تحوّل · مرفوض) وملاحظاتٌ وأثرٌ زمنيّ، ولا يرى النظامَ ولا يملك صفّاً في `tenants`
 *      حتى يُحوَّل. والتحويل **فعلٌ صريح** يترك أثراً، لا نتيجةٌ جانبية لملء استمارة.
 *   2. **الاستمارة العامّة بابٌ مفتوح على الإنترنت** — فهي أول ما يُهاجَم: مصيدةٌ (حقلٌ
 *      مخفيّ لا يملؤه إنسان)، وتطبيعُ بريدٍ واحد لا صورٌ متعدّدة (حروف كبيرة، مسافات)،
 *      وسقفُ طولٍ لكل حقل، ورسالةٌ حرّة لا تُقبل بلا حدّ.
 *
 * والنصوص العربية للحالات في العقد لا في الشاشة: الشاشة اللوحية والشاشة العامة والسكربت
 * الحيّ يقولون الشيء نفسه عن الحالة نفسها.
 */

// ═══════════════════════════════════════════════════ الحالات والمصادر

export const leadStatuses = ['new', 'contacted', 'qualified', 'won', 'rejected'] as const;
export const leadStatusSchema = z.enum(leadStatuses);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

export const leadStatusLabelsAr: Record<LeadStatus, string> = {
  new: 'جديد',
  contacted: 'قيد التواصل',
  qualified: 'مؤهَّل',
  won: 'تحوّل',
  rejected: 'مرفوض',
};

/**
 * الانتقالات المسموحة — لا كلُّ حالةٍ من كلّ حالة. والحالات النهائية (`won` · `rejected`)
 * لا تعود: رجوعٌ عن قرارٍ يُسجَّل كطلبٍ جديد أو كملاحظة، لا كتغيير حالةٍ يمحو الأثر.
 */
export const leadTransitions: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ['contacted', 'qualified', 'rejected'],
  contacted: ['qualified', 'rejected'],
  qualified: ['won', 'rejected'],
  won: [],
  rejected: [],
};

export function leadTransitionAllowed(from: LeadStatus, to: LeadStatus): boolean {
  return from === to || (leadTransitions[from] ?? []).includes(to);
}

export function isLeadClosed(status: LeadStatus): boolean {
  return status === 'won' || status === 'rejected';
}

export const leadSources = ['form', 'demo', 'newsletter', 'campaign', 'manual'] as const;
export const leadSourceSchema = z.enum(leadSources);
export type LeadSource = z.infer<typeof leadSourceSchema>;

export const leadSourceLabelsAr: Record<LeadSource, string> = {
  form: 'نموذج تواصل',
  demo: 'طلب عرض',
  newsletter: 'النشرة البريدية',
  campaign: 'حملة',
  manual: 'مُدخَل يدوياً',
};

/** المصادر التي تُكتب من الإنترنت — وما عداها لا يُقبل من مسارٍ عام. */
export const publicLeadSources = ['form', 'demo', 'newsletter'] as const satisfies readonly LeadSource[];

// ═══════════════════════════════════════════════════ UTM

/**
 * UTM كما تصل من الرابط لا كما تُخزَّن: تُطبَّع (تُشذَّب) وتُسقَط الفارغة، فلا يُخزَّن `null`
 * بمعنى «لم تُذكر». والحدود قصيرة عن قصد: هذه وسومُ حملةٍ لا نصوص.
 */
export const utmSchema = z.object({
  source: z.string().trim().max(80).optional(),
  medium: z.string().trim().max(80).optional(),
  campaign: z.string().trim().max(120).optional(),
  term: z.string().trim().max(80).optional(),
  content: z.string().trim().max(120).optional(),
  /** الصفحة التي جاء منها الزائر (أو `Referer`)، تُقصّ إلى 300 حرف. */
  referrer: z.string().trim().max(300).optional(),
  landingPath: z.string().trim().max(200).optional(),
});
export type Utm = z.infer<typeof utmSchema>;

/** من معاملات رابطٍ إلى كائنٍ نظيف — والمفاتيح الفارغة تسقط. */
export function utmFromSearch(search: string | URLSearchParams): Utm {
  const params = typeof search === 'string' ? new URLSearchParams(search.replace(/^\?/, '')) : search;
  const read = (key: string, max: number): string | undefined => {
    const raw = params.get(key)?.trim();
    if (!raw) return undefined;
    return raw.slice(0, max);
  };
  const utm: Utm = {
    source: read('utm_source', 80),
    medium: read('utm_medium', 80),
    campaign: read('utm_campaign', 120),
    term: read('utm_term', 80),
    content: read('utm_content', 120),
    referrer: read('ref', 300),
    landingPath: read('path', 200),
  };
  for (const key of Object.keys(utm) as Array<keyof Utm>) {
    if (utm[key] === undefined) delete utm[key];
  }
  return utm;
}

export function utmIsEmpty(utm: Utm | null | undefined): boolean {
  if (!utm) return true;
  return Object.values(utm).every((value) => value === undefined || value === '');
}

// ═══════════════════════════════════════════════════ المصيدة والتطبيع

/**
 * حقل المصيدة: اسمٌ مُغري لأي ماسحٍ آليّ (`website`) وموضعه في الاستمارة مخفيّ عن الإنسان.
 * إنسانٌ لا يراه فلا يملؤه؛ وروبوتٌ يملأ كل حقلٍ يجده فيكشف نفسه. **والقبول صامت**: الطلب
 * يُرَدّ 202 بلا صفّ — إخبارُ الآلة بأنها كُشِفت دعوةٌ لتجربةٍ أخرى.
 */
export const LEAD_HONEYPOT_FIELD = 'website' as const;

export function isHoneypotFilled(payload: Record<string, unknown>): boolean {
  const value = payload[LEAD_HONEYPOT_FIELD];
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

/** بريدٌ واحد لكل عنوان: حروفٌ صغيرة وبلا مسافات — عليه يُقاس «مكرَّر؟». */
export function normalizeLeadEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** اسم عرضٍ للعميل المتوقَّع: الاسم، ثم الشركة، ثم البريد — بلا فراغٍ في أي حالة. */
export function leadDisplayName(input: {
  fullName?: string | null;
  companyName?: string | null;
  email: string;
}): string {
  const name = input.fullName?.trim();
  if (name) return name;
  const company = input.companyName?.trim();
  if (company) return company;
  return normalizeLeadEmail(input.email);
}

// ═══════════════════════════════════════════════════ الأشكال

/** `POST /public/leads` — استمارةُ تواصلٍ أو طلبُ عرض. */
export const leadCreateSchema = z.object({
  fullName: z.string().trim().min(2, 'الاسم حرفان على الأقل').max(120),
  companyName: z.string().trim().min(2).max(160).optional(),
  email: z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(160),
  phone: z.string().trim().min(6, 'رقم هاتف غير صالح').max(32).optional(),
  /** عدد الفروع كما يُعلنه الزائر — يُقرأ في التأهيل، ولا يُفرض. */
  branchCount: z.coerce.number().int().min(0).max(999).optional(),
  planInterest: z.string().trim().max(64).optional(),
  message: z.string().trim().min(10, 'اكتب رسالةً من ١٠ أحرف على الأقل').max(2000),
  source: leadSourceSchema.default('form'),
  locale: z.enum(['ar', 'en']).default('ar'),
  /** موافقةٌ صريحة على الرسائل التسويقية — افتراضها الرفض لا القبول. */
  acceptsMarketing: z.boolean().default(false),
  utm: utmSchema.optional(),
  /**
   * المصيدة (`LEAD_HONEYPOT_FIELD`): حقلٌ مخفيّ لا يملؤه إنسان. مكتوبٌ هنا صراحةً لا
   * بمفتاحٍ محسوب، لأن المخطّطات تُقرأ في مراجعة الكود — وحقلٌ لا يظهر في التعريف لا
   * يُراجَع. يُقرأ في الخدمة ولا يُخزَّن ولا يُمرَّر إلى أي صفّ.
   */
  website: z.string().max(200).optional(),
});
export type LeadCreate = z.infer<typeof leadCreateSchema>;

export const subscriberStatuses = ['pending', 'confirmed', 'unsubscribed'] as const;
export const subscriberStatusSchema = z.enum(subscriberStatuses);
export type SubscriberStatus = z.infer<typeof subscriberStatusSchema>;

export const subscriberStatusLabelsAr: Record<SubscriberStatus, string> = {
  pending: 'بانتظار التأكيد',
  confirmed: 'مؤكَّد',
  unsubscribed: 'أُلغي الاشتراك',
};

/**
 * مرشّحات الطابور. `unassigned` نصّيٌّ لا `z.coerce.boolean()`: `"false"` تتحوّل مع
 * `coerce.boolean` إلى `true` (كل نصٍّ غير فارغ صادق)، فيصير طلبُ «غير المُسنَد» مقلوباً
 * صامتاً — وهذا خطأٌ يُصلح في العقد لا في الشاشة.
 */
export const leadListQuerySchema = paginationQuerySchema.extend({
  status: leadStatusSchema.optional(),
  source: leadSourceSchema.optional(),
  assignedTo: uuidSchema.optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z.string().trim().max(120).optional(),
  /** `mine` = الطلبات المُسنَدة إليّ — المسار الأسرع لمندوبٍ يفتح صندوقه صباحاً. */
  mine: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const subscriberListQuerySchema = paginationQuerySchema.extend({
  status: subscriberStatusSchema.optional(),
  q: z.string().trim().max(120).optional(),
});
export type SubscriberListQuery = z.infer<typeof subscriberListQuerySchema>;

export const leadPatchSchema = z
  .object({
    status: leadStatusSchema.optional(),
    assignedTo: uuidSchema.nullable().optional(),
    /** سببٌ مكتوب للتغيير — يُسجَّل أثراً، وهو ما يجعل «مرفوض» قراراً لا إغفالاً. */
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'لا تغيير في الطلب' });
export type LeadPatch = z.infer<typeof leadPatchSchema>;

export const leadNoteCreateSchema = z.object({
  body: z.string().trim().min(2, 'الملاحظة حرفان على الأقل').max(2000),
});
export type LeadNoteCreate = z.infer<typeof leadNoteCreateSchema>;

export const leadAssignSchema = z.object({
  assignedTo: uuidSchema.nullable(),
  reason: z.string().trim().max(300).optional(),
});
export type LeadAssign = z.infer<typeof leadAssignSchema>;

/**
 * `POST /platform/leads/:id/convert` — إنشاء المنشأة من الطلب.
 * والباقي يأتي من الطلب نفسه (الاسم والبريد والشركة)؛ وما يُطلب هنا هو ما لا يعرفه الطلب:
 * الباقة، ورمز المنشأة، ومدّة التجربة.
 */
export const leadConvertSchema = z.object({
  planId: uuidSchema.optional(),
  tenantCode: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'رمز المنشأة حروفٌ صغيرة وأرقام وشرطات (٢–٦٣)')
    .optional(),
  tenantName: z.string().trim().min(2).max(120).optional(),
  trialDays: z.coerce.number().int().min(0).max(365).optional(),
  /** إرسال دعوة الدخول بالبريد (قالب P-C6) — والتخلّي عنها يترك المدير بلا كلمة مرور. */
  inviteOwner: z.boolean().default(true),
});
export type LeadConvert = z.infer<typeof leadConvertSchema>;

/** `POST /public/subscribe` — النشرة البريدية (تأكيدٌ مزدوج). */
export const subscriberCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(160),
  locale: z.enum(['ar', 'en']).default('ar'),
  source: leadSourceSchema.default('newsletter'),
  utm: utmSchema.optional(),
  /** المصيدة — كما في `leadCreateSchema`. */
  website: z.string().max(200).optional(),
});
export type SubscriberCreate = z.infer<typeof subscriberCreateSchema>;

/**
 * `PATCH /platform/leads/subscribers/:id` — تأكيدٌ يدوي أو إلغاء اشتراك.
 * ولماذا يدويّ وإلى جانبه رابط التأكيد؟ لأن من كتب عنوانه في ورقةٍ أو هاتفه لن يفتح رابطاً
 * أبداً — ومن يطلب الإزالة يطلبها بسرعة. والقرار يُنسب لمن اتّخذه في اللوحة.
 */
export const subscriberStatusUpdateSchema = z.object({ status: subscriberStatusSchema });
export type SubscriberStatusUpdate = z.infer<typeof subscriberStatusUpdateSchema>;

// ═══════════════════════════════════════════════════ ردود الواجهة

export const leadViewSchema = z.object({
  id: uuidSchema,
  /** المرجع القصير الذي يُقال للزائر ويُبحث به في اللوحة (`L-3F9A2C1D44`). */
  reference: z.string(),
  fullName: z.string().nullable(),
  companyName: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  branchCount: z.number().int().nullable(),
  planInterest: z.string().nullable(),
  message: z.string(),
  source: leadSourceSchema,
  sourceLabelAr: z.string(),
  status: leadStatusSchema,
  statusLabelAr: z.string(),
  /** الحالة النهائية (`won` · `rejected`): الشاشة تُخفي أزرار الانتقال عنها. */
  statusLocked: z.boolean(),
  locale: z.enum(['ar', 'en']),
  acceptsMarketing: z.boolean(),
  utm: utmSchema.nullable(),
  assignedTo: uuidSchema.nullable(),
  assignedToName: z.string().nullable(),
  convertedTenantId: uuidSchema.nullable(),
  convertedTenantCode: z.string().nullable(),
  convertedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type LeadView = z.infer<typeof leadViewSchema>;

export const leadNoteViewSchema = z.object({
  id: uuidSchema,
  leadId: uuidSchema,
  body: z.string(),
  authorId: uuidSchema.nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
});
export type LeadNoteView = z.infer<typeof leadNoteViewSchema>;

export const leadEventViewSchema = z.object({
  id: uuidSchema,
  leadId: uuidSchema,
  kind: z.string(),
  detail: z.string().nullable(),
  actorId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string(),
});
export type LeadEventView = z.infer<typeof leadEventViewSchema>;

export const subscriberViewSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  status: subscriberStatusSchema,
  statusLabelAr: z.string(),
  locale: z.enum(['ar', 'en']),
  source: leadSourceSchema,
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
});
export type SubscriberView = z.infer<typeof subscriberViewSchema>;

/**
 * عدّادات الطابور — تُرسل مع كل صفحة، لأن سؤال «كم طلباً جديداً لم يُسنَد؟» هو أوّل ما
 * يُسأل عند فتح الصندوق، ولا يجوز أن يكلّف نداءً ثانياً.
 */
export const leadCountsSchema = z.object({
  counts: z.record(leadStatusSchema, z.number().int()),
  unassigned: z.number().int(),
});
export type LeadCounts = z.infer<typeof leadCountsSchema>;

export const subscriberCountsSchema = z.object({
  counts: z.record(subscriberStatusSchema, z.number().int()),
});
export type SubscriberCounts = z.infer<typeof subscriberCountsSchema>;

/** جواب الاستمارة العامّة: **لا يكشف** هل العنوان مسجَّل من قبل (نفس درس 404 في P-M4). */
export const leadAcceptedSchema = z.object({
  received: z.literal(true),
  reference: z.string(),
});
export type LeadAccepted = z.infer<typeof leadAcceptedSchema>;

export const subscriberAcceptedSchema = z.object({
  received: z.literal(true),
  /** `pending` للجديد، و`confirmed` إن كان مؤكَّداً سابقاً — بلا كشفٍ عن سببٍ آخر. */
  status: subscriberStatusSchema,
});
export type SubscriberAccepted = z.infer<typeof subscriberAcceptedSchema>;

/** جواب رابط التأكيد — يُعرَض في صفحةٍ صغيرة على الموقع. */
export const subscriberConfirmSchema = z.object({
  email: z.string(),
  status: subscriberStatusSchema,
});
export type SubscriberConfirm = z.infer<typeof subscriberConfirmSchema>;

/**
 * نتائج التحويل. `tempPassword` **تُعاد مرّةً واحدة** ولا تُخزَّن خاماً ولا تُرسل بالبريد:
 * من حَضَر التحويل هو من يبلّغ العميل، والحساب يطالب بتغييرها عند أول دخول.
 */
export const leadConversionSchema = z.object({
  lead: leadViewSchema,
  tenantId: uuidSchema,
  tenantCode: z.string(),
  ownerEmail: z.string(),
  ownerUserId: uuidSchema,
  tempPassword: z.string(),
  subscriptionId: z.string(),
  trialDays: z.number().int(),
  trialEndsAt: z.string().nullable(),
});
export type LeadConversion = z.infer<typeof leadConversionSchema>;

/**
 * ردّ `GET /platform/leads/:id`: الطلبُ وملاحظاتُه وأثرُه في نداءٍ واحد.
 *
 * ولماذا نداءٌ واحد؟ لأن الشاشة تفتح البطاقة لتقرأ القصة كاملةً قبل أن تُقرّر — وثلاثةُ
 * نداءات تعني ثلاث حالات تحميلٍ وثلاث فرص لأن يظهر نصفُ القصة.
 */
export const leadDetailSchema = z.object({
  lead: leadViewSchema,
  notes: z.array(leadNoteViewSchema),
  events: z.array(leadEventViewSchema),
});
export type LeadDetailResponse = z.infer<typeof leadDetailSchema>;

/** أثر التحويل في سجلّ المنصّة (`audit_log`)، ولأنه يُنشئ منشأة فهو يُراجَع لا يُهمَل. */
export const leadAuditActions = {
  CONVERTED: 'lead.converted',
  STATUS_CHANGED: 'lead.status_changed',
  ASSIGNED: 'lead.assigned',
  SUBSCRIBER_STATUS: 'subscriber.status_changed',
} as const;
export type LeadAuditAction = (typeof leadAuditActions)[keyof typeof leadAuditActions];

// ═══════════════════════════════════════════════════ أحداث الأثر

export const leadEventKinds = [
  'lead.created',
  'lead.assigned',
  'lead.status_changed',
  'lead.note_added',
  'lead.converted',
  /** طلبٌ ثانٍ من عنوانٍ قائم: لم يُكرَّر صفٌّ، بل أُلحقت الرسالة ملاحظةً على الطلب. */
  'lead.duplicated',
  'subscriber.created',
  'subscriber.confirmed',
] as const;
export const leadEventKindSchema = z.enum(leadEventKinds);
export type LeadEventKind = z.infer<typeof leadEventKindSchema>;

/** مفتاح منع التكرار: البريد وحده — فطلبٌ ثانٍ من العنوان نفسه يُلحق بالأول لا يُكرَّر. */
export function leadDedupeKey(email: string): string {
  return normalizeLeadEmail(email);
}
