'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

import { login } from '../lib/api';

export function LoginForm() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      const session = await login({
        tenantCode: String(form.get('tenantCode')).trim(),
        email: String(form.get('email')).trim(),
        password: String(form.get('password')),
      });
      // A portal login handed out by the supplier starts as a one-time password.
      globalThis.location.assign(session.mustChangePassword ? '/auth/change-password' : '/portal');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'تعذر تسجيل الدخول');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <input className="input" name="tenantCode" placeholder="رمز الشركة (المورد)" aria-label="tenant" required />
      <input className="input" name="email" type="email" placeholder="البريد الإلكتروني" aria-label="email" required />
      <input className="input" name="password" type="password" placeholder="كلمة المرور" aria-label="password" required />
      {error ? (
        <p role="alert" className="muted">
          {error}
        </p>
      ) : null}
      <button className="btn primary" type="submit" disabled={loading}>
        {loading ? 'جارٍ التحقق...' : 'تسجيل الدخول'}
      </button>
      <a className="muted" href="/auth/forgot">
        نسيت كلمة المرور؟
      </a>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, setState] = useState<{ error: string; done: boolean; busy: boolean }>({ error: '', done: false, busy: false });

  async function submit(event: FormEvent<globalThis.HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get('next'));
    if (next !== String(form.get('confirm'))) {
      setState({ error: 'كلمتا المرور غير متطابقتين', done: false, busy: false });
      return;
    }
    setState({ error: '', done: false, busy: true });
    try {
      const { changePassword } = await import('../lib/api');
      await changePassword(String(form.get('current')), next);
      setState({ error: '', done: true, busy: false });
      // Every session is revoked server-side on a password change, so sign in again.
      globalThis.setTimeout(() => globalThis.location.assign('/auth/login'), 1500);
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : 'تعذّر تغيير كلمة المرور', done: false, busy: false });
    }
  }

  if (state.done) return <p className="muted">تم تغيير كلمة المرور. سيتم تحويلك لتسجيل الدخول من جديد…</p>;

  return (
    <form className="form" onSubmit={submit} noValidate>
      <input className="input" name="current" type="password" placeholder="كلمة المرور الحالية / المؤقتة" required />
      <input className="input" name="next" type="password" placeholder="كلمة المرور الجديدة" required minLength={12} />
      <input className="input" name="confirm" type="password" placeholder="تأكيد كلمة المرور الجديدة" required minLength={12} />
      {state.error ? (
        <p role="alert" className="muted">
          {state.error}
        </p>
      ) : null}
      <button className="btn primary" type="submit" disabled={state.busy}>
        {state.busy ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور'}
      </button>
    </form>
  );
}
