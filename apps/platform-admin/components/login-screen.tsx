'use client';

import { useState } from 'react';

import { ApiError, apiPost } from '../lib/api';
import { useSession } from '../lib/session';

type AuthStep = 'credentials' | 'mfa' | 'forgot' | 'reset';

/**
 * Sign-in screen for the platform console. Deliberately Arabic-only and WITHOUT a
 * signup path: platform operators are provisioned by hand, never self-service.
 * Supports the TOTP second factor and self-service password reset.
 */
export function LoginScreen({ initialError }: { initialError?: string }) {
  const { signIn } = useSession();
  const [step, setStep] = useState<AuthStep>('credentials');
  const [tenantCode, setTenantCode] = useState('platform');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [notice, setNotice] = useState<string | undefined>();

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
        } else if (caught.status === 401) setError('بيانات الدخول غير صحيحة.');
        else if (caught.status === 423) setError('الحساب موقوف مؤقتاً.');
        else if (caught.status === 429) setError('محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.');
        else setError(caught.message);
      } else {
        setError('تعذر الاتصال بالخادم.');
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

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <span className="logo big">ERP</span>
        <h1>لوحة تحكم المنصة</h1>
        <p>إدارة المنشآت والاشتراكات والتراخيص — لمشغّلي المنصة فقط.</p>
      </div>

      <form className="auth-card" onSubmit={submit}>
        <h2>
          {step === 'mfa'
            ? 'التحقق بخطوتين'
            : step === 'forgot'
              ? 'استعادة كلمة المرور'
              : step === 'reset'
                ? 'تعيين كلمة مرور جديدة'
                : 'تسجيل الدخول'}
        </h2>
        <p className="muted">
          {step === 'mfa'
            ? 'أدخل الرمز من تطبيق المصادقة.'
            : step === 'forgot'
              ? 'أدخل بريدك الإلكتروني لإرسال رمز استعادة كلمة المرور.'
              : step === 'reset'
                ? 'أدخل رمز الاستعادة المرسل إلى بريدك وكلمة المرور الجديدة.'
                : 'سجّل الدخول بحساب مشغّل المنصة.'}
        </p>

        {notice && (
          <p className="alert ok" role="status">
            {notice}
          </p>
        )}

        {step === 'credentials' && (
          <>
            <label className="field">
              <span>رمز المنشأة</span>
              <input
                className="input"
                value={tenantCode}
                onChange={(event) => setTenantCode(event.target.value)}
                placeholder="platform"
                autoComplete="organization"
                required
                dir="ltr"
              />
            </label>

            <label className="field">
              <span>البريد الإلكتروني</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                dir="ltr"
              />
            </label>

            <label className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>كلمة المرور</span>
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
            <span>رمز المصادقة</span>
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
          <label className="field">
            <span>البريد الإلكتروني</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
              dir="ltr"
            />
          </label>
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
            ? 'جارٍ التنفيذ…'
            : step === 'mfa'
              ? 'تحقق'
              : step === 'forgot'
                ? 'إرسال رمز الاستعادة'
                : step === 'reset'
                  ? 'حفظ كلمة المرور الجديدة'
                  : 'دخول'}
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

        {step !== 'credentials' && (
          <button
            className="btn block"
            type="button"
            onClick={() => {
              setStep('credentials');
              setMfaCode('');
              setError(undefined);
            }}
          >
            رجوع لتسجيل الدخول
          </button>
        )}
      </form>
    </div>
  );
}
