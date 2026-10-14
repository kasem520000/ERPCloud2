'use client';

/**
 * P-M6 — استمارة التواصل وطلب العرض: مكوّنٌ واحد وبوّابتان (`kind`).
 *
 * ولماذا مكوّنٌ واحد؟ لأن الحقول واحدة والفرق في النصّ والمصدر — ونسختان تعنيان حقلين
 * يُضافان إلى إحداهما ويُنسيان في الأخرى، ثم استمارتان لا تتشابهان في الحماية.
 *
 * وأربعة قرارات ظاهرة هنا:
 *
 *   * **المصيدة قبل أي إرسال**: حقلٌ اسمه `website` مخفيٌّ بـCSS (لا `hidden`) — إنسانٌ لا
 *     يراه، والماسح الآلي يملؤه، والخادم يقابله بـ202 بلا صفّ.
 *   * **الرسالة تُعرض بجانب حقلها** لا في رأس الاستمارة: من يخطئ في البريد يجد السبب تحته.
 *   * **بعد النجاح لا يبقى حقل**: الاستمارة تُستبدل ببطاقةٍ فيها **المرجع** — فمن ينسى هل
 *     أرسل أم لا، يجد الرقم أمامه.
 *   * **الوسوم تُلتقط لحظة الإرسال** من `location` و`referrer`، لا لحظة تحميل الصفحة.
 */

import { useCallback, useMemo, useState } from 'react';
import type { LeadAccepted } from '@erp/contracts';

import { PortalError, portalFetch } from '../lib/api';
import { trackGoal } from '../lib/track';
import {
  LEAD_HONEYPOT_FIELD,
  emptyLeadDraft,
  leadFormConfig,
  leadPayload,
  leadProblemMessage,
  leadSuccessMessage,
  leadUtm,
  leadVerdict,
  sanitizeBranchCount,
  type LeadDraft,
  type LeadFormKind,
} from '../lib/leads';

