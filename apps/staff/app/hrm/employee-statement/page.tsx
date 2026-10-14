'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { downloadCsv } from '../../../lib/accounts';
import { apiFetch } from '../../../lib/api';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 📄 كشف حساب موظف — `Form_WPF/frmEmpAccountGet.xaml` («كشف حساب موظف»).
 *
 * The window's `🔍 خيارات البحث` are `👤 اسم الموظف` · `🏢 الفرع` (`كل الفروع`) ·
 * `📅 الفترة الزمنية` (`فترة كاملة`, `من:`, `إلى:`) · `🔍 عرض كشف الحساب`, its grid
 * `📊 تفاصيل كشف الحساب` is `م · مدين · دائن · الموظف · رقم القيد · تاريخ القيد · البيان ·
 * تفاصيل` (`BuildResultTable`), and its four tiles are `💳 إجمالي المدين` ·
 * `💵 إجمالي الدائن` · `⚖️ الرصيد المدين` · `⚖️ الرصيد الدائن` (`UpdateSummary`).
 *
 * The rows come from the desktop's own query — `ShowAccount` (`frmEmpAccountGet.xaml.cs`
 * L226) joins `Entry` to `Entry_sub` on the employee's account, keeps
 * `Entry.IS_Deleted=0 AND Entry.state=1`, and `GROUP BY Entry.GlobalID, Entry.date,
 * Entry_sub.notes, Entry_sub.acc_no`, which is the cloud's تجميعي statement of the
 * employee's account. `UpdateSummary` (L318) puts `|مدين − دائن|` on one side only and
 * writes `0` to the other; the API's `summary` block does the same.
 *
 * Two columns the desktop does not print are shown here because the cloud is
 * branch-first and every other cloud statement has them: `الفرع` (the window filters by
 * it, `chkAllBranches`, but never displays it) and `⚖️ الرصيد` (the running balance the
 * window only totals). `📊 تصدير Excel` becomes CSV, as in the rest of the cloud
 * statements.
 */
type Row = {
  seq: number;
  date: string;
  entryId: string | null;
  entryNumber: string | null;
  description: string | null;
  debit: string;
  credit: string;
  employee: string | null;
  branchName: string | null;
  entryType: string;
  runningBalance: string | null;
  balanceStatus: string | null;
};

type Summary = { totalDebit: string; totalCredit: string; balanceDebit: string; balanceCredit: string };

type Employee = {
  id: string;
  employeeNo: string;
  name: string;
  accountCode?: string | null;
  status?: string;
};

type Branch = { id: string; nameAr?: string; name?: string };

type Envelope = {
  employee: { id: string; employeeNo: string; name: string; accountId: string | null; accountCode: string | null; accountName: string | null } | null;
  branchId: string | null;
  from: string | null;
  to: string | null;
  fullPeriod: boolean;
  summary: Summary;
  rows: Row[];
};

type Filters = {
  employeeId: string;
  branchId: string;
  from: string;
  to: string;
  fullPeriod: boolean;
  hidePrevious: boolean;
  detailed: boolean;
};

const EMPTY_SUMMARY: Summary = { totalDebit: '0', totalCredit: '0', balanceDebit: '0', balanceCredit: '0' };

