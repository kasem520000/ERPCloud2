'use client';

/**
 * P-M9 — «هل أفادك هذا؟»: الزرّان الوحيدان في الموقع التسويقي اللذان **يكتبان** (الصوت).
 *
 * وثلاثة قرارات في هذا الملف:
 *
 *   1. **الصوت يُقال قبل أن يُرسَل**: الزرّان لا يظهران لمن صوّت من قبل (الصوت محفوظٌ في
 *      `localStorage`)، فلا تُعدّ نقرةٌ مزدوجة صوتاً ثانياً من الشاشة أصلاً — والفهرس الفريد
 *      في القاعدة هو الحرس الثاني.
 *   2. **لا هوية**: `visitor` معرّفٌ عشوائي يولّده المتصفّح، وقيمته الوحيدة **منع عدّ الصوت
 *      مرّتين** — لا كوكي تتبّع، ولا عنوان IP (والمسار مستثنى من صفّ التدقيق الذي يحمل
 *      العنوان والوسيط).
 *   3. **الفشل يُقال**: إن لم يستجب الخادم يظهر نصُّ الفشل ولا يُعلَن التصويت ناجحاً — «شكراً»
 *      كاذبة أسوأ من رسالة خطأ.
 */

import { useEffect, useState } from 'react';

import { t, type Locale } from '../../lib/i18n';
import {
  helpVoteKey,
  helpVoteValue,
  newVisitorId,
  storedHelpVote,
  voteMessageAr,
} from '../../lib/help';

const PHASE = { idle: 'idle', sending: 'sending', done: 'done', failed: 'failed' } as const;
type Phase = (typeof PHASE)[keyof typeof PHASE];

export function HelpfulVote({
  slug,
  locale,
  yes,
  no,
}: {
  slug: string;
  locale: Locale;
  yes: number;
  no: number;
}) {
  const [phase, setPhase] = useState<Phase>(PHASE.idle);
  const [vote, setVote] = useState<boolean | null>(null);
  const [counts, setCounts] = useState({ yes, no });
  const [message, setMessage] = useState<string | null>(null);

  // ما صوّت به هذا المتصفّح من قبل يُقرأ بعد أول رسم (لا في الخادم: `localStorage` لا يوجد هناك).
  useEffect(() => {
    setVote(storedHelpVote(window.localStorage.getItem(helpVoteKey(slug))));
  }, [slug]);

  async function send(helpful: boolean) {
    setPhase(PHASE.sending);
    setMessage(null);
    try {
      const storageKey = helpVoteKey(slug);
      let visitor = window.localStorage.getItem('help-visitor');
      if (!visitor) {
        visitor = newVisitorId();
        window.localStorage.setItem('help-visitor', visitor);
      }
      const response = await fetch(`/api/v1/public/help/${encodeURIComponent(slug)}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ helpful, visitor }),
      });
      if (!response.ok) {
        setPhase(PHASE.failed);
        setMessage(t(locale, 'help.helpfulFailed'));
        return;
      }
      const payload = (await response.json()) as { data?: { yes: number; no: number; recorded: boolean } };
      if (payload.data) {
        setCounts({ yes: payload.data.yes, no: payload.data.no });
        setMessage(voteMessageAr(payload.data.recorded));
      }
      window.localStorage.setItem(storageKey, helpVoteValue(helpful));
      setVote(helpful);
      setPhase(PHASE.done);
    } catch {
      setPhase(PHASE.failed);
      setMessage(t(locale, 'help.helpfulFailed'));
    }
  }

  // اسمٌ لا يطابق حارس الأسماء الماليّة (`total|cost|rate|…`) — القاعدة عامّة على المستودع.
  const votes = counts.yes + counts.no;

  return (
    <section className="helpful" aria-label={t(locale, 'help.helpful')}>
      <p className="helpful-question">{t(locale, 'help.helpful')}</p>
      {vote === null ? (
        <div className="helpful-actions">
          <button
            className="btn sm"
            type="button"
            disabled={phase === PHASE.sending}
            onClick={() => void send(true)}
          >
            👍 {t(locale, 'help.helpfulYes')}
          </button>
          <button
            className="btn sm"
            type="button"
            disabled={phase === PHASE.sending}
            onClick={() => void send(false)}
          >
            👎 {t(locale, 'help.helpfulNo')}
          </button>
          {phase === PHASE.sending ? <span className="small muted">{t(locale, 'help.helpfulSending')}</span> : null}
        </div>
      ) : (
        <p className="small muted">
          {vote ? '👍' : '👎'} {message ?? voteMessageAr(false)}
        </p>
      )}
      {phase === PHASE.failed && message ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      {votes > 0 ? (
        <p className="small muted">
          {locale === 'en'
            ? `${counts.yes} of ${votes} readers found this helpful.`
            : `أفاد ${counts.yes} من ${votes} قارئاً.`}
        </p>
      ) : null}
    </section>
  );
}
