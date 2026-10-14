'use client';

import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiFetch, apiList, apiPatch, apiPost } from '../../../lib/api';
import { listParties, money, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🧵 إدارة طلبات التفصيل — `Form_WPF/frmOrders.xaml` («إدارة طلبات التفصيل») with the
 * card of `Form_WPF/frmOrderDetails.xaml` («إضافة طلب تفصيل») behind «➕ إضافة طلب جديد».
 *
 * `frmOrders` is a filter bar over one grid. Its boxes are `txtSearch` (رقم الطلب or
 * اسم العميل — `LoadOrders` L100), `cmbStatus` (the `OrderStatus` rows with «الكل»
 * prepended at StatusID 0), `dtFrom` and `dtTo`, and «🔍 بحث». The grid «📋 قائمة
 * الطلبات» carries `رقم الطلب · 👤 العميل · 📞 الجوال · القياس · نوع التفصيل · ⚙️ الحالة ·
 * 📅 تاريخ الطلب · 📅 موعد التسليم · 💰 السعر · 💵 المدفوع · ⌛ المتبقي`, and its buttons
 * are `✖ إغلاق · ➕ إضافة طلب جديد · ✏️ تعديل · 🗑️ حذف · 🔄 تغيير الحالة` — a double-click
 * on a row is the same as «✏️ تعديل» (L339).
 *
 * Two things are the desktop's own, and they are kept:
 *
 *   • ⌛ المتبقي = 💰 السعر − 💵 المدفوع (`CalculateRemaining` L290) and a **negative**
 *     remaining is allowed — the desktop paints it green, not red, instead of refusing.
 *   • a طلب whose موعد التسليم passed and whose حالة is not final is «متأخّر» and its row
 *     is painted `#FFE4E4` with dark-red text (L146).
 *
 * The card is `frmOrderDetails`: «👤 بيانات العميل», «📋 تفاصيل الطلب» (القياس ·
 * نوع التفصيل · موعد التسليم · الكمية · السعر · المدفوع · المتبقي), «🔧 الخيارات» and
 * «🧵 تفاصيل القماش والتصميم». Its refusals — «الرجاء اختيار عميل» · «الرجاء اختيار نوع
 * التفصيل» · «الرجاء إدخال السعر» — are the API's, and they come back in those words.
 *
 * One deliberate departure: the desktop's «✏️ تعديل» opens a blank card whose
 * `LoadOrderData` L417 is empty («يمكن تطويرها لاحقًا») and its save INSERTs a second
 * طلب. Here the selected طلب is the one that is edited.
 */
type Status = { id: string; code: string; nameAr: string; displayOrder: number; isFinal: boolean };
type Type = { id: string; nameAr: string; defaultPrice: string };
type OptionValue = { id: string; nameAr: string; isDefault: boolean };
type OptionCategory = { id: string; nameAr: string; values: OptionValue[] };
type Measurement = { id: string; createdAt: string; kind?: string };

type Order = {
  id: string;
  number: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  measurementId: string | null;
  measurementName: string | null;
  typeId: string;
  typeName: string;
  statusId: string;
  statusName: string;
  orderDate: string;
  deliveryDate: string | null;
  quantity: string;
  price: string;
  paidAmount: string;
  remainingAmount: string;
  isDelayed: boolean;
  fabricType: string | null;
  fabricColor: string | null;
  designNotes: string | null;
  generalNotes: string | null;
  version: number;
  options: Array<{ categoryId: string; categoryName: string; valueId: string; valueName: string }>;
};

type Filters = { statusId: string; from: string; to: string; search: string };

const ALL = '0';
const today = () => new Date().toISOString().slice(0, 10);
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

type Draft = {
  id?: string;
  version?: number;
  partyId: string;
  typeId: string;
  statusId: string;
  measurementId: string;
  orderDate: string;
  deliveryDate: string;
  quantity: string;
  price: string;
  paidAmount: string;
  fabricType: string;
  fabricColor: string;
  designNotes: string;
  generalNotes: string;
  options: Record<string, string>;
};

const emptyDraft = (statusId: string): Draft => ({
  partyId: '',
  typeId: '',
  statusId,
  measurementId: '',
  orderDate: today(),
  deliveryDate: inAWeek(),
  quantity: '1',
  price: '',
  paidAmount: '0',
  fabricType: '',
  fabricColor: '',
  designNotes: '',
  generalNotes: '',
  options: {},
});

function TailoringOrders() {
  const { can } = useSession();
  const canManage = can('tailoring.manage');

  const [filters, setFilters] = useState<Filters>({ statusId: ALL, from: '', to: '', search: '' });
  const [applied, setApplied] = useState<Filters>({ statusId: ALL, from: '', to: '', search: '' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [statusOf, setStatusOf] = useState<{ id: string; number: string; statusId: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const statuses = useQuery<Status[]>(() => apiList<Status>('/tailoring/order-statuses'), []);
  const types = useQuery<Type[]>(() => apiList<Type>('/tailoring/types'), []);
  const categories = useQuery<OptionCategory[]>(() => apiList<OptionCategory>('/tailoring/option-categories'), []);
  const customers = useQuery<Party[]>(() => listParties('customer'), []);

  const orders = useQuery<{ rows: Order[]; total: number }>(() => {
    const params = new URLSearchParams();
    if (applied.statusId && applied.statusId !== ALL) params.set('statusId', applied.statusId);
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.search) params.set('search', applied.search);
    const query = params.toString();
    return apiFetch<{ data: Order[]; meta: { total: number } }>(`/tailoring/orders${query ? `?${query}` : ''}`).then(
      (body) => ({ rows: body.data ?? [], total: body.meta?.total ?? (body.data ?? []).length }),
    );
  }, [applied]);

  const draftPartyId = draft?.partyId ?? '';
  const measurements = useQuery<Measurement[]>(
    () => (draftPartyId ? apiList<Measurement>(`/tailoring/parties/${draftPartyId}/measurements`) : Promise.resolve([])),
    [draftPartyId],
  );

  const rows = orders.data?.rows ?? [];
  const remaining = Number(draft?.price || 0) - Number(draft?.paidAmount || 0);
  const selectedCustomer = (customers.data ?? []).find((party) => party.id === draft?.partyId);

  const setField = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        partyId: draft.partyId,
        typeId: draft.typeId,
        statusId: draft.statusId || undefined,
        measurementId: draft.measurementId || null,
        orderDate: draft.orderDate,
        deliveryDate: draft.deliveryDate || null,
        quantity: draft.quantity || '1',
        price: draft.price,
        paidAmount: draft.paidAmount || '0',
        fabricType: draft.fabricType || null,
        fabricColor: draft.fabricColor || null,
        designNotes: draft.designNotes || null,
        generalNotes: draft.generalNotes || null,
        options: Object.entries(draft.options).map(([categoryId, valueId]) => ({ categoryId, valueId })),
      };
      const saved = draft.id
        ? await apiPatch<{ number: string }>(`/tailoring/orders/${draft.id}`, { ...payload, ...(draft.version ? { version: draft.version } : {}) })
        : await apiPost<{ number: string }>('/tailoring/orders', payload);
      setNotice(`تم حفظ الطلب بنجاح — رقم الطلب: ${saved.number ?? ''}`.trim());
      setDraft(null);
      orders.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(order: Order) {
    // «هل أنت متأكد من حذف هذا الطلب؟\nسيتم حذف جميع البيانات المرتبطة به» (L212).
    if (!window.confirm(`هل أنت متأكد من حذف هذا الطلب؟\nسيتم حذف جميع البيانات المرتبطة به\n\n${order.number}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/tailoring/orders/${order.id}`);
      setNotice(`تم حذف الطلب ${order.number}.`);
      orders.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus() {
    if (!statusOf) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiPost<{ statusName: string }>(`/tailoring/orders/${statusOf.id}/status`, {
        statusId: statusOf.statusId,
      });
      setNotice(`تم تغيير الحالة بنجاح — ${updated.statusName ?? ''}`.trim());
      setStatusOf(null);
      orders.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const openNew = () =>
    setDraft(emptyDraft((statuses.data ?? [])[0]?.id ?? ''));

  const openEdit = (order: Order) =>
    setDraft({
      id: order.id,
      version: order.version,
      partyId: order.partyId,
      typeId: order.typeId,
      statusId: order.statusId,
      measurementId: order.measurementId ?? '',
      orderDate: order.orderDate,
      deliveryDate: order.deliveryDate ?? '',
      quantity: Number(order.quantity).toString(),
      price: Number(order.price).toString(),
      paidAmount: Number(order.paidAmount).toString(),
      fabricType: order.fabricType ?? '',
      fabricColor: order.fabricColor ?? '',
      designNotes: order.designNotes ?? '',
      generalNotes: order.generalNotes ?? '',
      options: Object.fromEntries(order.options.map((option) => [option.categoryId, option.valueId])),
    });

  return (
    <Screen
      title="🧵 إدارة طلبات التفصيل"
      subtitle="طلب التفصيل: العميل وقياسه ونوع التفصيل وموعد التسليم، وحالته من «مستلم» إلى «تم التسليم»، وما دُفع منه وما بقي."
      crumbs={['التفصيل', 'الطلبات']}
      actions={
        canManage ? (
          <button className="btn primary" type="button" onClick={openNew}>
            ➕ إضافة طلب جديد
          </button>
        ) : null
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>الحالة:</span>
            <select
              className="input"
              value={filters.statusId}
              onChange={(event) => {
                const next = { ...filters, statusId: event.target.value };
                setFilters(next);
                // `cmbStatus_SelectionChanged` reloads on every change, not on «🔍 بحث».
                setApplied(next);
              }}
            >
              <option value={ALL}>الكل</option>
              {(statuses.data ?? []).map((status) => (
                <option key={status.id} value={status.id}>
                  {status.nameAr}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>من:</span>
            <input
              className="input"
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>إلى:</span>
            <input
              className="input"
              type="date"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 220, flex: 1 }}>
            <span>🔍 البحث (رقم/اسم):</span>
            <input
              className="input"
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              placeholder="رقم الطلب أو اسم العميل"
            />
          </label>
          <button className="btn" type="button" onClick={() => setApplied(filters)}>
            🔍 بحث
          </button>
        </div>
      </div>

      {orders.status === 'loading' && <Loading rows={6} />}
      {orders.status === 'forbidden' && <Forbidden />}
      {orders.status === 'error' && <ErrorBox message={orders.error} onRetry={orders.reload} />}
      {orders.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📋 قائمة الطلبات</span>
            <span className="muted">عدد السجلات: {orders.data?.total ?? rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty
              title="لا توجد طلبات"
              detail="ابدأ بـ «➕ إضافة طلب جديد»، أو وسّع الفترة، أو اختر «الكل» في الحالة."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>رقم الطلب</th>
                    <th>👤 العميل</th>
                    <th>📞 الجوال</th>
                    <th>القياس</th>
                    <th>نوع التفصيل</th>
                    <th>⚙️ الحالة</th>
                    <th>📅 تاريخ الطلب</th>
                    <th>📅 موعد التسليم</th>
                    <th className="num">💰 السعر</th>
                    <th className="num">💵 المدفوع</th>
                    <th className="num">⌛ المتبقي</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      // ⌛ متأخّر — the desktop paints the row `#FFE4E4` with dark-red text.
                      style={row.isDelayed ? { background: '#FFE4E4', color: 'var(--danger-ink)' } : undefined}
                      onDoubleClick={() => canManage && openEdit(row)}
                    >
                      <td dir="ltr">{row.number}</td>
                      <td>{row.customerName}</td>
                      <td dir="ltr">{row.customerPhone || '—'}</td>
                      <td>{row.measurementName ?? '—'}</td>
                      <td>{row.typeName}</td>
                      <td>
                        <span className="badge">{row.statusName}</span>
                        {row.isDelayed && <span className="badge danger"> متأخّر</span>}
                      </td>
                      <td dir="ltr">{row.orderDate}</td>
                      <td dir="ltr">{row.deliveryDate ?? '—'}</td>
                      <td className="num">{money(row.price)}</td>
                      <td className="num">{money(row.paidAmount)}</td>
                      {/* A negative remaining is green in the desktop, never refused. */}
                      <td className="num" style={{ color: Number(row.remainingAmount) < 0 ? 'var(--ok, #0a7a3d)' : undefined }}>
                        {money(row.remainingAmount)}
                      </td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn sm" type="button" onClick={() => openEdit(row)}>
                              ✏️ تعديل
                            </button>
                            <button
                              className="btn sm"
                              type="button"
                              onClick={() => setStatusOf({ id: row.id, number: row.number, statusId: row.statusId })}
                            >
                              🔄 تغيير الحالة
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
          <div className="modal-card" style={{ maxWidth: 860 }}>
            <div className="modal-head">
              <span className="modal-title">{draft.id ? '✏️ تعديل الطلب' : '👔 إضافة طلب جديد'}</span>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label">👤 بيانات العميل</legend>
                <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="field" style={{ margin: 0, minWidth: 260, flex: 1 }}>
                    <span>العميل:</span>
                    <select
                      className="input"
                      value={draft.partyId}
                      onChange={(event) => setField({ partyId: event.target.value, measurementId: '' })}
                    >
                      <option value="">اختر العميل...</option>
                      {(customers.data ?? []).map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted" style={{ margin: 0 }}>
                    الجوال: {selectedCustomer?.phone ?? '—'}
                  </p>
                </div>
              </fieldset>

              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label">📋 تفاصيل الطلب</legend>
                <div className="form-grid">
                  <label className="field">
                    <span>القياس:</span>
                    <select
                      className="input"
                      value={draft.measurementId}
                      onChange={(event) => setField({ measurementId: event.target.value })}
                      disabled={!draft.partyId}
                    >
                      <option value="">— بلا قياس —</option>
                      {(measurements.data ?? []).map((measurement) => (
                        <option key={measurement.id} value={measurement.id}>
                          قياس بتاريخ {measurement.createdAt.slice(0, 10)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>نوع التفصيل:</span>
                    <select
                      className="input"
                      value={draft.typeId}
                      onChange={(event) => {
                        const type = (types.data ?? []).find((row) => row.id === event.target.value);
                        setField({
                          typeId: event.target.value,
                          // `DefaultPrice` fills السعر the first time a type is chosen.
                          price: type && !draft.price ? Number(type.defaultPrice).toString() : draft.price,
                        });
                      }}
                    >
                      <option value="">اختر نوع التفصيل...</option>
                      {(types.data ?? []).map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.nameAr}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>⚙️ الحالة</span>
                    <select className="input" value={draft.statusId} onChange={(event) => setField({ statusId: event.target.value })}>
                      {(statuses.data ?? []).map((status) => (
                        <option key={status.id} value={status.id}>
                          {status.nameAr}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>📅 تاريخ الطلب</span>
                    <input
                      className="input"
                      type="date"
                      value={draft.orderDate}
                      onChange={(event) => setField({ orderDate: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>موعد التسليم:</span>
                    <input
                      className="input"
                      type="date"
                      value={draft.deliveryDate}
                      onChange={(event) => setField({ deliveryDate: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>الكمية:</span>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="1"
                      value={draft.quantity}
                      onChange={(event) => setField({ quantity: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>السعر:</span>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft.price}
                      onChange={(event) => setField({ price: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>المدفوع:</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      value={draft.paidAmount}
                      onChange={(event) => setField({ paidAmount: event.target.value })}
                    />
                  </label>
                  <div className="field">
                    <span>المتبقي:</span>
                    <output
                      className="input"
                      style={{ color: remaining < 0 ? 'var(--ok, #0a7a3d)' : '#E35656', fontWeight: 700 }}
                    >
                      {money(String(remaining))}
                    </output>
                  </div>
                </div>
              </fieldset>

              {(categories.data ?? []).length > 0 && (
                <fieldset className="card tight" style={{ margin: 0 }}>
                  <legend className="group-label">🔧 الخيارات</legend>
                  {(categories.data ?? []).map((category) => (
                    <div key={category.id} style={{ marginBottom: 8 }}>
                      <p className="muted" style={{ margin: '0 0 4px', fontWeight: 700 }}>
                        {category.nameAr}:
                      </p>
                      <div className="chips">
                        {category.values.map((value) => (
                          <button
                            key={value.id}
                            type="button"
                            className={`chip${draft.options[category.id] === value.id ? ' on' : ''}`}
                            onClick={() =>
                              // `selectedOptions[catId] = valId` — one value per category.
                              setField({ options: { ...draft.options, [category.id]: value.id } })
                            }
                          >
                            {value.nameAr}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </fieldset>
              )}

              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label">🧵 تفاصيل القماش والتصميم</legend>
                <div className="form-grid">
                  <label className="field">
                    <span>نوع القماش:</span>
                    <input
                      className="input"
                      value={draft.fabricType}
                      onChange={(event) => setField({ fabricType: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>اللون:</span>
                    <input
                      className="input"
                      value={draft.fabricColor}
                      onChange={(event) => setField({ fabricColor: event.target.value })}
                    />
                  </label>
                  <label className="field" style={{ gridColumn: '1 / -1' }}>
                    <span>ملاحظات:</span>
                    <textarea
                      className="input"
                      rows={3}
                      value={draft.designNotes}
                      onChange={(event) => setField({ designNotes: event.target.value })}
                    />
                  </label>
                </div>
              </fieldset>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={save} disabled={busy}>
                💾 حفظ الطلب
              </button>
              <button className="btn danger" type="button" onClick={() => setDraft(null)} disabled={busy}>
                ✖ إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {statusOf && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 420 }}>
            <div className="modal-head">
              <span className="modal-title">تغيير حالة الطلب</span>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12 }}>
              <p style={{ margin: 0, fontWeight: 700 }}>
                الحالة الحالية:{' '}
                {(statuses.data ?? []).find((status) => status.id === statusOf.statusId)?.nameAr ?? '—'}
              </p>
              <label className="field" style={{ margin: 0 }}>
                <span>الحالة الجديدة:</span>
                <select
                  className="input"
                  value={statusOf.statusId}
                  onChange={(event) => setStatusOf({ ...statusOf, statusId: event.target.value })}
                >
                  {(statuses.data ?? []).map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.nameAr}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted" style={{ margin: 0 }}>
                الطلب رقم <span dir="ltr">{statusOf.number}</span>
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={changeStatus} disabled={busy}>
                ✔ تغيير
              </button>
              <button className="btn danger" type="button" onClick={() => setStatusOf(null)} disabled={busy}>
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
      <TailoringOrders />
    </Suspense>
  );
}
