'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  maskSignupEmail,
  type SignupStatus,
  type SignupVerificationView,
} from '@erp/contracts';

import { PortalError, portalFetch } from '../lib/api';
import { trackGoal } from '../lib/track';
import { orderSetupTasks, setupProgress, signupProblem, type SignupTicket } from '../lib/signup';
import { surfaceHref } from '../lib/surfaces';

import { SignupPanel } from './signup-panel';

/**
 * P-M4 — ما بعد التحقّق: **لوحة الترحيب** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * الشاشة تقرأ `GET /signup/status/:email?token=` — والرمز المميّز هو ما يجعل القراءة ممكنةً
 * بلا جلسة: الزائر ليس مسجّلاً بعد (كلمة مروره لا تُستعمل هنا)، والتذكرة تُنقل في رابط
 * الصفحة. وإن انتهى التسجيل أو ضاع الرمز تبقى الشاشة صالحة: تعود بالزائر إلى الخاتم الأول
 * من المعالج بنفس البريد لا من الصفر.
 *
 * والمهامّ **تُقاس من الخادم**: كل مهمّة تأتي مع `done` و`count` مقيسين من القاعدة
 * (فرعٌ فعليّ، دليلُ حساباتٍ فعليّ، فاتورةٌ فعليّة) — فاللوحة تقول ما تبقّى فعلاً، ولا تقول
 * «مكتمل» لأن الشاشة السابقة قالت ذلك.
 */
