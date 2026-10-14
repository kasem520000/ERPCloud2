'use client';

import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiFetch, apiList, apiPatch, apiPost } from '../../../lib/api';
import {
  arabicName,
  cashLocationLabel,
  listBranches,
  listCashLocations,
  listParties,
  money,
  type Branch,
  type CashLocation,
  type Party,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🧾 فواتير التفصيل — `Form_WPF/frmViewOrders.xaml` («عرض الطلبات - ViewOrders») with the
 * card of `Form_WPF/AddNewSizes.xaml` («إضافة مقاس جديد») behind «👁️ عرض».
 *
 * `frmViewOrders` is one search box over one grid:
 *
 *   • `txtPhoneNum` — «🔍 الهاتف أو اسم العميل...», searched as you type
 *     (`txtPhoneNum_TextChanged`), matching `phone_num LIKE @search OR name LIKE @search`
 *     (`SearchInData` L64).
 *   • the grid — `📋 رقم الفاتورة · 👤 الاسم · 📱 الجوال · 📅 التاريخ · 💰 الإجمالي ·
 *     ✅ المدفوع · ⏳ الباقي · 📌 الحالة · 👁️ عرض`, counted by «النتائج: {n}»
 *     (`lblResultCount`).
 *   • 💰 الإجمالي is **not** the stored price: `sale_price + sale_price * 5.0 / 100.0`
 *     (L88) — the same 5% `AddNewSizes.CreateInvoice` L419 hands to the point of sale.
 *   • ⏳ الباقي = الإجمالي بالضريبة − ✅ المدفوع (L90), and المدفوع is the running
 *     `Inv_Sub_Tailor.paid` (L130).
 *
 * The card is `AddNewSizes`: «📋 البيانات الأساسية» (`👤 اسم العميل` · `📞 رقم الجوال` ·
 * `👔 نوع الثوب` · `🔢 العدد` · `💰 السعر` · `💵 الإجمالي` · `✅ الحالة` · `💳 الصافي (مع
 * الضريبة)` · `💵 المدفوع` · `💰 الباقي`), then `📐 المقاسات` (`الطول` · `الكتف` · `اليد` ·
 * `الرقبه` · `الوسع` · `وسع الكم` · `🔍 نوع الجيب`), `✨ الأشكال والتفاصيل` (`شكل الجبزور` ·
 * `مقاس الجبزور` · `الكتف` · `الجيب` · `شكل الرقبه` · `طقطق` · `شكل اليد` · `كسرة اليد` ·
 * `شكل الحافة`) and `📏 مقاسات إضافية` (`كفة تحت` · `جوال` · `محفظة` · `أسفل` · `رقابة` ·
 * `ملاحظات`). The 39 boxes are served by `GET /tailoring/measurement-fields` with the
 * labels above, so the screen renders them from the catalogue instead of guessing.
 *
 * «⚙️ لوحة التحكم» in the desktop is `جديد · حفظ · مكرر · فاتورة · طباعه · إستلام دفعة`.
 * Five of the six are here: حفظ · مكرر · طباعه · إستلام دفعة, plus «جديد» in the screen
 * header. The sixth, «فاتورة», fills a cart and raises the POS window — a screen this
 * phase does not build, so the button is not offered rather than offered and dead; the
 * API still carries the `bill` flag it would set.
 *
 * `CalculateTotalPrice` L860 is 💵 الإجمالي = 💰 السعر × 🔢 العدد, and the two refusals
 * of `btnSave_Click` L191 — «برجاء اختيار العميل» و«يرجي إدخال السعر» — are the API's.
 */
type Status = { id: string; code: string; nameAr: string; displayOrder: number; isFinal: boolean };
type GarmentType = { id: string; code: string; nameAr: string; displayOrder: number };
type MeasurementField = {
  key: string;
  label: string;
  group: 'measurements' | 'shapes' | 'extra';
  kind: 'number' | 'text' | 'select' | 'flag';
  options?: string[];
};
type Payment = { id: string; amount: string; paidAt: string; note: string | null; voucherId: string | null };

type Invoice = {
  id: string;
  number: string;
  partyId: string | null;
  customerName: string;
  phone: string | null;
  invoiceDate: string;
  quantity: string;
  unitPrice: string;
  total: string;
  totalWithTax: string;
  paidAmount: string;
  remainingAmount: string;
  statusId: string;
  statusName: string;
  garmentTypeId: string | null;
  garmentTypeName: string | null;
  billed: boolean;
  measurements: Record<string, string>;
  notes: string | null;
  version: number;
  payments: Payment[];
};

type Draft = {
  id?: string;
  version?: number;
  partyId: string;
  customerName: string;
  phone: string;
  invoiceDate: string;
  garmentTypeId: string;
  quantity: string;
  unitPrice: string;
  statusId: string;
  measurements: Record<string, string>;
  notes: string;
};

const GROUPS: Array<{ key: MeasurementField['group']; title: string }> = [
  { key: 'measurements', title: '📐 المقاسات' },
  { key: 'shapes', title: '✨ الأشكال والتفاصيل' },
  { key: 'extra', title: '📏 مقاسات إضافية' },
];

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'cash', label: 'نقدي' },
  { value: 'cheque', label: 'شيك' },
  { value: 'bank_transfer', label: 'تحويل بنكي' },
  { value: 'card', label: 'بطاقة' },
];

