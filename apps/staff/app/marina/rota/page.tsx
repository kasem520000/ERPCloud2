'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { shortDate, today } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Vessel = { id: string; code: string; name: string; groupId?: string | null };
type Marina = { groups: Array<{ id: string; name: string }>; vessels: Vessel[] };
type PlanLine = { lineNo: number; vesselId: string; periodLabel: string | null };
type Plan = { id: string; name: string; planDate: string; groupId: string | null; lines: PlanLine[] };

const PERIODS = ['الفترة الصباحية', 'فترة الظهيرة', 'الفترة المسائية', 'فترة الليل'];

export default function MarinaRotaPage() {
  const { can } = useSession();
  const [day, setDay] = useState('');
  const plans = useQuery<Plan[]>(() => apiList<Plan>(`/marina/operation-plans${day ? `?date=${day}` : ''}`), [day]);
  const marina = useQuery<Marina>(() => apiData<Marina>('/marina'), []);
  const vessels = marina.data?.vessels ?? [];
  const groups = marina.data?.groups ?? [];

  const [name, setName] = useState('');
  const [planDate, setPlanDate] = useState(today());
  const [groupId, setGroupId] = useState('');
  const [lines, setLines] = useState<Array<{ vesselId: string; periodLabel: string }>>([{ vesselId: '', periodLabel: PERIODS[0] ?? '' }]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  // 📋 تحضير المراكب — `frmAttendM` شبكته `رقم الدور · المركب · حضور/غياب · إعادة احتساب الرحلات`
  const [attendance, setAttendance] = useState<Record<string, boolean>>({});
  const [tripCount, setTripCount] = useState<number | null>(null);

  const vesselName = (id: string) => {
    const vessel = vessels.find((row) => row.id === id);
    return vessel ? `${vessel.code} — ${vessel.name}` : id;
  };
  const groupName = (id: string | null) => groups.find((row) => row.id === id)?.name ?? 'كل المجموعات';

  function updateLine(index: number, patch: Partial<{ vesselId: string; periodLabel: string }>) {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  }

  async function createPlan(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const filled = lines.filter((line) => line.vesselId);
      if (filled.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أضف مركباً واحداً على الأقل إلى خطة الدور.');
      await apiPost('/marina/operation-plans', {
        name,
        planDate,
        groupId: groupId || undefined,
        lines: filled.map((line) => ({ vesselId: line.vesselId, periodLabel: line.periodLabel || undefined })),
      });
      setNotice({ kind: 'ok', text: 'تم حفظ خطة الدور.' });
      setName('');
      setLines([{ vesselId: '', periodLabel: PERIODS[0] ?? '' }]);
      plans.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  // `frmAttendM` — إعادة احتساب الرحلات: عدد المراكب الحاضرة في خطة اليوم
  const recalcTrips = (plan: Plan) => {
    const present = plan.lines.filter((line) => attendance[`${plan.id}:${line.lineNo}`] !== false).length;
    setTripCount(present);
    setNotice({ kind: 'info', text: `🔄 إعادة احتساب الرحلات: ${present} مركب حاضر من ${plan.lines.length} — كل مركب حاضر = رحلة واحدة في اليوم.` });
  };

  return (
    <Screen
      title="خطة الدور — تحضير المراكب"
      subtitle="ترتيب دور المراكب على فترات اليوم — `frmAttendM` «تحضير المراكب»: رقم الدور · المركب · حضور/غياب · إعادة احتساب الرحلات. الخطة تنظيمية ولا تنشئ حجزاً ولا فاتورة."
      crumbs={['إدارة المراسي', 'العمليات']}
    >
      {can('marina.manage') && (
        <form className="card" onSubmit={createPlan}>
          <h2>خطة دور جديدة</h2>
          <div className="form-grid">
            <label className="field">
              <span>اسم الخطة *</span>
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} required placeholder="دور يوم الخميس" />
            </label>
            <label className="field">
              <span>التاريخ *</span>
              <input className="input" dir="ltr" type="date" value={planDate} onChange={(event) => setPlanDate(event.target.value)} required />
            </label>
            <label className="field">
              <span>المجموعة</span>
              <select className="input" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                <option value="">— كل المجموعات —</option>
                {groups.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h3>ترتيب الدور</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>المركب</th>
                  <th>الفترة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td className="num">{index + 1}</td>
                    <td>
                      <select className="input" value={line.vesselId} onChange={(event) => updateLine(index, { vesselId: event.target.value })}>
                        <option value="">— اختر —</option>
                        {vessels.map((row) => (
                          <option key={row.id} value={row.id}>
                            {`${row.code} — ${row.name}`}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className="input" value={line.periodLabel} onChange={(event) => updateLine(index, { periodLabel: event.target.value })}>
                        {PERIODS.map((period) => (
                          <option key={period} value={period}>
                            {period}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button className="btn sm" type="button" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn sm" type="button" onClick={() => setLines((current) => [...current, { vesselId: '', periodLabel: PERIODS[0] ?? '' }])}>
            + مركب
          </button>

          <Notice notice={notice} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ الخطة'}
          </button>
        </form>
      )}

      <div className="toolbar">
        <label className="field">
          <span>تصفية بالتاريخ</span>
          <input className="input" dir="ltr" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
        </label>
        {day && (
          <button className="btn sm" type="button" onClick={() => setDay('')}>
            كل التواريخ
          </button>
        )}
      </div>

      {!can('marina.manage') && <Notice notice={notice} />}

      <QueryView query={plans} empty="لا توجد خطط دور" emptyDetail="أنشئ خطة لترتيب دور المراكب على فترات اليوم.">
        {(rows) => (
          <>
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.planDate) },
                { key: 'name', header: 'الخطة', cell: (row) => row.name },
                { key: 'group', header: 'المجموعة', cell: (row) => groupName(row.groupId) },
                { key: 'count', header: 'عدد المراكب', align: 'num', cell: (row) => row.lines.length },
              ]}
            />
            {rows.map((plan) => (
              <div className="card" key={plan.id}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>
                    {plan.name} — {shortDate(plan.planDate)} — {groupName(plan.groupId)}
                  </h3>
                  <button className="btn sm" type="button" onClick={() => recalcTrips(plan)}>
                    🔄 إعادة احتساب الرحلات
                  </button>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>رقم الدور</th>
                        <th>المركب</th>
                        <th>الفترة</th>
                        <th>حضور/غياب</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.lines.map((line) => {
                        const key = `${plan.id}:${line.lineNo}`;
                        const present = attendance[key] !== false;
                        return (
                          <tr key={line.lineNo}>
                            <td className="num">{line.lineNo}</td>
                            <td>{vesselName(line.vesselId)}</td>
                            <td>{line.periodLabel ?? '—'}</td>
                            <td>
                              <label className="check">
                                <input
                                  type="checkbox"
                                  checked={present}
                                  onChange={(e) => setAttendance((prev) => ({ ...prev, [key]: e.target.checked }))}
                                />
                                <span>{present ? '✅ حضور' : '❌ غياب'}</span>
                              </label>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {tripCount !== null && <p className="hint">إجمالي الرحلات المحتسبة: {tripCount}</p>}
              </div>
            ))}
          </>
        )}
      </QueryView>
    </Screen>
  );
}