export function OnboardingPanel({
  ticket,
  presetPlanCode,
}: {
  ticket?: SignupTicket;
  presetPlanCode?: string;
}) {
  const [status, setStatus] = useState<SignupStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');
  const [verification, setVerification] = useState<SignupVerificationView | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!ticket) return;
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({ token: ticket.token }).toString();
      const result = await portalFetch<SignupStatus>(
        `/signup/status/${encodeURIComponent(ticket.email)}?${query}`,
      );
      setStatus(result);
      setVerification(result.verification);
    } catch (caught) {
      if (caught instanceof PortalError) {
        setError(signupProblem({ status: caught.status, code: caught.code, detail: caught.message }).message);
      } else {
        setError('تعذّر قراءة حالة التسجيل. أعد تحديث الصفحة أو اطلب رمزاً جديداً.');
      }
    } finally {
      setLoading(false);
    }
  }, [ticket]);

  useEffect(() => {
    void load();
  }, [load]);

  async function verify() {
    if (!ticket) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await portalFetch<SignupStatus>('/signup/verify', {
        method: 'POST',
        body: JSON.stringify({ email: ticket.email, token: ticket.token, code }),
      });
      setStatus(result);
      setVerification(result.verification);
      setCode('');
      // P-M10 — «إتمام الاشتراك» يُقاس عند التحقّق الناجح: الهدف الأخير في القمع.
      trackGoal('signup_complete', { source: 'onboarding' });
    } catch (caught) {
      if (caught instanceof PortalError) {
        setError(signupProblem({ status: caught.status, code: caught.code, detail: caught.message }).message);
      } else {
        setError('تعذّر التحقّق من الرمز. أعد المحاولة.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!ticket) return;
    setBusy(true);
    setError(undefined);
    try {
      const view = await portalFetch<SignupVerificationView>('/signup/resend', {
        method: 'POST',
        body: JSON.stringify({ email: ticket.email, token: ticket.token }),
      });
      setVerification(view);
      setCode('');
      await load();
    } catch (caught) {
      if (caught instanceof PortalError) {
        setError(signupProblem({ status: caught.status, code: caught.code, detail: caught.message }).message);
      } else {
        setError('تعذّر إرسال رمزٍ جديد. أعد المحاولة بعد قليل.');
      }
    } finally {
      setBusy(false);
    }
  }

  // ── بلا تذكرة: الزائر في بداية الطريق، فيُعرض المعالج نفسه (المسار القديم لم ينكسر).
  if (!ticket) {
    return <SignupPanel presetPlanCode={presetPlanCode} />;
  }

  const tasks = status ? orderSetupTasks(status.setup) : [];
  const progress = setupProgress(status?.setup ?? []);
  const verified = status?.verification.state === 'verified';
  const staffLogin = status
    ? `${surfaceHref('staff', '/')}?tenant=${encodeURIComponent(status.tenantCode)}&email=${encodeURIComponent(status.ownerEmail)}&joined=1`
    : surfaceHref('staff', '/');

  return (
    <div className="grid">
      {status ? (
        <section className="card" aria-label="ملخّص الاشتراك">
          <h2>أهلاً بك في {status.tenantName}</h2>
          <p>
            رمز المنشأة: <b dir="ltr">{status.tenantCode}</b> — احفظه؛ يُطلب مع كل دخول.
          </p>
          <p className="muted">
            البريد: <bdi>{maskSignupEmail(status.ownerEmail)}</bdi> · الحالة:{' '}
            <span className={`badge ${status.subscriptionStatus === 'active' ? 'paid' : 'pending'}`}>
              {status.subscriptionStatus === 'active' ? 'اشتراك فعّال' : 'بانتظار اعتماد إدارة المنصة'}
            </span>
          </p>
          <p className="muted">
            {status.plan
              ? `الباقة المطلوبة: ${status.plan.name} — ${status.plan.amount} ${status.plan.currency} / ${status.plan.interval === 'year' ? 'سنة' : 'شهر'}`
              : 'لم تُختر باقة: تُحدَّد مع اعتماد الاشتراك.'}
            {status.trialDays > 0 ? ` · فترة تجريبية معلَنة: ${status.trialDays} يوماً` : ''}
          </p>
          <div className="toolbar">
            <a className="btn primary" href={staffLogin}>
              الدخول إلى لوحة الإدارة
            </a>
            <a className="btn" href="/pricing">
              مقارنة الباقات
            </a>
          </div>
          <p className="muted">
            <small>
              الرخصة تُفعَّل باعتماد إدارة المنصة، ويمكنك العمل في النظام قبل ذلك — الفرع ودليل الحسابات
              جاهزان بالفعل.
            </small>
          </p>
        </section>
      ) : null}

      {!verified ? (
        <section className="card" aria-label="تأكيد البريد">
          <h2>تأكيد البريد الإلكتروني</h2>
          <p className="muted">
            أدخل الرمز الذي وصل إلى بريدك. {verification ? `المحاولات المتبقية: ${verification.attemptsRemaining}.` : ''}
          </p>
          <div className="form">
            <input
              className="input"
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="verification code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              placeholder="الرمز (٦ أرقام)"
            />
            <div className="toolbar">
              <button className="btn primary" type="button" disabled={busy || code.length !== 6} onClick={() => void verify()}>
                {busy ? 'جارٍ التحقّق…' : 'تأكيد الرمز'}
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => void resend()}>
                إرسال رمز جديد
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="card">
          <p role="alert" className="muted">
            {error}
          </p>
          <div className="toolbar">
            <button className="btn" type="button" onClick={() => void load()} disabled={loading}>
              {loading ? 'جارٍ المحاولة…' : 'إعادة القراءة'}
            </button>
            <a className="btn" href="/onboarding">
              بدء تسجيل جديد
            </a>
          </div>
        </section>
      ) : null}

      {status ? (
        <section className="card" aria-label="مهامّ الإعداد">
          <h2>مهامّ الإعداد</h2>
          <p className="muted">
            {progress.done} من {progress.total} مكتملة ({progress.percent}%)
          </p>
          <ol className="steps">
            {tasks.map((task, index) => (
              <li key={task.key}>
                <span className="step-number">{task.done ? '✓' : index + 1}</span>
                <span>
                  <b>{task.labelAr}</b>
                  {task.count ? <span className="pill">{task.count}</span> : null}
                  <br />
                  <span className="muted">{task.helpAr}</span>
                  <br />
                  {task.done ? (
                    <span className="muted">
                      <small>تمّ.</small>
                    </span>
                  ) : (
                    <a className="text-link" href={surfaceHref('staff', task.href)}>
                      افتح الخطوة ←
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {loading && !status ? (
        <section className="card">
          <p className="muted">جارٍ قراءة حالة التسجيل…</p>
        </section>
      ) : null}
    </div>
  );
}
