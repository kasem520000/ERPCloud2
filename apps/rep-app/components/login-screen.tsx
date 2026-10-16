'use client';

import { useState } from 'react';
import { ApiError, login } from '@erp/web-core/api';

import { useLang } from '../lib/i18n';

/**
 * M5 — the rep app's login. Same session contract as every other surface (tenant code +
 * e-mail + password, `MFA_REQUIRED` flips to the code step) with the rep app's branding;
 * no signup, no forgot-password — account lifecycle lives in the staff panel.
 */
export function LoginScreen({ initialError }: { initialError?: string }) {
  const { t } = useLang();
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [tenantCode, setTenantCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  async function attempt(code?: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await login(email.trim(), password, tenantCode.trim(), code);
      // The session provider picks the change up and the gate re-renders the shell.
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === 'MFA_REQUIRED') setStep('mfa');
        else if (caught.status === 401) setError(t(step === 'mfa' ? 'mfa.error.invalid' : 'login.error.invalid'));
        else if (caught.status === 423) setError(t('login.error.suspended'));
        else if (caught.status === 429) setError(t('login.error.rateLimited'));
        else setError(caught.message);
      } else {
        setError(t('login.error.generic'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <span className="logo big">ERP</span>
        <h1>{t('app.name')}</h1>
        <p>{t('app.tagline')}</p>
        <ul>
          <li>{t('nav.invoice')}</li>
          <li>{t('nav.receipt')}</li>
          <li>{t('nav.return')}</li>
          <li>{t('nav.closing')}</li>
        </ul>
      </div>
      <div className="auth-card">
        <h2 style={{ margin: 0 }}>{step === 'mfa' ? t('mfa.title') : t('login.title')}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {step === 'mfa' ? t('mfa.hint') : t('login.subtitle')}
        </p>

        <form
          className="grid gap-2"
          style={{ marginTop: '12px' }}
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(step === 'mfa' ? mfaCode.trim() : undefined);
          }}
        >
          {step === 'credentials' ? (
            <>
              <label className="field">
                <span>{t('login.tenant')}</span>
                <input className="input" value={tenantCode} onChange={(e) => setTenantCode(e.target.value)} autoComplete="organization" required />
              </label>
              <label className="field">
                <span>{t('login.email')}</span>
                <input className="input" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
              </label>
              <label className="field">
                <span>{t('login.password')}</span>
                <input className="input" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </label>
            </>
          ) : (
            <label className="field">
              <span>{t('login.mfa')}</span>
              <input className="input" dir="ltr" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" autoFocus required />
            </label>
          )}

          {error ? (
            <p className="small" role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
              {error}
            </p>
          ) : null}

          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? '…' : step === 'mfa' ? t('mfa.submit') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
