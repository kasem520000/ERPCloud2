/**
 * P-M10 — **الموافقة قبل القياس** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * القاعدة: **لا يُرسل حدثٌ قبل أن يوافق الزائر**، ورفضُه لا يُنقص من الموقع شيئاً (لا بوابة،
 * ولا صفحةٌ تُقفل). وثلاثة قرارات في هذا الملف:
 *
 *   1. **لا كوكي إطلاقاً** — الخيار يُحفظ في `localStorage`، فلا يُرسل إلى الخادم مع كل طلب،
 *      ولا يُشارك بين المواقع. وحفظه محلياً يعني أن مسح بيانات المتصفّح يعيد السؤال، وهو
 *      السلوك الصحيح: لا نُطارد من قال «لا» بعلامةٍ أبدية.
 *   2. **الرفض يعني الرفض**: `consentAllowsEvents` لا تُجيز إلا `accepted` — والغياب
 *      (لم يُسأل بعد) ليس موافقة، و`rejected` لا تُخفَّف إلى «قياسٌ بلا هوية».
 *   3. **`Do Not Track` يُحترم قبل السؤال**: متصفّحٌ يقول «لا تتتبّع» لا يُسأل ولا يُقاس، ولو
 *      ضغط زرّ القبول — لأن الإشارة أسبق من النقرة وأصدق منها في النيّة.
 */

export const CONSENT_STORAGE_KEY = 'erp.consent.v1';

export const consentDecisions = ['accepted', 'rejected'] as const;
export type ConsentDecision = (typeof consentDecisions)[number];

/** ما نحتاجه من التخزين المحلّي — نوعٌ ضيّق يُقاس في السبيك بلا متصفّح. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type Copy = { locale: 'ar' | 'en' };

/** نصّ اللافتة بلغتين — يُكتب هنا ليُقاس في السبيك لا ليُبنى في الشاشة. */
export const consentCopy = {
  ar: {
    title: 'هل نُحصي زيارات الموقع؟',
    body:
      'نودّ أن نعرف أيّ صفحةٍ تُقرأ وأيّها لا، لنُحسّن المحتوى. لا نستخدم كوكي ولا طرفاً ثالثاً، ولا نحفظ عنوانك ولا بريدك — حدثٌ مجهول: الصفحة واللغة والمصدر.',
    accept: 'أوافق',
    reject: 'لا أوافق',
    change: 'تغيير اختيار القياس',
    accepted: 'القياس مفعَّل — شكراً. يمكنك إيقافه في أي وقت.',
    rejected: 'القياس متوقّف. الموقع يعمل كاملاً بلا قياس.',
    note: 'الاختيار محفوظٌ في متصفّحك وحده، ولا يُرسل إلينا.',
  },
  en: {
    title: 'May we measure site visits?',
    body:
      'We would like to know which pages are read and which are not. No cookies, no third party, no IP or e-mail — anonymous events only: page, language, source.',
    accept: 'Accept',
    reject: 'Decline',
    change: 'Change analytics choice',
    accepted: 'Analytics is on — thank you. You can turn it off anytime.',
    rejected: 'Analytics is off. The site works exactly the same.',
    note: 'Your choice is stored in this browser only and is never sent to us.',
  },
} as const;

export function readConsentDecision(storage: StorageLike | null): ConsentDecision | null {
  const raw = storage?.getItem(CONSENT_STORAGE_KEY) ?? null;
  return (consentDecisions as readonly string[]).includes(raw ?? '') ? (raw as ConsentDecision) : null;
}

export function writeConsentDecision(storage: StorageLike | null, decision: ConsentDecision): void {
  storage?.setItem(CONSENT_STORAGE_KEY, decision);
}

/** الموافقة الصريحة وحدها تُجيز الإرسال: الغياب ليس موافقة. */
export function consentAllowsEvents(decision: ConsentDecision | null): boolean {
  return decision === 'accepted';
}

/** `DNT: 1` أو `navigator.doNotTrack === 'yes'` — إشارةٌ تُقدَّم على النقرة. */
export function doNotTrackEnabled(nav: { doNotTrack?: string | null } | null | undefined): boolean {
  const value = nav?.doNotTrack;
  return value === '1' || value === 'yes';
}