export function LeadForm({ kind, presetPlan }: { kind: LeadFormKind; presetPlan?: string }) {
  const config = leadFormConfig[kind];
  const [draft, setDraft] = useState<LeadDraft>({ ...emptyLeadDraft, planInterest: presetPlan ?? '' });
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState<LeadAccepted | null>(null);

  const update = useCallback(<K extends keyof LeadDraft>(key: K, value: LeadDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  }, []);

  const utm = useMemo(
    () =>
      leadUtm({
        search: typeof globalThis.location === 'undefined' ? '' : globalThis.location.search,
        referrer: typeof globalThis.document === 'undefined' ? '' : globalThis.document.referrer,
        pathname: typeof globalThis.location === 'undefined' ? '' : globalThis.location.pathname,
        host: typeof globalThis.location === 'undefined' ? '' : globalThis.location.host,
      }),
    [],
  );

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const verdict = leadVerdict(draft);
    if (!verdict.ok) {
      setError({ field: String(verdict.field), message: verdict.message });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = { ...leadPayload(draft, { utm }), source: config.source };
      const data = await portalFetch<LeadAccepted>('/public/leads', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAccepted(data);
      // P-M10 — «طلب عرض» يُقاس عند قبول الخادم للطلب (بمرجعه) لا عند النقر.
      trackGoal('request_demo', { source: config.source });
    } catch (failure) {
      const status = failure instanceof PortalError ? failure.status : 0;
      const code = failure instanceof PortalError ? failure.code : undefined;
      const detail = failure instanceof Error ? failure.message : undefined;
      setError({ field: 'form', message: leadProblemMessage(status, code, detail) });
    } finally {
      setBusy(false);
    }
  };

  if (accepted) {
    const success = leadSuccessMessage(accepted.reference);
    return (
      <section className="card lead-success">
        <h2>{success.titleAr}</h2>
        <p className="muted">{success.bodyAr}</p>
        <p className="lead-reference">
          <span className="muted">رقم الطلب</span>{' '}
          <bdi className="reference">{success.reference}</bdi>
        </p>
      </section>
    );
  }

  const fieldError = (name: keyof LeadDraft) => (error?.field === name ? <span className="field-error">{error.message}</span> : null);

  return (
    <section className="card">
      <h2>{config.headingAr}</h2>
      <p className="muted">{config.introAr}</p>

      <form className="form lead-form" onSubmit={submit} noValidate>
        {error?.field === 'form' ? <p className="form-error" role="alert">{error.message}</p> : null}

        <div className="field-row">
          <label className="field">
            <span>الاسم</span>
            <input
              className="input"
              name="fullName"
              value={draft.fullName}
              onChange={(event) => update('fullName', event.target.value)}
              autoComplete="name"
              required
            />
            {fieldError('fullName')}
          </label>

          <label className="field">
            <span>الشركة</span>
            <input
              className="input"
              name="companyName"
              value={draft.companyName}
              onChange={(event) => update('companyName', event.target.value)}
              autoComplete="organization"
            />
            {fieldError('companyName')}
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>البريد الإلكتروني</span>
            <input
              className="input"
              name="email"
              type="email"
              dir="ltr"
              value={draft.email}
              onChange={(event) => update('email', event.target.value)}
              autoComplete="email"
              required
            />
            {fieldError('email')}
          </label>

          <label className="field">
            <span>الهاتف</span>
            <input
              className="input"
              name="phone"
              dir="ltr"
              value={draft.phone}
              onChange={(event) => update('phone', event.target.value)}
              autoComplete="tel"
            />
            {fieldError('phone')}
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>عدد الفروع</span>
            <input
              className="input"
              name="branchCount"
              inputMode="numeric"
              value={draft.branchCount}
              onChange={(event) => update('branchCount', sanitizeBranchCount(event.target.value))}
            />
            {fieldError('branchCount')}
          </label>

          <label className="field">
            <span>الباقة التي تهمّك (اختياري)</span>
            <input
              className="input"
              name="planInterest"
              value={draft.planInterest}
              onChange={(event) => update('planInterest', event.target.value)}
            />
            {fieldError('planInterest')}
          </label>
        </div>

        <label className="field">
          <span>{config.messageLabelAr}</span>
          <textarea
            className="input"
            name="message"
            rows={5}
            value={draft.message}
            onChange={(event) => update('message', event.target.value)}
            placeholder={config.messagePlaceholderAr}
            required
          />
          {fieldError('message')}
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.acceptsMarketing}
            onChange={(event) => update('acceptsMarketing', event.target.checked)}
          />
          <span>أوافق على أن ترسل لي المنصة رسائل عن المنتج والعروض (اختياري، ويمكن سحبها في أي وقت).</span>
        </label>

        {/*
          المصيدة: مخفيّةٌ بـCSS لا بـ`hidden` — بعض الماسحات تتجاهل `display:none`، وملءُ
          حقلٍ «مخفيٍّ» هو ما يكشفها. ولا `aria-hidden` عليها وحدها: هي مغلّفة بـ`display:none`
          على الحاوية، فلا يصل إليها قارئ الشاشة ولا ترتيب التنقّل.
        */}
        <div className="hp-field" aria-hidden="true">
          <label>
            <span>موقعك</span>
            <input
              className="input"
              tabIndex={-1}
              autoComplete="off"
              name={LEAD_HONEYPOT_FIELD}
              value={draft[LEAD_HONEYPOT_FIELD]}
              onChange={(event) => update(LEAD_HONEYPOT_FIELD, event.target.value)}
            />
          </label>
        </div>

        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الإرسال…' : kind === 'demo' ? 'اطلب العرض' : 'أرسل الرسالة'}
          </button>
          <span className="muted small">لا نشارك بريدك، ولا نُرسل شيئاً بلا موافقتك.</span>
        </div>
      </form>
    </section>
  );
}
