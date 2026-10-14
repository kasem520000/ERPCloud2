'use client';

import { useState, type ReactNode } from 'react';

import { ApiError } from '../lib/api';
import type { QueryState } from '../lib/use-query';

import { DataTable, Notice, QueryView, type Column } from './data-view';
import { Screen } from './screen';
import { StatTiles, type Tone } from './ui';

/** One KPI tile above the table. */
export type Tile = { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone };


/**
 * A directory screen = a table plus an inline "new record" form.
 *
 * Two thirds of the menu tree (warehouses, categories, units, parties, departments,
 * jobs, employees, vessels…) are exactly that. Describing them declaratively keeps the
 * pages short enough to read in one screen and makes every one of them behave the same:
 * same states, same validation feedback, same reload-after-save.
 */
export type FieldSpec = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea';
  options?: Array<{ id: string; label: string }>;
  required?: boolean;
  ltr?: boolean;
  placeholder?: string;
  hint?: string;
  /** Full-width row in the form grid. */
  wide?: boolean;
};

export type FormValues = Record<string, string | boolean>;

/**
 * Editing and deleting are opt-in: a screen passes `toForm` + `onUpdate` when its records
 * are correctable, and `onDelete` when they can be withdrawn. Screens that only ever
 * append (stock movements, notes, adjustments) simply omit them and keep behaving as
 * before — a ledger row is not a record you fix, it is a record you reverse.
 */
export type RowActions<T> = {
  toForm: (row: T) => FormValues;
  onUpdate: (row: T, values: FormValues) => Promise<unknown>;
};

export function Directory<T>({
  title,
  subtitle,
  crumbs,
  query,
  columns,
  rowKey,
  empty,
  emptyDetail,
  canCreate = true,
  createLabel = 'إضافة جديد',
  formTitle,
  fields,
  initial,
  onCreate,
  edit,
  onDelete,
  deleteLabel = 'حذف',
  confirmDelete,
  rowLabel,
  successText,
  blocked,
  toolbar,
  tiles,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  crumbs?: string[];
  query: QueryState<T[]>;
  columns: Array<Column<T>>;
  rowKey: (row: T, index: number) => string;
  empty?: string;
  emptyDetail?: string;
  canCreate?: boolean;
  createLabel?: string;
  formTitle?: string;
  fields: FieldSpec[];
  initial?: FormValues;
  onCreate: (values: FormValues) => Promise<unknown>;
  /** Enables the per-row "تعديل" button and reuses the same form for editing. */
  edit?: RowActions<T>;
  /** Enables the per-row "حذف" button. */
  onDelete?: (row: T) => Promise<unknown>;
  deleteLabel?: string;
  /** Confirmation question; defaults to a generic one built from `rowLabel`. */
  confirmDelete?: (row: T) => string;
  /** How to name a single row in confirmations and success messages. */
  rowLabel?: (row: T) => string;
  successText?: (values: FormValues) => string;
  /** Rendered instead of the submit button when a prerequisite is missing. */
  blocked?: string;
  toolbar?: ReactNode;
  /** KPI tiles rendered above the table — counts the screen can derive from its rows. */
  tiles?: Tile[];
  /** Totals row for the table, computed from the rows on screen. */
  footer?: (rows: T[]) => ReactNode[];
  /** Extra content rendered between the form and the table. */
  children?: ReactNode;
}) {
  const blank: FormValues = Object.fromEntries(fields.map((field) => [field.name, field.type === 'checkbox' ? false : '']));
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormValues>({ ...blank, ...initial });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<T | undefined>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  function reset() {
    setEditing(undefined);
    setValues({ ...blank, ...initial });
  }

  function startEdit(row: T) {
    if (!edit) return;
    setEditing(row);
    // Whatever the card does not expose keeps its blank default, so a partially mapped
    // row can never send stale values from a previously edited record.
    setValues({ ...blank, ...edit.toForm(row) });
    setNotice(undefined);
    setOpen(true);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (editing && edit) {
        await edit.onUpdate(editing, values);
        setNotice({ kind: 'ok', text: 'تم حفظ التعديل.' });
      } else {
        await onCreate(values);
        setNotice({ kind: 'ok', text: successText ? successText(values) : 'تم الحفظ.' });
      }
      reset();
      query.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: T) {
    if (!onDelete) return;
    const question = confirmDelete ? confirmDelete(row) : `هل تريد حذف ${rowLabel ? rowLabel(row) : 'هذا السجل'}؟`;
    if (typeof window !== 'undefined' && !window.confirm(question)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await onDelete(row);
      setNotice({ kind: 'ok', text: 'تم الحذف.' });
      if (editing) reset();
      query.reload();
    } catch (error) {
      // The API refuses to delete anything that documents already point at, and the
      // reason it gives ("used on invoices", "has sub-accounts") is the useful part.
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const rowColumns: Array<Column<T>> =
    edit || onDelete
      ? [
          ...columns,
          {
            key: '__actions',
            header: '',
            cell: (row: T) => (
              <span className="row">
                {edit && (
                  <button className="btn sm" type="button" onClick={() => startEdit(row)} disabled={busy}>
                    تعديل
                  </button>
                )}
                {onDelete && (
                  <button className="btn sm danger" type="button" onClick={() => void remove(row)} disabled={busy}>
                    {deleteLabel}
                  </button>
                )}
              </span>
            ),
          },
        ]
      : columns;

  return (
    <Screen
      title={title}
      subtitle={subtitle}
      crumbs={crumbs}
      actions={
        canCreate ? (
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              if (open) reset();
              setOpen(!open);
            }}
          >
            {open ? 'إغلاق' : createLabel}
          </button>
        ) : null
      }
    >
      {open && (
        <form className="card" onSubmit={submit}>
          <h2>{editing ? `تعديل ${rowLabel ? rowLabel(editing) : 'السجل'}` : (formTitle ?? createLabel)}</h2>
          {blocked && !editing && <p className="alert warn">{blocked}</p>}
          <FormFields fields={fields} values={values} onChange={setValues} />
          <Notice notice={notice} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || (Boolean(blocked) && !editing)}>
              {busy ? 'جارٍ الحفظ…' : editing ? 'حفظ التعديل' : 'حفظ'}
            </button>
            {editing && (
              <button className="btn" type="button" onClick={reset} disabled={busy}>
                إلغاء التعديل
              </button>
            )}
          </div>
        </form>
      )}

      {toolbar && <div className="card toolbar">{toolbar}</div>}
      {children}
      {tiles && tiles.length > 0 && (
        <StatTiles>
          {tiles.map((tile) => (
            <div className={`tile${tile.tone && tile.tone !== 'default' ? ` ${tile.tone}` : ''}`} key={tile.label}>
              <span className="tile-label">{tile.label}</span>
              <span className="tile-value">{tile.value}</span>
              {tile.hint ? <span className="tile-hint">{tile.hint}</span> : null}
            </div>
          ))}
        </StatTiles>
      )}

      {!open && notice && <Notice notice={notice} />}

      <QueryView query={query} empty={empty} emptyDetail={emptyDetail}>
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={rowKey}
            columns={rowColumns}
            footer={footer ? footer(rows) : undefined}
          />
        )}
      </QueryView>
    </Screen>
  );
}

