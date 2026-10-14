'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

import { CountUp } from './count-up';

export type MetricTone = 'violet' | 'green' | 'amber' | 'red' | 'sky' | 'slate';

const TONES: Record<MetricTone, { accent: string; text: string }> = {
  violet: { accent: 'var(--color-chart-2)', text: 'text-brand' },
  green: { accent: 'var(--color-chart-3)', text: 'text-ok' },
  amber: { accent: 'var(--color-chart-4)', text: 'text-warn' },
  red: { accent: 'var(--color-chart-5)', text: 'text-danger' },
  sky: { accent: 'var(--color-chart-6)', text: 'text-info' },
  slate: { accent: 'var(--muted)', text: 'text-muted' },
};

/**
 * بطاقة مقياس — الأرقام بخط Mono (JetBrains) مع وسم اتجاه وخط شرارة صغير.
 * صك Vercel/Linear: بطاقة خفيفة، رقم كبير، شرارة 40px.
 */
export function MetricCard({
  label,
  value,
  suffix,
  icon,
  tone = 'violet',
  delta,
  deltaLabel,
  spark,
  hint,
  delay = 0,
  live,
}: {
  label: string;
  value: number;
  suffix?: string;
  icon?: ReactNode;
  tone?: MetricTone;
  /** نسبة التغيّر (تُعرض سهمًا أخضر/أحمر). */
  delta?: number;
  deltaLabel?: string;
  /** نقاط الشرارة (تُرسم آخر 30 نقطة). */
  spark?: number[];
  hint?: string;
  delay?: number;
  /** نقطة نابضة — «live» مثل مؤشرات Linear. */
  live?: boolean;
}) {
  const toneDef = TONES[tone];
  const positive = (delta ?? 0) >= 0;
  const points = (spark ?? []).slice(-30);
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;

  return (
    <motion.article
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-[10px] border border-line bg-surface p-4 shadow-1 transition-all duration-150 ease-out hover:-translate-y-0.5 hover:shadow-3"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: `linear-gradient(90deg, ${toneDef.accent}, transparent 70%)` }} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 flex items-center gap-2 text-[11.5px] font-bold tracking-wide text-muted">
            {label}
            {live ? (
              <span className="relative inline-flex size-2 rounded-full bg-ok">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-70" />
              </span>
            ) : null}
          </p>
          <p
            className="m-0 mt-2 text-[26px] font-bold leading-none tracking-tight text-ink"
            style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}
            dir="ltr"
          >
            <CountUp value={value} />
            {suffix ? <span className="text-[15px] font-semibold text-muted"> {suffix}</span> : null}
          </p>
        </div>
        {icon ? (
          <span className={`grid size-9 flex-none place-items-center rounded-lg border border-line bg-surface-2 ${toneDef.text}`}>
            {icon}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {delta !== null && delta !== undefined ? (
            <p className="m-0 flex items-center gap-1 text-[11.5px] font-bold" style={{ color: positive ? 'var(--ok)' : 'var(--danger)' }}>
              <span dir="ltr">{positive ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%</span>
              {deltaLabel ? <span className="font-medium text-muted">{deltaLabel}</span> : null}
            </p>
          ) : hint ? (
            <p className="m-0 truncate text-[11.5px] font-medium text-muted">{hint}</p>
          ) : null}
        </div>
        {points.length > 1 ? (
          <svg width="88" height="36" viewBox="0 0 88 36" className="flex-none overflow-visible" aria-hidden>
            <polyline
              fill="none"
              stroke={toneDef.accent}
              strokeWidth="1.8"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={points.map((p, i) => `${(i / (points.length - 1)) * 88},${32 - ((p - min) / range) * 28 + 2}`).join(' ')}
            />
            <circle
              cx="88"
              cy={32 - (((points[points.length - 1] ?? max) - min) / range) * 28 + 2}
              r="2.4"
              fill={toneDef.accent}
            />
          </svg>
        ) : null}
      </div>
    </motion.article>
  );
}
