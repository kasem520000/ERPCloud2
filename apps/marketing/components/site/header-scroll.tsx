'use client';

/**
 * رأسٌ يستجيب للتمرير — يضيف `scrolled` على `.site-header` بعد بضع بكسلات،
 * فيكسب تظليلاً وحدّاً فوق الخلفيات المتحركة.
 */
import { useEffect, type ReactNode } from 'react';

export function HeaderScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('.site-header');
    if (!header) return;
    let ticking = false;
    const update = () => {
      header.classList.toggle('scrolled', window.scrollY > 12);
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return <>{children}</>;
}
