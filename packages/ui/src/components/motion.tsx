'use client';

import { motion, useInView } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Reveal, CountUp and Marquee — the marketing-only motion primitives
 * (Design v3 §5: "Reveal/CountUp/Marquee لـ marketing فقط").
 *
 * They exist in the shared kit because the tokens own the duration and easing
 * constants, and a second copy of `cubic-bezier(0.16,1,0.3,1)` in the
 * marketing app is exactly how a design system forks. Every one of them:
 *   • runs at ≤ 300ms;
 *   • is a no-op under `prefers-reduced-motion` (framer-motion honours the
 *     media query, and the tokens' global rule kills CSS transitions too);
 *   • reads its colours from the tokens, so the hero animates in both themes.
 *
 * They are deliberately **not** imported by staff or platform-admin: a back
 * office that fades its tables in is a back office that wastes a second per
 * screen.
 */

export type RevealProps = {
  children: ReactNode;
  /** Seconds. */
  delay?: number;
  /** Travel distance in px; `0` is a pure fade. */
  y?: number;
  className?: string;
  as?: 'div' | 'section' | 'li' | 'article';
};

export function Reveal({ children, delay = 0, y = 14, className = '', as = 'div' }: RevealProps) {
  const Component = motion[as];
  return (
    <Component
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.3, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </Component>
  );
}

export type CountUpProps = {
  /** The final value. */
  value: number;
  /** Milliseconds; capped at 300ms by the tokens' motion rule. */
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  decimals?: number;
};

/**
 * CountUp — a number that lands on its value once, when it scrolls into view.
 *
 * It never loops and never runs on a value the visitor has already read, which
 * is what keeps INP low on a landing page (§4: INP < 200ms).
 */
export function CountUp({
  value,
  duration = 300,
  prefix = '',
  suffix = '',
  className = '',
  decimals = 0,
}: CountUpProps) {
  const reference = useRef<HTMLSpanElement>(null);
  const inView = useInView(reference, { once: true, margin: '-40px' });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduced) {
      setDisplay(value);
      return;
    }
    const span = Math.min(300, Math.max(0, duration));
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = span === 0 ? 1 : Math.min(1, (now - start) / span);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(value * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [inView, value, duration]);

  return (
    <span ref={reference} className={cn('num', className)} dir="ltr">
      {prefix}
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

export type MarqueeProps = {
  children: ReactNode;
  /** Seconds for one full pass. */
  speed?: number;
  className?: string;
  /** Pause on hover — a logo strip you cannot stop is a logo strip you cannot read. */
  pauseOnHover?: boolean;
};

/**
 * Marquee — an infinite strip for the sector logos.
 *
 * The content is duplicated once and translated by exactly -50%, so the loop
 * is seamless without measuring anything at runtime (no layout thrash, no CLS).
 */
export function Marquee({ children, speed = 28, className = '', pauseOnHover = true }: MarqueeProps) {
  return (
    <div
      className={cn('group relative overflow-hidden', className)}
      style={{
        maskImage:
          'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
        WebkitMaskImage:
          'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
      }}
    >
      <div
        className={cn(
          'flex w-max items-center gap-10',
          pauseOnHover && 'group-hover:[animation-play-state:paused]',
        )}
        style={{
          animation: `erp-marquee ${speed}s linear infinite`,
        }}
      >
        <div className="flex items-center gap-10">{children}</div>
        <div className="flex items-center gap-10" aria-hidden>
          {children}
        </div>
      </div>
      <style>{`@keyframes erp-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}
