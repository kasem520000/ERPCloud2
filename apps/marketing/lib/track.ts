'use client';

/**
 * P-M10 — **الطرف الذي يُرسل** في المتصفّح: ملفٌّ صغير يفعل ثلاثة أشياء لا رابع لها.
 *
 *   1. يسأل `allowedToSend` (موافقةٌ صريحة، ولا `DNT`) — فإن لم تُسمح لا يُرسل شيئاً **ولا
 *      يُنشئ معرّفاً**، فلا أثر لمن قال «لا».
 *   2. يبني الحدث من دوالّ `lib/analytics.ts` الخالصة (المفردات المغلقة، والمسار مشذَّب).
 *   3. يُرسل ولمن يفشل: الخطأ يُهمَل بصمت — قياسٌ يُعطّل زرّاً أسوأ من قياسٍ ناقص.
 *
 * **ولا يمنع شيئاً**: لا `await` في مسار نقر الزائر، و`keepalive` ليعيش الطلب لو انتقل فوراً.
 */

import { SITE_EVENTS_ENDPOINT, allowedToSend, ensureVisitorId, eventPayload, goalEvent, pageViewEvent } from './analytics';
import type { StorageLike } from './consent';
import { localeFromPath, type Locale } from './i18n';

/**
 * ما نقرأه من المتصفّح، معلَناً بنوعٍ صغير: الملف يُترجم في سبيك Node أيضاً (حيث لا `localStorage`)،
 * والوصول الضمنيّ إلى `globalThis.<شيء>` يعطي `any` ضمنيّاً في tsc الأساس — وهو نصف خطأٍ لا يُرى.
 */
type BrowserGlobals = {
  localStorage?: StorageLike;
  sessionStorage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  navigator?: Parameters<typeof allowedToSend>[0]['navigator'];
  location?: { pathname?: string };
};
const browser = globalThis as unknown as BrowserGlobals;

const send = (events: ReturnType<typeof goalEvent>[]): void => {
  if (events.length === 0) return;
  const body = JSON.stringify(eventPayload(events));
  void fetch(SITE_EVENTS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // القياس أثرٌ لا وعد: فشلُ الشبكة لا يُقال للزائر ولا يُسجَّل في واجهته.
  });
};

function context(): { visitor: string; locale: Locale } | null {
  if (typeof browser.localStorage === 'undefined') return null;
  if (!allowedToSend({ storage: browser.localStorage, navigator: browser.navigator })) return null;
  const visitor = ensureVisitorId(browser.localStorage);
  if (!visitor) return null;
  const path = browser.location?.pathname ?? '/';
  return { visitor, locale: localeFromPath(path) };
}

/** حدثٌ باسمٍ صريح — يستدعيه من يعرف أن شيئاً ذا معنى وقع فعلاً (نجاحُ استمارة). */
export function trackGoal(name: Parameters<typeof goalEvent>[0]['name'], meta?: Parameters<typeof goalEvent>[0]['meta']): void {
  const current = context();
  if (!current) return;
  send([goalEvent({ name, path: browser.location?.pathname ?? '/', locale: current.locale, visitor: current.visitor, meta })]);
}

/** مشاهدة صفحةٍ — تُنادى عند كل تنقّل، والمكرّر في الجلسة نفسه لا يُرسل مرّتين. */
export function trackPageView(): void {
  const current = context();
  if (!current) return;
  const path = browser.location?.pathname ?? '/';
  const key = `erp.pv.${path}`;
  try {
    if (browser.sessionStorage?.getItem(key)) return;
    browser.sessionStorage?.setItem(key, '1');
  } catch {
    // متصفّحٌ يمنع `sessionStorage` (وضع خاص): نُرسل مرّةً ولا نُكرّر — بلا تخزين.
  }
  send([pageViewEvent({ path, locale: current.locale, visitor: current.visitor })]);
}
