/**
 * P-M4 — «الاشتراك والتفعيل» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): نموذج المعالج ودوالّه.
 *
 * الفصل مقصود: **المنطق هنا والرسم في المكوّن**. كل ما يمكن أن يُخطئ — ترتيب الخطوات، ومن
 * يُسمح له بالانتقال، وما يُقال عند كل رمز خطأ — دالّةٌ نقيّة يقيسها اختبار
 * (`tests/signup.spec.ts`)، والمكوّن يرسمها فقط. ولهذا لا تُقرأ الأرقام من هنا: تأتي من
 * `@erp/contracts` — **نفس المصدر الذي تقرأ منه الخدمة**، فلا تفترق الواجهة عن الـAPI في
 * عدد أرقام الرمز ولا في سقف المحاولات ولا في مدّة المهلة.
 *
 * ومعالج الاشتراك هو المسار العام الوحيد في الموقع الذي **يكتب** في النظام (ينشئ منشأةً
 * ويرسل بريداً)، فحرسُه على العميل لا يُغني عن حرس الخادم: كل شرطٍ هنا مُعادٌ في الـAPI
 * (`apps/api/test/signup-flow.spec.ts`)، وما هنا يمنع إزعاج المستخدم لا أكثر.
 */
import {
  SIGNUP_CODE_LENGTH,
  SIGNUP_CODE_TTL_MINUTES,
  SIGNUP_MAX_ATTEMPTS,
  SIGNUP_MAX_SENDS,
  SIGNUP_RESEND_COOLDOWN_SECONDS,
  isSignupCodeShaped,
  normalizeSignupEmail,
} from '@erp/contracts';

export {
  SIGNUP_CODE_LENGTH,
  SIGNUP_CODE_TTL_MINUTES,
  SIGNUP_MAX_ATTEMPTS,
  SIGNUP_MAX_SENDS,
  SIGNUP_RESEND_COOLDOWN_SECONDS,
};

// ═══════════════════════════════════════════════════ الخطوات الأربع

export const signupWizardSteps = [
  {
    key: 'plan',
    titleAr: 'الباقة',
    helpAr: 'اختر ما يناسب حجم عملك — ويمكن تغييرها لاحقاً من داخل النظام.',
  },
  {
    key: 'company',
    titleAr: 'المنشأة',
    helpAr: 'الاسم والرمز والدولة والعملة والمنطقة الزمنية — عليها تُبنى الفواتير والتقارير.',
  },
  {
    key: 'manager',
    titleAr: 'مدير الحساب',
    helpAr: 'بيانات الدخول الأولى: الاسم والبريد وكلمة المرور والهاتف.',
  },
  {
    key: 'verify',
    titleAr: 'التحقّق',
    helpAr: 'رمزٌ من ستة أرقام يصل إلى بريد المدير — يتأكّد أن العنوان له صاحبه.',
  },
] as const;

export type SignupWizardStepKey = (typeof signupWizardSteps)[number]['key'];

/** ما يجمعه المعالج قبل الإرسال — بلا كلمة مرورٍ مكرَّرة ولا حالة عرض. */
export type SignupDraft = {
  planCode: string;
  companyName: string;
  companyCode: string;
  countryCode: string;
  baseCurrency: string;
  timezone: string;
  ownerFullName: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerPasswordConfirm: string;
  phone: string;
};

export const emptySignupDraft: SignupDraft = {
  planCode: '',
  companyName: '',
  companyCode: '',
  countryCode: 'SA',
  baseCurrency: 'SAR',
  timezone: 'Asia/Riyadh',
  ownerFullName: '',
  ownerEmail: '',
  ownerPassword: '',
  ownerPasswordConfirm: '',
  phone: '',
};

export const signupCountries = [
  { code: 'SA', nameAr: 'السعودية' },
  { code: 'AE', nameAr: 'الإمارات' },
  { code: 'YE', nameAr: 'اليمن' },
  { code: 'KW', nameAr: 'الكويت' },
  { code: 'QA', nameAr: 'قطر' },
] as const;

export const signupCurrencies = ['SAR', 'AED', 'YER', 'USD'] as const;

export const signupTimezones = [
  { value: 'Asia/Riyadh', nameAr: 'الرياض (UTC+3)' },
  { value: 'Asia/Dubai', nameAr: 'دبي (UTC+4)' },
  { value: 'Asia/Aden', nameAr: 'عدن (UTC+3)' },
  { value: 'Asia/Kuwait', nameAr: 'الكويت (UTC+3)' },
  { value: 'Asia/Qatar', nameAr: 'الدوحة (UTC+3)' },
] as const;

