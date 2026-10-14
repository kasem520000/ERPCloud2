/**
 * P-M4 — الاشتراك والتفعيل: العقد الكامل بين الموقع التسويقي والـAPI.
 *
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 «الشاشات: معالج ٤ خطوات … التحقق (رمز بالبريد)».)
 *
 * ثلاث قواعد تحكم هذا الملف:
 *
 *   1. **الرمز سرّ** لا يُخزَّن ولا يُعاد. يُخزَّن تجزئته (`code_hash`) ويُرسل في البريد وحده،
 *      ولا يظهر في أي استجابة — لا في `POST /signup` ولا في الحالة. وما يُعاد للعميل مرّةً
 *      واحدة هو **الرمز المميّز** (`token`) الذي يُثبت أن الطالب هو من بدأ التسجيل، فيُطلب
 *      في التحقّق وإعادة الإرسال والحالة؛ وبذلك لا يصير `GET /signup/status/:email` باباً
 *      لسرد العناوين (بلا رمزٍ صحيح الجواب **404**، لا «غير موجود» و«غير مصرَّح» مختلفين).
 *   2. **القواعد زمانية ونقيّة** هنا لا في الخدمة: انتهاء الرمز، الإغلاق بعد محاولات،
 *      ومهلة إعادة الإرسال — دوالُّ تُحسب من الطوابع الزمنية فتُقاس في اختبارٍ بلا انتظار.
 *   3. **التسميات من سجلّ واحد** (`signupSetupTaskDefinitions`): شاشة الترحيب والاختبار
 *      والسكربت الحيّ تقرأ المهامّ الأربع من هنا، فلا تفترق قائمةُ «ما تبقّى» في مكانين.
 */
import { z } from 'zod';

import { uuidSchema } from '../ids.js';

// ═══════════════════════════════════════════════════ الثوابت

/** طول رمز التحقّق (أرقام). ستة أرقام: تكفي لتجربةٍ واحدة وتُقرأ من البريد بلا خطأ. */
export const SIGNUP_CODE_LENGTH = 6;
/** صلاحية الرمز — نصف ساعة. أقصرُ يُلحق بالزائر، وأطولُ يترك نافذةً مفتوحة. */
export const SIGNUP_CODE_TTL_MINUTES = 30;
/** المحاولات الخاطئة المسموحة قبل إغلاق الطلب (يُعاد الفتح بإعادة إرسال جديدة). */
export const SIGNUP_MAX_ATTEMPTS = 5;
/** مهلة إعادة الإرسال — دقيقة. تمنع استخدام الشاشة مُرسِلَ بريدٍ إلى عنوانٍ لا يملكه الطالب. */
export const SIGNUP_RESEND_COOLDOWN_SECONDS = 60;
/** أقصى عدد إرسالاتٍ لنفس البريد قبل أن يُطلب البدء من جديد (حمايةُ سقف SMTP). */
export const SIGNUP_MAX_SENDS = 5;

export const signupVerificationStates = ['pending', 'verified', 'expired', 'locked'] as const;
export const signupVerificationStateSchema = z.enum(signupVerificationStates);
export type SignupVerificationState = z.infer<typeof signupVerificationStateSchema>;

// ═══════════════════════════════════════════════════ دوالّ نقيّة

/** البريد عنوانُ الهوية في هذا المسار: يُوحَّد قبل أي قراءة أو كتابة (لا مسافات ولا حالة). */
export function normalizeSignupEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * الرمز يُكتب على مهل: مسافاتٌ وشرطات قد تُلصق عند النسخ من البريد، فتُنزع قبل المقارنة —
 * ولا يُقبل غير الأرقام. (والمقارنة نفسها على التجزئة، هنا التطبيع فقط.)
 */
export function normalizeSignupCode(value: string): string {
  return value.replace(/[\s\u200f\u200e-]/g, '');
}

/** الشكل الصحيح: أرقامٌ بعدد الطول بالضبط. يُفحص قبل أي استعلام. */
export function isSignupCodeShaped(value: string): boolean {
  const normalized = normalizeSignupCode(value);
  return new RegExp(`^\\d{${SIGNUP_CODE_LENGTH}}$`).test(normalized);
}

/**
 * إخفاء البريد للعرض في الشاشة (`o…@demo.test`): الزائر يرى ما يكفي ليتأكّد أنه هو، ولا
 * يُطبع العنوان كاملاً في صفحةٍ قد يفتحها غيره على الشاشة نفسها.
 */
