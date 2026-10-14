'use client';

import { cn } from '../lib/cn';

/**
 * Progress and Meter.
 *
 * `Progress` is the indeterminate/known bar used for a job queue; `Meter` is
 * the *quota* shape — «استُهلك 80% من الحصة» — which staff's usage screen and
 * the console's tenant drawer both need. A quota over 100% is drawn full and
 * painted danger, because a limit that quietly overflows is a limit nobody
 * trusts.
 */

export type ProgressProps = {
  /** 0–100. Omit for an indeterminate bar. */
  value?: number;
  tone?: 'brand' | 'ok' | 'warn' | 'danger';
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
};

const TONE_BAR: Record<NonNullable<ProgressProps['tone']>, string> = {
  brand: 'bg-brand',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export function Progress({ value, tone = 'brand', size = 'md', label, className = '' }: ProgressProps) {
  const indeterminate = value === undefined;
  const clamped = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      className={cn(
        'w-full overflow-hidden rounded-full bg-surface-3',
        size === 'sm' ? 'h-1.5' : 'h-2.5',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out',
          TONE_BAR[tone],
          indeterminate && 'w-1/3 animate-pulse',
        )}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}

export type MeterProps = {
  label: string;
  /** Already-formatted «12,400» and the limit «15,000». */
  used: string;
  limit: string;
  /** 0–100+; values above 100 are clamped for the bar and flagged as over. */
  percent: number;
  unit?: string;
  className?: string;
};

export function Meter({ label, used, limit, percent, unit, className = '' }: MeterProps) {
  const over = percent > 100;
  const tone = over ? 'danger' : percent >= 80 ? 'warn' : 'ok';
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-bold text-ink-2">{label}</span>
        <span className="num text-[11.5px] text-muted" dir="ltr">
          {used} / {limit}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <Progress value={Math.min(100, percent)} tone={tone} size="sm" label={label} />
      <p className={cn('m-0 num text-[11px] font-bold', over ? 'text-danger' : 'text-muted')} dir="ltr">
        {percent.toFixed(0)}%{over ? ' — تجاوزت الحصة' : ''}
      </p>
    </div>
  );
}
