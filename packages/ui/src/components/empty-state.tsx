'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * EmptyState — the one component every "nothing here" answer goes through.
 *
 * Design v3 §6.1: an unavailable screen is *named*, never silently hidden. A
 * `tone="danger"` empty state with the endpoint in the description is how an
 * `api`-status screen and a `403` both read; a plain one is how an empty
 * table reads. Nothing is left blank.
 */
export type EmptyStateTone = 'brand' | 'ok' | 'warn' | 'danger' | 'neutral';

const TONES: Record<EmptyStateTone, string> = {
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface-3 text-muted',
};

export type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: EmptyStateTone;
  className?: string;
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  className = '',
}: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'grid place-items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface-2 px-6 py-12 text-center',
        className,
      )}
    >
      <span className={cn('grid size-14 place-items-center rounded-xl', TONES[tone])} aria-hidden>
        {icon}
      </span>
      <div>
        <h3 className="m-0 text-[15px] font-bold text-ink">{title}</h3>
        {description ? (
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </motion.div>
  );
}
