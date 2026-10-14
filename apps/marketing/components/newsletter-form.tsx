'use client';

/**
 * P-M6 — اشتراك النشرة البريدية في تذييل الموقع.
 *
 * **تأكيدٌ مزدوج**: لا يُضاف عنوانٌ إلى القائمة قبل أن يفتح صاحبه الرابط الذي وصل ببرده —
 * والاشتراك بلا تأكيد يعني أن نُرسل إلى عنوانٍ كتبه غيرُ صاحبه، وهو أسرع طريق إلى قائمة
 * إيقافٍ (blocklist) تُسقط بريد المنصة كلّه.
 *
 * والردّ واحد للحالتين: جديدٌ أو مؤكَّدٌ من قبل — فلا يتحوّل الحقل إلى أداة تحقّقٍ من العناوين.
 * والمصيدة نفسها التي في استمارة التواصل، وحدُّ المعدّل نفسه على الخادم (`public-form`).
 */

import { useState } from 'react';
import type { SubscriberAccepted } from '@erp/contracts';

import { PortalError, portalFetch } from '../lib/api';
import { trackGoal } from '../lib/track';
import {
  LEAD_HONEYPOT_FIELD,
  leadProblemMessage,
  leadUtm,
  newsletterCopy,
} from '../lib/leads';

export function NewsletterForm({ locale = 'ar', compact = false }: { locale?: 'ar' | 'en'; compact?: boolean }) {
  const copy = newsletterCopy[locale];
  const [email, setEmail] = useState('');
  const [trap, setTrap] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(copy.invalid);
      return;
    }

    setState('busy');
    setError(null);
    try {
      await portalFetch<SubscriberAccepted>('/public/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          [LEAD_HONEYPOT_FIELD]: trap,
          utm: leadUtm({
            search: typeof globalThis.location === 'undefined' ? '' : globalThis.location.search,
            pathname: typeof globalThis.location === 'undefined' ? '' : globalThis.location.pathname,
          }),
        }),
      });
      setState('done');
      // P-M10 — الهدف يُقاس عند **الاشتراك الفعلي** لا عند الضغط: النجاح شرطُ الحدث.
      trackGoal('newsletter_subscribe', { source: 'footer' });
    } catch (failure) {
      const status = failure instanceof PortalError ? failure.status : 0;
      setError(leadProblemMessage(status, failure instanceof PortalError ? failure.code : undefined));
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <div className="footer-newsletter" dir={locale === 'en' ? 'ltr' : 'rtl'}>
        <h2>{copy.heading}</h2>
        <p className="muted small" role="status">{copy.success}</p>
      </div>
    );
  }

  return (
    <div className="footer-newsletter" dir={locale === 'en' ? 'ltr' : 'rtl'}>
      <h2>{copy.heading}</h2>
      {compact ? null : <p className="muted small">{copy.intro}</p>}
      <form className="newsletter-form" onSubmit={submit} noValidate>
        <label className="sr-only" htmlFor="newsletter-email">{copy.label}</label>
        <input
          id="newsletter-email"
          className="input"
          type="email"
          dir="ltr"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          placeholder={copy.placeholder}
        />
        <button className="btn primary" type="submit" disabled={state === 'busy'}>
          {state === 'busy' ? '…' : copy.cta}
        </button>
        <div className="hp-field" aria-hidden="true">
          <input
            className="input"
            tabIndex={-1}
            autoComplete="off"
            name={LEAD_HONEYPOT_FIELD}
            value={trap}
            onChange={(event) => setTrap(event.target.value)}
          />
        </div>
      </form>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
  );
}
