'use client';

/**
 * شريط متحرك (marquee) بأسماء القطاعات — يتوقف عند التحويم، ويحترم
 * `prefers-reduced-motion` (يبقى ساكناً). البيانات من `lib/industries` — لا اسمٌ مفترض.
 */
import type { Industry } from '../../lib/industries';

export function Marquee({ items }: { items: ReadonlyArray<Pick<Industry, 'labelAr' | 'icon'>> }) {
  // نسختان من السلسلة في مسار واحد: الحركة -50% تعطي حلقةً لا انقطاع فيها.
  const loop: Array<Pick<Industry, 'labelAr' | 'icon'>> = [...items, ...items];
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {loop.map((item, index) => (
          <span className="marquee-item" key={`${item.labelAr}-${index}`}>
            <span className="mark" aria-hidden="true">
              {item.icon}
            </span>
            {item.labelAr}
          </span>
        ))}
      </div>
    </div>
  );
}
