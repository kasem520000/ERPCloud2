'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '/api/v1';

export default function ForgotPage() {
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [tenantCode, setTenantCode] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (step === 'request') {
        const res = await fetch(`${baseUrl}/auth/forgot-password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            ...(tenantCode.trim() ? { tenantCode: tenantCode.trim() } : {}),
          }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(payload?.detail || payload?.message || 'تعذر إرسال طلب استعادة كلمة المرور');
        }
        setNotice(payload?.data?.message || 'تم إرسال رمز ورابط الاستعادة إلى بريدك الإلكتروني.');
        setStep('reset');
      } else {
        const res = await fetch(`${baseUrl}/auth/reset-password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: token.trim(),
            newPassword,
          }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(payload?.detail || payload?.message || 'تعذر إعادة تعيين كلمة المرور');
        }
        setNotice(payload?.data?.message || 'تم إعادة تعيين كلمة المرور بنجاح.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر إتمام الطلب');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h1>نسيت كلمة المرور</h1>
      <p className="muted">
        أدخل بريدك الإلكتروني المسجّل لإرسال رمز استعادة كلمة المرور، أو أدخل الرمز لتعيين كلمة مرور جديدة. كما يمكنك التواصل مع المورد لإصدار كلمة مرور مؤقتة من بطاقة العميل.
      </p>

      {notice ? <p className="alert ok">{notice}</p> : null}
      {error ? <p className="alert danger">{error}</p> : null}

      <form className="form" onSubmit={submit} style={{ marginTop: 12 }}>
        {step === 'request' ? (
          <>
            <input
              className="input"
              value={tenantCode}
              onChange={(event) => setTenantCode(event.target.value)}
              placeholder="رمز المنشأة (اختياري)"
              dir="ltr"
            />
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="البريد الإلكتروني المسجّل"
              required
              dir="ltr"
            />
            <button className="btn primary" type="submit" disabled={loading}>
              {loading ? 'جارٍ الإرسال…' : 'إرسال رمز الاستعادة'}
            </button>
            <button className="btn" type="button" onClick={() => setStep('reset')}>
              لدي رمز الاستعادة بالفعل
            </button>
          </>
        ) : (
          <>
            <input
              className="input"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="رمز الاستعادة (rst_...)"
              required
              dir="ltr"
            />
            <input
              className="input"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="كلمة المرور الجديدة (12 حرفاً على الأقل)"
              minLength={12}
              required
              dir="ltr"
            />
            <button className="btn primary" type="submit" disabled={loading}>
              {loading ? 'جارٍ الحفظ…' : 'تعيين كلمة المرور الجديدة'}
            </button>
            <button className="btn" type="button" onClick={() => setStep('request')}>
              طلب رمز جديد
            </button>
          </>
        )}
      </form>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <a className="btn primary" href="/auth/login">
          رجوع لتسجيل الدخول
        </a>
        <a className="btn" href="/portal/profile">
          بيانات التواصل مع المورد
        </a>
      </div>
    </section>
  );
}
