'use client';

import type { ReactNode } from 'react';

/**
 * Shared presentation layer for the module screens.
 *
 * Before part four every inventory screen was the same shape: a `Screen` title, a
 * couple of cards and a `DataTable`. The pieces below are the vocabulary that was
 * missing — tiles for the numbers that matter, a step track for the document
 * lifecycle, tabs, a filter bar, and states that explain themselves — so a screen
 * can be laid out from the desktop form instead of being improvised per page.
 */

export type Tone = 'default' | 'ok' | 'warn' | 'danger' | 'brand';

function toneClass(tone?: Tone): string {
  return tone && tone !== 'default' ? ` ${tone}` : '';
}

// ------------------------------------------------------------------------- tiles

/** A row of KPI tiles. Each tile carries a quantity *and*, where it exists, a value. */
export function StatTiles({ children }: { children: ReactNode }) {
  return <div className="tiles">{children}</div>;
}

export function StatTile({
  label,
  value,
  hint,
  tone,
  bar,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** 0–100. Renders a progress bar under the value — used for "received of sent". */
  bar?: number;
}) {
  return (
    <div className={`tile${toneClass(tone)}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint ? <span className="tile-hint">{hint}</span> : null}
      {typeof bar === 'number' ? (
        <span className={`bar${toneClass(tone).trim()}`}>
          <span style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
        </span>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------- stepper

/**
 * The lifecycle of a document as steps: مسودة → مُرسَلة → مُستلمة → مُغلقة.
 *
 * `current` is the index of the live step; anything before it is done, anything
 * after it is still ahead. A negative index leaves every step pending.
 */
export function StatusTrack({
  steps,
  current,
  cancelled,
}: {
  steps: string[];
  current: number;
  /** Draws the track in the danger tone — the document was voided or cancelled. */
  cancelled?: boolean;
}) {
  return (
    <div className="stepper">
      {steps.map((step, index) => {
        const state: 'done' | 'current' | 'cancelled' | 'todo' =
          index < current ? 'done' : index > current ? 'todo' : cancelled ? 'cancelled' : 'current';
        return (
          <span key={step} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {index > 0 ? <span className="step-sep" /> : null}
            <span className={`step${state === 'todo' ? '' : ` ${state}`}`}>
              <span className="step-bullet">
                {state === 'done' ? '✓' : state === 'cancelled' ? '✕' : index + 1}
              </span>
              {step}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------------- tabs

export function Tabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: Array<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="tabs">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`tab${item.id === value ? ' active' : ''}`}
          onClick={() => onChange(item.id)}
          aria-current={item.id === value}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------- filters

/** Sticky-ish filter row. Fields keep their own labels; actions sit at the end. */
export function FilterBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="filters no-print">
      {children}
      {actions ? <div className="filters-actions">{actions}</div> : null}
    </div>
  );
}

/** Document actions (save / post / void / print) — hidden when printing. */
export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="toolbar no-print">{children}</div>;
}

// ------------------------------------------------------------------- doc header

/** The header fields of a document as the desktop forms lay them out. */
export function DocHead({ children }: { children: ReactNode }) {
  return <div className="doc-head">{children}</div>;
}

export function DocField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="doc-field">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

// ----------------------------------------------------------------------- states

export function StateBox({
  icon = '📭',
  title,
  detail,
  action,
}: {
  icon?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-box">
      <span className="state-icon" aria-hidden>
        {icon}
      </span>
      <span className="state-title">{title}</span>
      {detail ? <span className="small">{detail}</span> : null}
      {action}
    </div>
  );
}

/** Totals strip under a document grid. */
export function Totals({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="totals">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <b>{item.value}</b>
        </div>
      ))}
    </div>
  );
}
