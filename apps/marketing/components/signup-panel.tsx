'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  maskSignupEmail,
  type SignupStarted,
  type SignupVerificationView,
} from '@erp/contracts';

import { PortalError, portalFetch } from '../lib/api';
import {
  SIGNUP_CODE_LENGTH,
  SIGNUP_CODE_TTL_MINUTES,
  SIGNUP_MAX_ATTEMPTS,
  SIGNUP_MAX_SENDS,
  codeIsComplete,
  emptySignupDraft,
  formatCountdown,
  onboardingHref,
  sanitizeCodeInput,
  signupCountries,
  signupCurrencies,
  signupProblem,
  signupTimezones,
  signupWizardSteps,
  stepVerdict,
  type SignupDraft,
  type SignupWizardStepKey,
} from '../lib/signup';

type Plan = { id: string; code: string; name: string; amount: string; currency: string; interval: string };

type SignupPayload = SignupStarted;

/**
 * P-M4 — معالج الاشتراك الذاتي بأربع خطوات (`docs/roadmap/MARKETING_SITE_PLAN.md` §5):
 * الباقة ← المنشأة ← المدير ← التحقّق، ثم تُنقل الشاشة إلى لوحة الترحيب.
 *
 * **ولماذا خطوات لا استمارة واحدة؟** لأن كل خطوة تُنتج شيئاً يُراجع قبل التي بعدها: باقةٌ
 * سعرها معروف، ثم ملفٌّ قانونيّ (اسم/دولة/عملة)، ثم حساب دخول. والاستمارة الطويلة تُخفي
 * الخطأ إلى آخرها فتُعيد الزائر من الأول.
 *
 * والباقة تُختار بالمعرّف: الصفحة التسويقية تربط بـ`?plan=<code>`، فيُحوَّل الرمز إلى معرّفٍ
 * من `/signup/plans` — نفس قائمة صفحة الأسعار تماماً (`PublicPlansService`)، فلا تفترق
 * القائمة المعروضة عن القائمة المقبولة.
 */
