import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Status vocabulary — one map for every surface (Design v3 §5).
 *
 * The desktop's own words are the labels, and the API's English codes are the
 * keys, so a badge never invents a colour: `posted` is green everywhere,
 * `voided` is red everywhere, and the accounting states the desktop actually
 * distinguishes — «مرحّل / مسودة / ملغاة / معكوس» — keep their own tone
 * instead of collapsing into one generic "green".
 */
export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'brand';

export const STATUS_TONES: Record<string, StatusTone> = {
  /* posted / settled */
  posted: 'ok',
  paid: 'ok',
  settled: 'ok',
  approved: 'ok',
  active: 'ok',
  ready: 'ok',
  succeeded: 'ok',
  success: 'ok',
  completed: 'ok',
  done: 'ok',
  matched: 'ok',
  reconciled: 'ok',
  closed: 'ok',
  resolved: 'ok',
  pass: 'ok',
  /* in flight */
  draft: 'warn',
  pending: 'warn',
  running: 'warn',
  processing: 'warn',
  scheduled: 'warn',
  trialing: 'warn',
  trial: 'warn',
  partial: 'warn',
  incomplete: 'warn',
  queued: 'warn',
  open: 'info',
  issued: 'info',
  new: 'info',
  information: 'info',
  /* refused / gone */
  failed: 'danger',
  error: 'danger',
  voided: 'danger',
  cancelled: 'danger',
  canceled: 'danger',
  rejected: 'danger',
  unpaid: 'danger',
  overdue: 'danger',
  past_due: 'danger',
  suspended: 'danger',
  revoked: 'danger',
  expired: 'danger',
  quarantined: 'danger',
  /* the tender-match answer the POS shows before committing (R4) */
  زيادة: 'danger',
  ناقص: 'warn',
  مطابق: 'ok',
  surplus: 'danger',
  shortage: 'warn',
  exact: 'ok',
};

/** Resolve a raw status string (API code or Arabic label) onto a tone. */
export function statusTone(status?: string | null): StatusTone {
  if (!status) return 'neutral';
  const key = status.trim().toLowerCase();
  return STATUS_TONES[key] ?? STATUS_TONES[status.trim()] ?? 'neutral';
}

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok-soft text-ok-ink border-ok-line',
  warn: 'bg-warn-soft text-warn-ink border-warn-line',
  danger: 'bg-danger-soft text-danger-ink border-danger-line',
  info: 'bg-info-soft text-info-ink border-info-line',
  neutral: 'bg-surface-3 text-ink-2 border-line',
  brand: 'bg-brand-soft text-brand border-brand-line',
};

const DOT_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-muted',
  brand: 'bg-brand',
};

export type BadgeProps = {
  children: ReactNode;
  tone?: StatusTone;
  /** Derive the tone from a raw status value when no explicit tone is given. */
  status?: string | null;
  dot?: boolean;
  className?: string;
  title?: string;
};

/**
 * Badge / StatusBadge.
 *
 * The tone is applied through the semantic `*-soft` / `*-ink` / `*-line`
 * tokens, so the label keeps its contrast on a white card and on slate-950
 * alike (Design v3 §2.2.10).
 */
export function Badge({ children, tone, status, dot = false, className = '', title }: BadgeProps) {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] font-bold whitespace-nowrap',
        TONE_CLASS[resolved],
        className,
      )}
    >
      {dot ? <span className={cn('size-1.5 rounded-full', DOT_CLASS[resolved])} aria-hidden /> : null}
      {children}
    </span>
  );
}

/** A small square marker for dense table cells — same tone map, less chrome. */
export function CellBadge({
  tone,
  status,
  dot = true,
  children,
  className = '',
}: {
  tone?: StatusTone;
  status?: string | null;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={tone} status={status} dot={dot} className={cn('px-2 py-0.5 text-[11px]', className)}>
      {children}
    </Badge>
  );
}
