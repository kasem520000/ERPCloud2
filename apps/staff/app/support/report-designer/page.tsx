'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import {
  REPORT_GROUP_LABELS,
  REPORT_GROUP_ORDER,
  deleteReportLayout,
  fetchReportCatalog,
  fetchReportLayouts,
  formatCell,
  isNumericColumn,
  runReport,
  saveReportLayout,
  updateReportLayout,
  type ReportEntry,
  type ReportLayout,
  type ReportLayoutColumn,
  type ReportResult,
} from '../../../lib/reports';
import { useQuery } from '../../../lib/use-query';

/**
 * مصمم التقارير.
 *
 * The desktop designer let users author the report itself. On a shared service that is a
 * query editor pointed at other people's data, so this designer shapes **presentation**
 * only: which of the report's own columns appear, in what order, under what heading, and
 * which filters it opens with. The SQL stays on the server, which also means a saved
 * layout keeps working when the report behind it is improved.
 */
export default function ReportDesignerPage() {
  const catalog = useQuery<ReportEntry[]>(() => fetchReportCatalog(), []);
  const [reportKey, setReportKey] = useState('');
  const entry = (catalog.data ?? []).find((row) => row.key === reportKey);

  const layouts = useQuery<ReportLayout[]>(async () => (reportKey ? fetchReportLayouts(reportKey) : []), [reportKey]);

  const [editing, setEditing] = useState<ReportLayout | null>(null);
  const [name, setName] = useState('');
  const [titleAr, setTitleAr] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [columns, setColumns] = useState<ReportLayoutColumn[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  // A fresh report means a fresh sheet: every column visible, in catalog order.
  useEffect(() => {
    setEditing(null);
    setName('');
    setTitleAr('');
    setIsDefault(false);
    setFilters({});
    setPreview(null);
    setColumns((entry?.columns ?? []).map((column) => ({ key: column.key, labelAr: undefined, visible: true })));
  }, [entry]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, ReportEntry[]>();
    for (const row of catalog.data ?? []) {
      const bucket = buckets.get(row.group) ?? [];
      bucket.push(row);
      buckets.set(row.group, bucket);
    }
    return REPORT_GROUP_ORDER.filter((group) => buckets.has(group)).map((group) => ({ group, rows: buckets.get(group)! }));
  }, [catalog.data]);

  function load(layout: ReportLayout) {
    setEditing(layout);
    setName(layout.name);
    setTitleAr(layout.titleAr ?? '');
    setIsDefault(layout.isDefault);
    setFilters(layout.filters ?? {});
    const known = new Map((entry?.columns ?? []).map((column) => [column.key, column]));
    const chosen = (layout.columns ?? []).filter((column) => known.has(column.key));
    const missing = (entry?.columns ?? []).filter((column) => !chosen.some((entryColumn) => entryColumn.key === column.key));
    setColumns([...chosen, ...missing.map((column) => ({ key: column.key, labelAr: undefined, visible: false }))]);
    setPreview(null);
  }

  function move(index: number, direction: -1 | 1) {
    setColumns((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setNotice(undefined);
    try {
      const payload = { reportKey, name: name.trim(), titleAr: titleAr.trim() || null, columns, filters, isDefault };
      const saved = editing ? await updateReportLayout(editing.id, payload) : await saveReportLayout(payload);
      setEditing(saved);
      setNotice({ kind: 'ok', text: `تم حفظ التصميم «${saved.name}».` });
      layouts.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(layout: ReportLayout) {
    setBusy(true);
    setNotice(undefined);
    try {
      await deleteReportLayout(layout.id);
      if (editing?.id === layout.id) setEditing(null);
      setNotice({ kind: 'ok', text: `تم حذف التصميم «${layout.name}».` });
      layouts.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!editing) {
      setNotice({ kind: 'info', text: 'احفظ التصميم أولاً ثم اعرض المعاينة.' });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      setPreview(await runReport(reportKey, { ...filters, layout: editing.id }));
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const visibleCount = columns.filter((column) => column.visible).length;

  return (
    <Screen
      title="مصمم التقارير"
      subtitle="تصاميم محفوظة لتقارير النظام: اختيار الأعمدة وترتيبها وتسميتها، ومرشحات افتراضية."
      crumbs={['الدعم الفني']}
      actions={reportKey ? <Link className="btn" href={`/reports/${reportKey}`}>فتح التقرير</Link> : undefined}
    >
      <div className="card">
        <p className="alert info">
          التصميم هنا يغيّر <strong>طريقة العرض</strong> فقط: الأعمدة وترتيبها وعناوينها والمرشحات الافتراضية.
          استعلام التقرير نفسه محفوظ في الخادم ولا يُكتب من الواجهة، فتبقى الأرقام واحدة مهما اختلف التصميم.
        </p>
        <label className="field wide">
          <span>التقرير</span>
          <select className="input" value={reportKey} onChange={(event) => setReportKey(event.target.value)}>
            <option value="">— اختر تقريراً —</option>
            {grouped.map((bucket) => (
              <optgroup key={bucket.group} label={REPORT_GROUP_LABELS[bucket.group] ?? bucket.group}>
                {bucket.rows.map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.titleAr}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <Notice notice={notice} />
      </div>

      {entry && (
        <div className="grid cols-2">
          <section className="card">
            <h3>التصاميم المحفوظة</h3>
            {(layouts.data ?? []).length === 0 ? (
              <p className="muted">لا يوجد تصميم محفوظ لهذا التقرير — الأعمدة الافتراضية مستخدمة حالياً.</p>
            ) : (
              <ul className="chips" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {(layouts.data ?? []).map((layout) => (
                  <li key={layout.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      {layout.name} {layout.isDefault && <span className="badge">افتراضي</span>}
                    </span>
                    <span className="row">
                      <button type="button" className="btn sm" onClick={() => load(layout)}>
                        تحرير
                      </button>
                      <button type="button" className="btn sm danger" disabled={busy} onClick={() => remove(layout)}>
                        حذف
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h3>{editing ? `تحرير: ${editing.name}` : 'تصميم جديد'}</h3>
            <div className="form-grid">
              <label className="field">
                <span>اسم التصميم</span>
                <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="مختصر للإدارة" />
              </label>
              <label className="field">
                <span>عنوان بديل (اختياري)</span>
                <input className="input" value={titleAr} onChange={(event) => setTitleAr(event.target.value)} placeholder={entry.titleAr} />
              </label>
            </div>
            <label className="row" style={{ gap: 8, marginTop: 8 }}>
              <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
              <span>اجعله التصميم الافتراضي لهذا التقرير</span>
            </label>
            {entry.params.length > 0 && (
              <>
                <p className="muted small" style={{ marginTop: 10 }}>
                  مرشحات افتراضية (تُطبّق عند فتح التقرير ويمكن للمستخدم تغييرها):
                </p>
                <div className="form-grid">
                  {entry.params
                    .filter((param) => param.kind === 'date' || param.kind === 'select')
                    .map((param) => (
                      <label className="field" key={param.name}>
                        <span>{param.labelAr}</span>
                        {param.kind === 'date' ? (
                          <input
                            className="input"
                            type="date"
                            value={filters[param.name] ?? ''}
                            onChange={(event) => setFilters({ ...filters, [param.name]: event.target.value })}
                          />
                        ) : (
                          <select
                            className="input"
                            value={filters[param.name] ?? ''}
                            onChange={(event) => setFilters({ ...filters, [param.name]: event.target.value })}
                          >
                            <option value="">الكل</option>
                            {(param.options ?? []).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.labelAr}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                    ))}
                </div>
              </>
            )}
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button type="button" className="btn primary" disabled={busy || name.trim().length < 2 || visibleCount === 0} onClick={save}>
                {editing ? 'حفظ التعديلات' : 'حفظ التصميم'}
              </button>
              <button type="button" className="btn" disabled={busy || !editing} onClick={runPreview}>
                معاينة
              </button>
              {editing && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditing(null);
                    setName('');
                    setTitleAr('');
                    setIsDefault(false);
                    setPreview(null);
                    setColumns((entry.columns ?? []).map((column) => ({ key: column.key, labelAr: undefined, visible: true })));
                  }}
                >
                  تصميم جديد
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {entry && (
        <section className="card">
          <h3>الأعمدة ({visibleCount} ظاهر من {columns.length})</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ظاهر</th>
                  <th>العمود</th>
                  <th>عنوان بديل</th>
                  <th>الترتيب</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((column, index) => {
                  const source = entry.columns.find((entryColumn) => entryColumn.key === column.key);
                  return (
                    <tr key={column.key}>
                      <td>
                        <input
                          type="checkbox"
                          checked={column.visible}
                          onChange={(event) =>
                            setColumns((current) => current.map((row, position) => (position === index ? { ...row, visible: event.target.checked } : row)))
                          }
                        />
                      </td>
                      <td>{source?.labelAr ?? column.key}</td>
                      <td>
                        <input
                          className="input"
                          value={column.labelAr ?? ''}
                          placeholder={source?.labelAr ?? ''}
                          onChange={(event) =>
                            setColumns((current) => current.map((row, position) => (position === index ? { ...row, labelAr: event.target.value || undefined } : row)))
                          }
                        />
                      </td>
                      <td className="row">
                        <button type="button" className="btn sm" disabled={index === 0} onClick={() => move(index, -1)}>
                          ↑
                        </button>
                        <button type="button" className="btn sm" disabled={index === columns.length - 1} onClick={() => move(index, 1)}>
                          ↓
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {preview && (
        <section className="card">
          <h3>معاينة: {preview.titleAr}</h3>
          <p className="muted small">{preview.rowCount} سطراً</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {preview.columns.map((column) => (
                    <th key={column.key}>{column.labelAr}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 15).map((row, index) => (
                  <tr key={`${preview.key}-${index}`}>
                    {preview.columns.map((column) => (
                      <td key={column.key} className={isNumericColumn(column) ? 'num' : undefined}>
                        {formatCell(row[column.key] ?? '', column.type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Screen>
  );
}
