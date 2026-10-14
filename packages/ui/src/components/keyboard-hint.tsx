'use client';

import { cn } from '../lib/cn';

/**
 * KeyboardHint — «F7» «F9» «Esc».
 *
 * The desktop's speed keys are the reason a cashier can work without looking
 * at the mouse, so the cloud shows them the same way: a small keycap, not a
 * sentence. Rendered with `kbd` so a screen reader reads "F7" rather than
 * spelling the glyph.
 */

const KEY_LABELS: Record<string, string> = {
  F7: 'F7',
  F9: 'F9',
  Esc: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
};

export type KeyboardHintProps = {
  keys: string[];
  /** What the key does, in the visitor's language. */
  label?: string;
  className?: string;
  size?: 'sm' | 'md';
};

export function KeyboardHint({ keys, label, className = '', size = 'sm' }: KeyboardHintProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {keys.map((key) => (
        <kbd
          key={key}
          className={cn(
            'inline-grid min-w-6 place-items-center rounded-xs border border-line-strong border-b-2 bg-surface-2 font-bold text-ink-2',
            size === 'sm' ? 'h-5 px-1.5 text-[10.5px]' : 'h-6 px-2 text-[11.5px]',
          )}
        >
          {KEY_LABELS[key] ?? key}
        </kbd>
      ))}
      {label ? <span className="text-[11.5px] text-muted">{label}</span> : null}
    </span>
  );
}

/** The POS footer's F-keys, as one row. */
export function PosKeyHints({ hints }: { hints: Array<{ keys: string[]; label: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {hints.map((hint) => (
        <KeyboardHint key={hint.label} keys={hint.keys} label={hint.label} />
      ))}
    </div>
  );
}
