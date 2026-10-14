'use client';

/**
 * كشفٌ عند التمرير — يضيف `in-view` على العنصر عند دخوله الشاشة (IntersectionObserver).
 * الأنيميشن نفسه في `globals.css` (`.reveal`)، مع احترام `prefers-reduced-motion`.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
}: {
  children: ReactNode;
  /** تأخير بالمللي ثانية لتمرير التتابع (stagger). */
  delay?: number;
  as?: 'div' | 'section' | 'article' | 'li';
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      el.classList.add('in-view');
      return;
    }
    el.style.transitionDelay = `${delay}ms`;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    // @ts-expect-error — ref generic across tag union
    <Tag ref={ref} className={`reveal ${className}`}>
      {children}
    </Tag>
  );
}
