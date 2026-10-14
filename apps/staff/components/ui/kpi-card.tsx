'use client';

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * بطاقة مؤشر — أيقونة في مربع ملون، رقم 32px، نسبة تغيّر، وخيط sparkline خلف الرقم.
 * `stagger` يتحكم بتوقيت الدخول ضمن المجموعة.
 */
export type KpiTone = 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'slate';

const TONE_BOX: Record<KpiTone, string> = {
  blue: 'bg-info-soft text-info',
  green: 'bg-ok-soft text-ok',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
  purple: 'bg-brand-soft text-brand',
  slate: 'bg-surface-3 text-muted',
};

const TONE_SPARK: Record<KpiTone, string> = {
  blue: 'var(--color-chart-1)',
  green: 'var(--color-chart-3)',
  amber: 'var(--color-chart-4)',
  red: 'var(--color-chart-5)',
  purple: 'var(--color-chart-2)',
  slate: 'var(--muted)',
};

/** Tiny inline sparkline — an SVG path over normalized points. */
export function Sparkline({ points, color, width = 120, height = 36 }: { points: number[]; color: string; width?: number; height?: number }) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => `${(i * stepX).toFixed(1)},${(height - 3 - ((p - min) / span) * (height - 6)).toFixed(1)}`);
  const path = `M${coords.join(' L')}`;
  const area = `${path} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <path d={area} fill={color} opacity={0.12} />
      <motion.path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      />
    </svg>
  );
}

export type KpiCardProps = {
  title: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: KpiTone;
  /** Percent vs previous period, e.g. +12.4 or -3.1. */
  delta?: number | null;
  deltaLabel?: string;
  spark?: number[];
  hint?: ReactNode;
  /** Enter animation delay (stagger), seconds. */
  delay?: number;
};

export function KpiCard({ title, value, icon, tone = 'blue', delta, deltaLabel, spark, hint, delay = 0 }: KpiCardProps) {
  const positive = (delta ?? 0) >= 0;
  return (
    <motion.article
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-1 transition-all duration-150 ease-out hover:-translate-y-1 hover:shadow-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-[12.5px] font-bold text-muted flex items-center gap-1.5">{title}</p>
          <p className="m-0 mt-1.5 text-[32px] font-bold text-ink leading-none tracking-tight" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </p>
        </div>
        <span className={`grid place-items-center size-11 rounded-xl flex-none ${TONE_BOX[tone]}`}>{icon}</span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          {delta !== null && delta !== undefined ? (
            <p className="m-0 text-[12px] font-bold flex items-center gap-1" style={{ color: positive ? 'var(--ok)' : 'var(--danger)' }}>
              {positive ? <ArrowUpRight size={14} /> : delta < 0 ? <ArrowDownRight size={14} /> : <Minus size={14} />}
              <span dir="ltr">{Math.abs(delta).toFixed(1)}%</span>
              {deltaLabel ? <span className="text-muted font-medium">{deltaLabel}</span> : null}
            </p>
          ) : hint ? (
            <p className="m-0 text-[12px] text-muted font-medium truncate">{hint}</p>
          ) : null}
        </div>
        {spark && spark.length > 1 ? (
          <Sparkline points={spark} color={TONE_SPARK[tone]} />
        ) : null}
      </div>
    </motion.article>
  );
}
