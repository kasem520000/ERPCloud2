import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  SIGNUP_CODE_LENGTH,
  SIGNUP_CODE_TTL_MINUTES,
  SIGNUP_MAX_ATTEMPTS,
  SIGNUP_MAX_SENDS,
  SIGNUP_RESEND_COOLDOWN_SECONDS,
} from '@erp/contracts';

import {
  codeIsComplete,
  emptySignupDraft,
  firstIncompleteStep,
  formatCountdown,
  onboardingHref,
  orderSetupTasks,
  readSignupTicket,
  resendSecondsLeft,
  sanitizeCodeInput,
  setupProgress,
  signupProblem,
  signupWizardSteps,
  stepVerdict,
  type SignupDraft,
} from '../lib/signup';

const appDir = fileURLToPath(new URL('../app', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

const draft = (overrides: Partial<SignupDraft> = {}): SignupDraft => ({ ...emptySignupDraft, ...overrides });

const complete = draft({
  planCode: 'starter',
  companyName: 'مؤسسة النور',
  countryCode: 'SA',
  baseCurrency: 'SAR',
  ownerFullName: 'سالم النور',
  ownerEmail: 'owner@noor.test',
  ownerPassword: 'Strong-Pass-2026!',
  ownerPasswordConfirm: 'Strong-Pass-2026!',
});

/**
 * P-M4 — معالج الاشتراك في الموقع التسويقي: **نموذجٌ يُقاس قبل أن يُرسَل**.
 *
 * الاختبار هنا ليس اختبار واجهةٍ (لا متصفّح في هذا المستودع)، بل اختبار **القواعد** التي
 * تحكم الواجهة: ترتيب الخطوات، وشروط الانتقال، وترجمة أخطاء الـAPI، وعدّاد إعادة الإرسال،
 * وتذكرة لوحة الترحيب. وسبب وجودها هنا أن كلفة الخطأ في هذا المسار أعلى من غيره: كل إرسالٍ
 * يُنشئ منشأةً ويرسل بريداً، فلا يجوز أن يكون الشرط مخبوءاً في JSX.
 */
describe('signup wizard (P-M4)', () => {
  it('أربع خطوات بترتيبها المنصوص عليه', () => {
    expect(signupWizardSteps.map((step) => step.key)).toEqual(['plan', 'company', 'manager', 'verify']);
    expect(signupWizardSteps.map((step) => step.titleAr)).toEqual(['الباقة', 'المنشأة', 'مدير الحساب', 'التحقّق']);
    expect(signupWizardSteps.every((step) => step.helpAr.length > 10)).toBe(true);
  });

  it('لا تُقرأ أرقام الرمز من الواجهة: هي نفس ثوابت العقود التي يقرأها الـAPI', () => {
    // لو غيّر أحدٌ ٦ أرقام إلى ٨ في العقود، فشل هذا السطر قبل أن يكتشفه زائرٌ لا يصله رمز.
    expect(SIGNUP_CODE_LENGTH).toBe(6);
    expect(SIGNUP_CODE_TTL_MINUTES).toBe(30);
    expect(SIGNUP_MAX_ATTEMPTS).toBe(5);
    expect(SIGNUP_MAX_SENDS).toBe(5);
    expect(SIGNUP_RESEND_COOLDOWN_SECONDS).toBe(60);
  });

  it('خطوة المنشأة ترفض اسماً قصيراً ورمزاً غير صالح', () => {
    expect(stepVerdict('company', draft({ companyName: 'أ' }))).toMatchObject({ ok: false });
    expect(stepVerdict('company', draft({ companyName: 'نور', companyCode: 'رمز عربي' }))).toMatchObject({
      ok: false,
    });
    // بلا رمزٍ مختار: الرمز يُشتقّ من الاسم (الـAPI يفعل ذلك)، فالفراغ ليس خطأً.
    expect(stepVerdict('company', complete).ok).toBe(true);
  });

  it('خطوة المدير ترفض البريد الناقص وكلمة المرور القصيرة وعدم التطابق', () => {
    expect(stepVerdict('manager', draft({ ...complete, ownerEmail: 'owner@' }))).toMatchObject({ ok: false });
    expect(stepVerdict('manager', draft({ ...complete, ownerPassword: 'short-short' }))).toMatchObject({
      ok: false,
      message: expect.stringContaining('١٢'),
    });
    expect(
      stepVerdict('manager', draft({ ...complete, ownerPasswordConfirm: 'Another-Pass-2026!' })),
    ).toMatchObject({ ok: false, message: expect.stringContaining('متطابقتين') });
    expect(stepVerdict('manager', complete).ok).toBe(true);
  });

  it('الباقة ليست شرطاً — فالاشتراك يُعتمد من المنصة لا من اختيار الزائر', () => {
    expect(stepVerdict('plan', draft()).ok).toBe(true);
    expect(stepVerdict('verify', draft()).ok).toBe(true);
  });

  it('أول خطوة ناقصة هي ما يُفتح عليه المعالج', () => {
    expect(firstIncompleteStep(draft())).toBe('company');
    expect(firstIncompleteStep(draft({ companyName: 'نور' }))).toBe('manager');
    expect(firstIncompleteStep(complete)).toBe('verify');
  });

  it('ترجمة أخطاء الـAPI تعيد الزائر إلى الخطوة المعنيّة لا إلى الأولى', () => {
    expect(signupProblem({ status: 409, code: 'SIGNUP_EMAIL_TAKEN' })).toMatchObject({ step: 'manager' });
    expect(signupProblem({ status: 422, code: 'SIGNUP_CODE_INVALID' })).toMatchObject({ step: 'verify' });
    expect(signupProblem({ status: 404, code: 'SIGNUP_TOKEN_INVALID' })).toMatchObject({
      step: 'verify',
      restart: true,
    });
    expect(signupProblem({ status: 429, code: 'RATE_LIMITED' })).toMatchObject({ step: 'verify' });
    expect(signupProblem({ status: 403, code: 'FORBIDDEN' })).toMatchObject({ step: 'plan' });
    // نصّ الخادم يُعرض إن وُجد: الشاشة لا تُعيد صياغة رسالةٍ تعرفها.
    const detailed = signupProblem({ status: 422, code: 'SIGNUP_CODE_INVALID', detail: 'الرمز غير صحيح. تبقّى 4 محاولة.' });
    expect(detailed.message).toBe('الرمز غير صحيح. تبقّى 4 محاولة.');
    // و500 لا يُعاد فيه نشر تفاصيل الخادم.
    expect(signupProblem({ status: 500, detail: 'stack trace' }).message).not.toContain('stack');
  });

  it('عدّاد إعادة الإرسال محسوبٌ من وقت الإرسال المُعلَن', () => {
    const sentAt = new Date('2026-09-18T10:00:00.000Z').toISOString();
    const at = (offsetSeconds: number) => new Date(Date.parse(sentAt) + offsetSeconds * 1000).getTime();
    expect(resendSecondsLeft(sentAt, at(0))).toBe(60);
    expect(resendSecondsLeft(sentAt, at(59))).toBe(1);
    expect(resendSecondsLeft(sentAt, at(60))).toBe(0);
    expect(resendSecondsLeft('ليس تاريخاً', at(0))).toBe(0);
    expect(formatCountdown(60)).toBe('01:00');
    expect(formatCountdown(9)).toBe('00:09');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5)).toBe('00:00');
  });

  it('الرمز يُنقّى قبل الاستعمال: أرقامٌ فقط وبعدد خانات العقود', () => {
    expect(sanitizeCodeInput('12 34-56')).toBe('123456');
    expect(sanitizeCodeInput('١٢٣٤٥٦')).toBe(''); // أرقام هندية: لا تُخمَّن، تُرفض
    expect(sanitizeCodeInput('12345678')).toHaveLength(SIGNUP_CODE_LENGTH);
    expect(codeIsComplete('123456')).toBe(true);
    expect(codeIsComplete('12345')).toBe(false);
  });

  it('تذكرة لوحة الترحيب تدور في الرابط وتعود كما هي', () => {
    const ticket = { email: 'Owner@Noor.TEST', token: 'a'.repeat(48) };
    const href = onboardingHref(ticket);
    expect(href.startsWith('/onboarding?')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    const parsed = readSignupTicket({
      email: params.get('email') ?? undefined,
      token: params.get('token') ?? undefined,
    });
    expect(parsed).toEqual({ email: 'owner@noor.test', token: ticket.token });
    expect(onboardingHref(ticket, { plan: 'starter' })).toContain('plan=starter');

    // وما لا يصلح للتذكرة لا يُنشئ جلسة: بريدٌ ناقص أو رمزٌ قصير.
    expect(readSignupTicket({ email: 'owner@', token: ticket.token })).toBeNull();
    expect(readSignupTicket({ email: ticket.email, token: 'short' })).toBeNull();
    expect(readSignupTicket({})).toBeNull();
  });

  it('لوحة الترحيب ترتّب غير المنجَز أولاً وتحسب النسبة', () => {
    const tasks = [
      { key: 'company', done: true },
      { key: 'branch', done: true },
      { key: 'chart', done: true },
      { key: 'invoice', done: false },
    ];
    expect(orderSetupTasks(tasks).map((task) => task.key)).toEqual(['invoice', 'company', 'branch', 'chart']);
    expect(setupProgress(tasks)).toEqual({ done: 3, total: 4, percent: 75 });
    expect(setupProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it('المسار والشاشة موجودان فعلاً — لا واجهةٌ بلا صفحة', () => {
    expect(existsSync(join(appDir, 'onboarding/page.tsx'))).toBe(true);
    expect(existsSync(join(root, 'components/signup-panel.tsx'))).toBe(true);
    expect(existsSync(join(root, 'components/onboarding-panel.tsx'))).toBe(true);

    // والصفحة تقرأ المعاملات في الخادم، فلا `useSearchParams` في العميل ولا حدود Suspense.
    const page = readFileSync(join(appDir, 'onboarding/page.tsx'), 'utf8');
    // الكود وحده: الشرح يذكر الاسم أيضاً، والحكم على ما يُنفَّذ لا على ما يُشرَح.
    const code = page
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    expect(page).toContain('searchParams');
    expect(code).not.toContain('useSearchParams');
    expect(code).not.toContain('next/navigation');
  });
});
