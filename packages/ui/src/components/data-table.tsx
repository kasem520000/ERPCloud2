'use client';

import { ChevronDown, ChevronUp, ChevronsUpDown, Inbox } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';

import { Skeleton } from './skeleton';

/**
 * DataTable — the grid every list in staff and platform-admin sits on.
 *
 * Design v3 §5, in the order a dense back office needs it:
 *   • **sticky header** — a 60-row table keeps its column names;
 *   • **sort + filter** — client-side, driven by the caller's `sort` state;
 *   • **column chooser persisted in `localStorage`** — one key per table,
 *     namespaced by `storageKey`, so hiding a column survives a reload and a
 *     theme switch alike (and never leaks between two tables);
 *   • **pagination** — page size + «n من m», with the desktop's «موضع …» shape;
 *   • **four honest states** — empty, loading, error and *forbidden*, none of
 *     which is ever a blank area (§6.1: "بلا صمت أبداً").
 *
 * Zebra and hover are applied through tokens, so the two striping patterns
 * look identical in light and dark instead of one disappearing.
 */

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** End-align with tabular figures. */
  numeric?: boolean;
  /** Force LTR for codes, serials and amounts. */
  ltr?: boolean;
  grow?: boolean;
  width?: number | string;
  sortable?: boolean;
  /** A column can be hidden by the visitor. */
  hideable?: boolean;
  /** Hidden by default (a wide, rarely-read column). */
  defaultHidden?: boolean;
};

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

