'use client';

import { useState } from 'react';
import { ApiError, login } from '@erp/web-core/api';

import { useLang } from '../lib/i18n';

/**
 * M3 — the accounting app's login. Same session contract as the staff panel
 * (tenant code + e-mail + password, `MFA_REQUIRED` flips to the code step) but focused:
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
          <li>{t('nav.accounts')}</li>
          <li>{t('nav.journals')}</li>
          <li>{t('nav.trialBalance')}</li>
          <li>{t('nav.zatca')}</li>
        </ul>
      </div>
      <div className="auth-card">
        <h2 style={{ margin: 0 }}>{step === 'mfa' ? t('mfa.title') : t('login.title')}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {step === 'mfa' ? t('mfa.hint') : t('login.subtitle')}
        </p>

        <form
          className="form"
          style={{ marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            void attempt(step === 'mfa' ? mfaCode.trim() : undefined);
          }}
        >
          {step === 'credentials' ? (
            <>
              <label className="field">
                <span>{t('login.tenantCode')}</span>
                <input
                  className="input"
                  value={tenantCode}
                  onChange={(event) => setTenantCode(event.target.value)}
                  autoComplete="organization"
                  required
                />
              </label>
              <label className="field">
                <span>{t('login.email')}</span>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label className="field">
                <span>{t('login.password')}</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>{t('mfa.code')}</span>
              <input
                className="input"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </label>
          )}

          {error ? (
            <p className="small" style={{ color: 'var(--danger)', margin: 0 }} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn primary block" disabled={busy}>
            {busy ? t('login.busy') : step === 'mfa' ? t('mfa.verify') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