const today = () => new Date().toISOString().slice(0, 10);

const emptyDraft = (statusId: string, garmentTypeId: string): Draft => ({
  partyId: '',
  customerName: '',
  phone: '',
  invoiceDate: today(),
  garmentTypeId,
  quantity: '1',
  unitPrice: '',
  statusId,
  measurements: {},
  notes: '',
});

const draftOf = (invoice: Invoice): Draft => ({
  id: invoice.id,
  version: invoice.version,
  partyId: invoice.partyId ?? '',
  customerName: invoice.customerName,
  phone: invoice.phone ?? '',
  invoiceDate: invoice.invoiceDate,
  garmentTypeId: invoice.garmentTypeId ?? '',
  quantity: Number(invoice.quantity).toString(),
  unitPrice: Number(invoice.unitPrice).toString(),
  statusId: invoice.statusId,
  measurements: invoice.measurements ?? {},
  notes: invoice.notes ?? '',
});

function TailoringInvoices() {
  const { can } = useSession();
  const canManage = can('tailoring.manage');

  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const [statusOf, setStatusOf] = useState<{ id: string; number: string; statusId: string } | null>(null);
  const [paying, setPaying] = useState<{
    id: string;
    number: string;
    remaining: string;
    amount: string;
    date: string;
    cashLocationId: string;
    branchId: string;
    method: string;
    note: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const statuses = useQuery<Status[]>(() => apiList<Status>('/tailoring/order-statuses'), []);
  const garments = useQuery<GarmentType[]>(() => apiList<GarmentType>('/tailoring/garment-types'), []);
  const fields = useQuery<MeasurementField[]>(() => apiList<MeasurementField>('/tailoring/measurement-fields'), []);
  const customers = useQuery<Party[]>(() => listParties('customer'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const safes = useQuery<CashLocation[]>(() => listCashLocations(), []);

  const invoices = useQuery<{ rows: Invoice[]; total: number }>(() => {
    const params = new URLSearchParams();
    if (applied) params.set('search', applied);
    const query = params.toString();
    return apiFetch<{ data: Invoice[]; meta: { total: number } }>(
      `/tailoring/invoices${query ? `?${query}` : ''}`,
    ).then((body) => ({ rows: body.data ?? [], total: body.meta?.total ?? (body.data ?? []).length }));
  }, [applied]);

  const rows = invoices.data?.rows ?? [];
  const firstStatus = (statuses.data ?? [])[0]?.id ?? '';
  const firstGarment = (garments.data ?? [])[0]?.id ?? '';

  const setField = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const totalOf = (current: Draft | null) => Number(current?.unitPrice || 0) * Number(current?.quantity || 1);
  // 💳 الصافي (مع الضريبة) — `CreateInvoice` L419 `txtTotVAT = الإجمالي × 0.05`.
  const withTaxOf = (gross: number) => gross + gross * 0.05;

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        partyId: draft.partyId || null,
        customerName: draft.customerName,
        phone: draft.phone || null,
        invoiceDate: draft.invoiceDate,
        quantity: draft.quantity || '1',
        unitPrice: draft.unitPrice,
        statusId: draft.statusId || undefined,
        garmentTypeId: draft.garmentTypeId || null,
        measurements: draft.measurements,
        notes: draft.notes || null,
      };
      const saved = draft.id
        ? await apiPatch<{ number: string }>(`/tailoring/invoices/${draft.id}`, {
            ...payload,
            ...(draft.version ? { version: draft.version } : {}),
          })
        : await apiPost<{ number: string }>('/tailoring/invoices', payload);
      setNotice(`تم حفظ الفاتورة بنجاح — رقم الفاتورة: ${saved.number ?? ''}`.trim());
      setDraft(null);
      invoices.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveStatus() {
    if (!statusOf) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiPost<{ statusName: string }>(`/tailoring/invoices/${statusOf.id}/status`, {
        statusId: statusOf.statusId,
      });
      setNotice(`تم تغيير الحالة بنجاح — ${updated.statusName ?? ''}`.trim());
      setStatusOf(null);
      invoices.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!paying) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiPost<{ paidAmount: string; remainingAmount: string; payments: Payment[] }>(
        `/tailoring/invoices/${paying.id}/payments`,
        {
          amount: paying.amount,
          date: paying.date,
          cashLocationId: paying.cashLocationId || null,
          branchId: paying.branchId || null,
          method: paying.method,
          note: paying.note || null,
        },
      );
      const voucher = (updated.payments ?? []).some((payment) => payment.voucherId);
      setNotice(
        `تم إستلام الدفعة — المدفوع ${money(updated.paidAmount ?? '0')} · الباقي ${money(
          updated.remainingAmount ?? '0',
        )}${voucher ? ' · أُنشئ سند قبض' : ''}`,
      );
      setPaying(null);
      invoices.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(invoice: Invoice) {
    // «هل أنت متأكد من حذف هذه الفاتورة؟» — the delete is the only button in the desktop
    // that does not confirm, and it is the only one that cannot be undone.
    if (!window.confirm(`هل أنت متأكد من حذف هذه الفاتورة؟\nسيتم حذف جميع الدفعات المرتبطة بها\n\n${invoice.number}`)) {
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/tailoring/invoices/${invoice.id}`);
      setNotice(`تم حذف الفاتورة ${invoice.number}.`);
      invoices.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const openNew = () => setDraft(emptyDraft(firstStatus, firstGarment));

  const openPayment = (invoice: Invoice) =>
    setPaying({
      id: invoice.id,
      number: invoice.number,
      remaining: invoice.remainingAmount,
      amount: Number(invoice.remainingAmount).toString(),
      date: today(),
      cashLocationId: (safes.data ?? []).find((safe) => safe.isDefault)?.id ?? (safes.data ?? [])[0]?.id ?? '',
      branchId: (branches.data ?? []).find((branch) => branch.isDefault)?.id ?? (branches.data ?? [])[0]?.id ?? '',
      method: 'cash',
      // «تم استلام دفعة من عملية رقم {code}» (`AddNewSizes` L683).
      note: `تم استلام دفعة من عملية رقم ${invoice.number}`,
    });

  return (
    <Screen
      title="🧾 فواتير التفصيل"
      subtitle="ما يُفصَّل ويُحاسب عليه: بيانات الثوب ومقاساته وإجماليه بضريبته، وما قُبض منه وما بقي، وحالته من «مستلم» إلى «تم التسليم»."
      crumbs={['التفصيل', 'الفواتير']}
      actions={
        canManage ? (
          <button className="btn primary" type="button" onClick={openNew}>
            ➕ فاتورة جديدة
          </button>
        ) : null
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {/* `txtPhoneNum` — searched as you type, as `txtPhoneNum_TextChanged` does. */}
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 280, flex: 1 }}>
            <span>🔍 الهاتف أو اسم العميل...</span>
            <input
              className="input"
              value={search}
              placeholder="🔍 الهاتف أو اسم العميل..."
              onChange={(event) => {
                setSearch(event.target.value);
                setApplied(event.target.value);
              }}
            />
          </label>
        </div>
      </div>

      {invoices.status === 'loading' && <Loading rows={6} />}
      {invoices.status === 'forbidden' && <Forbidden />}
      {invoices.status === 'error' && <ErrorBox message={invoices.error} onRetry={invoices.reload} />}
      {invoices.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📋 الفواتير</span>
            {/* «النتائج: {n}» — `lblResultCount`. */}
            <span className="muted">النتائج: {invoices.data?.total ?? rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty
              title="لا توجد فواتير"
              detail={applied ? `لا فاتورة تطابق «${applied}».` : 'ابدأ بـ «➕ فاتورة جديدة».'}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>📋 رقم الفاتورة</th>
                    <th>👤 الاسم</th>
                    <th>📱 الجوال</th>
                    <th>📅 التاريخ</th>
                    <th>👔 نوع الثوب</th>
                    <th className="num">💰 الإجمالي</th>
                    <th className="num">✅ المدفوع</th>
                    <th className="num">⏳ الباقي</th>
                    <th>📌 الحالة</th>
                    <th>👁️ عرض</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.number}</td>
                      <td>{row.customerName}</td>
                      <td dir="ltr">{row.phone || '—'}</td>
                      <td dir="ltr">{row.invoiceDate}</td>
                      <td>{row.garmentTypeName ?? '—'}</td>
                      {/* 💰 الإجمالي في الشبكة هو الصافي بضريبته (L88). */}
                      <td className="num">{money(row.totalWithTax)}</td>
                      <td className="num">{money(row.paidAmount)}</td>
                      <td
                        className="num"
                        style={{
                          fontWeight: 700,
                          color: Number(row.remainingAmount) <= 0 ? 'var(--ok, #0a7a3d)' : '#E35656',
                        }}
                      >
                        {money(row.remainingAmount)}
                      </td>
                      <td>
                        <span className="badge">{row.statusName}</span>
                        {row.billed && <span className="badge"> مُحوَّلة</span>}
                      </td>
                      <td>
                        <button className="btn sm" type="button" onClick={() => setViewing(row)}>
                          👁️ عرض
                        </button>
                      </td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button
                              className="btn sm"
                              type="button"
                              onClick={() => setDraft(draftOf(row))}
                            >
                              ✏️ تعديل
                            </button>
                            <button
                              className="btn sm"
                              type="button"
                              onClick={() => setStatusOf({ id: row.id, number: row.number, statusId: row.statusId })}
                            >
                              🔄 تغيير الحالة
                            </button>
                            <button className="btn sm" type="button" onClick={() => openPayment(row)}>
                              💵 إستلام دفعة
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

      {viewing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 900 }}>
            <div className="modal-head">
              <span className="modal-title">
                👁️ عرض — <span dir="ltr">{viewing.number}</span>
              </span>
              <button className="btn sm" type="button" onClick={() => setViewing(null)}>
                ✖ إغلاق
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <div className="form-grid">
                <div className="field">
                  <span>👤 الاسم</span>
                  <output className="input">{viewing.customerName}</output>
                </div>
                <div className="field">
                  <span>📞 رقم الجوال</span>
                  <output className="input" dir="ltr">
                    {viewing.phone || '—'}
                  </output>
                </div>
                <div className="field">
                  <span>📅 التاريخ</span>
                  <output className="input" dir="ltr">
                    {viewing.invoiceDate}
                  </output>
                </div>
                <div className="field">
                  <span>👔 نوع الثوب</span>
                  <output className="input">{viewing.garmentTypeName ?? '—'}</output>
                </div>
                <div className="field">
                  <span>🔢 العدد</span>
                  <output className="input">{Number(viewing.quantity).toString()}</output>
                </div>
                <div className="field">
                  <span>💰 السعر</span>
                  <output className="input">{money(viewing.unitPrice)}</output>
                </div>
                <div className="field">
                  <span>💵 الإجمالي</span>
                  <output className="input">{money(viewing.total)}</output>
                </div>
                <div className="field">
                  <span>💳 الصافي (مع الضريبة)</span>
                  <output className="input">{money(viewing.totalWithTax)}</output>
                </div>
                <div className="field">
                  <span>💵 المدفوع</span>
                  <output className="input">{money(viewing.paidAmount)}</output>
                </div>
                <div className="field">
                  <span>💰 الباقي</span>
                  <output className="input" style={{ fontWeight: 700 }}>
                    {money(viewing.remainingAmount)}
                  </output>
                </div>
                <div className="field">
                  <span>✅ الحالة</span>
                  <output className="input">
                    <span className="badge">{viewing.statusName}</span>
                  </output>
                </div>
              </div>

              {GROUPS.map((group) => {
                const groupFields = (fields.data ?? []).filter((field) => field.group === group.key);
                const filled = groupFields.filter((field) => viewing.measurements?.[field.key]);
                if (!filled.length) return null;
                return (
                  <fieldset className="card tight" key={group.key} style={{ margin: 0 }}>
                    <legend className="group-label">{group.title}</legend>
                    <div className="form-grid">
                      {filled.map((field) => (
                        <div className="field" key={field.key}>
                          <span>{field.label}</span>
                          <output className="input">
                            {field.kind === 'flag'
                              ? viewing.measurements[field.key] === 'true'
                                ? '✔'
                                : '—'
                              : viewing.measurements[field.key]}
                          </output>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                );
              })}

              {viewing.notes && (
                <fieldset className="card tight" style={{ margin: 0 }}>
                  <legend className="group-label">ملاحظات</legend>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{viewing.notes}</p>
                </fieldset>
              )}

              {viewing.payments.length > 0 && (
                <fieldset className="card tight" style={{ margin: 0 }}>
                  <legend className="group-label">💵 إستلام دفعة</legend>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>📅 التاريخ</th>
                          <th className="num">المبلغ</th>
                          <th>ملاحظات</th>
                          <th>سند القبض</th>
                        </tr>
                      </thead>
                      <tbody>
                        {viewing.payments.map((payment) => (
                          <tr key={payment.id}>
                            <td dir="ltr">{payment.paidAt}</td>
                            <td className="num">{money(payment.amount)}</td>
                            <td>{payment.note ?? '—'}</td>
                            <td>{payment.voucherId ? '✔' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </fieldset>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" type="button" onClick={() => window.print()}>
                🖨️ طباعه
              </button>
              {canManage && (
                <button className="btn primary" type="button" onClick={() => setDraft(draftOf(viewing))}>
                  ✏️ تعديل
                </button>
              )}
              <button className="btn danger" type="button" onClick={() => setViewing(null)}>
                ✖ إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 1000 }}>
            <div className="modal-head">
              <span className="modal-title">
                {draft.id ? '✏️ تعديل فاتورة تفصيل' : '➕ إضافة مقاس جديد'}
              </span>
              <button className="btn sm" type="button" onClick={() => setDraft(null)}>
                ✖ إغلاق
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label">📋 البيانات الأساسية</legend>
                <div className="form-grid">
                  <label className="field">
                    <span>👤 اسم العميل</span>
                    <select
                      className="input"
                      value={draft.partyId}
                      onChange={(event) => {
                        const party = (customers.data ?? []).find((row) => row.id === event.target.value);
                        // `txtPhoneNum` is filled from the client, and stays editable.
                        setField({
                          partyId: event.target.value,
                          customerName: party?.name ?? '',
                          phone: party?.phone ?? draft.phone,
                        });
                      }}
                    >
                      <option value="">اختر العميل...</option>
                      {(customers.data ?? []).map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>📞 رقم الجوال</span>
                    <input
                      className="input"
                      dir="ltr"
                      value={draft.phone}
                      onChange={(event) => setField({ phone: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>👔 نوع الثوب</span>
                    <select
                      className="input"
                      value={draft.garmentTypeId}
                      onChange={(event) => setField({ garmentTypeId: event.target.value })}
                    >
                      <option value="">—</option>
                      {(garments.data ?? []).map((garment) => (
                        <option key={garment.id} value={garment.id}>
                          {garment.nameAr}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>📅 التاريخ</span>
                    <input
                      className="input"
                      type="date"
                      value={draft.invoiceDate}
                      onChange={(event) => setField({ invoiceDate: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>🔢 العدد</span>
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
                    <span>💰 السعر</span>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft.unitPrice}
                      onChange={(event) => setField({ unitPrice: event.target.value })}
                    />
                  </label>
                  <div className="field">
                    <span>💵 الإجمالي</span>
                    <output className="input" style={{ fontWeight: 700 }}>
                      {money(String(totalOf(draft)))}
                    </output>
                  </div>
                  <div className="field">
                    <span>💳 الصافي (مع الضريبة)</span>
                    <output className="input">{money(String(withTaxOf(totalOf(draft))))}</output>
                  </div>
                  <label className="field">
                    <span>✅ الحالة</span>
                    <select
                      className="input"
                      value={draft.statusId}
                      onChange={(event) => setField({ statusId: event.target.value })}
                    >
                      {(statuses.data ?? []).map((status) => (
                        <option key={status.id} value={status.id}>
                          {status.nameAr}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>

              {GROUPS.map((group) => (
                <fieldset className="card tight" key={group.key} style={{ margin: 0 }}>
                  <legend className="group-label">{group.title}</legend>
                  <div className="form-grid">
                    {(fields.data ?? [])
                      .filter((field) => field.group === group.key)
                      .map((field) => {
                        const value = draft.measurements[field.key] ?? '';
                        if (field.kind === 'flag') {
                          return (
                            <label className="field" key={field.key}>
                              <span>{field.label}</span>
                              <input
                                type="checkbox"
                                checked={value === 'true'}
                                onChange={(event) => {
                                  const next = { ...draft.measurements };
                                  if (event.target.checked) next[field.key] = 'true';
                                  else delete next[field.key];
                                  setField({ measurements: next });
                                }}
                              />
                            </label>
                          );
                        }
                        if (field.kind === 'select') {
                          return (
                            <label className="field" key={field.key}>
                              <span>{field.label}</span>
                              <select
                                className="input"
                                value={value}
                                onChange={(event) => {
                                  const next = { ...draft.measurements };
                                  if (event.target.value) next[field.key] = event.target.value;
                                  else delete next[field.key];
                                  setField({ measurements: next });
                                }}
                              >
                                <option value="">—</option>
                                {(field.options ?? []).map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            </label>
                          );
                        }
                        return (
                          <label className="field" key={field.key}>
                            <span>{field.label}</span>
                            <input
                              className="input"
                              type={field.kind === 'number' ? 'number' : 'text'}
                              step="0.01"
                              value={value}
                              onChange={(event) => {
                                const next = { ...draft.measurements };
                                if (event.target.value) next[field.key] = event.target.value;
                                else delete next[field.key];
                                setField({ measurements: next });
                              }}
                            />
                          </label>
                        );
                      })}
                    {group.key === 'extra' && (
                      <label className="field" style={{ gridColumn: '1 / -1' }}>
                        <span>ملاحظات</span>
                        <textarea
                          className="input"
                          rows={2}
                          value={draft.notes}
                          onChange={(event) => setField({ notes: event.target.value })}
                        />
                      </label>
                    )}
                  </div>
                </fieldset>
              ))}
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={save} disabled={busy}>
                💾 حفظ
              </button>
              {draft.id && (
                // «مكرر» — the same فاتورة with no number yet, as the desktop's button does.
                <button
                  className="btn"
                  type="button"
                  onClick={() => setDraft({ ...draft, id: undefined, version: undefined })}
                >
                  مكرر
                </button>
              )}
              <button className="btn" type="button" onClick={() => window.print()}>
                🖨️ طباعه
              </button>
              <button className="btn danger" type="button" onClick={() => setDraft(null)} disabled={busy}>
                ✖ إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {statusOf && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 420 }}>
            <div className="modal-head">
              <span className="modal-title">تغيير حالة الفاتورة</span>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12 }}>
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
                الفاتورة رقم <span dir="ltr">{statusOf.number}</span>
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={saveStatus} disabled={busy}>
                ✔ تغيير
              </button>
              <button className="btn danger" type="button" onClick={() => setStatusOf(null)} disabled={busy}>
                ✖ إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {paying && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 520 }}>
            <div className="modal-head">
              {/* «إستلام دفعة» — `frmSandQ` opened with `ISTailor = true` (L664). */}
              <span className="modal-title">💵 إستلام دفعة</span>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12 }}>
              <p style={{ margin: 0, fontWeight: 700 }}>
                الفاتورة رقم <span dir="ltr">{paying.number}</span> — المتبقي{' '}
                <span dir="ltr">{money(paying.remaining)}</span>
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>المبلغ:</span>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={paying.amount}
                    onChange={(event) => setPaying({ ...paying, amount: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>📅 التاريخ:</span>
                  <input
                    className="input"
                    type="date"
                    value={paying.date}
                    onChange={(event) => setPaying({ ...paying, date: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>طريقة الدفع:</span>
                  <select
                    className="input"
                    value={paying.method}
                    onChange={(event) => setPaying({ ...paying, method: event.target.value })}
                  >
                    {METHODS.map((method) => (
                      <option key={method.value} value={method.value}>
                        {method.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>💵 الصندوق:</span>
                  <select
                    className="input"
                    value={paying.cashLocationId}
                    onChange={(event) => setPaying({ ...paying, cashLocationId: event.target.value })}
                  >
                    {/* No صندوق means the دفعة is recorded on the فاتورة without a سند قبض. */}
                    <option value="">— بلا سند قبض —</option>
                    {(safes.data ?? []).map((safe) => (
                      <option key={safe.id} value={safe.id}>
                        {cashLocationLabel(safe)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>🏢 الفرع:</span>
                  <select
                    className="input"
                    value={paying.branchId}
                    onChange={(event) => setPaying({ ...paying, branchId: event.target.value })}
                  >
                    <option value="">—</option>
                    {(branches.data ?? []).map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {arabicName(branch) || branch.code || branch.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ gridColumn: '1 / -1' }}>
                  <span>ملاحظات:</span>
                  <input
                    className="input"
                    value={paying.note}
                    onChange={(event) => setPaying({ ...paying, note: event.target.value })}
                  />
                </label>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={pay} disabled={busy}>
                ✔ إستلام
              </button>
              <button className="btn danger" type="button" onClick={() => setPaying(null)} disabled={busy}>
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
      <TailoringInvoices />
    </Suspense>
  );
}
