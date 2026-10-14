/**
 * P-M6 — «التقاط العملاء المتوقّعين» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): نموذج
 * الاستمارة ودوالّه.
 *
 * الفصل نفسه الذي فعله P-M4 في `lib/signup.ts`: **المنطق هنا والرسم في المكوّن**. كل ما يمكن
 * أن يُخطئ — من يجوز له الإرسال، وما يُقال عند كل رمز خطأ، وكيف تُقرأ وسوم الحملة، وما يفعله
 * حقل المصيدة — دالّةٌ نقيّة يقيسها اختبار (`tests/leads.spec.ts`).
 *
 * وثلاثة قرارات هنا تستحق التصريح:
 *
 *   1. **المصيدة حقلٌ حقيقي في الاستمارة** (`website`) ومخفيٌّ بـCSS لا بـ`hidden`: كثيرٌ من
 *      الماسحات تتجاهل ما هو `display:none`، وملءُ حقلٍ «مخفيٍّ» هو ما يكشفها.
 *   2. **وسوم الحملة تُلتقط على العميل** لحظة الإرسال من `location`، لأن الزائر قد ينتقل بين
 *      صفحتين قبل أن يملأ الاستمارة — و`document.referrer` الأصلي يضيع في التنقّل.
 *   3. **الردّ واحد**: «وصلنا» ومرجعٌ قصير — لا يُقال للزائر «أنت مسجَّل من قبل»، لأن ذلك
 *      يجعل الحقل أداةَ تحقّقٍ من العناوين (وهو درس 404 الموحّد في P-M4).
 */
import { LEAD_HONEYPOT_FIELD, leadCreateSchema, normalizeLeadEmail, utmFromSearch, type Utm } from '@erp/contracts';

export { LEAD_HONEYPOT_FIELD, normalizeLeadEmail };

export type LeadFormKind = 'form' | 'demo';

export const leadFormConfig: Record<
  LeadFormKind,
  { source: 'form' | 'demo'; headingAr: string; introAr: string; messageLabelAr: string; messagePlaceholderAr: string }
> = {
  form: {
    source: 'form',
    headingAr: 'تواصل معنا',
    introAr: 'اكتب ما تحتاجه وسيتواصل معك فريقنا — لا نطلب بطاقة ولا نُنشئ حساباً بلا موافقتك.',
    messageLabelAr: 'كيف نساعدك؟',
    messagePlaceholderAr: 'مثال: عندنا ثلاثة فروع ونحتاج فواتير ضريبية وربطاً بالمخزون.',
  },
  demo: {
    source: 'demo',
    headingAr: 'اطلب عرضاً',
    introAr: 'نعرض عليك النظام على بياناتك أو على بيانات تجريبية، ثم تُقرّر — بلا التزام.',
    messageLabelAr: 'ما الذي تريد أن تراه في العرض؟',
    messagePlaceholderAr: 'مثال: دورة البيع والفواتير، وتقارير المخزون، وصلاحية المستخدمين.',
  },
};

/** مسودة الاستمارة كما تعيش في المكوّن. */
export type LeadDraft = {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  branchCount: string;
  planInterest: string;
  message: string;
  acceptsMarketing: boolean;
  /** المصيدة — لا تظهر لإنسان، ومن ملأها لا يُرسَل عنه شيء. */
  [LEAD_HONEYPOT_FIELD]: string;
};

export const emptyLeadDraft: LeadDraft = {
  fullName: '',
  companyName: '',
  email: '',
  phone: '',
  branchCount: '',
  planInterest: '',
  message: '',
  acceptsMarketing: false,
  [LEAD_HONEYPOT_FIELD]: '',
};

export type LeadVerdict = { ok: true } | { ok: false; field: keyof LeadDraft | 'form'; message: string };

const OK: LeadVerdict = { ok: true };
const fail = (field: LeadVerdict extends never ? never : keyof LeadDraft | 'form', message: string): LeadVerdict => ({
  ok: false,
  field,
  message,
});

/**
 * هل يجوز الإرسال؟ والرسالة **سببية ومصحوبة بالحقل** حتى تُعرض بجانبه لا في رأس الصفحة.
 * والشروط هنا هي شروط `leadCreateSchema` نفسها — تُقاس من العقد لا من نُسخةٍ ثانية:
 * المخطّط يُستدعى على مدخلٍ مُطبَّع، والخطأ الأوّل يُترجَم إلى حقلٍ ورسالة.
 */
export function leadVerdict(draft: LeadDraft): LeadVerdict {
  const payload = leadPayload(draft);
  const parsed = leadCreateSchema.safeParse(payload);
  if (parsed.success) return OK;

  const issue = parsed.error.issues[0];
  const path = String(issue?.path?.[0] ?? 'form');
  const field = (isLeadField(path) ? path : 'form') as keyof LeadDraft | 'form';
  return fail(field, issue?.message ?? 'راجع الحقول المطلوبة.');
}

function isLeadField(value: string): value is keyof LeadDraft {
  return value in emptyLeadDraft;
}

/** حمولة الإرسال: ما يراه الـAPI بالضبط، مُطبَّعاً — والفراغ يسقط ولا يُرسل `''`. */
export function leadPayload(draft: LeadDraft, options: { utm?: Utm | null } = {}): Record<string, unknown> {
  const branchCount = draft.branchCount.trim();
  const payload: Record<string, unknown> = {
    fullName: draft.fullName.trim(),
    email: normalizeLeadEmail(draft.email),
    message: draft.message.trim(),
    acceptsMarketing: draft.acceptsMarketing,
    [LEAD_HONEYPOT_FIELD]: draft[LEAD_HONEYPOT_FIELD],
  };
  if (draft.companyName.trim()) payload.companyName = draft.companyName.trim();
  if (draft.phone.trim()) payload.phone = draft.phone.trim();
  if (branchCount) payload.branchCount = Number(branchCount);
  if (draft.planInterest.trim()) payload.planInterest = draft.planInterest.trim();
  const utm = options.utm ?? {};
  if (Object.keys(utm).length > 0) payload.utm = utm;
  return payload;
}