// ═══════════════════════════════════════════════════ الانتقال بين الخطوات

export type StepVerdict = { ok: true } | { ok: false; message: string };

const OK: StepVerdict = { ok: true };
const fail = (message: string): StepVerdict => ({ ok: false, message });

/**
 * هل يجوز الانتقال من هذه الخطوة؟ والرسالة **سببية**: تقول ما ينقص لا «حقلاً غير صالح».
 * والباقة ليست شرطاً — يمكن للمنشأة أن تُسجَّل بلا اختيار وتُختار الباقة مع اعتماد الاشتراك.
 */
export function stepVerdict(step: SignupWizardStepKey, draft: SignupDraft): StepVerdict {
  switch (step) {
    case 'plan':
      return OK;
    case 'company': {
      if (draft.companyName.trim().length < 2) return fail('اسم المنشأة حرفان على الأقل.');
      if (draft.companyCode.trim() && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(draft.companyCode.trim().toLowerCase())) {
        return fail('رمز المنشأة حروفٌ إنجليزية صغيرة وأرقام وشرطات (٢–٦٣).');
      }
      if (draft.countryCode.trim().length !== 2) return fail('اختر الدولة.');
      if (draft.baseCurrency.trim().length !== 3) return fail('اختر العملة.');
      return OK;
    }
    case 'manager': {
      if (draft.ownerFullName.trim().length < 2) return fail('اسم المدير حرفان على الأقل.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.ownerEmail.trim())) return fail('بريد إلكتروني غير صالح.');
      // الثاني عشر هو حدّ الـAPI نفسه (`signupRequestSchema`)، لا رقمٌ اخترعناه في الواجهة.
      if (draft.ownerPassword.length < 12) return fail('كلمة المرور ١٢ حرفاً على الأقل.');
      if (draft.ownerPassword !== draft.ownerPasswordConfirm) return fail('كلمتا المرور غير متطابقتين.');
      return OK;
    }
    case 'verify':
      return OK;
  }
}

/** أول خطوة ناقصة — تُستعمل عند فتح الشاشة على مسارٍ يحمل حالةً ناقصة. */
export function firstIncompleteStep(draft: SignupDraft): SignupWizardStepKey {
  for (const step of signupWizardSteps) {
    if (!stepVerdict(step.key, draft).ok) return step.key;
  }
  return 'verify';
}

// ═══════════════════════════════════════════════════ أخطاء الـAPI بلغة الواجهة

export type SignupProblem = {
  /** ما يقوله للمستخدم. */
  message: string;
  /** موضع العطل: تُعاد الشاشة إلى الخطوة المعنيّة لا إلى الأولى. */
  step: SignupWizardStepKey;
  /** هل يستحق تسجيلاً جديداً؟ (رمزٌ ضائع أو تسجيلٌ انتهى) */
  restart?: boolean;
};

/**
 * ترجمة رموز الـAPI إلى رسائل. والمفتاح هو `code` لا نصّ الخادم: النصّ يتغيّر، والرمز عقد
 * (P-C1/§errors). و`422` بلا رمزٍ معروف = بياناتٌ لم تُقبل، فتُعاد الخطوة التي تُنتجها.
 */
export function signupProblem(input: {
  status: number;
  code?: string;
  detail?: string;
}): SignupProblem {
  const { status, code, detail } = input;
  switch (code) {
    case 'SIGNUP_EMAIL_TAKEN':
      return {
        message: detail ?? 'هذا البريد يملك منشأةً بالفعل. سجّل الدخول، أو استخدم بريداً آخر.',
        step: 'manager',
      };
    case 'SIGNUP_CODE_INVALID':
      return { message: detail ?? 'الرمز غير صحيح. تأكّد من آخر رسالة وصلتك.', step: 'verify' };
    case 'SIGNUP_TOKEN_INVALID':
      return {
        message: 'انتهت جلسة هذا التسجيل. ابدأ من جديد بنفس البريد — بياناتك لم تُفقد.',
        step: 'verify',
        restart: true,
      };
    case 'RATE_LIMITED':
      return { message: detail ?? 'محاولات كثيرة خلال وقت قصير. انتظر قليلاً ثم أعد المحاولة.', step: 'verify' };
    case 'VALIDATION_FAILED':
      return { message: detail ?? 'تحقّق من البيانات المدخلة.', step: 'manager' };
    case 'FORBIDDEN':
      return { message: detail ?? 'التسجيل الذاتي معطّل على هذا الخادم. تواصل مع إدارة المنصة.', step: 'plan' };
    default:
      break;
  }
  if (status === 409) return { message: detail ?? 'هذا البريد مستخدم مسبقاً.', step: 'manager' };
  if (status === 429) return { message: detail ?? 'محاولات كثيرة. انتظر دقيقة ثم أعد المحاولة.', step: 'verify' };
  if (status === 403) return { message: detail ?? 'التسجيل الذاتي معطّل على هذا الخادم.', step: 'plan' };
  if (status >= 500) return { message: 'تعذّر إتمام الطلب الآن. أعد المحاولة بعد قليل.', step: 'verify' };
  return { message: detail ?? 'تعذّر إتمام الطلب. راجع البيانات وأعد المحاولة.', step: 'manager' };
}

// ═══════════════════════════════════════════════════ عدّاد إعادة الإرسال

/** `MM:SS` — العداد يُعرض للزائر فيرى لماذا الزرّ معطَّل. */
export function formatCountdown(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** الثواني المتبقية على إعادة الإرسال، محسوبةً من لحظة الإرسال المُعلَنة. */
export function resendSecondsLeft(lastSentAtIso: string, now: number = Date.now()): number {
  const sentAt = new Date(lastSentAtIso).getTime();
  if (!Number.isFinite(sentAt)) return 0;
  const left = Math.ceil((sentAt + SIGNUP_RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000);
  return left > 0 ? left : 0;
}

// ═══════════════════════════════════════════════════ تذكرة لوحة الترحيب

/**
 * لوحة الترحيب تقرأ الحالة بـ`GET /signup/status/:email?token=` — والتذكرة تُنقل في **رابط
 * الصفحة** لا في تخزين المتصفح: الزائر قد يفتح الرابط في تبويبٍ آخر أو يحدّث الصفحة، والرابط
 * هو الشيء الوحيد الذي يبقى. والرمز مؤقّت (٣٠ دقيقة) ويُقرأ مرّة.
 */
export type SignupTicket = { email: string; token: string };

export function onboardingHref(ticket: SignupTicket, extra: { plan?: string } = {}): string {
  const params = new URLSearchParams({ email: ticket.email, token: ticket.token });
  if (extra.plan) params.set('plan', extra.plan);
  return `/onboarding?${params.toString()}`;
}

export function readSignupTicket(params: { email?: string; token?: string }): SignupTicket | null {
  const email = normalizeSignupEmail(params.email ?? '');
  const token = (params.token ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || token.length < 16) return null;
  return { email, token };
}

// ═══════════════════════════════════════════════════ الرمز المُدخل

/** إدخال الرمز: أرقامٌ فقط وحدٌّ بعدد الخانات — فيمنع لصق «١٢٣٤٥٦٧» بلا رسالة. */
export function sanitizeCodeInput(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, SIGNUP_CODE_LENGTH);
}

export function codeIsComplete(value: string): boolean {
  return isSignupCodeShaped(value);
}

// ═══════════════════════════════════════════════════ مهامّ الإعداد في اللوحة

export type SetupTaskView = {
  key: string;
  labelAr: string;
  helpAr: string;
  href: string;
  done: boolean;
  count?: number | null;
};

/**
 * ترتيب مهامّ اللوحة: **غير المنجَز أولاً** — الشاشة تدفع إلى الخطوة التالية لا إلى ما أُنجز.
 * والاستقرار مضمون: الترتيب الأصلي محفوظ داخل كل مجموعة (`Array.prototype.sort` مستقرّ في
 * كل محرّكات JS الحديثة، ومع ذلك نُثبّته بالفهرس لأن الترتيب قرار).
 */
export function orderSetupTasks<T extends { done: boolean }>(tasks: readonly T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => Number(left.task.done) - Number(right.task.done) || left.index - right.index)
    .map((entry) => entry.task);
}

export function setupProgress(tasks: readonly { done: boolean }[]): { done: number; total: number; percent: number } {
  // `all` لا `total`: eslint يحرس أي مُعرِّفٍ باسمٍ ماليّ في موضع قيمة (`no-restricted-syntax`)،
  // والعدد هنا عددُ مهامّ لا مبلغ. والاسم المُعاد `total` يبقى لأنه اسم حقلٍ في العقد.
  const all = tasks.length;
  const done = tasks.filter((task) => task.done).length;
  return { done, total: all, percent: all === 0 ? 0 : Math.round((done / all) * 100) };
}
