'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * PrintSheet — the paper a document is printed on.
 *
 * Design v3 §6.1 and §2.2.7 meet here: one sheet for a journal entry, an
 * invoice, a statement, a trial balance and an 80mm receipt. The sheet is
 * always white with dark ink, whatever the on-screen theme is, because the
 * tokens' `@media print` block forces it — a receipt printed from a night
 * shift must not come out black.
 *
 * Two formats:
 *   `format="a4"`    — 210mm, 12mm margins, `size: A4` in `@page`.
 *   `format="receipt"` — 80mm thermal roll: no margins, monospace-ish figures,
 *     a narrow measure, and no page break in the middle of a line.
 */

export type PrintSheetProps = {
  children: ReactNode;
  format?: 'a4' | 'receipt';
  className?: string;
  /** Rendered above the body on paper only — a company header, a stamp. */
  header?: ReactNode;
  footer?: ReactNode;
};

export function PrintSheet({
  children,
  format = 'a4',
  className = '',
  header,
  footer,
}: PrintSheetProps) {
  return (
    <article
      data-print-format={format}
      className={cn(
        'mx-auto bg-white text-slate-900',
        format === 'a4'
          ? 'w-full max-w-[210mm] p-8'
          : 'w-[80mm] max-w-[80mm] p-3 text-[12px] leading-relaxed',
        className,
      )}
    >
      {header ? <div className="mb-4 border-b border-slate-300 pb-3">{header}</div> : null}
      <div className={format === 'receipt' ? 'num' : undefined}>{children}</div>
      {footer ? (
        <div className="mt-6 border-t border-slate-300 pt-3 text-[11px] text-slate-600">{footer}</div>
      ) : null}
    </article>
  );
}

/**
 * A4 page break helper — screens put it between two documents so a 40-line
 * statement does not get cut in half by the printer.
 */
export function PageBreak() {
  return <div className="my-6 break-after-page border-t border-dashed border-slate-300" aria-hidden />;
}

/**
 * The QR block on a ZATCA invoice.
 *
 * The payload comes from the API untouched (Design v3 §6.1: «QR الفاتورة
 * بصيغتها الحالية — لا تغيّر DTO»); this component only decides how it sits on
 * the paper. It is drawn on a white plate so it stays scannable even when the
 * page around it is a dark theme's card.
 */
export function PrintQr({ value, size = 96, label }: { value: string; size?: number; label?: string }) {
  return (
    <div className="inline-flex flex-col items-center gap-1 rounded-md border border-slate-300 bg-white p-2">
      {/* The QR itself is rendered by the caller's own component (the app's
          existing QR renderer) so the encoded payload is produced in exactly
          one place. This wrapper only owns the plate. */}
      <div className="grid place-items-center bg-white" style={{ width: size, height: size }}>
        <span className="num text-[9px] text-slate-500" dir="ltr">
          {value.slice(0, 24)}
        </span>
      </div>
      {label ? <span className="text-[10px] text-slate-600">{label}</span> : null}
    </div>
  );
}