/**
 * وسوم الحملة كما تلتقطها الشاشة: من `location.search`، ومن `document.referrer` إن كان
 * من نطاقٍ آخر (التحويل الداخليّ لا يُحتسب مرجعاً — هذا هو الفرق بين «جاء من جوجل» و«تنقّل
 * داخل موقعنا»)، ومن مسار الهبوط الحالي.
 */
export function leadUtm(input: { search?: string; referrer?: string; pathname?: string; host?: string }): Utm {
  const query = utmFromSearch(input.search ?? '');
  const referrer = input.referrer?.trim() ?? '';
  // المرجع الخارجي وحده يُحتسب: تحويلٌ داخلي (من `/pricing` إلى `/contact`) ليس مصدر حملة،
  // وتسجيلُه يملأ تقرير المصادر بضجيجٍ داخليّ لا معنى له.
  let external = '';
  if (referrer) {
    try {
      // يُحلَّل دائماً: مرجعٌ مكسور (`not a url`) ليس مرجعاً — ولو قُبل لنُقل إلى الطابور
      // نصٌّ لا معنى له، ولظهر في تقرير المصادر مصدرٌ لا وجود له.
      const parsed = new URL(referrer);
      if (!input.host || parsed.host !== input.host) external = referrer;
    } catch {
      external = '';
    }
  }
  return {
    ...query,
    ...(external ? { referrer: external.slice(0, 300) } : {}),
    ...(input.pathname && !query.landingPath ? { landingPath: input.pathname.slice(0, 200) } : {}),
  };
}

/** ترجمة ردود الـAPI إلى ما يُقال للزائر — والـ429 لها نصٌّ يقول «انتظر» لا «فشل». */
export function leadProblemMessage(status: number, code?: string, detail?: string): string {
  if (status === 429 || code === 'RATE_LIMITED') {
    return 'أرسلتَ طلباتٍ كثيرة في وقتٍ قصير. انتظر دقيقة ثم أعد المحاولة، أو راسلنا على بريد الدعم.';
  }
  if (status === 400 || code === 'VALIDATION_FAILED') {
    return detail || 'راجع الحقول: الاسم والبريد والرسالة ثلاثة لا تُترك فارغة.';
  }
  if (status === 0) {
    return 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال ثم أعد المحاولة.';
  }
  return 'لم نستطع تسجيل الطلب الآن. أعد المحاولة، وإن تكرّر الأمر راسلنا على بريد الدعم.';
}

/** نصّ ما بعد النجاح: يقول ما سيجري ومتى، ومعه المرجع الذي يُتابع به الطلب. */
export function leadSuccessMessage(reference: string): { titleAr: string; bodyAr: string; reference: string } {
  return {
    titleAr: 'وصلنا طلبك',
    bodyAr:
      'سيتواصل معك فريقنا خلال يوم عمل. احتفظ بالرقم التالي — يُتابع به طلبك، ولا حاجة لتكرار الإرسال.',
    reference,
  };
}

/** رقم الفروع كما يُكتب في الاستمارة: أرقام فقط، ولا يُقبل نصّ. */
export function sanitizeBranchCount(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, 3);
}

/** رسالة النشرة — واحدة في الحالتين (جديدٌ أو مؤكَّد من قبل). */
export const newsletterSuccessAr =
  'أرسلنا رسالة تأكيد. افتح الرابط فيها ليصير اشتراكك نافذاً — ولا نُرسل شيئاً قبله.';

export const newsletterHeadingAr = 'النشرة البريدية';
export const newsletterIntroAr = 'رسالةٌ واحدة في الشهر: ما أُضيف إلى النظام، وما تغيّر في الأنظمة الضريبية.';

/**
 * نصّ النشرة بلغتين — خلافاً لاستمارتَي التواصل والعرض.
 *
 * والفرق مقصود: التذييل يظهر في الشجرة **العربية والإنجليزية** معاً (`/` و`/en`)، فنصٌّ
 * عربيٌّ وحده يعني زائراً إنجليزياً يقرأ لغةً لا يفهمها في أسفل كل صفحة. أمّا `/contact`
 * و`/demo` فمساران عربيان في خريطة الموقع (كحال معالج الاشتراك)، وترجمتُهما تُنجَز مع
 * `/en/*` في P-M10 بلا نصٍّ وهمي (بوابة الخطة §1: «اللغتان حقيقيتان»).
 */
export const newsletterCopy: Record<
  'ar' | 'en',
  { heading: string; intro: string; cta: string; placeholder: string; label: string; success: string; invalid: string }
> = {
  ar: {
    heading: newsletterHeadingAr,
    intro: newsletterIntroAr,
    cta: 'اشترك',
    placeholder: 'name@company.com',
    label: 'البريد الإلكتروني',
    success: newsletterSuccessAr,
    invalid: 'اكتب بريداً صحيحاً — رسالة التأكيد تذهب إليه.',
  },
  en: {
    heading: 'Newsletter',
    intro: 'One message a month: what shipped and what changed in the tax rules.',
    cta: 'Subscribe',
    placeholder: 'name@company.com',
    label: 'Email address',
    success: 'We sent a confirmation message. Open the link in it to activate — nothing is sent before that.',
    invalid: 'Enter a valid email — the confirmation message goes there.',
  },
};