export function SignupPanel({ presetPlanCode }: { presetPlanCode?: string }) {
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [draft, setDraft] = useState<SignupDraft>(emptySignupDraft);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<SignupPayload | undefined>();
  const [verification, setVerification] = useState<SignupVerificationView | undefined>();
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);

  const step = signupWizardSteps[stepIndex]?.key ?? 'plan';
  const set = <K extends keyof SignupDraft>(key: K, value: SignupDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    portalFetch<Plan[]>('/signup/plans')
      .then((rows) => {
        setPlans(rows);
        if (presetPlanCode) {
          const preset = rows.find((plan) => plan.code === presetPlanCode);
          if (preset) set('planCode', preset.code);
        }
      })
      .catch(() => setPlans([]));
    // الباقة المسبقة تُقرأ مرّة عند الوصول من صفحة الأسعار (والحالة تُبنى على `set` الوظيفي).
  }, [presetPlanCode]);

  // عدّاد إعادة الإرسال: يعدّ في الواجهة من وقت الإرسال المُعلَن، ولا يُسأل الخادم كل ثانية.
  useEffect(() => {
    if (!verification) return;
    const tick = () => {
      const sentAt = new Date(verification.sentAt).getTime();
      const left = Math.ceil((sentAt + 60_000 - Date.now()) / 1000);
      setSecondsLeft(left > 0 ? left : 0);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [verification]);

  const chosenPlan = useMemo(
    () => plans.find((plan) => plan.code === draft.planCode),
    [plans, draft.planCode],
  );

  function goNext() {
    const verdict = stepVerdict(step, draft);
    if (!verdict.ok) {
      setError(verdict.message);
      return;
    }
    setError(undefined);
    if (step === 'manager') {
      void submit();
      return;
    }
    setStepIndex((index) => Math.min(index + 1, signupWizardSteps.length - 1));
  }

  function goBack() {
    setError(undefined);
    setStepIndex((index) => Math.max(0, index - 1));
  }

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await portalFetch<SignupPayload>('/signup', {
        method: 'POST',
        body: JSON.stringify({
          companyName: draft.companyName.trim(),
          code: draft.companyCode.trim() ? draft.companyCode.trim().toLowerCase() : undefined,
          ownerFullName: draft.ownerFullName.trim(),
          ownerEmail: draft.ownerEmail.trim().toLowerCase(),
          ownerPassword: draft.ownerPassword,
          phone: draft.phone.trim() || undefined,
          planId: chosenPlan?.id,
          countryCode: draft.countryCode,
          baseCurrency: draft.baseCurrency,
          timezone: draft.timezone,
          locale: 'ar',
          acceptedTerms: true,
        }),
      });
      setStarted(result);
      setVerification(result.verification);
      setStepIndex(signupWizardSteps.findIndex((entry) => entry.key === 'verify'));
    } catch (caught) {
      applyProblem(caught);
    } finally {
      setBusy(false);
    }
  }

  function applyProblem(caught: unknown) {
    if (caught instanceof PortalError) {
      const problem = signupProblem({ status: caught.status, code: caught.code, detail: caught.message });
      setError(problem.message);
      if (problem.restart) {
        setStarted(undefined);
        setVerification(undefined);
        setStepIndex(0);
      } else {
        const index = signupWizardSteps.findIndex((entry) => entry.key === problem.step);
        if (index >= 0) setStepIndex(index);
      }
      return;
    }
    setError('تعذّر الاتصال بالخادم. تأكّد من تشغيل الـ API ثم أعد المحاولة.');
  }

  async function verify() {
    if (!started) return;
    setBusy(true);
    setError(undefined);
    try {
      const status = await portalFetch<{ verification: SignupVerificationView }>('/signup/verify', {
        method: 'POST',
        body: JSON.stringify({ email: started.ownerEmail, token: started.token, code }),
      });
      setVerification(status.verification);
      router.push(onboardingHref({ email: started.ownerEmail, token: started.token }, { plan: draft.planCode }));
    } catch (caught) {
      applyProblem(caught);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!started) return;
    setBusy(true);
    setError(undefined);
    try {
      const view = await portalFetch<SignupVerificationView>('/signup/resend', {
        method: 'POST',
        body: JSON.stringify({ email: started.ownerEmail, token: started.token }),
      });
      setVerification(view);
      setCode('');
    } catch (caught) {
      applyProblem(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      {/* ── شريط الخطوات: ما مضى وما تبقّى، وموضع الزائر منه */}
      <ol className="steps" aria-label="خطوات الاشتراك">
        {signupWizardSteps.map((entry, index) => (
          <li key={entry.key} aria-current={index === stepIndex ? 'step' : undefined}>
            <span className="step-number">{index + 1}</span>
            <span>
              <b>{entry.titleAr}</b>
              <br />
              <span className="muted">{entry.helpAr}</span>
            </span>
          </li>
        ))}
      </ol>

      {step === 'plan' ? (
        <section aria-label="الباقة">
          {plans.length === 0 ? (
            <p className="muted">
              لا توجد باقات معلنة الآن — يمكنك المتابعة، ويُحدَّد الاشتراك مع اعتماد إدارة المنصة.
            </p>
          ) : (
            <div className="plan-grid">
              {plans.map((plan) => (
                <article
                  className={`card plan-card${plan.code === draft.planCode ? ' selected' : ''}`}
                  key={plan.id}
                >
                  <h3>{plan.name}</h3>
                  <p className="plan-price">
                    {plan.amount} {plan.currency}
                  </p>
                  <p className="muted">{plan.interval === 'year' ? 'سنوياً' : 'شهرياً'}</p>
                  <button
                    className={`btn${plan.code === draft.planCode ? ' primary' : ''}`}
                    type="button"
                    aria-pressed={plan.code === draft.planCode}
                    onClick={() => set('planCode', plan.code === draft.planCode ? '' : plan.code)}
                  >
                    {plan.code === draft.planCode ? 'مختارة' : 'اختيار هذه الباقة'}
                  </button>
                </article>
              ))}
            </div>
          )}
          <p className="muted">
            {chosenPlan
              ? `المختار: ${chosenPlan.name} — ${chosenPlan.amount} ${chosenPlan.currency}`
              : 'لم تُختر باقة: تُحدَّد مع اعتماد طلب الاشتراك.'}
          </p>
        </section>
      ) : null}

      {step === 'company' ? (
        <section aria-label="بيانات المنشأة">
          <input
            className="input"
            aria-label="company name"
            value={draft.companyName}
            onChange={(event) => set('companyName', event.target.value)}
            placeholder="اسم المنشأة * — مثال: مؤسسة النور التجارية"
          />
          <input
            className="input"
            dir="ltr"
            aria-label="tenant code"
            value={draft.companyCode}
            onChange={(event) => set('companyCode', event.target.value.toLowerCase())}
            placeholder="رمز المنشأة (اختياري) — يُشتقّ من الاسم إن تُرك فارغاً"
          />
          <div className="row">
            <select
              className="input"
              aria-label="country"
              value={draft.countryCode}
              onChange={(event) => set('countryCode', event.target.value)}
            >
              {signupCountries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.nameAr}
                </option>
              ))}
            </select>
            <select
              className="input"
              aria-label="currency"
              value={draft.baseCurrency}
              onChange={(event) => set('baseCurrency', event.target.value)}
            >
              {signupCurrencies.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </div>
          <select
            className="input"
            aria-label="timezone"
            value={draft.timezone}
            onChange={(event) => set('timezone', event.target.value)}
          >
            {signupTimezones.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.nameAr}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      {step === 'manager' ? (
        <section aria-label="بيانات المدير">
          <input
            className="input"
            aria-label="owner full name"
            value={draft.ownerFullName}
            onChange={(event) => set('ownerFullName', event.target.value)}
            placeholder="اسمك الكامل *"
          />
          <input
            className="input"
            type="email"
            dir="ltr"
            aria-label="owner email"
            autoComplete="username"
            value={draft.ownerEmail}
            onChange={(event) => set('ownerEmail', event.target.value)}
            placeholder="البريد الإلكتروني * — يصل إليه رمز التحقّق"
          />
          <div className="row">
            <input
              className="input"
              type="password"
              dir="ltr"
              aria-label="owner password"
              autoComplete="new-password"
              value={draft.ownerPassword}
              onChange={(event) => set('ownerPassword', event.target.value)}
              placeholder="كلمة المرور * (١٢ حرفاً على الأقل)"
            />
            <input
              className="input"
              type="password"
              dir="ltr"
              aria-label="owner password confirm"
              autoComplete="new-password"
              value={draft.ownerPasswordConfirm}
              onChange={(event) => set('ownerPasswordConfirm', event.target.value)}
              placeholder="تأكيد كلمة المرور *"
            />
          </div>
          <input
            className="input"
            dir="ltr"
            aria-label="owner phone"
            value={draft.phone}
            onChange={(event) => set('phone', event.target.value)}
            placeholder="رقم الجوال (اختياري) — مثال: +9665xxxxxxxx"
          />
        </section>
      ) : null}

      {step === 'verify' ? (
        <section aria-label="التحقّق">
          <p>
            أرسلنا رمزاً من <b>{SIGNUP_CODE_LENGTH}</b> أرقام إلى{' '}
            <bdi>{started ? maskSignupEmail(started.ownerEmail) : ''}</bdi> — صالحٌ{' '}
            <b>{SIGNUP_CODE_TTL_MINUTES}</b> دقيقة.
          </p>
          <input
            className="input"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="verification code"
            value={code}
            onChange={(event) => setCode(sanitizeCodeInput(event.target.value))}
            placeholder={`${SIGNUP_CODE_LENGTH} أرقام`}
          />
          <div className="toolbar">
            <button
              className="btn primary"
              type="button"
              disabled={busy || !codeIsComplete(code)}
              onClick={() => void verify()}
            >
              {busy ? 'جارٍ التحقّق…' : 'تأكيد الرمز'}
            </button>
            <button className="btn" type="button" disabled={busy || secondsLeft > 0} onClick={() => void resend()}>
              {secondsLeft > 0 ? `إعادة الإرسال بعد ${formatCountdown(secondsLeft)}` : 'إرسال رمز جديد'}
            </button>
          </div>
          {verification ? (
            <p className="muted">
              المحاولات المتبقية: {verification.attemptsRemaining} من {SIGNUP_MAX_ATTEMPTS} · الرسائل المتبقية:{' '}
              {verification.sendsRemaining} من {SIGNUP_MAX_SENDS}
            </p>
          ) : null}
          <p className="muted">
            <small>
              لم يصل الرمز؟ تحقّق من مجلّد الإعلانات، أو اطلب رمزاً جديداً بعد انتهاء المهلة. البريد نفسه لا
              يُسجَّل مرّتين.
            </small>
          </p>
        </section>
      ) : null}

      {started && step === 'verify' ? (
        <p className="muted">
          رمز منشأتك: <b dir="ltr">{started.tenantCode}</b> — احفظه؛ ستحتاجه في الدخول.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="muted">
          {error}
        </p>
      ) : null}

      {/* ── أدوات التنقّل: الخطوة الحالية تُقرأ من نفس مصفوفة الخطوات */}
      {step !== 'verify' ? (
        <div className="toolbar">
          {stepIndex > 0 ? (
            <button className="btn" type="button" disabled={busy} onClick={goBack}>
              السابق
            </button>
          ) : null}
          <button className="btn primary" type="button" disabled={busy} onClick={goNext}>
            {busy ? 'جارٍ الإرسال…' : step === 'manager' ? 'إنشاء المنشأة وإرسال الرمز' : 'التالي'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** أسماء الخطوات للاختبار وللوحة الترحيب — مجموعةٌ واحدة لا تكرار. */
export const signupStepKeys: SignupWizardStepKey[] = signupWizardSteps.map((entry) => entry.key);