/** The same field renderer, also usable by hand-written document screens. */
export function FormFields({
  fields,
  values,
  onChange,
}: {
  fields: FieldSpec[];
  values: FormValues;
  onChange: (next: FormValues) => void;
}) {
  const update = (name: string, value: string | boolean) => onChange({ ...values, [name]: value });

  return (
    <div className="form-grid">
      {fields.map((field) => {
        const value = values[field.name];
        if (field.type === 'checkbox') {
          return (
            <label className="field" key={field.name}>
              <span>{field.label}</span>
              <span className="row">
                <input type="checkbox" checked={Boolean(value)} onChange={(event) => update(field.name, event.target.checked)} />
                {field.hint && <span className="muted small">{field.hint}</span>}
              </span>
            </label>
          );
        }
        return (
          <label className="field" key={field.name} style={field.wide ? { gridColumn: '1 / -1' } : undefined}>
            <span>
              {field.label}
              {field.required ? ' *' : ''}
            </span>
            {field.type === 'select' ? (
              <select
                className="input"
                value={String(value ?? '')}
                required={field.required}
                onChange={(event) => update(field.name, event.target.value)}
              >
                <option value="">— اختر —</option>
                {(field.options ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'textarea' ? (
              <textarea
                className="input"
                rows={3}
                value={String(value ?? '')}
                required={field.required}
                placeholder={field.placeholder}
                onChange={(event) => update(field.name, event.target.value)}
              />
            ) : (
              <input
                className="input"
                type={field.type === 'date' ? 'date' : 'text'}
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                dir={field.ltr || field.type === 'number' || field.type === 'date' ? 'ltr' : undefined}
                value={String(value ?? '')}
                required={field.required}
                placeholder={field.placeholder}
                onChange={(event) => update(field.name, event.target.value)}
              />
            )}
            {field.hint && <span className="muted small">{field.hint}</span>}
          </label>
        );
      })}
    </div>
  );
}
