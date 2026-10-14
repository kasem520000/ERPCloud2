'use client';

import { useEffect, useRef } from 'react';

import { writeSession } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * AUD-08 — يستقبل جسر الدخول من الواجهة التسويقية.
 *
 * ما كان: `?token=<access>&refresh=<refresh>&tenant=…` — أي أن **رموز الجلسة كاملة**
 * تمرّ في عنوان الطلب الأول، فتُسجَّل في سجلّات الوسيط/الوكيل وفي `Referer`، وإزالتها
 * بعد التحميل لا تلغي ما سُجّل. ما صار: العنوان يحمل `?handoff=<code>` فقط، رمزٌ
 * لمرة واحدة عمره ~60 ثانية **لا يحمل صلاحية بنفسه**، يُستبدل هنا عبر POST بجلسةٍ
 * جديدة، ثم يُنظَّف العنوان بلا إعادة تحميل.
 *
 * الفشل مغلق: رمز منتهٍ أو مُستبدل سابقاً يُلقي المستخدم على شاشة الدخول، لا على جلسة
 * جزئية. ولا يوجد مسار قراءة `token` من الاستعلام بعد اليوم.
 */
export function TokenBridge() {
  const { status, reload } = useSession();
  const inFlight = useRef(false);

  useEffect(() => {
    if (status !== 'anonymous' || inFlight.current) return;
    const url = new URL(globalThis.location.href);
    const code = url.searchParams.get('handoff');
    if (!code) return;
    inFlight.current = true;

    // التنظيف فوراً: لا يبقى الرمز في العنوان/المحفوظات حتى لو فشل الاستبدال.
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
        const payload = (await response.json()) as {
          data: { accessToken: string; refreshToken: string; expiresIn: number; memberships: Array<{ tenantCode: string }> };
        };
        writeSession({
          accessToken: payload.data.accessToken,
          refreshToken: payload.data.refreshToken,
          tenantCode: payload.data.memberships[0]?.tenantCode ?? '',
          expiresAt: Date.now() + payload.data.expiresIn * 1000,
        });
        void reload();
      } catch {
        globalThis.location.assign('/login?handoff=failed');
      }
    })();
  }, [status, reload]);

  return null;
}
