'use client';

import { useEffect, useState } from 'react';

import { leaveSupportSession, type MePayload } from '../lib/api';

/**
 * P-C8 — اللافتة الحمراء التي تُعلن أن الشاشة ليست شاشة المستخدم.
 *
 * الشرط الذي يجعلها تظهر هو وجود `impersonation` في `GET /me` — أي أن **الرمز نفسه** رمزُ
 * دخولٍ مؤقّت، لا أن شاشةً قرّرت إخفاء شيء. ولا تُخفى بأي تفاعل: المشغّل يجب أن يرى دائماً
 * أنه داخل منشأة عميل، ومن دخل باسمه، وإلى متى.
 *
 * والعدّاد يقرأ من `expiresAt` المحسوب في الخادم — فالوقت ليس رقمياً في الواجهة.
 */
export function ImpersonationBanner({
  impersonation,
  lang,
}: {
  impersonation?: MePayload['impersonation'];
  lang: 'ar' | 'en';
}) {
  const [remaining, setRemaining] = useState<number>(0);
  const expiresAt = impersonation?.expiresAt ?? '';

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemaining(Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!impersonation) return null;

  const minutes = Math.ceil(remaining / 60_000);
  const who = impersonation.operatorLabel ?? impersonation.operatorUserId;

  return (
    <section className="imp-banner" role="alert" aria-live="polite">
      <div>
        <strong>{lang === 'ar' ? '🔴 جلسة دخول مؤقّت' : '🔴 Temporary access session'}</strong>
        <p style={{ margin: '2px 0 0' }}>
          {lang === 'ar'
            ? `أنت داخل منشأة عميل باسم «${who}» — السبب: ${impersonation.reason}`
            : `You are inside a customer tenant as “${who}” — reason: ${impersonation.reason}`}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 12 }}>
          {lang === 'ar'
            ? `تنتهي خلال ${minutes} دقيقة · لا حذف، ولا تغيير كلمة مرور، ولا رمز جديد خلال الجلسة.`
            : `Ends in ${minutes} min · no deletes, no password changes and no new tokens during the session.`}
        </p>
      </div>
      <button
        className="btn danger"
        type="button"
        onClick={() => {
          // الخروج من «النظر» محلياً؛ وإنهاء الجلسة نفسها من مكتب الدعم في اللوحة.
          leaveSupportSession();
          window.location.href = '/';
        }}
      >
        {lang === 'ar' ? 'الخروج من الجلسة' : 'Leave session'}
      </button>
    </section>
  );
}
