'use client';

import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { downloadCsv } from '../../../lib/accounts';
import { apiFetch } from '../../../lib/api';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 💼 تقرير الرواتب — `Form_WPF/frmRptSalary.xaml` («تقرير الرواتب»).
 *
 * The window is `الشهر:` · `السنة:` · `كل الفترة` (checked, and it disables both boxes)
 * · `🔍 عرض` · `💰 سند استلام راتب لموظف`, over a grid «💼 بيانات الرواتب» of
 * `م · SalId · رقم السند · 👤 الموظف · الراتب الأساسي · بدل سكن · بدل مواصلات · الحوافز ·
 * 💰 الإجمالي · الخصومات · 💵 صافي الراتب · 👁️ عرض`, with `💰 إجمالي الرواتب:` in the
 * footer. `btnShow_Click` (L58) reads `SalaryPay` — the cloud's `salary_payments`, the
 * إذن صرف of part three — with `IS_Deleted=0`, narrowed by year and month unless
 * «كل الفترة» is on.
 *
 * Two things are said plainly rather than invented:
 *
 *   • `SalId` is the window's own key for the payment (it is what «👁️ عرض» navigates
 *     with). The cloud links by the same id, so the column is not printed — `رقم السند`
 *     is the number a human reads.
 *   • `👁️ عرض` opens `frmSalaryPay` *navigated to* that one إذن. The cloud's payment
 *     screen is a list, not a card, so the column waits for it to open one document by
 *     `?id=` — the same deferral part three recorded for «الأول/السابق/التالي/الأخير».
 *
 * `gross` is `الصافي + الخصومات`: the window's own `tot_salary + Houses + Travel +
 * salary_add` has no room for the four allowances the cloud's إذن carries
 * (`other_allowances`, part three), and a gross that did not add up to the صافي printed
 * on the very same payment would be a lie.
 */
type Row = {
  seq: number;
  id: string;
  number: string;
  employeeNo: string | null;
  employeeName: string;
  branchName: string | null;
  yearMonth: string;
  month: string;
  year: string;
  paymentDate: string;
  basic: string;
  housing: string;
  transport: string;
  additions: string;
  gross: string;
  deductions: string;
  net: string;
  posted: boolean;
  voucherNumber: string | null;
};

type Summary = { total: string; gross: string; deductions: string; count: number };

type Envelope = { allPeriod: boolean; month: string | null; year: string | null; branchId: string | null; summary: Summary; rows: Row[] };

const EMPTY: Summary = { total: '0', gross: '0', deductions: '0', count: 0 };

function SalaryReport() {
  const now = new Date();
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [allPeriod, setAllPeriod] = useState(true);
  const [applied, setApplied] = useState({ month: '', year: '', allPeriod: true });

  const report = useQuery<Envelope>(() => {
    const params = new URLSearchParams();
    if (!applied.allPeriod) {
      if (applied.month) params.set('month', applied.month);
      if (applied.year) params.set('year', applied.year);
      params.set('all_period', 'false');
    }
    const query = params.toString();
    return apiFetch<{ data: Envelope }>(`/hrm/reports/salary${query ? `?${query}` : ''}`).then((body) => body.data);
  }, [applied]);

  const rows = report.data?.rows ?? [];
  const totals = report.data?.summary ?? EMPTY;

  return (
    <Screen
      title="تقرير الرواتب"
      subtitle="💼 كل إذن صرف عن كل شهر — «كل الفترة» تعرضها كلها، والشهر والسنة يضيّقانها."
      crumbs={['الموظفين والرواتب', 'التقارير']}
      actions={
        <>
          <button className="btn" type="button" onClick={() => window.print()} disabled={rows.length === 0}>
            🖨️ طباعة
          </button>
          <button
            className="btn"
            type="button"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(
                'salary-report.csv',
                ['م', 'رقم السند', 'الموظف', 'الشهر', 'السنة', 'الراتب الأساسي', 'بدل سكن', 'بدل مواصلات', 'الحوافز', 'الإجمالي', 'الخصومات', 'صافي الراتب'],
                rows.map((row) => [
                  row.seq,
                  row.number,
                  row.employeeName,
                  row.month,
                  row.year,
                  row.basic,
                  row.housing,
                  row.transport,
                  row.additions,
                  row.gross,
                  row.deductions,
                  row.net,
                ]),
              )
            }
          >
            📊 تصدير CSV
          </button>
        </>
      }
    >
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, width: 120 }}>
            <span>الشهر:</span>
            <input
              className="input"
              type="number"
              min={1}
              max={12}
              dir="ltr"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              disabled={allPeriod}
            />
          </label>
          <label className="field" style={{ margin: 0, width: 140 }}>
            <span>السنة:</span>
            <input
              className="input"
              type="number"
              min={2000}
              dir="ltr"
              value={year}
              onChange={(event) => setYear(event.target.value)}
              disabled={allPeriod}
            />
          </label>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={allPeriod} onChange={(event) => setAllPeriod(event.target.checked)} />
            كل الفترة
          </label>
          <button
            className="btn primary"
            type="button"
            onClick={() => setApplied({ month, year, allPeriod })}
          >
            🔍 عرض
          </button>
          <a className="btn" href="/hrm/salary-payments">
            💰 سند استلام راتب لموظف
          </a>
        </div>
      </div>

      {report.status === 'loading' && <Loading />}
      {report.status === 'forbidden' && <Forbidden />}
      {report.status === 'error' && <ErrorBox message={report.error} onRetry={report.reload} />}
      {report.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="💰 إجمالي الرواتب" value={money(totals.total)} tone="ok" />
            <StatTile label="💰 الإجمالي" value={money(totals.gross)} tone="brand" />
            <StatTile label="الخصومات" value={money(totals.deductions)} />
            <StatTile label="عدد الإذونات" value={String(totals.count)} />
          </StatTiles>

          {rows.length === 0 ? (
            <Empty title="لا إذنات صرف في هذه الفترة" detail="أوقف «كل الفترة» وحدّد شهراً وسنة، أو أنشئ إذن صرف من شاشة «دفع الرواتب»." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>م</th>
                    <th>رقم السند</th>
                    <th>الموظف</th>
                    <th>الشهر</th>
                    <th>السنة</th>
                    <th className="num">الراتب الأساسي</th>
                    <th className="num">بدل سكن</th>
                    <th className="num">بدل مواصلات</th>
                    <th className="num">الحوافز</th>
                    <th className="num">الإجمالي</th>
                    <th className="num">الخصومات</th>
                    <th className="num">صافي الراتب</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.seq}</td>
                      <td dir="ltr">{row.number}</td>
                      <td>
                        {row.employeeNo ? `${row.employeeNo} — ` : ''}
                        {row.employeeName}
                        {/* «إذنٌ بلا صرف» — the window reads every `SalaryPay` with `IS_Deleted=0`. */}
                        {row.posted ? '' : ' (بلا سند)'}
                      </td>
                      <td dir="ltr">{row.month}</td>
                      <td dir="ltr">{row.year}</td>
                      <td className="num">{money(row.basic)}</td>
                      <td className="num">{money(row.housing)}</td>
                      <td className="num">{money(row.transport)}</td>
                      <td className="num">{money(row.additions)}</td>
                      <td className="num">{money(row.gross)}</td>
                      <td className="num">{money(row.deductions)}</td>
                      <td className="num">{money(row.net)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={9}>💰 إجمالي الرواتب</th>
                    <th className="num">{money(totals.gross)}</th>
                    <th className="num">{money(totals.deductions)}</th>
                    <th className="num">{money(totals.total)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <SalaryReport />
    </Suspense>
  );
}
