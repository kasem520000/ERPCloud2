'use client';

import { GripVertical, Minus, TrendingDown, TrendingUp, X } from 'lucide-react';

import { money } from '../../lib/lookups';
import type { WidgetFigure } from '../../lib/bi-dashboards';

function figureText(widget: WidgetFigure): string {
  if (widget.error) return '—';
  if (widget.value === undefined) return '—';
  if (widget.unit === 'money') return `${money(widget.value)} ر.س`;
  return money(widget.value);
}

export function WidgetCard({
  widget,
  editable,
  onDragStart,
  onDrop,
  onRemove,
}: {
  widget: WidgetFigure;
  editable?: boolean;
  onDragStart?: (id: string) => void;
  onDrop?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const delta = widget.deltaPercent === undefined ? null : Number(widget.deltaPercent);
  const up = (delta ?? 0) >= 0;
  return (
    <article
      draggable={Boolean(editable)}
      onDragStart={() => onDragStart?.(widget.id)}
      onDragOver={(event) => {
        if (editable) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop?.(widget.id);
      }}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-1"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {editable ? <GripVertical size={14} className="shrink-0 text-muted" /> : null}
          <h3 className="m-0 truncate text-[13px] font-semibold text-ink">{widget.titleAr}</h3>
        </div>
        {editable && onRemove ? (
          <button type="button" className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-danger" onClick={() => onRemove(widget.id)} aria-label="حذف المؤشر">
            <X size={14} />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 p-3">
        {widget.error ? <p className="m-0 text-[13px] text-warn-ink">{widget.error}</p> : null}
        {!widget.error && widget.kind === 'kpi' ? (
          <div>
            <p className="m-0 text-[28px] font-bold tracking-tight text-ink">{figureText(widget)}</p>
            {delta !== null && Number.isFinite(delta) ? (
              <p className={`m-0 mt-1 inline-flex items-center gap-1 text-[12px] font-semibold ${up ? 'text-ok' : 'text-danger'}`}>
                {delta === 0 ? <Minus size={13} /> : up ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                {up && delta > 0 ? '+' : ''}
                {delta.toFixed(1)}%
                {widget.comparisonAr ? <span className="font-normal text-muted">{widget.comparisonAr}</span> : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {!widget.error && widget.kind === 'chart' ? <Bars series={widget.series ?? []} /> : null}
        {!widget.error && (widget.kind === 'table' || widget.kind === 'list') ? (
          <Rows columns={widget.columns ?? []} rows={widget.rows ?? []} />
        ) : null}
      </div>
    </article>
  );
}

function Bars({ series }: { series: { label: string; value: string }[] }) {
  if (series.length === 0) return <p className="m-0 text-[13px] text-muted">لا توجد بيانات</p>;
  const max = Math.max(...series.map((item) => Number(item.value) || 0), 1);
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {series.map((item) => (
        <li key={item.label} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 text-[12px]">
          <span className="truncate text-muted">{item.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.max(4, ((Number(item.value) || 0) / max) * 100)}%` }} />
          </span>
          <span className="tabular-nums text-ink-2">{money(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Rows({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="m-0 text-[13px] text-muted">لا توجد بيانات</p>;
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="text-muted">
          {columns.map((column) => (
            <th key={column} className="pb-1 text-start font-medium">{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-t border-line text-ink-2">
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className="py-1 pe-2">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
