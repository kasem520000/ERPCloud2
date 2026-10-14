'use client';

/**
 * P-M10 — **لافتة الموافقة** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **وهي لا تحجب شيئاً**: لا طبقةً معتمة ولا زرّاً رمادياً ولا «وافق لتُكمل». القياس اختيارٌ
 * لا شرطُ استعمال، وهذه الجملة هي الفرق بين لافتةٍ تُحترم ولافتةٍ تُغلق بلا قراءة.
 *
 * وأربعة قرارات ظاهرة هنا:
 *
 *   1. **أوّل زيارة: لا حدث ولا معرّف.** اللافتة تظهر، ولا يُرسل شيء قبل نقرة. ومن رفض:
 *      لا معرّف، ولا حدث، ولا إعادة سؤال.
 *   2. **الاختيار يُغيّر بعد حين**: سطرٌ صغير في التذييل يقول الحالة الحالية ويفتح اللافتة
 *      من جديد — لأن «قرارٌ لا يمكن التراجع عنه» ليس موافقةً حرّة.
 *   3. **`DNT` يُغلق السؤال**: متصفّحٌ يطلب عدم التتبّع لا تظهر له لافتةٌ أصلاً (قراره سابقٌ
 *      للسؤال)، والحالة تُعرض في التذييل كما هي.
 *   4. **النصّ من `consentCopy`** لا من الشاشة: يُقاس في السبيك، ويُترجم مع الموقع.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  CONSENT_STORAGE_KEY,
  consentCopy,
  doNotTrackEnabled,
  readConsentDecision,
  writeConsentDecision,
  type ConsentDecision,
} from '../../lib/consent';
import { trackPageView } from '../../lib/track';

/** حدثٌ داخليّ يفتح اللافتة من التذييل — بلا إدارة حالةٍ عامّة لأجل زرّ. */
const OPEN_EVENT = 'erp:consent-open';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function ConsentStatusLine({ locale }: { locale: 'ar' | 'en' }) {
  const [decision, setDecision] = useState<ConsentDecision | null | 'unknown'>('unknown');
  const copy = consentCopy[locale];

  useEffect(() => {
    setDecision(readConsentDecision(storage()));
    const refresh = () => setDecision(readConsentDecision(storage()));
    globalThis.addEventListener(CONSENT_STORAGE_KEY, refresh);
    return () => globalThis.removeEventListener(CONSENT_STORAGE_KEY, refresh);
  }, []);

  const label =
    decision === 'accepted' ? copy.accepted : decision === 'rejected' ? copy.rejected : copy.note;

  return (
    <p className="consent-line">
      <span className="small">{label}</span>{' '}
      <button type="button" className="link-button" onClick={() => globalThis.dispatchEvent(new Event(OPEN_EVENT))}>
        {copy.change}
      </button>
    </p>
  );
}

export function ConsentBanner({ locale }: { locale: 'ar' | 'en' }) {
  const copy = consentCopy[locale];
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sync = () => {
      const blocked = doNotTrackEnabled(globalThis.navigator);
      setVisible(!blocked && readConsentDecision(storage()) === null);
    };
    sync();
    const open = () => setVisible(!doNotTrackEnabled(globalThis.navigator));
    globalThis.addEventListener(OPEN_EVENT, open);
    return () => globalThis.removeEventListener(OPEN_EVENT, open);
  }, []);

  const decide = useCallback((decision: ConsentDecision) => {
    writeConsentDecision(storage(), decision);
    setVisible(false);
    // إشعار سطر التذييل ليقرأ القرار الجديد (‏`storage` لا يتغيّر في التبويب نفسه).
    globalThis.dispatchEvent(new Event(CONSENT_STORAGE_KEY));
    // الموافقة تعني بدء القياس **من هذه اللحظة**: أوّل صفحةٍ تُحسب هذه، لا ما قبلها.
    if (decision === 'accepted') trackPageView();
  }, []);

  if (!visible) return null;

  return (
    <aside className="consent-banner" role="dialog" aria-label={copy.title}>
      <div className="wrap consent-inner">
        <p className="consent-body">
          <strong>{copy.title}</strong> {copy.body}
        </p>
        <div className="consent-actions">
          <button type="button" className="btn primary sm" onClick={() => decide('accepted')}>
            {copy.accept}
          </button>
          <button type="button" className="btn sm" onClick={() => decide('rejected')}>
            {copy.reject}
          </button>
        </div>
      </div>
    </aside>
  );
}