export function maskSignupEmail(value: string): string {
  const email = normalizeSignupEmail(value);
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local.slice(0, 1)}…${domain}`;
  return `${local.slice(0, 1)}…${local.slice(-1)}${domain}`;
}

export type SignupVerificationRow = {
  verifiedAt?: Date | string | null;
  expiresAt: Date | string;
  attempts: number;
  sends?: number;
};

/**
 * حالة التحقّق — دالّة نقيّة تُقرأ منها الشاشة والخدمة والاختبار بالنتيجة نفسها.
 * الترتيب مقصود: المُتحقَّق يبقى متحقَّقاً ولو انتهى رمزه (التوثيق حدثٌ وقع، ولا يُلغى بمرور
 * الوقت)، ثم الإغلاق بعد المحاولات، ثم الانتهاء، ثم الانتظار.
 */
export function signupVerificationState(
  row: SignupVerificationRow,
  now: Date = new Date(),
): SignupVerificationState {
  if (row.verifiedAt) return 'verified';
  if (row.attempts >= SIGNUP_MAX_ATTEMPTS) return 'locked';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/** متى يُسمح بإرسالٍ جديد؟ (تُقارن في الشاشة وفي الخدمة — قاعدةٌ واحدة للعدّاد.) */
export function signupResendAvailableAt(lastSentAt: Date | string): Date {
  return new Date(new Date(lastSentAt).getTime() + SIGNUP_RESEND_COOLDOWN_SECONDS * 1000);
}

/** الثواني المتبقية قبل إعادة الإرسال (صفر = متاحةٌ الآن). */
export function signupResendWaitSeconds(lastSentAt: Date | string, now: Date = new Date()): number {
  const wait = Math.ceil((signupResendAvailableAt(lastSentAt).getTime() - now.getTime()) / 1000);
  return wait > 0 ? wait : 0;
}

// ═══════════════════════════════════════════════════ مهامّ الإعداد

/**
 * لوحة الترحيب تقول ما تبقّى فعلاً، لا ما يُفترض أن يبقى. وكل مهمّة لها مصدرٌ في القاعدة:
 * ملفّ المنشأة من `tenants`، الفرع ودليل الحسابات ممّا أنشأته `provisionOrgDefaults`،
 * وأول فاتورة من `sales_invoices` — والمشغّل يقرأ النتيجة نفسها في اللوحة.
 */
export const signupSetupTaskDefinitions = [
  {
    key: 'company',
    labelAr: 'ملف المنشأة',
    labelEn: 'Company profile',
    helpAr: 'الاسم والدولة والعملة والمنطقة الزمنية — تُملأ من خطوة «المنشأة».',
    helpEn: 'Name, country, currency and time zone — filled by the company step.',
    href: '/settings',
  },
  {
    key: 'branch',
    labelAr: 'الفرع الرئيسي',
    labelEn: 'Main branch',
    helpAr: 'يُجهَّز تلقائياً مع المستودع والخزنة وقائمة الأسعار.',
    helpEn: 'Provisioned automatically with the warehouse, safe and price list.',
    href: '/settings/branches',
  },
  {
    key: 'chart',
    labelAr: 'دليل الحسابات',
    labelEn: 'Chart of accounts',
    helpAr: 'يُنسخ من الدليل الافتراضي عند التسجيل، فتكون القيود جاهزة.',
    helpEn: 'Copied from the default chart at signup so posting works immediately.',
    href: '/accounting/accounts',
  },
  {
    key: 'invoice',
    labelAr: 'أول فاتورة',
    labelEn: 'First invoice',
    helpAr: 'أصدر فاتورة ضريبية واحدة لتتأكّد من الترقيم والترحيل والطباعة.',
    helpEn: 'Issue one tax invoice to confirm numbering, posting and printing.',
    href: '/sales/invoices/new',
  },
] as const;

export const signupSetupTaskSchema = z.object({
  key: z.string().trim().min(1).max(40),
  labelAr: z.string().trim().min(1).max(80),
  labelEn: z.string().trim().min(1).max(80),
  helpAr: z.string().trim().min(1).max(240),
  helpEn: z.string().trim().min(1).max(240),
  href: z.string().trim().min(1).max(120),
  done: z.boolean(),
  /** قيمةٌ تقيس الإنجاز حين تكون ذات معنى (عدد فروع، عدد حسابات، عدد فواتير). */
  count: z.number().int().min(0).nullish(),
});
export type SignupSetupTask = z.infer<typeof signupSetupTaskSchema>;

// ═══════════════════════════════════════════════════ الأشكال

export const signupRequestSchema = z.object({
  companyName: z.string().trim().min(2, 'اسم المنشأة حرفان على الأقل').max(120),
  /** رمز المنشأة اختياري: يُشتقّ من الاسم إن غاب (وهو ما يفعله الـAPI). */
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'رمز المنشأة حروفٌ صغيرة وأرقام وشرطات (٢–٦٣)')
    .optional(),
  ownerFullName: z.string().trim().min(2, 'اسم المدير حرفان على الأقل').max(120),
  ownerEmail: z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(160),
  ownerPassword: z.string().min(12, 'كلمة المرور ١٢ حرفاً على الأقل').max(200),
  planId: uuidSchema.optional(),
  phone: z.string().trim().max(32).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().default('SA'),
  baseCurrency: z.string().trim().length(3).toUpperCase().default('SAR'),
  timezone: z.string().trim().min(3).max(60).default('Asia/Riyadh'),
  /** لغة البريد والواجهة — يقرّرها الزائر من عنوان الموقع. */
  locale: z.enum(['ar', 'en']).default('ar'),
  /** موافقةٌ صريحة لا صندوقٌ مُسبق التحديد (وإن كان الحقل اختيارياً في النسخة الحالية). */
  acceptedTerms: z.boolean().optional(),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const signupVerifyRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  token: z.string().trim().min(16).max(128),
  code: z.string().trim().min(1).max(16),
});
export type SignupVerifyRequest = z.infer<typeof signupVerifyRequestSchema>;

export const signupResendRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  token: z.string().trim().min(16).max(128),
});
export type SignupResendRequest = z.infer<typeof signupResendRequestSchema>;

export const signupVerificationViewSchema = z.object({
  state: signupVerificationStateSchema,
  email: z.string(),
  /** العنوان مُخفيّ للعرض (`o…@demo.test`). */
  emailMasked: z.string(),
  sentAt: z.string(),
  expiresAt: z.string(),
  attemptsRemaining: z.number().int().min(0),
  sendsRemaining: z.number().int().min(0),
  resendWaitSeconds: z.number().int().min(0),
});
export type SignupVerificationView = z.infer<typeof signupVerificationViewSchema>;

export const signupPlanChoiceSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  interval: z.enum(['month', 'year']),
  amount: z.string(),
  currency: z.string(),
});
export type SignupPlanChoice = z.infer<typeof signupPlanChoiceSchema>;

/**
 * جواب `POST /signup`. **لا يحتوي الرمز**: يُرسل بالبريد وحده؛ وما يعود هنا هو `token`
 * (سرّ الجلسة القصيرة للمعالج) ومعرّف طلب التفعيل وحالةً تُظهر الشاشة بها.
 */
export const signupStartedSchema = z.object({
  tenantCode: z.string(),
  tenantName: z.string(),
  ownerEmail: z.string(),
  subscriptionStatus: z.enum(['pending', 'active']),
  activationRequestId: uuidSchema.nullable(),
  verification: signupVerificationViewSchema,
  token: z.string(),
  plan: signupPlanChoiceSchema.nullable(),
  /** الفترة التجريبية المعلَنة من إعدادات المنصة (`billing.trial_days`). */
  trialDays: z.number().int().min(0),
});
export type SignupStarted = z.infer<typeof signupStartedSchema>;

export const signupStatusSchema = z.object({
  tenantCode: z.string(),
  tenantName: z.string(),
  ownerEmail: z.string(),
  subscriptionStatus: z.enum(['pending', 'active']),
  verification: signupVerificationViewSchema,
  plan: signupPlanChoiceSchema.nullable(),
  trialDays: z.number().int().min(0),
  setup: z.array(signupSetupTaskSchema),
  progress: z.object({
    done: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
});
export type SignupStatus = z.infer<typeof signupStatusSchema>;

/** ما يُرسل إلى عميل البريد: متغيّرات القالب بلغته. */
export function signupEmailVariables(input: {
  ownerName: string;
  companyName: string;
  code: string;
  expiresAt: Date | string;
}): Record<string, string> {
  return {
    name: input.ownerName,
    company: input.companyName,
    code: input.code,
    expires: new Date(input.expiresAt).toISOString(),
  };
}
