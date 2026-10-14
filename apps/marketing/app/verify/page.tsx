'use client';

import { useState } from 'react';
import type { PublicVerifyResult } from '@erp/contracts';

import {
  VERIFY_SAMPLE_PAYLOAD,
  checkClass,
  decideLocally,
  fieldRows,
  readableRecordedAt,
  serverInput,
  serverProblemMessage,
  toneClass,
  verifyCopy,
  type VerifyLocalOutcome,
  type VerifyMode,
} from '../../lib/verify';

/**
 * P-M8 — `/verify`: التحقّق من فاتورة (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **الصفحة عميلية والقراءة محليّة**: تُلصق الحِمل فتُفكّ حقولُه في المتصفّح (`lib/verify.ts`
 * فوق `lib/qr.ts`)، ولا يُرسل شيء إلى أي خادم. والنداء الخادمي **لا يقع تلقائياً أبداً**: يفتحه
 * الزائر بخيار موافقةٍ صريح ثم زرٍّ ثانٍ، وحينها فقط يُرسل الحِمل أو رمز الفاتورة.
 *
 * **والنتيجة على أقسام، كلٌّ منها يقول من أين جاء**: حُكمُ الشكل (من متصفّحك)، وحقولُ الرمز
 * (من الرمز نفسه)، والفحوص (بقواعد العقد المشتركة مع الخادم)، وحالةُ السجلّ (من الخادم حين
 * تُطلب). والفصل مقصود: من لا يريد أن يخرج شيء من جهازه يأخذ كل شيء إلا الحالة، ويعرف أنه
 * أخذ كل شيء إلا الحالة.
 *
 * **ونصّ الحدّ لا يغيب**: «التحقّق الرسمي عبر تطبيق فاتورة» — في الذيل دائماً، ومعه ما تقوله
 * المنصّة عن سجلّها.
 */
