'use client';

import type { ReactNode } from 'react';
import { useId, useState } from 'react';

import { cn } from '../lib/cn';

/**
 * Tooltip — a label for an icon-only control.
 *
 * Design v3 §4 requires every interaction to be reachable and named; an icon
 * button with no text therefore needs a tooltip *and* an `aria-label`. This
 * component takes the label once and wires both, so the two can never drift.
 * It is hover/focus driven (never click), and it never traps focus.
 */
export type TooltipProps = {
  /** The accessible name. Also the visible text. */
  label: string;
  children: ReactNode;
  /** Which edge the bubble grows from. */
  side?: 'top' | 'bottom';
  className?: string;
};

export function Tooltip({ label, children, side = 'top', className = '' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'pointer-events-none absolute start-1/2 z-50 -translate-x-1/2 rounded-md border border-line bg-raised px-2 py-1 text-[11.5px] font-semibold whitespace-nowrap text-ink shadow-3',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