function EmployeeStatement() {
  const search = useSearchParams();
  const employees = useQuery<Employee[]>(() => apiFetch<{ data: Employee[] }>('/hrm/employees').then((body) => body.data), []);
  const branches = useQuery<Branch[]>(() => apiFetch<{ data: Branch[] }>('/branches').then((body) => body.data), []);

  const [employeeId, setEmployeeId] = useState(search.get('employee') ?? '');
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fullPeriod, setFullPeriod] = useState(true);
  const [hidePrevious, setHidePrevious] = useState(false);
  const [detailed, setDetailed] = useState(false); // 📑 نوع التقرير — تجميعي/تفصيلي
  const [applied, setApplied] = useState<Filters>({
    employeeId: search.get('employee') ?? '',
    branchId: '',
    from: '',
    to: '',
    fullPeriod: true,
    hidePrevious: false,
    detailed: false,
  });

  const statement = useQuery<Envelope>(() => {
    if (!applied.employeeId) return Promise.resolve({ employee: null, branchId: null, from: null, to: null, fullPeriod: true, summary: EMPTY_SUMMARY, rows: [] });
    const params = new URLSearchParams({ employee_id: applied.employeeId });
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.branchId) params.set('branch_id', applied.branchId);
    if (applied.fullPeriod) params.set('full_period', '1');
    if (applied.hidePrevious) params.set('hide_previous_balance', '1');
    if (applied.detailed) params.set('detailed', '1');
    return apiFetch<{ data: Envelope }>(`/hrm/employee-statement?${params.toString()}`).then((body) => body.data);
  }, [applied]);

  const rows = statement.data?.rows ?? [];
  const totals = statement.data?.summary ?? EMPTY_SUMMARY;
  const reported = statement.data?.employee;
  // `LoadAccounts` (L96) — the window only offers employees that have an account
  // (`AccCode <> -1`); an employee without one cannot have a statement at all.
  const withAccount = (employees.data ?? []).filter((row) => row.accountCode);

  return (
    <Screen
      title="كشف حساب موظف"
      subtitle={
        reported
          ? `${reported.employeeNo} — ${reported.name} · الحساب ${reported.accountCode ?? '—'} ${reported.accountName ?? ''}`.trim()
          : '📄 حركة حساب الموظف من القيود المرحّلة فقط — سلفة، صرف راتب، واستحقاق.'
      }
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
                `employee-statement-${reported?.employeeNo ?? 'report'}.csv`,
                ['م', 'التاريخ', 'النوع', 'رقم القيد', 'الفرع', 'الموظف', 'البيان', 'مدين', 'دائن', 'الرصيد', 'الحالة'],
                rows.map((row) => [
                  row.seq,
                  row.date,
                  row.entryType,
                  row.entryNumber ?? '',
                  row.branchName ?? '',
                  row.employee ?? '',
                  row.description ?? '',
                  row.debit,
                  row.credit,
                  row.runningBalance ?? '',
                  row.balanceStatus ?? '',
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
          <label className="field" style={{ margin: 0, minWidth: 260, flex: 1 }}>
            <span>👤 اسم الموظف *</span>
            <select className="input" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">اختر الموظف...</option>
              {withAccount.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.employeeNo} — {row.name} ({row.accountCode})
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, minWidth: 200 }}>
            <span>🏢 الفرع</span>
            <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr ?? branch.name ?? branch.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>من:</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={fullPeriod} />
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>إلى:</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={fullPeriod} />
          </label>
          <button
            className="btn primary"
            type="button"
            disabled={!employeeId}
            onClick={() => setApplied({ employeeId, branchId, from, to, fullPeriod, hidePrevious, detailed })}
          >
            🔍 عرض كشف الحساب
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <span className="group-label">📅 الفترة الزمنية</span>
          <label className="check">
            <input type="checkbox" checked={fullPeriod} onChange={(event) => setFullPeriod(event.target.checked)} />
            فترة كاملة
          </label>
          <label className="check">
            <input type="checkbox" checked={hidePrevious} onChange={(event) => setHidePrevious(event.target.checked)} />
            عدم إظهار الرصيد السابق
          </label>
          <span className="group-label" style={{ marginInlineStart: 12 }}>
            📑 نوع التقرير
          </span>
          <button type="button" className={`btn sm${detailed ? '' : ' primary'}`} onClick={() => setDetailed(false)}>
            تجميعي
          </button>
          <button type="button" className={`btn sm${detailed ? ' primary' : ''}`} onClick={() => setDetailed(true)}>
            تفصيلي
          </button>
        </div>
      </div>

      {!applied.employeeId && <Empty title="اختر الموظف" detail="«اختر موظف» — لا يظهر في القائمة إلا من له حساب في دليل الحسابات." />}
      {applied.employeeId && statement.status === 'loading' && <Loading />}
      {applied.employeeId && statement.status === 'forbidden' && <Forbidden />}
      {applied.employeeId && statement.status === 'error' && <ErrorBox message={statement.error} onRetry={statement.reload} />}
      {applied.employeeId && statement.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="💳 إجمالي المدين" value={money(totals.totalDebit)} tone="ok" />
            <StatTile label="💵 إجمالي الدائن" value={money(totals.totalCredit)} tone="brand" />
            <StatTile label="⚖️ الرصيد المدين" value={money(totals.balanceDebit)} />
            <StatTile label="⚖️ الرصيد الدائن" value={money(totals.balanceCredit)} />
          </StatTiles>

          {rows.length === 0 ? (
            <Empty title="لا توجد حركة على حساب هذا الموظف" detail="تأكد من الفترة، أو أن القيود التي تحمل حساب الموظف مرحّلة." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>م</th>
                    <th>تاريخ القيد</th>
                    <th>رقم القيد</th>
                    <th>الفرع</th>
                    <th>الموظف</th>
                    <th>البيان</th>
                    <th>تفاصيل</th>
                    <th className="num">مدين</th>
                    <th className="num">دائن</th>
                    <th className="num">⚖️ الرصيد</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.seq}-${row.entryId ?? 'opening'}`} className={row.entryId === null ? 'opening' : undefined}>
                      <td dir="ltr">{row.seq}</td>
                      <td dir="ltr">{row.date}</td>
                      <td dir="ltr" title={row.entryId ?? ''}>
                        {row.entryNumber ?? '—'}
                      </td>
                      <td>{row.branchName ?? '—'}</td>
                      <td>{row.employee ?? '—'}</td>
                      <td>{row.description ?? '—'}</td>
                      <td>{row.entryType}</td>
                      <td className="num">{money(row.debit)}</td>
                      <td className="num">{money(row.credit)}</td>
                      <td className="num">{money(row.runningBalance ?? '')}</td>
                      <td>{row.balanceStatus ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={7}>الإجمالي</th>
                    <th className="num">{money(totals.totalDebit)}</th>
                    <th className="num">{money(totals.totalCredit)}</th>
                    <th className="num">{money(Number(totals.balanceDebit) > 0 ? totals.balanceDebit : totals.balanceCredit)}</th>
                    <th>{Number(totals.balanceDebit) > 0 ? 'مدين' : Number(totals.balanceCredit) > 0 ? 'دائن' : '—'}</th>
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
      <EmployeeStatement />
    </Suspense>
  );
}