export default function VerifyPage() {
  const [mode, setMode] = useState<VerifyMode>('payload');
  const [value, setValue] = useState('');
  const [local, setLocal] = useState<VerifyLocalOutcome | null>(null);
  const [remote, setRemote] = useState<PublicVerifyResult | null>(null);
  const [remoteError, setRemoteError] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setLocal(null);
    setRemote(null);
    setRemoteError('');
  }

  function pickMode(next: VerifyMode): void {
    setMode(next);
    reset();
  }

  function readHere(): void {
    setRemote(null);
    setRemoteError('');
    setLocal(decideLocally(mode, value));
  }

  /** النداء الخادمي الوحيد: بنقرة صريحة، بعد موافقةٍ صريحة، على مُدخلٍ غير فارغ. */
  async function askServer(): Promise<void> {
    setRemote(null);
    setRemoteError('');
    setBusy(true);
    try {
      const response = await fetch('/api/v1/public/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverInput(mode, value)),
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: PublicVerifyResult; code?: string }
        | null;
      if (!response.ok || !payload?.data) {
        setRemoteError(serverProblemMessage(response.status, payload?.code));
        return;
      }
      setRemote(payload.data);
      // الحُكم المحلّي لا يُلغى بالحُكم الخادمي: الخادم يضيف حالة السجلّ ولا يمحو الفحص.
      // (ولا يُستدعى في وضع رمز الفاتورة: لا حقول فيه ليُقرأ، ورسالةُ «اقرأه في الخادم» تحت
      // الجواب الصحيح تبدو كأنها عطل.)
      if (local === null && mode === 'payload') setLocal(decideLocally(mode, value));
    } catch {
      setRemoteError(serverProblemMessage(0));
    } finally {
      setBusy(false);
    }
  }

  const canAskServer = consent && value.trim().length > 0 && !busy;
  const status = remote?.record ?? null;

  return (
    <div className="grid">
      <header className="hero">
        <h1>{verifyCopy.titleAr}</h1>
        <p className="hero-lead">{verifyCopy.leadAr}</p>
        <p className="muted small">{verifyCopy.privacyAr}</p>
      </header>

      <section className="card">
        <div className="toolbar" role="tablist" aria-label="نوع المُدخل">
          <button
            className={mode === 'payload' ? 'btn primary sm' : 'btn sm'}
            type="button"
            role="tab"
            aria-selected={mode === 'payload'}
            onClick={() => pickMode('payload')}
          >
            {verifyCopy.payloadLabelAr}
          </button>
          <button
            className={mode === 'uuid' ? 'btn primary sm' : 'btn sm'}
            type="button"
            role="tab"
            aria-selected={mode === 'uuid'}
            onClick={() => pickMode('uuid')}
          >
            {verifyCopy.uuidLabelAr}
          </button>
        </div>

        <div className="form">
          <label className="field">
            <span>{mode === 'payload' ? verifyCopy.payloadLabelAr : verifyCopy.uuidLabelAr}</span>
            {mode === 'payload' ? (
              <textarea
                className="input"
                rows={4}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={verifyCopy.payloadHintAr}
                dir="ltr"
              />
            ) : (
              <input
                className="input"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={verifyCopy.uuidHintAr}
                dir="ltr"
              />
            )}
          </label>

          <div className="form-actions">
            <button className="btn primary" type="button" onClick={readHere} disabled={!value.trim()}>
              {verifyCopy.readCtaAr}
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                setMode('payload');
                setValue(VERIFY_SAMPLE_PAYLOAD);
                reset();
              }}
            >
              {verifyCopy.sampleCtaAr}
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                setValue('');
                reset();
              }}
            >
              {verifyCopy.clearCtaAr}
            </button>
          </div>

          {/* الفصل بين القراءة المحليّة وسؤال الخادم ظاهرٌ في النموذج نفسه لا في حاشية. */}
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>{verifyCopy.consentAr}</span>
          </label>
          <div className="form-actions">
            <button className="btn" type="button" onClick={() => void askServer()} disabled={!canAskServer}>
              {busy ? verifyCopy.serverPendingAr : verifyCopy.serverCtaAr}
            </button>
            <span className="muted small">{verifyCopy.serverIdleAr}</span>
          </div>
        </div>
      </section>

      {local && !local.ok ? (
        <section className="card">
          {local.tone === 'error' ? (
            <p className="form-error" role="alert">
              {local.messageAr}
            </p>
          ) : (
            <p className="muted">{local.messageAr}</p>
          )}
        </section>
      ) : null}

      {remoteError ? (
        <section className="card">
          <p className="form-error" role="alert">
            {remoteError}
          </p>
        </section>
      ) : null}

      {local && local.ok ? (
        <section className="card">
          <h2>{verifyCopy.fieldsTitleAr}</h2>
          <table>
            <tbody>
              {fieldRows(local.fields).map((row) => (
                <tr key={row.key}>
                  <td className="muted">{row.label}</td>
                  <td dir="ltr">{row.value || '—'}</td>
                </tr>
              ))}
              <tr>
                <td className="muted">الختم الإلكتروني</td>
                <td>
                  <span className={local.fields.signed ? 'badge ready' : 'badge pending'}>
                    {local.fields.signed ? 'بصمةٌ وتوقيع (مرحلة ثانية)' : 'بلا ختم (مرحلة أولى)'}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>

          <p>{local.headlineAr}</p>

          <h3>{verifyCopy.checksTitleAr}</h3>
          <ul className="verify-checks">
            {local.checks.map((check) => (
              <li key={check.code}>
                <span className={checkClass(check)}>
                  {check.ok ? 'سليم' : check.severity === 'error' ? 'لا يجتاز' : 'ملاحظة'}
                </span>{' '}
                <strong>{check.labelAr}</strong> — <span className="muted">{check.detailAr}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">هذا الفحص وقع في متصفّحك: لم يُرسل حِملٌ ولا حقولُ فاتورة.</p>
        </section>
      ) : null}

      {remote ? (
        <section className="card">
          <h2>{verifyCopy.statusTitleAr}</h2>
          {status ? (
            <>
              <p>
                <span className={toneClass(status.tone)}>{status.statusLabelAr}</span>{' '}
                <span className="muted small">
                  {verifyCopy.recordedAtLabelAr}: <span dir="ltr">{readableRecordedAt(status.recordedAt)}</span>
                </span>
              </p>
              <p className="muted">{status.explanationAr}</p>
            </>
          ) : (
            <p className="muted">{verifyCopy.statusMissingAr}</p>
          )}
          <p>{remote.verdictAr}</p>
          <p className="muted small">{remote.authorityNoteAr}</p>
        </section>
      ) : null}

      <section className="card">
        <h2>كيف تقرأ النتيجة</h2>
        <ul className="verify-notes">
          {verifyCopy.howToReadAr.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="muted small">{verifyCopy.authoritySmallAr}</p>
      </section>
    </div>
  );
}
