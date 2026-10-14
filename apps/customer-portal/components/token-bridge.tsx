'use client';

import { useEffect, useRef } from 'react';

import { storeToken } from '../lib/api';

/**
 * AUD-08 — يستقبل جسر الدخول من الواجهة التسويقية في بوابة العميل.
 *
 * كان `?token=<access>&refresh=…` يمرّ في العنوان ثم يُحذف بعد التحميل — والعنوان يكون
 * قد وصل إلى السجلّات. الآن `?handoff=<code>` لمرة واحدة يُستبدل عبر POST، ويُنظَّف
 * العنوان قبل الاستبدال، ورمز الاستبدال لا يُقبل مرتين.
 */
export function TokenBridge() {
  const inFlight = useRef(false);

  useEffect(() => {
    if (inFlight.current) return;
    const url = new URL(globalThis.location.href);
    const code = url.searchParams.get('handoff');
    if (!code) return;
    inFlight.current = true;

    url.searchParams.delete('handoff');
    globalThis.history.replaceState(null, '', url.toString());

    void (async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL || '/api/v1'}/auth/handoff/redeem`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (!response.ok) {
          globalThis.location.assign('/login?handoff=failed');
          return;
        }
        const payload = (await response.json()) as { data: { accessToken: string } };
        storeToken(payload.data.accessToken);
        globalThis.location.assign(url.pathname === '/' ? '/portal' : `${url.pathname}${url.search}`);
      } catch {
        globalThis.location.assign('/login?handoff=failed');
      }
    })();
  }, []);

  return null;
}
