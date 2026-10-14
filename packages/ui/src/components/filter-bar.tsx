'use client';

import { FilterX } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * FilterBar — the strip above every list.
 *
 * It is a plain flex row of controls plus an optional "clear" action, because
 * a filter bar that owns its own layout logic becomes the one thing a screen
 * cannot rearrange. `dir` is inherited, so in an RTL page the controls lay out
 * right-to-left with no override.
 */
export type FilterBarProps = {
  children: ReactNode;
  /** Shown when at least one filter is active; clears them all. */
  onClear?: () => void;
  clearLabel?: string;
  /** A count or a summary on the far end — «12 من 340». */
  summary?: ReactNode;
  className?: string;
};

export function FilterBar({
  children,
  onClear,
  clearLabel = 'مسح الفلاتر',
  summary,
  className = '',
}: FilterBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3 shadow-1',
        className,
      )}
    >
      {children}
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="mb-[2px] inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[12.5px] font-bold text-muted transition-colors duration-150 hover:border-danger-line hover:bg-danger-soft hover:text-danger-ink"
        >
          <FilterX size={14} aria-hidden />
          {clearLabel}
        </button>
      ) : null}
      {summary ? (
        <span className="num mb-[10px] ms-auto text-[12px] text-muted">{summary}</span>
      ) : null}
    </div>
  );
}