export type TableState =
  | { kind: 'ready' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden'; message?: string };

export type DataTableProps<T> = {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  state?: TableState;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  activeKey?: string;
  /** Sticky footer cells in column order — totals. */
  footer?: ReactNode[];
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  sortable?: boolean;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  actions?: (row: T) => Array<{ label: string; icon?: ReactNode; onClick: () => void; danger?: boolean }>;
  dense?: boolean;
  zebra?: boolean;
  /** Enables the column chooser and names its `localStorage` entry. */
  storageKey?: string;
  pageSize?: number;
  /** Extra class on the scrolling wrapper. */
  className?: string;
  labels?: Partial<TableLabels>;
};

export type TableLabels = {
  selectAll: string;
  selectRow: string;
  openActions: string;
  closeActions: string;
  empty: string;
  error: string;
  forbidden: string;
  loading: string;
  columns: string;
  page: string;
  previous: string;
  next: string;
};

const DEFAULT_LABELS: TableLabels = {
  selectAll: 'تحديد الكل',
  selectRow: 'تحديد الصف',
  openActions: 'فتح القائمة',
  closeActions: 'إغلاق القائمة',
  empty: 'لا توجد سجلات لعرضها',
  error: 'تعذّر تحميل البيانات',
  forbidden: 'لا تملك صلاحية عرض هذه الشاشة',
  loading: 'جارٍ التحميل…',
  columns: 'الأعمدة',
  page: 'صفحة',
  previous: 'السابق',
  next: 'التالي',
};

/** Prefix for every column-chooser key — one namespace, never per-app forks. */
const STORAGE_PREFIX = 'erp.table.columns.';

function readHidden(storageKey: string | undefined, columns: Array<Column<never>>): Set<string> {
  const fallback = new Set(
    columns.filter((column) => column.defaultHidden).map((column) => column.key),
  );
  if (!storageKey) return fallback;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const keys = parsed.filter((entry): entry is string => typeof entry === 'string');
    return new Set(keys);
  } catch {
    return fallback;
  }
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  state = { kind: 'ready' },
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
  storageKey,
  pageSize,
  className = '',
  labels: labelOverrides,
}: DataTableProps<T>) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [hidden, setHidden] = useState<Set<string>>(() =>
    readHidden(storageKey, columns as Array<Column<never>>),
  );
  const [page, setPage] = useState(0);
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(
        `${STORAGE_PREFIX}${storageKey}`,
        JSON.stringify([...hidden]),
      );
    } catch {
      /* a blocked storage must not break the chooser */
    }
  }, [hidden, storageKey]);

  useEffect(() => {
    if (!chooserOpen) return;
    function onDown(event: MouseEvent) {
      if (chooserRef.current && !chooserRef.current.contains(event.target as Node)) {
        setChooserOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setChooserOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [chooserOpen]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => !hidden.has(column.key)),
    [columns, hidden],
  );

  const hideable = useMemo(() => columns.filter((column) => column.hideable !== false), [columns]);

  const cellPad = dense ? 'px-2.5 py-1.5' : 'px-3 py-2.5';
  const allSelected =
    selectable && rows.length > 0 && rows.every((row, index) => selectedKeys?.has(rowKey(row, index)));
  const someSelected =
    selectable && rows.some((row, index) => selectedKeys?.has(rowKey(row, index))) && !allSelected;

  const paged = useMemo(() => {
    if (!pageSize || pageSize <= 0) return { items: rows, pages: 1, current: 0 };
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const current = Math.min(page, pages - 1);
    return { items: rows.slice(current * pageSize, current * pageSize + pageSize), pages, current };
  }, [rows, pageSize, page]);

  const items = state.kind === 'ready' ? paged.items : [];

  const toggleAll = useCallback(() => {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (allSelected) for (const [index, row] of rows.entries()) next.delete(rowKey(row, index));
    else for (const [index, row] of rows.entries()) next.add(rowKey(row, index));
    onSelectionChange(next);
  }, [allSelected, onSelectionChange, rows, rowKey, selectedKeys]);

  const toggleOne = useCallback(
    (key: string) => {
      if (!onSelectionChange) return;
      const next = new Set(selectedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange(next);
    },
    [onSelectionChange, selectedKeys],
  );

  const toggleSort = useCallback(
    (key: string) => {
      if (!onSortChange) return;
      if (sort?.key !== key) onSortChange({ key, dir: 'asc' });
      else if (sort.dir === 'asc') onSortChange({ key, dir: 'desc' });
      else onSortChange(null);
    },
    [onSortChange, sort],
  );

  const headerCell = `sticky top-0 z-10 bg-surface-2 font-bold text-[11px] tracking-wide text-muted whitespace-nowrap ${cellPad}`;

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="w-full overflow-auto rounded-lg border border-line bg-surface shadow-1">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {selectable ? (
                <th className={cn(headerCell, 'w-10')}>
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-brand"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    aria-label={labels.selectAll}
                  />
                </th>
              ) : null}
              {visibleColumns.map((column) => (
                <th
                  key={column.key}
                  style={column.width ? { width: column.width } : undefined}
                  className={cn(
                    headerCell,
                    column.numeric ? 'text-end' : 'text-start',
                    column.grow && 'w-full',
                  )}
                >
                  {column.sortable && sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={cn(
                        'inline-flex items-center gap-1 transition-colors duration-150 hover:text-ink',
                        sort?.key === column.key && 'text-brand',
                      )}
                    >
                      {column.header}
                      {sort?.key === column.key ? (
                        sort.dir === 'asc' ? (
                          <ChevronUp size={13} aria-hidden />
                        ) : (
                          <ChevronDown size={13} aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDown size={13} className="opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
              {actions ? <th className={cn(headerCell, 'w-10')} /> : null}
            </tr>
          </thead>

          <tbody>
            {state.kind === 'loading'
              ? Array.from({ length: 6 }).map((_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`} className={zebra && rowIndex % 2 === 1 ? 'bg-surface-2' : ''}>
                    {selectable ? (
                      <td className={cellPad}>
                        <Skeleton className="size-4" />
                      </td>
                    ) : null}
                    {visibleColumns.map((column) => (
                      <td key={column.key} className={cellPad}>
                        <Skeleton className="h-3.5 w-3/4" />
                      </td>
                    ))}
                    {actions ? (
                      <td className={cellPad}>
                        <Skeleton className="size-6" />
                      </td>
                    ) : null}
                  </tr>
                ))
              : state.kind === 'error'
                ? [
                    <tr key="error">
                      <td colSpan={visibleColumns.length + (selectable ? 1 : 0) + (actions ? 1 : 0)}>
                        <div className="grid place-items-center gap-2 px-6 py-12 text-center">
                          <span className="grid size-12 place-items-center rounded-lg bg-danger-soft text-danger">
                            <Inbox size={24} aria-hidden />
                          </span>
                          <p className="m-0 text-[13.5px] font-bold text-ink">
                            {state.message || labels.error}
                          </p>
                          <p className="m-0 max-w-sm text-[12.5px] text-muted">
                            تحقّق من الاتصال ثم أعد المحاولة. الرسالة أعلاه كما وردت من الخدمة.
                          </p>
                        </div>
                      </td>
                    </tr>,
                  ]
                : state.kind === 'forbidden'
                  ? [
                      <tr key="forbidden">
                        <td colSpan={visibleColumns.length + (selectable ? 1 : 0) + (actions ? 1 : 0)}>
                          <div className="grid place-items-center gap-2 px-6 py-12 text-center">
                            <span className="grid size-12 place-items-center rounded-lg bg-warn-soft text-warn">
                              <Inbox size={24} aria-hidden />
                            </span>
                            <p className="m-0 text-[13.5px] font-bold text-ink">
                              {state.message || labels.forbidden}
                            </p>
                            <p className="m-0 max-w-sm text-[12.5px] text-muted">
                              الصلاحية تُمنح من «⚙️ تعديل الصلاحيات» — وهذا ما تقوله الخدمة، لا ما
                              تخفيه الواجهة.
                            </p>
                          </div>
                        </td>
                      </tr>,
                    ]
                  : items.length === 0
                    ? [
                        <tr key="empty">
                          <td colSpan={visibleColumns.length + (selectable ? 1 : 0) + (actions ? 1 : 0)}>
                            <div className="grid place-items-center gap-2 px-6 py-12 text-center">
                              <span className="grid size-12 place-items-center rounded-lg bg-surface-3 text-muted">
                                <Inbox size={24} strokeWidth={1.5} aria-hidden />
                              </span>
                              <p className="m-0 text-[13.5px] font-bold text-ink">
                                {empty ?? labels.empty}
                              </p>
                            </div>
                          </td>
                        </tr>,
                      ]
                    : items.map((row, index) => {
                        const key = rowKey(row, index);
                        const selected = selectedKeys?.has(key) ?? false;
                        const active = activeKey !== undefined && activeKey === key;
                        return (
                          <tr
                            key={key}
                            onClick={onRowClick ? () => onRowClick(row) : undefined}
                            className={cn(
                              'transition-colors duration-150',
                              zebra && index % 2 === 1 && 'bg-surface-2',
                              onRowClick && 'cursor-pointer',
                              active && 'bg-brand-soft shadow-[inset_0_0_0_1.5px_var(--brand-line)]',
                              selected && !active && 'bg-brand-soft/60',
                            )}
                          >
                            {selectable ? (
                              <td
                                className={cellPad}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  className="size-4 cursor-pointer accent-brand"
                                  checked={selected}
                                  onChange={() => toggleOne(key)}
                                  aria-label={labels.selectRow}
                                />
                              </td>
                            ) : null}
                            {visibleColumns.map((column) => (
                              <td
                                key={column.key}
                                className={cn(
                                  cellPad,
                                  'align-middle',
                                  column.numeric ? 'text-end' : 'text-start',
                                  column.ltr && 'ltr',
                                )}
                                style={
                                  column.numeric
                                    ? { fontVariantNumeric: 'tabular-nums' }
                                    : undefined
                                }
                              >
                                {column.cell(row, index)}
                              </td>
                            ))}
                            {actions ? (
                              <td className={cn(cellPad, 'text-center')} onClick={(event) => event.stopPropagation()}>
                                <RowActions
                                  items={actions(row)}
                                  labels={{ open: labels.openActions, close: labels.closeActions }}
                                />
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
          </tbody>

          {footer && state.kind === 'ready' && items.length > 0 ? (
            <tfoot>
              <tr>
                {selectable ? <td className={cn(cellPad, 'border-t-2 border-line-strong bg-surface-2')} /> : null}
                {footer.map((cell, index) => (
                  <td
                    key={index}
                    className={cn(
                      cellPad,
                      'border-t-2 border-line-strong bg-surface-2 font-bold text-ink',
                      visibleColumns[index]?.numeric ? 'num text-end' : 'text-start',
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <div className="flex items-center gap-2">
          {pageSize && pageSize > 0 && paged.pages > 1 ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={paged.current === 0}
                onClick={() => setPage(paged.current - 1)}
                className="h-7 rounded-sm border border-line bg-surface px-2 font-bold transition-colors duration-150 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {labels.previous}
              </button>
              <span className="num px-1">
                {labels.page} {paged.current + 1} / {paged.pages}
              </span>
              <button
                type="button"
                disabled={paged.current >= paged.pages - 1}
                onClick={() => setPage(paged.current + 1)}
                className="h-7 rounded-sm border border-line bg-surface px-2 font-bold transition-colors duration-150 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {labels.next}
              </button>
            </div>
          ) : (
            <span className="num">{rows.length}</span>
          )}
        </div>

        {storageKey && hideable.length > 1 ? (
          <div className="relative" ref={chooserRef}>
            <button
              type="button"
              onClick={() => setChooserOpen((value) => !value)}
              aria-expanded={chooserOpen}
              className="h-7 rounded-sm border border-line bg-surface px-2 font-bold text-ink transition-colors duration-150 hover:bg-surface-3"
            >
              {labels.columns}
            </button>
            {chooserOpen ? (
              <div className="absolute end-0 bottom-full z-30 mb-1 max-h-64 w-52 overflow-auto rounded-md border border-line bg-raised p-1.5 shadow-4">
                {hideable.map((column) => (
                  <label
                    key={column.key}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[12.5px] text-ink transition-colors duration-150 hover:bg-surface-3"
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-brand"
                      checked={!hidden.has(column.key)}
                      onChange={(event) =>
                        setHidden((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.delete(column.key);
                          else next.add(column.key);
                          return next;
                        })
                      }
                    />
                    <span className="truncate">{column.header}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The per-row 3-dot menu — opens on click, closes on outside click or Escape. */
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
        aria-label={open ? labels.close : labels.open}
        aria-expanded={open}
        className="grid size-7 place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-3 hover:text-ink"
      >
        <span className="flex flex-col gap-[3px]" aria-hidden>
          <span className="block size-1 rounded-full bg-current" />
          <span className="block size-1 rounded-full bg-current" />
          <span className="block size-1 rounded-full bg-current" />
        </span>
      </button>
      {open ? (
        <div
          className="absolute end-0 top-full z-20 mt-1 min-w-36 overflow-hidden rounded-md border border-line bg-raised py-1 shadow-4"
          role="menu"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-start text-[12.5px] font-semibold transition-colors duration-150',
                item.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-surface-3',
              )}
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
