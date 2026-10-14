'use client';

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { formatPercent } from '../lib/format';

/**
 * KPI — a headline number with a direction and a sparkline.
 *
 * `direction` is not decoration: staff's dashboard compares today against
 * yesterday and the week against the last one, and «🠕 12.4%» has to be
 * readable at a glance from a metre away. The tone of the arrow is chosen by
 * the *caller* through `goodDirection`, because a rising receivable is not a
 * rising sale.
 */
export type KpiTone = 'brand' | 'ok' | 'warn' | 'danger' | 'neutral';

const TONE_BOX: Record<KpiTone, string> = {
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface-3 text-muted',
};

const TONE_SPARK: Record<KpiTone, string> = {
  brand: 'var(--brand)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  neutral: 'var(--muted)',
};

export type SparklineProps = {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
};

/**
 * Sparkline — a hand-rolled SVG path.
 *
 * Deliberately not a chart library: a sparkline is 12 numbers and a polyline,
 * and pulling recharts into every KPI tile would cost more than the tile
 * itself. The colour comes from a CSS variable, so it flips with the theme.
 */
export function Sparkline({
  points,
  color = 'var(--brand)',
  width = 120,
  height = 36,
  className = '',
}: SparklineProps) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map(
    (point, index) =>
      `${(index * stepX).toFixed(1)},${(height - 3 - ((point - min) / span) * (height - 6)).toFixed(1)}`,
  );
  const path = `M${coords.join(' L')}`;
  const area = `${path} L${width},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={cn('overflow-visible', className)}
    >
      <path d={area} fill={color} opacity={0.12} />
      <motion.path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}

export type KpiProps = {
  title: string;
  /** Already-formatted money or count — the caller owns the number's shape. */
  value: ReactNode;
  icon?: ReactNode;
  tone?: KpiTone;
  /** Percent change vs the comparison period. */
  delta?: number | null;
  deltaLabel?: string;
  /** Which direction counts as good; defaults to "up". */
  goodDirection?: 'up' | 'down' | 'none';
  spark?: number[];
  hint?: ReactNode;
  /** Stagger delay in seconds. */
  delay?: number;
  className?: string;
};

export function Kpi({
  title,
  value,
  icon,
  tone = 'brand',
  delta,
  deltaLabel,
  goodDirection = 'up',
  spark,
  hint,
  delay = 0,
  className = '',
}: KpiProps) {
  const direction = delta === null || delta === undefined ? 0 : Math.sign(delta);
  const positive = goodDirection === 'none' ? null : goodDirection === 'up' ? direction >= 0 : direction <= 0;
  const arrowColor =
    positive === null ? 'text-muted' : positive ? 'text-ok' : 'text-danger';

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.3, delay, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'relative overflow-hidden rounded-lg border border-line bg-surface p-4 shadow-1',
        'transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-line-strong hover:shadow-3',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 flex items-center gap-1.5 text-[12.5px] font-bold text-muted">{title}</p>
          <p className="num m-0 mt-1.5 text-[30px] leading-none font-bold tracking-tight text-ink">
            {value}
          </p>
        </div>
        {icon ? (
          <span className={cn('grid size-10 flex-none place-items-center rounded-lg', TONE_BOX[tone])}>
            {icon}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          {delta !== null && delta !== undefined ? (
            <p className={cn('m-0 flex items-center gap-1 text-[12px] font-bold', arrowColor)}>
              {direction > 0 ? (
                <ArrowUpRight size={14} aria-hidden />
              ) : direction < 0 ? (
                <ArrowDownRight size={14} aria-hidden />
              ) : (
                <Minus size={14} aria-hidden />
              )}
              <span dir="ltr">{formatPercent(delta)}</span>
              {deltaLabel ? (
                <span className="font-medium text-muted">{deltaLabel}</span>
              ) : null}
            </p>
          ) : hint ? (
            <p className="m-0 truncate text-[12px] font-medium text-muted">{hint}</p>
          ) : null}
        </div>
        {spark && spark.length > 1 ? (
          <Sparkline points={spark} color={TONE_SPARK[tone]} className="flex-none" />
        ) : null}
      </div>
    </motion.article>
  );
}
