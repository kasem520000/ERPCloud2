'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { DataTable, Notice } from '../../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { accountLabel, listAccounts, postableOf, type Account } from '../../../../lib/accounts';
import { ApiError, apiData, apiList, apiPost } from '../../../../lib/api';
import {
  branchOptions,
  cashLocationLabel,
  defaultOf,
  listBranches,
  listCashLocations,
  money,
  statusLabel,
  today,
  type Branch,
  type CashLocation,
} from '../../../../lib/lookups';
import { periodForDate } from '../../../../lib/posting';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

type RunLine = { lineNo: number; employeeId: string; gross: string; additions: string; deductions: string; net: string; status: string };
type Run = { id: string; yearMonth: string; status: string; currency: string; periodId: string | null; journalEntryId: string | null; lines: RunLine[] };
type Employee = { id: string; employeeNo: string; name: string };

export default function PayrollRunPage() {
  const params = useParams<{ id: string }>();
  const runId = String(params.id);
  const { can } = useSession();
  const runQuery = useQuery<Run>(() => apiData<Run>(`/hrm/payroll/runs/${runId}`), [runId]);
  const employees = useQuery<Employee[]>(() => apiList<Employee>('/hrm/employees'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);

  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [payableAccountId, setPayableAccountId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [cashLocationId, setCashLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  if (runQuery.status === 'loading') return <Loading />;
  if (runQuery.status !== 'success' || !runQuery.data) {
    return (
      <Screen title="مسيّر رواتب" crumbs={['الموظفين والرواتب']}>
        <ErrorBox message={runQuery.error ?? 'تعذّر تحميل المسيّر'} onRetry={runQuery.reload} />
      </Screen>
    );
  }

  const doc = runQuery.data;
  const netTotal = doc.lines.reduce((sum, line) => sum + Number(line.net), 0);
  const branchRows = branches.data ?? [];
  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const postable = (accounts.data ?? []).filter((account) => postableOf(account));

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      runQuery.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    const period = doc.periodId ? { id: doc.periodId } : await periodForDate(today());
    if (!period) throw new ApiError(422, 'PERIOD_NOT_FOUND', 'لا توجد فترة محاسبية مفتوحة.');
    await apiPost(`/hrm/payroll/runs/${doc.id}/post`, {
      branchId: effectiveBranch,
      fiscalPeriodId: period.id,
      journalLines: [
        { accountId: expenseAccountId, debit: netTotal.toFixed(4), description: `رواتب ${doc.yearMonth}` },
        { accountId: payableAccountId, credit: netTotal.toFixed(4), description: `رواتب مستحقة ${doc.yearMonth}` },
      ],
    });
  }

  return (
    <Screen
      title={`مسيّر رواتب ${doc.yearMonth}`}
      subtitle={`${statusLabel(doc.status)} — إجمالي الصافي ${money(netTotal, doc.currency)}`}
      crumbs={['الموظفين والرواتب', 'العمليات']}
      actions={
        <div className="row">
          <Link className="btn primary" href={`/hrm/payroll/${doc.id}/wps`}>
            تصدير حماية أجور
          </Link>
          <Link className="btn" href="/hrm/payroll">
            كل المسيّرات
          </Link>
        </div>
      }
    >
      <div className="card">
        <h2>الإجراءات</h2>
        <Notice notice={notice} />

        {doc.status === 'draft' && can('hrm.payroll.post') && (
          <>
            <div className="form-grid">
              <label className="field">
                <span>الفرع</span>
                <select className="input" value={effectiveBranch} onChange={(event) => setBranchId(event.target.value)}>
                  {branchOptions(branchRows).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>حساب مصروف الرواتب *</span>
                <select className="input" value={expenseAccountId} onChange={(event) => setExpenseAccountId(event.target.value)}>
                  <option value="">— اختر —</option>
                  {postable.map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>حساب الرواتب المستحقة *</span>
                <select className="input" value={payableAccountId} onChange={(event) => setPayableAccountId(event.target.value)}>
                  <option value="">— اختر —</option>
                  {postable.map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn primary" type="button" disabled={busy || !expenseAccountId || !payableAccountId} onClick={() => run(post, 'تم ترحيل المسيّر بقيد الاستحقاق.')}>
              {busy ? 'جارٍ الترحيل…' : 'ترحيل الاستحقاق'}
            </button>
          </>
        )}

        {doc.status === 'posted' && can('hrm.payroll.post') && (
          <>
            <h3>صرف الرواتب</h3>
            <div className="form-grid">
              <label className="field">
                <span>الفرع</span>
                <select className="input" value={effectiveBranch} onChange={(event) => setBranchId(event.target.value)}>
                  {branchOptions(branchRows).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>الصندوق / البنك *</span>
                <select className="input" value={cashLocationId} onChange={(event) => setCashLocationId(event.target.value)}>
                  <option value="">— اختر —</option>
                  {(cashLocations.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {cashLocationLabel(row)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="btn primary"
              type="button"
              disabled={busy || !cashLocationId}
              onClick={() =>
                run(
                  () => apiPost(`/hrm/payroll/runs/${doc.id}/pay`, { branchId: effectiveBranch, cashLocationId, method: 'bank_transfer', fiscalPeriodId: doc.periodId ?? undefined }),
                  'تم صرف الرواتب بسند صرف مرحّل.',
                )
              }
            >
              صرف الرواتب
            </button>
          </>
        )}

        {doc.status === 'paid' && <p className="alert ok">تم صرف رواتب هذا الشهر.</p>}
      </div>

      <div className="card">
        <h2>تفاصيل المسيّر</h2>
        <DataTable
          rows={doc.lines}
          rowKey={(row) => `${row.lineNo}`}
          columns={[
            { key: 'no', header: '#', align: 'num', cell: (row) => row.lineNo },
            {
              key: 'employee',
              header: 'الموظف',
              cell: (row) => (employees.data ?? []).find((entry) => entry.id === row.employeeId)?.name ?? row.employeeId,
            },
            { key: 'gross', header: 'الإجمالي', align: 'num', cell: (row) => money(row.gross) },
            { key: 'additions', header: 'الإضافات', align: 'num', cell: (row) => money(row.additions) },
            { key: 'deductions', header: 'الخصومات', align: 'num', cell: (row) => money(row.deductions) },
            { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.net) },
          ]}
        />
      </div>
    </Screen>
  );
}
