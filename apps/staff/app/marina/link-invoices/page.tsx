'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { dateTime, listParties, money, partyLabel, statusLabel, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Vessel = { id: string; code: string; name: string };
type Marina = { groups: Array<{ id: string; name: string }>; vessels: Vessel[] };
type Booking = { id: string; vesselId: string; partyId: string; startsAt: string; endsAt: string; insuranceAmount: string; status: string };
type RentalInvoice = {
  id: string;
  bookingId: string;
  salesInvoiceId: string | null;
  periodAmount: string;
  additionsAmount: string;
  insuranceAmount: string;
  total: string;
  taxAmount: string;
  netAmount: string;
  /** 🔢 الرقم — رقم الحجز, as `frmInvoiceRentSrch` shows it. */
  number: string | null;
  documentDate: string;
  customerName: string;
  customerPhone: string;
  status: string;
  createdAt: string;
};

export default function MarinaLinkInvoicesPage() {
  const { can } = useSession();
  const [filters, setFilters] = useState({ customer: '', from: '', to: '', minNet: '', maxNet: '' });
  const [applied, setApplied] = useState<typeof filters | null>(null);
  const rentals = useQuery<RentalInvoice[]>(() => {
    // «🔍 خيارات البحث» — `frmInvoiceRentSrch`: العميل أو جواله، التاريخان، والصافي من/إلى.
    const params = new URLSearchParams();
    if (applied) {
      if (applied.customer.trim()) params.set('customer', applied.customer.trim());
      if (applied.from) params.set('from', applied.from);
      if (applied.to) params.set('to', applied.to);
      if (applied.minNet) params.set('minNet', applied.minNet);
      if (applied.maxNet) params.set('maxNet', applied.maxNet);
    }
    const query = params.toString();
    return apiList<RentalInvoice>(`/marina/rental-invoices${query ? `?${query}` : ''}`);
  }, [applied]);
  const uninvoiced = useQuery<Booking[]>(() => apiList<Booking>('/marina/bookings/uninvoiced'), []);
  const bookings = useQuery<Booking[]>(() => apiList<Booking>('/marina/bookings'), []);
  const marina = useQuery<Marina>(() => apiData<Marina>('/marina'), []);
  const parties = useQuery<Party[]>(() => listParties(), []);
  const vessels = marina.data?.vessels ?? [];

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const vesselName = (id: string) => {
    const vessel = vessels.find((row) => row.id === id);
    return vessel ? `${vessel.code} — ${vessel.name}` : id;
  };
  const customerName = (id: string) => {
    const party = (parties.data ?? []).find((row) => row.id === id);
    return party ? partyLabel(party) : id;
  };
  const bookingVessel = (bookingId: string) => {
    const booking = (bookings.data ?? []).find((row) => row.id === bookingId);
    return booking ? vesselName(booking.vesselId) : '—';
  };
  const chosen = Object.entries(selected).filter(([, on]) => on).map(([id]) => id);

  async function link() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (chosen.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر حجزاً واحداً على الأقل.');
      const result = await apiPost<{ linked: Array<{ bookingId: string }>; failed: Array<{ bookingId: string; message: string }> }>('/marina/rental-invoices/link', {
        bookingIds: chosen,
      });
      const linked = result.linked.length;
      const failed = result.failed.length;
      setNotice({
        kind: failed ? 'info' : 'ok',
        text: failed ? `تم ربط ${linked} حجزاً، وتعذّر ربط ${failed}: ${result.failed.map((row) => row.message).join(' / ')}` : `تم ربط ${linked} حجزاً بفواتير تأجير.`,
      });
      setSelected({});
      rentals.reload();
      uninvoiced.reload();
      bookings.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="ربط الفواتير"
      subtitle="إصدار فاتورة التأجير للحجوزات التي لم تُفوتر بعد، وعرض ارتباط كل فاتورة تأجير بفاتورة المبيعات المقابلة."
      crumbs={['إدارة المراسي', 'العمليات']}
      actions={
        can('marina.invoice') ? (
          <button className="btn primary" type="button" onClick={link} disabled={busy || chosen.length === 0}>
            {busy ? 'جارٍ الربط…' : `ربط المحدد (${chosen.length})`}
          </button>
        ) : null
      }
    >
      <Notice notice={notice} />

      <div className="card">
        <h2>حجوزات بلا فاتورة تأجير</h2>
        <QueryView query={uninvoiced} empty="كل الحجوزات مفوترة" emptyDetail="لا يوجد حجز بدون فاتورة تأجير.">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'pick',
                  header: '',
                  cell: (row) => (
                    <input
                      type="checkbox"
                      checked={Boolean(selected[row.id])}
                      onChange={(event) => setSelected((current) => ({ ...current, [row.id]: event.target.checked }))}
                      aria-label="تحديد الحجز"
                    />
                  ),
                },
                { key: 'vessel', header: 'المركب', cell: (row) => vesselName(row.vesselId) },
                { key: 'customer', header: 'العميل', cell: (row) => customerName(row.partyId) },
                { key: 'from', header: 'من', align: 'ltr', cell: (row) => dateTime(row.startsAt) },
                { key: 'to', header: 'إلى', align: 'ltr', cell: (row) => dateTime(row.endsAt) },
                { key: 'insurance', header: 'التأمين', align: 'num', cell: (row) => money(row.insuranceAmount) },
                { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
              ]}
            />
          )}
        </QueryView>
      </div>

      {/* «🔍 خيارات البحث» — `Form_WPF/frmInvoiceRentSrch.xaml` («بحث الفواتير»). */}
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 200 }}>
            <span>العميل</span>
            <input
              className="input"
              value={filters.customer}
              placeholder="🔍 الاسم أو الجوال..."
              onChange={(event) => setFilters({ ...filters, customer: event.target.value })}
            />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 150 }}>
            <span>التاريخ من</span>
            <input className="input" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 150 }}>
            <span>إلى</span>
            <input className="input" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 120 }}>
            <span>الصافي من</span>
            <input className="input numeric" value={filters.minNet} onChange={(event) => setFilters({ ...filters, minNet: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 120 }}>
            <span>إلى</span>
            <input className="input numeric" value={filters.maxNet} onChange={(event) => setFilters({ ...filters, maxNet: event.target.value })} />
          </label>
          <button className="btn primary" type="button" onClick={() => setApplied(filters)}>
            🔍 بحث
          </button>
          {applied && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setFilters({ customer: '', from: '', to: '', minNet: '', maxNet: '' });
                setApplied(null);
              }}
            >
              🗑️ تصفية الحقول
            </button>
          )}
        </div>
      </div>

      {/* «🧾 قائمة الفواتير» — الرقم · 📅 التاريخ · 👤 العميل · 💰 الصافي · 📱 الجوال.
          `Form_WPF/frmInvoiceRentSrch.xaml` («بحث الفواتير»). */}
      <QueryView query={rentals} empty="لا توجد فواتير تأجير" emptyDetail="أصدر فاتورة تأجير من الحجوزات أعلاه.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number ?? '—' },
              { key: 'date', header: '📅 التاريخ', align: 'ltr', cell: (row) => row.documentDate },
              { key: 'customer', header: '👤 العميل', cell: (row) => row.customerName || customerName(row.bookingId) },
              { key: 'vessel', header: 'المركب', cell: (row) => bookingVessel(row.bookingId) },
              { key: 'period', header: 'قيمة الفترة', align: 'num', cell: (row) => money(row.periodAmount) },
              { key: 'additions', header: 'الإضافات', align: 'num', cell: (row) => money(row.additionsAmount) },
              { key: 'total', header: 'الإجمالي', align: 'num', cell: (row) => money(row.total) },
              { key: 'tax', header: 'الضريبة', align: 'num', cell: (row) => money(row.taxAmount) },
              { key: 'net', header: '💰 الصافي', align: 'num', cell: (row) => money(row.netAmount) },
              { key: 'phone', header: '📱 الجوال', align: 'ltr', cell: (row) => row.customerPhone || '—' },
              {
                key: 'sales',
                header: 'فاتورة المبيعات',
                cell: (row) => (row.salesInvoiceId ? <span className="badge">مرتبطة</span> : <span className="badge">غير مرتبطة</span>),
              },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
