'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, apiPost } from '../lib/api';
import { useLang } from '../lib/i18n';
import { useSession } from '../lib/session';

const MARKETING_URL = (process.env.NEXT_PUBLIC_MARKETING_URL ?? '').replace(/\/+$/, '');

type AuthStep = 'credentials' | 'mfa' | 'forgot' | 'reset';

/**
 * Sign-in screen for the staff back office. Bilingual, keyboard friendly, with a TOTP step
 * and full self-service Forgot Password / Reset Password flow.
 */
export function LoginScreen({ initialError }: { initialError?: string }) {
  const { signIn } = useSession();
  const { t } = useLang();
  const params = useSearchParams();
  const urlResetToken = params.get('resetToken') ?? '';
  const [step, setStep] = useState<AuthStep>(urlResetToken ? 'reset' : 'credentials');
  const [tenantCode, setTenantCode] = useState(params.get('tenant') ?? '');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [resetToken, setResetToken] = useState(urlResetToken);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [notice, setNotice] = useState<string | undefined>();
  const justJoined = params.get('joined') === '1';

  useEffect(() => {
    if (urlResetToken) {
      setResetToken(urlResetToken);
      setStep('reset');
    }
  }, [urlResetToken]);

  async function attempt(code?: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await signIn(email.trim(), password, tenantCode.trim(), code);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === 'MFA_REQUIRED') {
          setStep('mfa');
        } else if (caught.status === 401) setError(t(step === 'mfa' ? 'mfa.error.invalid' : 'login.error.invalid'));
        else if (caught.status === 423) setError(t('login.error.suspended'));
        else if (caught.status === 429) setError(t('login.error.rateLimited'));
        else setError(caught.message);
      } else {
        setError(t('login.error.unreachable'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await apiPost<{ data: { ok: boolean; message: string } }>('/auth/forgot-password', {
        email: email.trim(),
        ...(tenantCode.trim() ? { tenantCode: tenantCode.trim() } : {}),
      });
      const msg =
        (res as unknown as { message?: string })?.message ??
        res?.data?.message ??
        'إذا كان البريد الإلكتروني مسجلاً لدينا، فقد تم إرسال رمز ورابط استعادة كلمة المرور.';
      setNotice(msg);
      setStep('reset');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'تعذر إرسال طلب استعادة كلمة المرور.');
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    if (newPassword !== confirmPassword) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await apiPost<{ data: { ok: boolean; message: string } }>('/auth/reset-password', {
        token: resetToken.trim(),
        newPassword,
      });
      const msg =
        (res as unknown as { message?: string })?.message ??
        res?.data?.message ??
        'تم إعادة تعيين كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول.';
      setNotice(msg);
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setStep('credentials');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'تعذر إعادة تعيين كلمة المرور.');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (step === 'mfa') void attempt(mfaCode.trim());
    else if (step === 'forgot') void submitForgot();
    else if (step === 'reset') void submitReset();
    else void attempt();
  }

  const titleText =
    step === 'mfa'
      ? t('mfa.title')
      : step === 'forgot'
        ? 'استعادة كلمة المرور'
        : step === 'reset'
          ? 'تعيين كلمة مرور جديدة'
          : t('login.title');

  const subtitleText =
    step === 'mfa'
      ? t('mfa.hint')
      : step === 'forgot'
        ? 'أدخل بريدك الإلكتروني المسجّل لإرسال رمز ورابط استعادة كلمة المرور.'
        : step === 'reset'
          ? 'أدخل رمز الاستعادة المرسل إلى بريدك الإلكتروني وكلمة المرور الجديدة.'
          : t('login.subtitle');

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <span className="logo big">ERP</span>
        <h1>{t('app.name')}</h1>
        <p>{t('app.tagline')}</p>
        <ul>
          <li>{t('app.feature.isolation')}</li>
          <li>{t('app.feature.permissions')}</li>
          <li>{t('app.feature.audit')}</li>
        </ul>
      </div>

      <form className="auth-card" onSubmit={submit}>
        <h2>{titleText}</h2>
        <p className="muted">{subtitleText}</p>

        {justJoined && step === 'credentials' && (
          <p className="alert ok" role="status">
            {t('login.joined')}
          </p>
        )}

        {notice && (
          <p className="alert ok" role="status">
            {notice}
          </p>
        )}

        {step === 'credentials' && (
          <>
            <label className="field">
              <span>{t('login.tenantCode')}</span>
              <input
                className="input"
                value={tenantCode}
                onChange={(event) => setTenantCode(event.target.value)}
                placeholder="company-code"
                autoComplete="organization"
                required
                dir="ltr"
              />
            </label>

            <label className="field">
              <span>{t('login.email')}</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="user@company.com"
                autoComplete="username"
                required
                dir="ltr"
              />
            </label>

            <label className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('login.password')}</span>
                <button
                  type="button"
                  onClick={() => {
                    setError(undefined);
                    setNotice(undefined);
                    setStep('forgot');
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-primary-600, #2563eb)',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  نسيت كلمة السر؟
                </button>
              </div>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                dir="ltr"
              />
            </label>
          </>
        )}

        {step === 'mfa' && (
          <label className="field">
            <span>{t('mfa.code')}</span>
            <input
              className="input"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              placeholder="000000"
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              required
              dir="ltr"
            />
          </label>
        )}

        {step === 'forgot' && (
          <>
            <label className="field">
              <span>{t('login.tenantCode')} (اختياري)</span>
              <input
                className="input"
                value={tenantCode}
                onChange={(event) => setTenantCode(event.target.value)}
                placeholder="company-code"
                autoComplete="organization"
                dir="ltr"
              />
            </label>

            <label className="field">
              <span>{t('login.email')}</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="user@company.com"
                autoComplete="username"
                required
                dir="ltr"
              />
            </label>
          </>
        )}

        {step === 'reset' && (
          <>
            <label className="field">
              <span>رمز الاستعادة</span>
              <input
                className="input mono"
                value={resetToken}
                onChange={(event) => setResetToken(event.target.value)}
                placeholder="rst_..."
                required
                dir="ltr"
              />
            </label>

            <label className="field">
              <span>كلمة المرور الجديدة (12 حرفاً على الأقل)</span>
              <input
                className="input"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={12}
                autoComplete="new-password"
                required
                dir="ltr"
              />
            </label>

            <label className="field">
              <span>تأكيد كلمة المرور الجديدة</span>
              <input
                className="input"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                minLength={12}
                autoComplete="new-password"
                required
                dir="ltr"
              />
            </label>
          </>
        )}

        {error && (
          <p className="alert danger" role="alert">
            {error}
          </p>
        )}

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy
            ? step === 'mfa'
              ? t('mfa.verifying')
              : 'جارٍ التنفيذ…'
            : step === 'mfa'
              ? t('mfa.verify')
              : step === 'forgot'
                ? 'إرسال رابط ورمز الاستعادة'
                : step === 'reset'
                  ? 'حفظ كلمة المرور الجديدة'
                  : t('login.submit')}
        </button>

        {step === 'forgot' && (
          <button
            className="btn block"
            type="button"
            onClick={() => {
              setError(undefined);
              setStep('reset');
            }}
          >
            لدي رمز الاستعادة بالفعل
          </button>
        )}

        {step !== 'credentials' ? (
          <button
            className="btn block"
            type="button"
            onClick={() => {
              setStep('credentials');
              setMfaCode('');
              setError(undefined);
            }}
          >
            العودة لتسجيل الدخول
          </button>
        ) : (
          <a className="btn block" href={`${MARKETING_URL}/onboarding`}>
            {t('login.signup')}
          </a>
        )}
      </form>
    </div>
  );
}
