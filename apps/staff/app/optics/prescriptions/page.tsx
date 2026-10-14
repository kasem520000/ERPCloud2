'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiData, apiDelete, apiFetch, apiPatch, apiPost } from '../../../lib/api';
import { type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 👓 بيانات النظارات — `Form_WPF/frmGlasses.xaml` («👓 بيانات النظارات»), tab
 * «👓  القياسات»: two columns, «🔴 العين اليمنى (RE)» and «🟢 العين اليسرى (LE)», five
 * boxes each.
 *
 * The desktop opens the window from a sale invoice — `frmInvSale.glassesOptions` L2505,
 * Alt+G — for the صنف under the cursor, with «الرجاء إضافة صنف للفاتورة» و«الرجاء وضع
 * المؤشر على الصنف» standing in its way, and writes two `Glass` rows
 * (`orientation` "R" then "L") into
 * `Glasses(InvGlobalID, ItemId, orientation, SPH, CYL, AX, [ADD], IPD)`.
 *
 * Three things are the cloud's own, and each is a consequence of that difference:
 *
 *   1. There is no list window in the desktop — the وصفة is a child of a سطر فاتورة. The
 *      cloud keeps the prescription on a عميل (a `invoiceLineId` is still honoured, and
 *      قسم الطباعة reads it), so this list is the door to the card.
 *   2. The boxes are titled from «⚙  أسماء الحقول» (`Other_Column`), not from the markup:
 *      the five headers of each eye are the tenant's own words, defaulting to
 *      «RE-SPH» … «LE-IPD».
 *   3. Nothing is parsed. `bindClass` writes `txtReSPH.Text` into a `VarChar`, so «PL»
 *      و«+1.25» و«-0.50 × 90» are all values, and no number box may refuse them.
 *
 * The card's buttons are the window's: «🔄 جديد» (`CLR`), «✔ إدراج» (`bindClass` then
 * `Close`) و«✖ خروج».
 */
type EyeValues = Partial<Record<'sph' | 'cyl' | 'axis' | 'add' | 'ipd', string>>;

type FieldLabels = {
  id: string | null;
  right: Array<{ key: string; label: string }>;
  left: Array<{ key: string; label: string }>;
  fields: Array<{ slot: string; index: number; key: string; side: 'R' | 'L'; label: string; placeholder: string }>;
  version: number | null;
};

type Prescription = {
  id: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  invoiceLineId: string | null;
  orientation: string;
  rightEye: EyeValues;
  leftEye: EyeValues;
  notes: string | null;
  filledCount: number;
  createdAt: string;
  version: number;
};

type Draft = {
  id?: string;
  version?: number;
  partyId: string;
  right: EyeValues;
  left: EyeValues;
  notes: string;
};

const EYE_KEYS = ['sph', 'cyl', 'axis', 'add', 'ipd'] as const;

const emptyDraft = (partyId = ''): Draft => ({ partyId, right: {}, left: {}, notes: '' });

const draftOf = (prescription: Prescription): Draft => ({
  id: prescription.id,
  version: prescription.version,
  partyId: prescription.partyId,
  right: { ...prescription.rightEye },
  left: { ...prescription.leftEye },
  notes: prescription.notes ?? '',
});

function OpticsPrescriptions() {
  const { can } = useSession();
  const canManage = can('optics.manage');
  const searchParams = useSearchParams();
  const lineIdFilter = searchParams.get('lineId');
  const highlightedId = searchParams.get('id') ?? lineIdFilter;

  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const labels = useQuery<FieldLabels>(() => apiData<FieldLabels>('/optics/field-labels'), []);
  const customers = useQuery<Party[]>(() => apiData<Party[]>('/parties?kind=customer').then((body) => (Array.isArray(body) ? body : ((body as { data?: Party[] }).data ?? []))), []);

  const prescriptions = useQuery<{ rows: Prescription[]; total: number; customer: Party | null }>(() => {
    const params = new URLSearchParams();
    if (applied !== null) params.set('search', applied);
    const query = params.toString();
    return apiFetch<{ data: Prescription[]; meta: { total: number; customer: Party | null } }>(
      `/optics/prescriptions${query ? `?${query}` : ''}`,
    ).then((body) => ({
      rows: body.data ?? [],
      total: body.meta?.total ?? (body.data ?? []).length,
      customer: body.meta?.customer ?? null,
    }));
  }, [applied]);

  const rows = prescriptions.data?.rows ?? [];
  const rightLabels = labels.data?.right ?? EYE_KEYS.map((key) => ({ key, label: key.toUpperCase() }));
  const leftLabels = labels.data?.left ?? EYE_KEYS.map((key) => ({ key, label: key.toUpperCase() }));
  const selectedCustomer = (customers.data ?? []).find((party) => party.id === (draft?.partyId ?? ''));

  const setEye = (side: 'right' | 'left', key: string, value: string) =>
    setDraft((current) =>
      current
        ? { ...current, [side]: { ...current[side], [key]: value } }
        : current,
    );

  /** «✔ إدراج» — `btnSave_Click`: the ten boxes and the عميل, nothing else. */
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        partyId: draft.partyId,
        rightEye: draft.right,
        leftEye: draft.left,
        notes: draft.notes || null,
      };
      const saved = draft.id
        ? await apiPatch<Prescription>(`/optics/prescriptions/${draft.id}`, {
            ...payload,
            ...(draft.version ? { version: draft.version } : {}),
          })
        : await apiPost<Prescription>('/optics/prescriptions', payload);
      setNotice(`تم الحفظ بنجاح — ${saved.customerName ?? ''}`.trim());
      setDraft(null);
      prescriptions.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(prescription: Prescription) {
    if (!window.confirm(`هل أنت متأكد من حذف هذه الوصفة؟\n\n${prescription.customerName}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/optics/prescriptions/${prescription.id}`);
      setNotice('تم الحذف بنجاح');
      prescriptions.reload();
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
      title="👓 بيانات النظارات"
      subtitle="وصفة كل عميل بعشر قيم: خمس لليمين وخمس لليسار، بأسماءٍ يسمّيها صاحب المحل في «⚙️ أسماء الحقول» — وما يُطبع على الفاتورة هو هذا."
      crumbs={['النظارات', 'بيانات النظارات']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Link className="btn" href="/optics/field-labels">
            ⚙️ أسماء الحقول
          </Link>
          {canManage && (
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                setError('');
                setNotice('');
                setDraft(emptyDraft(prescriptions.data?.customer?.id ?? (customers.data ?? [])[0]?.id ?? ''));
              }}
            >
              ➕ وصفة جديدة
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}
      {lineIdFilter && (
        <div className="card tight" style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn-line)' }}>
          🔍 تم فتح بيانات النظارات للسطر <code dir="ltr">{lineIdFilter}</code> من فاتورة المبيعات (Alt+G) — الوصفات المرتبطة بهذا السطر مميزة أدناه.
        </div>
      )}

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
                if (event.key === 'Enter') searchNow();
              }}
            />
          </label>
          <button className="btn primary" type="button" onClick={searchNow}>
            🔍 بحث
          </button>
          {applied !== null && (
            <button className="btn" type="button" onClick={showAll}>
              📋 كل الوصفات
            </button>
          )}
        </div>
        {prescriptions.data?.customer && (
          <div className="row" style={{ marginTop: 8, gap: 16, fontWeight: 700 }}>
            <span>👤 العميل: {prescriptions.data.customer.name}</span>
            <span dir="ltr">📞 الجوال: {prescriptions.data.customer.phone || '—'}</span>
          </div>
        )}
      </div>

      {prescriptions.status === 'loading' && <Loading rows={6} />}
      {prescriptions.status === 'forbidden' && <Forbidden />}
      {prescriptions.status === 'error' && <ErrorBox message={prescriptions.error} onRetry={prescriptions.reload} />}
      {prescriptions.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>👓 بيانات النظارات</span>
            <span className="muted">عدد السجلات: {prescriptions.data?.total ?? rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty
              title="لا توجد وصفات"
              detail={
                prescriptions.data?.customer
                  ? `لا وصفة محفوظة لـ«${prescriptions.data.customer.name}». ابدأ بـ «➕ وصفة جديدة».`
                  : 'ابحث بجوال عميل أو اسمه لعرض وصفاته، أو أضف وصفة من «كل الوصفات».'
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  {/* «🔴 العين اليمنى (RE)» و«🟢 العين اليسرى (LE)» — the two columns of the card. */}
                  <tr>
                    <th rowSpan={2}>👤 العميل</th>
                    <th rowSpan={2}>📅 التاريخ</th>
                    <th colSpan={5} style={{ background: 'var(--brand-soft)' }}>
                      🔴 العين اليمنى (RE)
                    </th>
                    <th colSpan={5} style={{ background: 'var(--ok-soft)' }}>
                      🟢 العين اليسرى (LE)
                    </th>
                    <th rowSpan={2}>📝 الملاحظات</th>
                    {canManage && <th rowSpan={2}>إجراءات</th>}
                  </tr>
                  <tr>
                    {rightLabels.map((label) => (
                      <th key={`r-${label.key}`} style={{ background: 'var(--brand-soft)' }}>
                        {label.label}
                      </th>
                    ))}
                    {leftLabels.map((label) => (
                      <th key={`l-${label.key}`} style={{ background: 'var(--ok-soft)' }}>
                        {label.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .filter((row) => !lineIdFilter || row.invoiceLineId === lineIdFilter || row.id === highlightedId)
                    .map((row) => (
                      <tr
                        key={row.id}
                        onDoubleClick={() => canManage && setDraft(draftOf(row))}
                        className={row.id === highlightedId || row.invoiceLineId === lineIdFilter ? 'row-active' : undefined}
                      >
                      <td>{row.customerName}</td>
                      <td dir="ltr">{row.createdAt.slice(0, 10)}</td>
                      {rightLabels.map((label) => (
                        <td key={`r-${label.key}`} dir="ltr">
                          {row.rightEye[label.key as keyof EyeValues] ?? '—'}
                        </td>
                      ))}
                      {leftLabels.map((label) => (
                        <td key={`l-${label.key}`} dir="ltr">
                          {row.leftEye[label.key as keyof EyeValues] ?? '—'}
                        </td>
                      ))}
                      <td>{row.notes ?? '—'}</td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn sm" type="button" onClick={() => setDraft(draftOf(row))}>
                              ✏️ تعديل
                            </button>
                            <button className="btn sm danger" type="button" onClick={() => remove(row)}>
                              🗑️ حذف
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
          <div className="modal-card" style={{ maxWidth: 720 }}>
            <div className="modal-head">
              {/* «👓 بيانات النظارات» — `frmGlasses`, opened from a فاتورة or from here. */}
              <span className="modal-title">{draft.id ? '✏️ تعديل الوصفة' : '👓 بيانات النظارات'}</span>
              <button className="btn sm" type="button" onClick={() => setDraft(null)}>
                ✖ خروج
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <label className="field">
                {/* The desktop takes the عميل from the فاتورة; here the وصفة is his own card. */}
                <span>👤 العميل *</span>
                <select
                  className="input"
                  value={draft.partyId}
                  onChange={(event) => setDraft({ ...draft, partyId: event.target.value })}
                >
                  <option value="">— اختر عميلاً —</option>
                  {(customers.data ?? []).map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.name}
                      {party.phone ? ` · ${party.phone}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {selectedCustomer && (
                <p className="muted" style={{ margin: 0, fontWeight: 700 }}>
                  👤 العميل: {selectedCustomer.name} — 📞 {selectedCustomer.phone || '—'}
                </p>
              )}

              {(
                [
                  { side: 'right' as const, title: '🔴 العين اليمنى (RE)', background: 'var(--brand-soft)', captions: rightLabels },
                  { side: 'left' as const, title: '🟢 العين اليسرى (LE)', background: 'var(--ok-soft)', captions: leftLabels },
                ]
              ).map((column) => (
                <fieldset key={column.side} className="card tight" style={{ margin: 0, background: column.background }}>
                  <legend className="group-label" style={{ margin: 0 }}>
                    {column.title}
                  </legend>
                  <div className="form-grid">
                    {column.captions.map((caption) => (
                      <label key={caption.key} className="field" style={{ margin: 0 }}>
                        {/* The caption is «⚙️ أسماء الحقول»'s, or the desktop's default. */}
                        <span dir="ltr">{caption.label}</span>
                        <input
                          className="input"
                          dir="ltr"
                          value={draft[column.side][caption.key as keyof EyeValues] ?? ''}
                          placeholder="—"
                          onChange={(event) => setEye(column.side, caption.key, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}

              <label className="field">
                <span>📝 ملاحظات</span>
                <textarea
                  className="input"
                  rows={2}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
              <p className="muted" style={{ margin: 0 }}>
                القيم نصوص كما في الديسكتوب: «PL» و«+1.25» و«-0.50 × 90» كلها مقبولة — لا
                يُحلَّل رقمٌ ولا يُرفض.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={() => void save()} disabled={busy}>
                ✔ إدراج
              </button>
              {/* «🔄 جديد» = `CLR` — the ten boxes and the ملاحظات go blank. */}
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setDraft(emptyDraft(draft.partyId))}
              >
                🔄 جديد
              </button>
              <button className="btn danger" type="button" onClick={() => setDraft(null)} disabled={busy}>
                ✖ خروج
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
      <OpticsPrescriptions />
    </Suspense>
  );
}
