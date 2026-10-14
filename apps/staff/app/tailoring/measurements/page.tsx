'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiFetch, apiList, apiPatch, apiPost } from '../../../lib/api';
import { type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 📏 إدارة قياسات العملاء — `Form_WPF/frmMeasurements.xaml` («إدارة قياسات العملاء»)
 * with the card of `Form_WPF/frmMeasurementDetails.xaml` («📏 بيانات القياس»).
 *
 * The window is a search box over one grid:
 *
 *   • «البحث برقم الجوال أو الاسم:» — `txtSearch`, watermarked «🔍 الجوال أو
 *     الاسم...», searched by «🔍 بحث» or by pressing Return (`txtSearch_KeyDown`).
 *     The search resolves a **عميل** (`mobile LIKE @Search OR name LIKE @Search`,
 *     `TOP 10 … ORDER BY name`, first row wins), shows «العميل: …» «الجوال: …»
 *     (`pnlCustomerInfo`) and lists that عميل's قياسات.
 *   • «📋 قياسات العميل» — `👤 اسم صاحب القياس · 📅 التاريخ · 📝 الملاحظات ·
 *     📐 عدد المقاسات · العميل`, sorted `MeasurementDate DESC`; a double-click on a row
 *     is «✏️ تعديل القياس» (`gridViewMeasurements_DoubleClick`).
 *   • The buttons — `➕ إضافة قياس جديد · ✏️ تعديل القياس · 🗑️ حذف القياس · ✖ إغلاق` —
 *     and their refusals («الرجاء البحث عن عميل أولًا» · «الرجاء اختيار قياس للتعديل» ·
 *     «الرجاء اختيار قياس للحذف» · «هل أنت متأكد من حذف هذا القياس؟») are the API's.
 *
 * The card is `frmMeasurementDetails`: «👤 اسم صاحب القياس *», «📐 قيم القياسات» — a row
 * per **active** خاصية, built at runtime from `MeasurementAttributes WHERE IsActive = 1
 * ORDER BY DisplayOrder`, each with the unit «سم» — and «📝 ملاحظات». Its two refusals
 * («الرجاء إدخال اسم صاحب القياس» · «الرجاء إدخال قياس واحد على الأقل») come back in
 * those words, and saving is one transaction that writes only values greater than zero.
 *
 * 📏 «إدارة خصائص القياسات» (`frmMeasurementAttributes`) is its own window in the
 * desktop, and its own screen here: /tailoring/measurements/attributes.
 */
type Attribute = {
  id: string;
  nameAr: string;
  displayOrder: number;
  active: boolean;
  statusText: string;
  version: number;
};

type MeasurementValue = { attributeId: string; attributeName: string; value: string; displayOrder: number };

type Measurement = {
  id: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  kind: string;
  name: string | null;
  displayName: string;
  measurementDate: string;
  notes: string | null;
  active: boolean;
  measurementCount: number;
  values: MeasurementValue[];
  measurements: Record<string, string>;
  createdAt: string;
  version: number;
};

type Draft = {
  id?: string;
  version?: number;
  partyId: string;
  name: string;
  measurementDate: string;
  notes: string;
  values: Record<string, string>;
};

const today = () => new Date().toISOString().slice(0, 10);

const emptyDraft = (partyId: string): Draft => ({
  partyId,
  name: '',
  measurementDate: today(),
  notes: '',
  values: {},
});

const draftOf = (measurement: Measurement): Draft => ({
  id: measurement.id,
  version: measurement.version,
  partyId: measurement.partyId,
  name: measurement.name ?? '',
  measurementDate: measurement.measurementDate,
  notes: measurement.notes ?? '',
  values: Object.fromEntries(measurement.values.map((value) => [value.attributeId, value.value])),
});

function TailoringMeasurements() {
  const { can } = useSession();
  const canManage = can('tailoring.manage');

  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const attributes = useQuery<Attribute[]>(() => apiList<Attribute>('/tailoring/measurement-attributes'), []);
  const customers = useQuery<Party[]>(() => apiList<Party>('/parties?kind=customer'), []);

  const measurements = useQuery<{ rows: Measurement[]; total: number; customer: Party | null }>(() => {
    const params = new URLSearchParams();
    if (applied !== null) params.set('search', applied);
    const query = params.toString();
    return apiFetch<{ data: Measurement[]; meta: { total: number; customer: Party | null } }>(
      `/tailoring/measurements${query ? `?${query}` : ''}`,
    ).then((body) => ({
      rows: body.data ?? [],
      total: body.meta?.total ?? (body.data ?? []).length,
      customer: body.meta?.customer ?? null,
    }));
  }, [applied]);

  const rows = measurements.data?.rows ?? [];
  const activeAttributes = (attributes.data ?? []).filter((attribute) => attribute.active);
  const selectedCustomer = (customers.data ?? []).find((party) => party.id === (draft?.partyId ?? ''));

  const setField = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        partyId: draft.partyId,
        name: draft.name,
        measurementDate: draft.measurementDate,
        notes: draft.notes || null,
        values: activeAttributes
          .filter((attribute) => draft.values[attribute.id])
          .map((attribute) => ({ attributeId: attribute.id, value: draft.values[attribute.id] })),
      };
      const saved = draft.id
        ? await apiPatch<{ displayName: string }>(`/tailoring/measurements/${draft.id}`, {
            ...payload,
            ...(draft.version ? { version: draft.version } : {}),
          })
        : await apiPost<{ displayName: string }>('/tailoring/measurements', payload);
      setNotice(`تم الحفظ بنجاح — ${saved.displayName ?? ''}`.trim());
      setDraft(null);
      measurements.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(measurement: Measurement) {
    // «هل أنت متأكد من حذف هذا القياس؟» — «تأكيد الحذف».
    if (!window.confirm(`هل أنت متأكد من حذف هذا القياس؟\n\n${measurement.displayName}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/tailoring/measurements/${measurement.id}`);
      setNotice('تم الحذف بنجاح');
      measurements.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const searchNow = () => setApplied(search);
  const showAll = () => {
    setSearch('');
    setApplied(null);
  };

  return (
    <Screen
      title="📏 إدارة قياسات العملاء"
      subtitle="قياس كل عميل باسمه وتاريخه وملاحظاته، وقيمه كما يحدّدها ترتيب «خصائص القياسات» — وما يُخاط اليوم يُقاس على هذا."
      crumbs={['التفصيل', 'القياسات']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Link className="btn" href="/tailoring/measurements/attributes">
            📏 خصائص القياسات
          </Link>
          {canManage && (
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                // «➕ إضافة قياس جديد» — the desktop refuses when no عميل was searched for.
                if (!measurements.data?.customer) {
                  setError('الرجاء البحث عن عميل أولًا');
                  return;
                }
                setDraft(emptyDraft(measurements.data.customer.id));
              }}
            >
              ➕ إضافة قياس جديد
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 260, flex: 1 }}>
            <span>البحث برقم الجوال أو الاسم:</span>
            <input
              className="input"
              value={search}
              placeholder="🔍 الجوال أو الاسم..."
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                // `txtSearch_KeyDown` — Return searches, as «🔍 بحث» does.
                if (event.key === 'Enter') searchNow();
              }}
            />
          </label>
          <button className="btn primary" type="button" onClick={searchNow}>
            🔍 بحث
          </button>
          {applied !== null && (
            <button className="btn" type="button" onClick={showAll}>
              📋 كل القياسات
            </button>
          )}
        </div>
        {measurements.data?.customer && (
          // `pnlCustomerInfo` — «العميل: …» «الجوال: …», shown only once a عميل is picked.
          <div className="row" style={{ marginTop: 8, gap: 16, fontWeight: 700 }}>
            <span>👤 العميل: {measurements.data.customer.name}</span>
            <span dir="ltr">📞 الجوال: {measurements.data.customer.phone || '—'}</span>
          </div>
        )}
      </div>

      {measurements.status === 'loading' && <Loading rows={6} />}
      {measurements.status === 'forbidden' && <Forbidden />}
      {measurements.status === 'error' && <ErrorBox message={measurements.error} onRetry={measurements.reload} />}
      {measurements.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📋 قياسات العميل</span>
            <span className="muted">عدد السجلات: {measurements.data?.total ?? rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty
              title="لا توجد قياسات"
              detail={
                measurements.data?.customer
                  ? `لا قياس محفوظ لـ«${measurements.data.customer.name}». ابدأ بـ «➕ إضافة قياس جديد».`
                  : 'ابحث بجوال عميل أو اسمه لعرض قياساته، أو أضف قياساً من «كل القياسات».'
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>👤 اسم صاحب القياس</th>
                    <th>📅 التاريخ</th>
                    <th>📝 الملاحظات</th>
                    <th className="num">📐 عدد المقاسات</th>
                    <th>العميل</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} onDoubleClick={() => canManage && setDraft(draftOf(row))}>
                      <td>{row.displayName}</td>
                      <td dir="ltr">{row.measurementDate}</td>
                      <td>{row.notes ?? '—'}</td>
                      <td className="num">{row.measurementCount}</td>
                      <td>{row.customerName}</td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn sm" type="button" onClick={() => setDraft(draftOf(row))}>
                              ✏️ تعديل القياس
                            </button>
                            <button className="btn sm danger" type="button" onClick={() => remove(row)}>
                              🗑️ حذف القياس
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {draft && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 620 }}>
            <div className="modal-head">
              {/* «📏 بيانات القياس» — `frmMeasurementDetails`. */}
              <span className="modal-title">{draft.id ? '✏️ تعديل القياس' : '📏 بيانات القياس'}</span>
              <button className="btn sm" type="button" onClick={() => setDraft(null)}>
                ✖ إغلاق
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              {selectedCustomer && (
                <p className="muted" style={{ margin: 0, fontWeight: 700 }}>
                  👤 العميل: {selectedCustomer.name} — 📞 {selectedCustomer.phone || '—'}
                </p>
              )}

              <fieldset className="card tight" style={{ margin: 0 }}>
                <div className="form-grid">
                  <label className="field">
                    <span>👤 اسم صاحب القياس *</span>
                    <input
                      className="input"
                      value={draft.name}
                      onChange={(event) => setField({ name: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>📅 التاريخ</span>
                    <input
                      className="input"
                      type="date"
                      value={draft.measurementDate}
                      onChange={(event) => setField({ measurementDate: event.target.value })}
                    />
                  </label>
                </div>
              </fieldset>

              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label">📐 قيم القياسات</legend>
                {activeAttributes.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    لا خصائص مفعّلة. أضف خاصية من{' '}
                    <Link href="/tailoring/measurements/attributes">📏 إدارة خصائص القياسات</Link>.
                  </p>
                ) : (
                  <div className="form-grid">
                    {activeAttributes.map((attribute) => (
                      <label className="field" key={attribute.id}>
                        <span>{attribute.nameAr}:</span>
                        <div className="row" style={{ gap: 6 }}>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={draft.values[attribute.id] ?? ''}
                            onChange={(event) =>
                              setField({ values: { ...draft.values, [attribute.id]: event.target.value } })
                            }
                          />
                          {/* «سم» — the unit the desktop prints beside every box. */}
                          <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                            سم
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <fieldset className="card tight" style={{ margin: 0 }}>
                <label className="field" style={{ margin: 0 }}>
                  <span>📝 ملاحظات</span>
                  <textarea
                    className="input"
                    rows={3}
                    value={draft.notes}
                    onChange={(event) => setField({ notes: event.target.value })}
                  />
                </label>
              </fieldset>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={save} disabled={busy}>
                💾 حفظ
              </button>
              <button className="btn danger" type="button" onClick={() => setDraft(null)} disabled={busy}>
                ✖ إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <TailoringMeasurements />
    </Suspense>
  );
}
