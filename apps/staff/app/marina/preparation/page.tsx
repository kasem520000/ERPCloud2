'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { dateTime, shortDate, statusLabel, today } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Vessel = { id: string; code: string; name: string };
type Marina = { groups: Array<{ id: string; name: string }>; vessels: Vessel[] };
type Booking = { id: string; vesselId: string; partyId: string; startsAt: string; endsAt: string; companions: number | null; status: string };
type Preparation = {
  id: string;
  bookingId: string;
  vesselId: string;
  preparedOn: string;
  status: string;
  fuelLevel: string | null;
  lifeJackets: number;
  notes: string | null;
  preparedAt: string;
  returnedAt: string | null;
};

const STATUS_LABELS: Record<string, string> = { prepared: 'جاهز / بالخارج', returned: 'عاد للمرسى' };

export default function MarinaPreparationPage() {
  const { can } = useSession();
  const [day, setDay] = useState(today());
  const preparations = useQuery<Preparation[]>(() => apiList<Preparation>(`/marina/preparations${day ? `?date=${day}` : ''}`), [day]);
  const bookings = useQuery<Booking[]>(() => apiList<Booking>('/marina/bookings'), []);
  const marina = useQuery<Marina>(() => apiData<Marina>('/marina'), []);
  const vessels = marina.data?.vessels ?? [];
  const bookingRows = bookings.data ?? [];

  const [bookingId, setBookingId] = useState('');
  const [fuelLevel, setFuel] = useState('full');
  const [lifeJackets, setJackets] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const vesselName = (id: string) => {
    const vessel = vessels.find((row) => row.id === id);
    return vessel ? `${vessel.code} — ${vessel.name}` : id;
  };
  const booking = bookingRows.find((row) => row.id === bookingId);
  const preparedIds = new Set((preparations.data ?? []).map((row) => row.bookingId));
  const pending = bookingRows.filter((row) => !preparedIds.has(row.id) && !['returned', 'cancelled'].includes(row.status));

  function reload() {
    preparations.reload();
    bookings.reload();
  }

  async function act(action: () => Promise<unknown>, okText: string) {
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (!bookingId) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر حجزاً أولاً.');
      await apiPost(`/marina/bookings/${bookingId}/preparation`, {
        preparedOn: day || undefined,
        fuelLevel,
        lifeJackets: lifeJackets ? Number(lifeJackets) : 0,
        notes: notes || undefined,
      });
      setNotice({ kind: 'ok', text: 'تم تحضير المركب وتحوّل الحجز إلى «جاهز».' });
      setBookingId('');
      setJackets('');
      setNotes('');
      reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="تحضير المراكب"
      subtitle="قائمة تحضير ما قبل الإبحار: الوقود وسترات النجاة لكل مرافق، ثم تسجيل عودة المركب. لا يمكن تحضير الحجز مرتين."
      crumbs={['إدارة المراسي', 'العمليات']}
    >
      {can('marina.manage') && (
        <form className="card" onSubmit={prepare}>
          <h2>تحضير حجز</h2>
          <div className="form-grid">
            <label className="field wide">
              <span>الحجز *</span>
              <select className="input" value={bookingId} onChange={(event) => setBookingId(event.target.value)} required>
                <option value="">— اختر حجزاً لم يُحضَّر بعد —</option>
                {pending.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`${vesselName(row.vesselId)} — ${dateTime(row.startsAt)} — مرافقون: ${row.companions ?? 0}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>تاريخ التحضير</span>
              <input className="input" dir="ltr" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
            </label>
            <label className="field">
              <span>مستوى الوقود</span>
              <select className="input" value={fuelLevel} onChange={(event) => setFuel(event.target.value)}>
                <option value="full">ممتلئ</option>
                <option value="three_quarters">¾</option>
                <option value="half">نصف</option>
                <option value="quarter">¼</option>
                <option value="empty">فارغ</option>
              </select>
            </label>
            <label className="field">
              <span>سترات النجاة{booking ? ` (المطلوب ${booking.companions ?? 0})` : ''}</span>
              <input className="input" dir="ltr" inputMode="numeric" value={lifeJackets} onChange={(event) => setJackets(event.target.value)} />
            </label>
            <label className="field wide">
              <span>ملاحظات</span>
              <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="أعطال، نواقص، ملاحظات السلامة" />
            </label>
          </div>
          <Notice notice={notice} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'تسجيل التحضير'}
          </button>
        </form>
      )}

      {!can('marina.manage') && <Notice notice={notice} />}

      <QueryView query={preparations} empty="لا توجد تحضيرات في هذا اليوم" emptyDetail="اختر تاريخاً آخر أو سجِّل تحضيراً جديداً.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'vessel', header: 'المركب', cell: (row) => vesselName(row.vesselId) },
              { key: 'day', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.preparedOn) },
              { key: 'fuel', header: 'الوقود', cell: (row) => row.fuelLevel ?? '—' },
              { key: 'jackets', header: 'سترات النجاة', align: 'num', cell: (row) => row.lifeJackets },
              { key: 'notes', header: 'ملاحظات', cell: (row) => row.notes ?? '—' },
              { key: 'prepared', header: 'وقت التحضير', align: 'ltr', cell: (row) => dateTime(row.preparedAt) },
              { key: 'returned', header: 'وقت العودة', align: 'ltr', cell: (row) => (row.returnedAt ? dateTime(row.returnedAt) : '—') },
              { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STATUS_LABELS[row.status] ?? statusLabel(row.status)}</span> },
              {
                key: 'actions',
                header: '',
                cell: (row) =>
                  row.status === 'prepared' && can('marina.manage') ? (
                    <button className="btn sm primary" type="button" onClick={() => act(() => apiPost(`/marina/preparations/${row.id}/return`, {}), 'تم تسجيل عودة المركب.')}>
                      تسجيل العودة
                    </button>
                  ) : null,
              },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
