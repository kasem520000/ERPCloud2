'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiFetch, apiList, apiPatch, apiPost } from '../../../lib/api';
import { listBranches, listParties, type Branch, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * ⛵ الحجوزات — `Form_WPF/frmBookingM.xaml` («الحجوزات»).
 *
 * «📋 بيانات الحجوزات» is the card: 🔢 الرقم · 📅 التاريخ · 📋 الفئة · 🔖 حالة الحجز
 * («مؤكد»/«غير مؤكد») · 🚢 نوع الحجز («حجز عادي»/«بحر مفتوح») · 📅 تاريخ الحجز و🕐 وقته ·
 * 👤 العميل · ⚓ المركب · 💰 القيمة · ⏱️ المدة ساعة/دقيقة · 🎁 الإضافات (الكمية · السعر ·
 * الإجمالي) — ثم مجاميع `CalcuAll`: «إجمالي الإضافات» · «الإجمالي» · «ضريبة 15%» ·
 * «الصافي». «🔍 البحث» is the second tab: رقم الحجز · اسم العميل · رقم الجوال · من
 * تاريخ/إلى تاريخ، و«📋 نتائج البحث» تحته.
 *
 * ورفضها الأول قبل أي صفٍّ: «يجب تحديد مدة الحجز» — ساعةٌ ودقيقة يقفان على صفر.
 *
 * «📝 ملاحظات» مكتوبة في الشاشة عند الديسكتوب ولا تُحفظ (`txtNotes` تُمحى ولا تُقرأ)،
 * فلم تُنقل. و«🖨️ طباعة» مؤجَّلة مع ملفّات `Reports/*.repx`.
 *
 * 🎁 الإضافات تُقرأ من تعريفاتها (`Additions` — `Form_WPF/frmAdditions.xaml`): اختيارٌ
 * منها يكتب «السعر» من `SalePrice` كما يفعل `cmbAdditions_SelectionChanged`، و«➕» بجوارها
 * يفتح شاشة «📋 إضافات». و«— بلا تعريف —» لصفٍّ يُكتب وصفه باليد، وهو تسميةٌ مخترَعة:
 * النافذة عند الديسكتوب لا تقبل إلا ما في القائمة.
 */
type Addition = { id: string; additionId: string | null; description: string; quantity: string; unitPrice: string; amount: string };
type Draft = { id?: string; additionId?: string; description: string; quantity: string; unitPrice: string };
/** ➕ الإضافة — تعريفها من `Additions` (`Form_WPF/frmAdditions.xaml`): 🔢 الرقم · 📝 الاسم · 💰 القيمة. */
type AdditionDefinition = { id: string; number: number; name: string; salePrice: string; usageCount: number; version: number };

type Booking = {
  id: string;
  number: string | null;
  branchId: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  vesselId: string;
  vesselName: string;
  vesselCode: string;
  documentDate: string;
  startsAt: string;
  endsAt: string;
  bookingType: string;
  periodHours: number;
  periodMinutes: number;
  rentalPeriod: number;
  rentalAmount: string;
  insuranceAmount: string;
  companions: number;
  status: string;
  statusText: string;
  additions: Addition[];
  additionsTotal: string;
  total: string;
  taxAmount: string;
  netAmount: string;
  vatRate: number;
  version: number;
};

type Card = {
  id?: string;
  version?: number;
  branchId: string;
  partyId: string;
  vesselId: string;
  documentDate: string;
  startsAt: string;
  endsAt: string;
  bookingType: string;
  status: string;
  periodHours: string;
  periodMinutes: string;
  rentalAmount: string;
  insuranceAmount: string;
  companions: string;
  additions: Draft[];
};

type Vessel = { id: string; code: string; name: string; groupId?: string | null };
type Marina = { groups: Array<{ id: string; name: string }>; vessels: Vessel[] };

const today = () => new Date().toISOString().slice(0, 10);
const stamp = (dateTime: string) => dateTime.slice(0, 16);

const emptyCard = (branchId = '', partyId = '', vesselId = ''): Card => ({
  branchId,
  partyId,
  vesselId,
  documentDate: today(),
  startsAt: `${today()}T08:00`,
  endsAt: `${today()}T10:00`,
  bookingType: 'حجز عادي',
  status: 'مؤكد',
  periodHours: '2',
  periodMinutes: '0',
  rentalAmount: '0',
  insuranceAmount: '0',
  companions: '0',
  additions: [],
});

const cardOf = (booking: Booking): Card => ({
  id: booking.id,
  version: booking.version,
  branchId: booking.branchId,
  partyId: booking.partyId,
  vesselId: booking.vesselId,
  documentDate: booking.documentDate,
  startsAt: stamp(booking.startsAt),
  endsAt: stamp(booking.endsAt),
  bookingType: booking.bookingType,
  status: booking.status,
  periodHours: String(booking.periodHours),
  periodMinutes: String(booking.periodMinutes),
  rentalAmount: booking.rentalAmount,
  insuranceAmount: booking.insuranceAmount,
  companions: String(booking.companions),
  additions: booking.additions.map((row) => ({
    id: row.id,
    ...(row.additionId ? { additionId: row.additionId } : {}),
    description: row.description,
    quantity: Number(row.quantity).toString(),
    unitPrice: Number(row.unitPrice).toString(),
  })),
});

const num = (value: string): number => {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** `CalcuAll` — الإضافات، فالإجمالي، فالضريبة، فالصافي. */
const totalsOf = (card: Card, vatRate: number) => {
  const additionsSum = card.additions.reduce((sum, line) => sum + num(line.quantity) * num(line.unitPrice), 0);
  // الإجمالي، ثم الضريبة عليه، ثم الصافي — `CalcuAll` بحذافيره.
  const gross = additionsSum + num(card.rentalAmount) + num(card.insuranceAmount);
  const vat = Math.round(gross * (vatRate / 100) * 100) / 100;
  return { additionsTotal: additionsSum, total: gross, taxAmount: vat, netAmount: gross + vat };
};

const fmt = (value: number, digits = 2) => value.toFixed(digits).replace(/\.00$/, '');

function MarinaBookings() {
  const { can } = useSession();
  const canManage = can('marina.manage');
  const canInvoice = can('marina.invoice');

  const [filters, setFilters] = useState({ number: '', customer: '', from: '', to: '' });
  const [applied, setApplied] = useState<typeof filters | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [line, setLine] = useState<Draft>({ description: '', quantity: '1', unitPrice: '0' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const bookings = useQuery<Booking[]>(() => {
    const params = new URLSearchParams();
    if (applied) {
      if (applied.number.trim()) params.set('number', applied.number.trim());
      if (applied.customer.trim()) params.set('customer', applied.customer.trim());
      if (applied.from) params.set('from', applied.from);
      if (applied.to) params.set('to', applied.to);
    }
    const query = params.toString();
    return apiList<Booking>(`/marina/bookings${query ? `?${query}` : ''}`);
  }, [applied]);

  const marina = useQuery<Marina>(() => apiFetch<Marina>('/marina').then((body) => ((body as { data?: Marina }).data ?? body) as Marina), []);
  // «🎁 الإضافات» — `LoadAdditions`: select id, Name from Additions where IsDeleted=0.
  const definitions = useQuery<AdditionDefinition[]>(() => apiList<AdditionDefinition>('/marina/additions'), []);
  const parties = useQuery<Party[]>(() => listParties(), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);

  const rows = bookings.data ?? [];
  const vessels = marina.data?.vessels ?? [];
  const vatRate = 15;

  const setField = (patch: Partial<Card>) => setCard((current) => (current ? { ...current, ...patch } : current));
  const totals = card ? totalsOf(card, vatRate) : null;

  async function save() {
    if (!card) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        branchId: card.branchId,
        partyId: card.partyId,
        vesselId: card.vesselId,
        documentDate: card.documentDate,
        startsAt: new Date(card.startsAt).toISOString(),
        endsAt: new Date(card.endsAt).toISOString(),
        bookingType: card.bookingType,
        status: card.status,
        periodHours: Number(card.periodHours || 0),
        periodMinutes: Number(card.periodMinutes || 0),
        rentalAmount: card.rentalAmount || '0',
        insuranceAmount: card.insuranceAmount || '0',
        companions: Number(card.companions || 0),
        additions: card.additions.map((row) => ({
          ...(row.additionId ? { additionId: row.additionId } : {}),
          description: row.description,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
        })),
      };
      await (card.id
        ? apiPatch(`/marina/bookings/${card.id}`, { ...payload, ...(card.version ? { version: card.version } : {}) })
        : apiPost('/marina/bookings', payload));
      setNotice('تم حفظ الحجز');
      setCard(null);
      bookings.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(booking: Booking) {
    if (!window.confirm(`هل أنت متأكد من حذف هذا الحجز؟\n\n${booking.number ?? ''} — ${booking.customerName}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/marina/bookings/${booking.id}`);
      setNotice('تم الحذف');
      bookings.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function invoice(booking: Booking) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(`/marina/bookings/${booking.id}/rental-invoice`, {});
      setNotice('تم إصدار فاتورة التأجير');
      bookings.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const openNew = () => {
    setError('');
    setNotice('');
    setCard(emptyCard(branches.data?.[0]?.id ?? '', parties.data?.[0]?.id ?? '', vessels[0]?.id ?? ''));
  };

  return (
    <Screen
      title="⛵ الحجوزات"
      subtitle="حجز مركب لعميل: قيمته ومدته وإضافاته، ثم مجاميعه — «إجمالي الإضافات · الإجمالي · ضريبة 15% · الصافي» كما يحسبها الديسكتوب، ومنه فاتورة التأجير."
      crumbs={['إدارة المراسي', 'الحجوزات']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Link className="btn" href="/marina/violations">
            ⚠️ المخالفات
          </Link>
          {/* «➕» بجوار «🎁 الإضافات» — `btnAddObj_Click` يفتح `frmAdditions`. */}
          <Link className="btn" href="/marina/additions">
            📋 إضافات
          </Link>
          {canManage && (
            <button className="btn primary" type="button" onClick={openNew}>
              ➕ حجز جديد
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {/* «🔍 البحث» — رقم الحجز · اسم العميل أو جواله · من تاريخ وإلى تاريخ. */}
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 130 }}>
            <span>رقم الحجز</span>
            <input className="input" value={filters.number} placeholder="BK-000001" onChange={(event) => setFilters({ ...filters, number: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 200 }}>
            <span>اسم العميل / رقم الجوال</span>
            <input className="input" value={filters.customer} placeholder="🔍 الجوال أو الاسم..." onChange={(event) => setFilters({ ...filters, customer: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 150 }}>
            <span>من تاريخ</span>
            <input className="input" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 150 }}>
            <span>إلى تاريخ</span>
            <input className="input" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </label>
          <button className="btn primary" type="button" onClick={() => setApplied(filters)}>
            🔍 بحث
          </button>
          {applied && (
            <button className="btn" type="button" onClick={() => { setFilters({ number: '', customer: '', from: '', to: '' }); setApplied(null); }}>
              🗑️ تصفية الحقول
            </button>
          )}
        </div>
      </div>

      {bookings.status === 'loading' && <Loading rows={6} />}
      {bookings.status === 'forbidden' && <Forbidden />}
      {bookings.status === 'error' && <ErrorBox message={bookings.error} onRetry={bookings.reload} />}
      {bookings.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📋 بيانات الحجوزات</span>
            <span className="muted">عدد السجلات: {rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty title="لا توجد حجوزات" detail="ابدأ بـ «➕ حجز جديد»: مركب وعميل وقيمة ومدة — والمدة شرط الحفظ." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>🔢 الرقم</th>
                    <th>📅 التاريخ</th>
                    <th>👤 العميل</th>
                    <th>⚓ المركب</th>
                    <th>🚢 نوع الحجز</th>
                    <th className="num">⏱️ المدة</th>
                    <th className="num">💰 القيمة</th>
                    <th className="num">🎁 الإضافات</th>
                    <th className="num">الإجمالي</th>
                    <th className="num">الصافي</th>
                    <th>🔖 حالة الحجز</th>
                    {(canManage || canInvoice) && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} onDoubleClick={() => canManage && setCard(cardOf(row))}>
                      <td dir="ltr">{row.number ?? '—'}</td>
                      <td dir="ltr">{row.documentDate}</td>
                      <td>{row.customerName}</td>
                      <td>
                        {row.vesselCode} — {row.vesselName}
                      </td>
                      <td>{row.bookingType}</td>
                      <td className="num" dir="ltr">
                        {row.periodHours}س {row.periodMinutes}د
                      </td>
                      <td className="num" dir="ltr">{fmt(Number(row.rentalAmount))}</td>
                      <td className="num" dir="ltr">{fmt(Number(row.additionsTotal))}</td>
                      <td className="num" dir="ltr">{fmt(Number(row.total))}</td>
                      <td className="num" dir="ltr">{fmt(Number(row.netAmount))}</td>
                      <td>
                        <span className={`badge${row.statusText === 'مؤكد' ? '' : ' danger'}`}>{row.statusText}</span>
                      </td>
                      {(canManage || canInvoice) && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            {canManage && (
                              <button className="btn sm" type="button" onClick={() => setCard(cardOf(row))}>
                                ✏️ تعديل
                              </button>
                            )}
                            {canInvoice && (
                              <button className="btn sm" type="button" onClick={() => invoice(row)}>
                                🧾 فاتورة
                              </button>
                            )}
                            {canManage && (
                              <button className="btn sm danger" type="button" onClick={() => remove(row)}>
                                🗑️ حذف
                              </button>
                            )}
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

      {card && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 860 }}>
            <div className="modal-head">
              <span className="modal-title">{card.id ? '✏️ تعديل الحجز' : '📋 بيانات الحجوزات'}</span>
              <button className="btn sm" type="button" onClick={() => setCard(null)}>
                ✖ خروج
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <div className="form-grid">
                <label className="field">
                  <span>🔢 الرقم</span>
                  <input className="input" value={card.id ? 'يُصدر عند الحفظ' : 'يُصدر عند الحفظ'} disabled />
                </label>
                <label className="field">
                  <span>📅 التاريخ</span>
                  <input className="input" type="date" value={card.documentDate} onChange={(event) => setField({ documentDate: event.target.value })} />
                </label>
                <label className="field">
                  <span>🏢 الفرع</span>
                  <select className="input" value={card.branchId} onChange={(event) => setField({ branchId: event.target.value })}>
                    <option value="">— اختر فرعاً —</option>
                    {(branches.data ?? []).map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.nameAr ?? branch.code ?? branch.id}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>👤 العميل *</span>
                  <select className="input" value={card.partyId} onChange={(event) => setField({ partyId: event.target.value })}>
                    <option value="">— اختر عميلاً —</option>
                    {(parties.data ?? []).map((party) => (
                      <option key={party.id} value={party.id}>{party.name}{party.phone ? ` · ${party.phone}` : ''}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>⚓ المركب *</span>
                  <select className="input" value={card.vesselId} onChange={(event) => setField({ vesselId: event.target.value })}>
                    <option value="">— اختر مركباً —</option>
                    {vessels.map((vessel) => (
                      <option key={vessel.id} value={vessel.id}>{vessel.code} — {vessel.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>🔖 حالة الحجز</span>
                  <select className="input" value={card.status} onChange={(event) => setField({ status: event.target.value })}>
                    <option value="مؤكد">مؤكد</option>
                    <option value="غير مؤكد">غير مؤكد</option>
                  </select>
                </label>
                <label className="field">
                  <span>📅 تاريخ الحجز</span>
                  <input className="input" type="datetime-local" value={card.startsAt} onChange={(event) => setField({ startsAt: event.target.value })} />
                </label>
                <label className="field">
                  <span>🕐 حتى</span>
                  <input className="input" type="datetime-local" value={card.endsAt} onChange={(event) => setField({ endsAt: event.target.value })} />
                </label>
                <label className="field">
                  <span>💰 القيمة</span>
                  <input className="input numeric" value={card.rentalAmount} onChange={(event) => setField({ rentalAmount: event.target.value })} />
                </label>
                <label className="field">
                  <span>⏱️ المدة ساعة</span>
                  <input className="input numeric" value={card.periodHours} onChange={(event) => setField({ periodHours: event.target.value })} />
                </label>
                <label className="field">
                  <span>دقيقة</span>
                  <input className="input numeric" value={card.periodMinutes} onChange={(event) => setField({ periodMinutes: event.target.value })} />
                </label>
                <label className="field">
                  <span>🛡️ التأمين</span>
                  <input className="input numeric" value={card.insuranceAmount} onChange={(event) => setField({ insuranceAmount: event.target.value })} />
                </label>
                <label className="field">
                  <span>👥 المرافقون</span>
                  <input className="input numeric" value={card.companions} onChange={(event) => setField({ companions: event.target.value })} />
                </label>
              </div>

              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label" style={{ margin: 0 }}>🚢 نوع الحجز</legend>
                <div className="row" style={{ gap: 12 }}>
                  {['حجز عادي', 'بحر مفتوح'].map((type) => (
                    <label key={type} className="row" style={{ gap: 6 }}>
                      <input type="radio" name="bookingType" checked={card.bookingType === type} onChange={() => setField({ bookingType: type })} />
                      <span>{type}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* 🎁 الإضافات — الوصف · العدد · السعر · الإجمالي · 🗑️ حذف */}
              <fieldset className="card tight" style={{ margin: 0 }}>
                <legend className="group-label" style={{ margin: 0 }}>🎁 الإضافات</legend>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                    <span>🎁 الإضافات</span>
                    <select
                      className="input"
                      value={line.additionId ?? ''}
                      onChange={(event) => {
                        const chosen = (definitions.data ?? []).find((row) => row.id === event.target.value);
                        // `cmbAdditions_SelectionChanged` — «السعر» يُكتب من `SalePrice`.
                        setLine(
                          chosen
                            ? { additionId: chosen.id, description: chosen.name, quantity: line.quantity, unitPrice: String(Number(chosen.salePrice)) }
                            : { description: '', quantity: line.quantity, unitPrice: '0' },
                        );
                      }}
                    >
                      <option value="">— بلا تعريف —</option>
                      {(definitions.data ?? []).map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.number} · {row.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
                    <span>الوصف</span>
                    <input className="input" value={line.description} onChange={(event) => setLine({ ...line, description: event.target.value })} />
                  </label>
                  <label className="field" style={{ margin: 0, width: 90 }}>
                    <span>الكمية</span>
                    <input className="input numeric" value={line.quantity} onChange={(event) => setLine({ ...line, quantity: event.target.value })} />
                  </label>
                  <label className="field" style={{ margin: 0, width: 110 }}>
                    <span>السعر</span>
                    <input className="input numeric" value={line.unitPrice} onChange={(event) => setLine({ ...line, unitPrice: event.target.value })} />
                  </label>
                  <button
                    className="btn primary"
                    type="button"
                    title="إضافة"
                    onClick={() => {
                      if (!line.description.trim()) return;
                      // `Add2Dgv` — إضافةٌ في الشبكة أصلاً تُجمَع كمّيتها على صفّها.
                      const at = line.additionId ? card.additions.findIndex((row) => row.additionId === line.additionId) : -1;
                      const additions =
                        at >= 0
                          ? card.additions.map((row, index) =>
                              index === at ? { ...row, quantity: (num(row.quantity) + num(line.quantity)).toString() } : row,
                            )
                          : [...card.additions, { ...line }];
                      setCard({ ...card, additions });
                      setLine({ description: '', quantity: '1', unitPrice: '0' });
                    }}
                  >
                    ✔
                  </button>
                </div>
                {card.additions.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>🎁 الإضافة</th>
                          <th>الوصف</th>
                          <th className="num">العدد</th>
                          <th className="num">السعر</th>
                          <th className="num">الإجمالي</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {card.additions.map((row, index) => (
                          <tr key={`${row.description}-${index}`}>
                            <td dir="ltr">{(definitions.data ?? []).find((item) => item.id === row.additionId)?.number ?? '—'}</td>
                            <td>{row.description}</td>
                            <td className="num" dir="ltr">{row.quantity}</td>
                            <td className="num" dir="ltr">{row.unitPrice}</td>
                            <td className="num" dir="ltr">{fmt(num(row.quantity) * num(row.unitPrice))}</td>
                            <td>
                              <button
                                className="btn sm danger"
                                type="button"
                                onClick={() => setCard({ ...card, additions: card.additions.filter((_, i) => i !== index) })}
                              >
                                🗑️ حذف
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </fieldset>

              {totals && (
                <div className="row" style={{ gap: 16, flexWrap: 'wrap', fontWeight: 700 }}>
                  <span>إجمالي الإضافات: <span dir="ltr">{fmt(totals.additionsTotal)}</span></span>
                  <span>الإجمالي: <span dir="ltr">{fmt(totals.total)}</span></span>
                  <span>ضريبة {vatRate}%: <span dir="ltr">{fmt(totals.taxAmount)}</span></span>
                  <span>الصافي: <span dir="ltr">{fmt(totals.netAmount)}</span></span>
                </div>
              )}
              <p className="muted" style={{ margin: 0 }}>
                «يجب تحديد مدة الحجز» — الساعة والدقيقة لا يقفان معاً على صفر.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={() => void save()} disabled={busy}>
                💾 حفظ
              </button>
              {/* «🔄 جديد» = `CLR` — كل الصناديق تعود فارغة. */}
              <button className="btn" type="button" disabled={busy} onClick={() => setCard(emptyCard(card.branchId, card.partyId, card.vesselId))}>
                🔄 جديد
              </button>
              <button className="btn danger" type="button" onClick={() => setCard(null)} disabled={busy}>
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
      <MarinaBookings />
    </Suspense>
  );
}
