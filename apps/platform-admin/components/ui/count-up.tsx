'use client';

import { animate, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * رقم يعدّ تصاعدياً من 0 حتى قيمته عند دخوله مجال الرؤية (count-up).
 * يقبل `format` لضبط الشكل (فواصل، عملة…).
 */
export function CountUp({
  value,
  format,
  duration = 0.9,
  className = '',
}: {
  value: number;
  format?: (value: number) => string;
  duration?: number;
  className?: string;
}) {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(format ? format(0) : '0');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(format ? format(v) : Math.round(v).toLocaleString('en-US')),
    });
    return () => controls.stop();
  }, [inView, value, duration, format]);

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: 'tabular-nums' }} dir="ltr">
      {display}
    </span>
  );
}

/** غلاف ظهور تدريجي (fade + slide) عند دخول مجال الرؤية. */
export function Reveal({
  children,
  delay = 0,
  y = 14,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.45, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
