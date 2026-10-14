'use client';

/**
 * P-M10 — **مُلتقِط الأحداث العامّ** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): مشاهدةُ صفحةٍ
 * عند كل تنقّل، وهدفٌ عند كل نقرةٍ على عنصرٍ يحمل `data-goal`.
 *
 * **ولماذا مستمعٌ واحد على المستند بدل مكوّنٍ لكل زرّ؟** لأن الأزرار تُضاف في كل جزءٍ من
 * الموقع (البطل · الباقة · التذييل · صفحات القطاعات)، وربطُ كلٍّ بمكوّن قياسٍ يعني نسيان
 * واحدٍ منها في كل مرة — والنسيان هنا صامت: القمع ينقص ولا يشتكي أحد. فالقاعدة واحدة:
 * من يريد أن يُقاس مروره يكتب `data-goal="signup_start"`، والاسم يُقرأ من مفردات العقد
 * (`goalFromAttribute`) فلا يدخل HTML حدثٌ غير معروف.
 *
 * **ولا يعترض شيئاً**: لا `preventDefault` ولا تأخير — التنقّل يقع، والطلب يمضي بـ`keepalive`.
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { GOAL_ATTRIBUTE, goalFromAttribute } from '../../lib/analytics';
import { trackGoal, trackPageView } from '../../lib/track';

export function SiteEvents() {
  const pathname = usePathname();

  useEffect(() => {
    trackPageView();
  }, [pathname]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const holder = target?.closest?.(`[${GOAL_ATTRIBUTE}]`);
      if (!holder) return;
      const name = goalFromAttribute(holder.getAttribute(GOAL_ATTRIBUTE));
      if (!name) return;
      trackGoal(name, { source: 'cta' });
    };
    // المرحلة الالتقاطية: النقرة تُقرأ قبل أن يُنفَّذ التنقّل ويُفكّك المستند.
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  return null;
}
