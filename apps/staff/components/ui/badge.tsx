import type { ReactNode } from 'react';

/**
 * شارة حالة — 6 ألوان (neutral/blue/green/amber/red/purple) مع نقطة اختيارية.
 * `tone` يتجاوز اللون الافتراضي للحالة.
 */
export type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-ink-2',
  blue: 'bg-info-soft text-info-ink',
  green: 'bg-ok-soft text-ok-ink',
  amber: 'bg-warn-soft text-warn-ink',
  red: 'bg-danger-soft text-danger',
  purple: 'bg-brand-soft text-brand',
};

const DOT_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-line-raised',
  blue: 'bg-info',
  green: 'bg-ok',
  amber: 'bg-warn',
  red: 'bg-danger',
  purple: 'bg-brand-2',
};

/** Maps the API's English status vocabulary onto a tone. */
export function statusTone(status?: string | null): BadgeTone {
  const s = (status ?? '').toLowerCase();
  if (['posted', 'paid', 'active', 'succeeded', 'success', 'ready', 'approved', 'pass', 'completed', 'done'].includes(s))
    return 'green';
  if (['draft', 'pending', 'running', 'partial', 'trialing', 'trial', 'scheduled', 'processing', 'incomplete'].includes(s))
    return 'amber';
  if (
    ['failed', 'voided', 'unpaid', 'overdue', 'past_due', 'rejected', 'canceled', 'cancelled', 'suspended', 'revoked', 'error', 'expired'].includes(
      s,
    )
  )
    return 'red';
  if (['open', 'issued', 'won', 'new', 'information'].includes(s)) return 'blue';
  return 'neutral';
}

export type BadgeProps = {
  children: ReactNode;
  tone?: BadgeTone;
  /** Derive the tone from a raw status value when no explicit tone is given. */
  status?: string | null;
  dot?: boolean;
  className?: string;
  title?: string;
};

export function Badge({ children, tone, status, dot = false, className = '', title }: BadgeProps) {
  const resolved = tone ?? (status !== undefined ? statusTone(status) : 'neutral');
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-bold whitespace-nowrap ${TONES[resolved]} ${className}`}
    >
      {dot ? <span className={`w-1.5 h-1.5 rounded-full ${DOT_TONES[resolved]}`} aria-hidden /> : null}
      {children}
    </span>
  );
}
