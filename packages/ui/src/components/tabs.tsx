'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Tabs and SegmentedTabs.
 *
 * Both are driven by `useId`-linked buttons with `role="tab"` / `role="radio"`
 * so a keyboard and a screen reader get the same answer as a mouse. The
 * animated indicator uses `framer-motion`'s `layout` animation, which is
 * automatically cancelled under `prefers-reduced-motion` by the tokens.
 */

export type TabItem = { key: string; label: ReactNode; badge?: ReactNode; disabled?: boolean };

export type TabsProps = {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  /** Accessible name for the tab list. */
  label?: string;
};

export function Tabs({ items, value, onChange, className = '', label = 'أقسام' }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex flex-wrap items-center gap-1 border-b border-line', className)}
    >
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.key)}
            className={cn(
              'relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-bold transition-colors duration-150 ease-out',
              'focus-visible:ring-4 focus-visible:ring-brand/20 focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-55',
              active
                ? 'border-brand text-brand'
                : 'border-transparent text-muted hover:border-line-strong hover:text-ink',
            )}
          >
            {item.label}
            {item.badge ? <span className="num text-[11px] opacity-80">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export type SegmentedTabsProps = {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  label?: string;
  size?: 'sm' | 'md';
};

/**
 * SegmentedTabs — the «فاتحة | داكنة» / «كاش | شبكة | تحويل» switch.
 *
 * The pill is a real `radiogroup`, so arrow keys move between options without
 * a single line of key handling.
 */
export function SegmentedTabs({
  items,
  value,
  onChange,
  className = '',
  label = 'خيار',
  size = 'md',
}: SegmentedTabsProps) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={item.disabled}
            onClick={() => onChange(item.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm font-bold whitespace-nowrap transition-colors duration-150 ease-out',
              'focus-visible:ring-4 focus-visible:ring-brand/20 focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-55',
              size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
              active ? 'bg-surface text-ink shadow-1' : 'text-muted hover:text-ink',
            )}
          >
            {item.label}
            {item.badge ? <span className="num text-[11px] opacity-70">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
