'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { listPeriods, money, periodRange, statusLabel, type FiscalPeriod } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Run = { id: string; yearMonth: string; status: string; currency: string; periodId: string | null; postedAt: string | null; paidAt: string | null };
type PreviewLine = { employeeId: string; employeeName: string; gross: string; additions: string; deductions: string; net: string };
type Preview = { lines: PreviewLine[] };

const currentMonth = () => new Date().toISOString().slice(0, 7);

export default function PayrollPage() {
  const { can } = useSession();
  const runs = useQuery<Run[]>(() => apiList<Run>('/hrm/payroll/runs'), []);
  const periods = useQuery<FiscalPeriod[]>(() => listPeriods(), []);

  const [yearMonth, setYearMonth] = useState(currentMonth());
  const [periodId, setPeriodId] = useState('');
  const [preview, setPreview] = useState<Preview | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      runs.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const previewTotal = (preview?.lines ?? []).reduce((sum, line) => sum + Number(line.net), 0);

  return (
    <Screen
      title="إستحقاق راتب"
      subtitle="احسب مسيّر الشهر من بطاقات الموظفين والحوافز المعتمدة، ثم رحّله واصرفه."
      crumbs={['الموظفين والرواتب', 'العمليات']}
    >
      <div className="card">
        <h2>مسيّر جديد</h2>
        <div className="form-grid">
          <label className="field">
            <span>الشهر (YYYY-MM)</span>
            <input className="input" dir="ltr" value={yearMonth} onChange={(event) => setYearMonth(event.target.value)} />
          </label>
          <label className="field">
            <span>الفترة المحاسبية</span>
            <select className="input" value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
              <option value="">— تُحدَّد عند الترحيل —</option>
              {(periods.data ?? []).map((period) => {
                const range = periodRange(period);
                return (
                  <option key={period.id} value={period.id}>
                    {`${period.name} (${range.from} → ${range.to})`}
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        <Notice notice={notice} />
        <div className="row">
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await apiData<Preview>('/hrm/payroll/preview', { method: 'POST', body: JSON.stringify({ yearMonth }) });
                setPreview(result);
              }, 'تم احتساب المعاينة.')
            }
          >
            معاينة الاستحقاق
          </button>
          {can('hrm.manage') && (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => run(() => apiPost('/hrm/payroll/runs', { yearMonth, periodId: periodId || undefined }), 'تم إنشاء المسيّر كمسودة.')}
            >
              إنشاء المسيّر
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="card">
          <h2>معاينة {yearMonth}</h2>
          {preview.lines.length === 0 ? (
            <p className="muted">لا يوجد موظفون نشطون لاحتساب رواتبهم.</p>
          ) : (
            <>
              <DataTable
                rows={preview.lines}
                rowKey={(row) => row.employeeId}
                columns={[
                  { key: 'name', header: 'الموظف', cell: (row) => row.employeeName },
                  { key: 'gross', header: 'الإجمالي', align: 'num', cell: (row) => money(row.gross) },
                  { key: 'additions', header: 'الإضافات', align: 'num', cell: (row) => money(row.additions) },
                  { key: 'deductions', header: 'الخصومات', align: 'num', cell: (row) => money(row.deductions) },
                  { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.net) },
                ]}
              />
              <dl className="kv">
                <dt>إجمالي الصافي</dt>
                <dd>
                  <strong>{money(previewTotal)}</strong>
                </dd>
              </dl>
            </>
          )}
        </div>
      )}

      <QueryView query={runs} empty="لا توجد مسيّرات" emptyDetail="أنشئ مسيّر الشهر لاحتساب الرواتب.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'month', header: 'الشهر', align: 'ltr', cell: (row) => <Link href={`/hrm/payroll/${row.id}`}>{row.yearMonth}</Link> },
              { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
              { key: 'currency', header: 'العملة', align: 'ltr', cell: (row) => row.currency },
              { key: 'posted', header: 'مُرحّل', align: 'ltr', cell: (row) => (row.postedAt ? row.postedAt.slice(0, 10) : '—') },
              { key: 'paid', header: 'مدفوع', align: 'ltr', cell: (row) => (row.paidAt ? row.paidAt.slice(0, 10) : '—') },
              { key: 'wps', header: 'حماية الأجور', cell: (row) => <Link href={`/hrm/payroll/${row.id}/wps`}>تصدير</Link> },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
