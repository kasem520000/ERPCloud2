'use client';

import { ChevronDown, ChevronUp, ChevronsUpDown, Inbox } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Badge, type BadgeTone } from './badge';
import { Skeleton } from './skeleton';

/**
 * جدول النظام — ترويسة لاصقة، زبرا، فرز اختياري، تحديد بالـ checkbox، وأقواس 3 نقاط
 * لكل صف. الحشو كله اختياري: صفحة لا تمرر `sortable` أو `selectable` تحصل على جدول بسيط.
 */
export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** End-align with tabular figures. */
  numeric?: boolean;
  /** Force LTR direction (numbers, codes). */
  ltr?: boolean;
  /** Column takes the remaining width. */
  grow?: boolean;
  width?: number | string;
  sortable?: boolean;
};

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

type TableProps<T> = {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  activeKey?: string;
  /** Sticky footer row cells in column order (e.g. totals). */
  footer?: ReactNode[];
  /* selection */
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  /* sorting */
  sortable?: boolean;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Per-row 3-dot menu. */
  actions?: (row: T) => Array<{ label: string; icon?: ReactNode; onClick: () => void; danger?: boolean }>;
  dense?: boolean;
  zebra?: boolean;
};

export function Table<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 6,
  empty,
  onRowClick,
  activeKey,
  footer,
  selectable = false,
  selectedKeys,
  onSelectionChange,
  sortable = false,
  sort,
  onSortChange,
  actions,
  dense = false,
  zebra = true,
}: TableProps<T>) {
  const allSelected =
    selectable && rows.length > 0 && rows.every((row, i) => selectedKeys?.has(rowKey(row, i)));
  const someSelected =
    selectable && rows.some((row, i) => selectedKeys?.has(rowKey(row, i))) && !allSelected;

  const colSpan = columns.length + (selectable ? 1 : 0) + (actions ? 1 : 0);

  function toggleAll() {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (allSelected) for (const [i, row] of rows.entries()) next.delete(rowKey(row, i));
    else for (const [i, row] of rows.entries()) next.add(rowKey(row, i));
    onSelectionChange(next);
  }

  function toggleOne(key: string) {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  function toggleSort(key: string) {
    if (!onSortChange) return;
    if (sort?.key !== key) onSortChange({ key, dir: 'asc' });
    else if (sort.dir === 'asc') onSortChange({ key, dir: 'desc' });
    else onSortChange(null);
  }

  const cellPad = dense ? 'px-2.5 py-1.5' : 'px-3 py-2.5';

  return (
    <div className="w-full overflow-auto max-h-[70vh] rounded-xl border border-line bg-surface shadow-1">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {selectable ? (
              <th className={`sticky top-0 z-10 bg-surface-2 w-10 ${cellPad}`}>
                <input
                  type="checkbox"
                  className="size-4 accent-brand-600 cursor-pointer"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="تحديد الكل"
                />
              </th>
            ) : null}
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={`sticky top-0 z-10 bg-surface-2 font-bold text-[11px] tracking-wide text-muted whitespace-nowrap ${cellPad} ${
                  col.numeric ? 'text-end' : 'text-start'
                } ${col.grow ? 'w-full' : ''}`}
              >
                {col.sortable && sortable ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={`inline-flex items-center gap-1 hover:text-ink transition-colors duration-150 ${
                      sort?.key === col.key ? 'text-brand-700' : ''
                    }`}
                  >
                    {col.header}
                    {sort?.key === col.key ? (
                      sort.dir === 'asc' ? (
                        <ChevronUp size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )
                    ) : (
                      <ChevronsUpDown size={13} className="opacity-40" />
                    )}
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
            {actions ? <th className={`sticky top-0 z-10 bg-surface-2 w-10 ${cellPad}`} /> : null}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className={zebra && i % 2 === 1 ? 'bg-surface-2' : ''}>
                  {selectable ? (
                    <td className={cellPad}>
                      <Skeleton className="size-4" />
                    </td>
                  ) : null}
                  {columns.map((col) => (
                    <td key={col.key} className={cellPad}>
                      <Skeleton className="h-3.5 w-3/4" />
                    </td>
                  ))}
                  {actions ? (
                    <td className={cellPad}>
                      <Skeleton className="size-6 mx-auto" />
                    </td>
                  ) : null}
                </tr>
              ))
            : rows.length === 0
              ? [
                  <tr key="empty">
                    <td colSpan={colSpan}>
                      <div className="grid place-items-center gap-2 py-14 text-muted">
                        <span className="grid place-items-center size-16 rounded-2xl bg-surface-3 text-muted">
                          <Inbox size={30} strokeWidth={1.5} />
                        </span>
                        <p className="m-0 text-sm font-semibold text-muted">
                          {empty ?? 'لا توجد سجلات لعرضها'}
                        </p>
                      </div>
                    </td>
                  </tr>,
                ]
              : rows.map((row, index) => {
                  const key = rowKey(row, index);
                  const selected = selectedKeys?.has(key) ?? false;
                  const active = activeKey !== undefined && activeKey === key;
                  return (
                    <tr
                      key={key}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={[
                        'transition-colors duration-150',
                        zebra && index % 2 === 1 ? 'bg-surface-2' : '',
                        onRowClick ? 'cursor-pointer' : '',
                        active ? '!bg-info-soft shadow-[inset_0_0_0_1.5px_var(--brand-line)]' : '',
                        selected ? '!bg-info-soft' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {selectable ? (
                        <td
                          className={cellPad}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-brand-600 cursor-pointer"
                            checked={selected}
                            onChange={() => toggleOne(key)}
                            aria-label="تحديد الصف"
                          />
                        </td>
                      ) : null}
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={`${cellPad} align-middle ${col.numeric ? 'text-end' : 'text-start'} ${
                            col.ltr ? 'ltr' : ''
                          }`}
                          style={
                            col.numeric
                              ? { fontVariantNumeric: 'tabular-nums', direction: 'ltr' }
                              : col.ltr
                                ? { direction: 'ltr' }
                                : undefined
                          }
                        >
                          {col.cell(row, index)}
                        </td>
                      ))}
                      {actions ? (
                        <td
                          className={`${cellPad} text-center`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <RowActions
                            items={actions(row)}
                            labels={{ open: 'فتح القائمة', close: 'إغلاق القائمة' }}
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
        </tbody>
        {footer && !loading && rows.length > 0 ? (
          <tfoot>
            <tr>
              {selectable ? <td className={`${cellPad} bg-surface-2 border-t-2 border-line`} /> : null}
              {footer.map((cell, i) => (
                <td
                  key={i}
                  className={`${cellPad} bg-surface-2 border-t-2 border-line font-bold ${
                    columns[i]?.numeric ? 'text-end' : 'text-start'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/** قائمة 3 نقاط لكل صف — تنقر وتغلق عند النقر خارجها. */
function RowActions({
  items,
  labels,
}: {
  items: Array<{ label: string; icon?: ReactNode; onClick: () => void; danger?: boolean }>;
  labels: { open: string; close: string };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="grid place-items-center size-7 rounded-lg text-muted hover:bg-surface-3 hover:text-ink-2 transition-colors duration-150"
        aria-label={open ? labels.close : labels.open}
        aria-expanded={open}
      >
        <span className="flex flex-col gap-[3px]">
          <span className="block w-1 h-1 rounded-full bg-current" />
          <span className="block w-1 h-1 rounded-full bg-current" />
          <span className="block w-1 h-1 rounded-full bg-current" />
        </span>
      </button>
      {open ? (
        <div
          className="absolute z-20 top-full end-0 mt-1 min-w-36 rounded-xl border border-line bg-surface shadow-4 overflow-hidden py-1"
          dir="rtl"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] font-semibold text-start transition-colors duration-150 ${
                item.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink-2 hover:bg-surface-2'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** شارة صغيرة للاستخدام داخل الخلايا. */
export function CellBadge({ tone = 'neutral', dot, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <Badge tone={tone} dot={dot}>
      {children}
    </Badge>
  );
}
