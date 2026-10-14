'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { downloadCsv, type Account } from '../../../lib/accounts';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * ⚖️ ميزان المراجعة — `Form_WPF/frmRptBalances.xaml` («أرصدة الحسابات»).
 *
 * The window is a filter panel beside a grid. The panel is
 * `الفروع — كل الفروع` · `الحساب الرئيسي` · `المندوب` ·
 * `الفترة — كل الفترة / من / إلى` (`من وقت`/`إلى وقت`) · `عرض`; the grid
 * `جدول الأرصدة` is
 * `الحساب · اسم الحساب · رصيد افتتاحي مدين · رصيد افتتاحي دائن · حركة مدين · حركة دائن ·
 * رصيد مدين · رصيد دائن · رصيد ختامي مدين · رصيد ختامي دائن` with a `تفاصيل` button per
 * row, and under it `الرصيد:` and `الحالة:`.
 *
 * `Reports/rptAccountBalance.repx` prints the same six columns as
 * `افتتاحي · خلال الفترة المحددة · ختامي` with `الحالة` — the wording used here.
 *
 * `المندوب` needs its own list, and `من وقت`/`إلى وقت` are the desktop's way of cutting a
 * day; the cloud cuts by date, so the two time boxes are not reproduced (§9).
 */
type Row = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  balanceDebit: string;
  balanceCredit: string;
  closingDebit: string;
  closingCredit: string;
  status: string;
};

type Totals = {
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  balanceDebit: string;
  balanceCredit: string;
  closingDebit: string;
  closingCredit: string;
  balance: string;
  status: string;
  balanced: boolean;
};

type Envelope = { data: Row[]; totals: Totals };
type Branch = { id: string; nameAr?: string; name?: string };
type Salesman = { id: string; name?: string; fullName?: string };

const EMPTY: Totals = {
  openingDebit: '0',
  openingCredit: '0',
  debit: '0',
  credit: '0',
  balanceDebit: '0',
  balanceCredit: '0',
  closingDebit: '0',
  closingCredit: '0',
  balance: '0',
  status: '',
  balanced: true,
};

/** The ten columns `btnExportExcel_Click` writes, in the window's own order. */
const COLUMNS = [
  'الحساب',
  'اسم الحساب',
  'رصيد افتتاحي مدين',
  'رصيد افتتاحي دائن',
  'حركة مدين',
  'حركة دائن',
  'رصيد مدين',
  'رصيد دائن',
  'رصيد ختامي مدين',
  'رصيد ختامي دائن',
];

export default function TrialBalancePage() {
  const accounts = useQuery<Account[]>(() => apiFetch<{ data: Account[] }>('/accounts').then((body) => body.data), []);
  const branches = useQuery<Branch[]>(() => apiFetch<{ data: Branch[] }>('/branches').then((body) => body.data), []);
  const salesmen = useQuery<Salesman[]>(
    () => apiFetch<{ data: Salesman[] }>('/hrm/employees').then((body) => body.data).catch(() => []),
    [],
  );

  const [parentId, setParentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [salesmanId, setSalesmanId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [allPeriod, setAllPeriod] = useState(true);
  const [applied, setApplied] = useState({ parentId: '', branchId: '', salesmanId: '', from: '', to: '' });

  const trial = useQuery<Envelope>(() => {
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.branchId) params.set('branch_id', applied.branchId);
    if (applied.salesmanId) params.set('salesman_id', applied.salesmanId);
    if (applied.parentId) params.set('parent_id', applied.parentId);
    const query = params.toString();
    return apiFetch<Envelope>(`/statements/trial-balance${query ? `?${query}` : ''}`);
  }, [applied]);

  const rows = trial.data?.data ?? [];
  const totals = trial.data?.totals ?? EMPTY;
  const mains = (accounts.data ?? []).filter((account) => !(account.isPostable ?? true) || account.parentId == null);

  return (
    <Screen
      title="أرصدة الحسابات"
      subtitle="⚖️ ميزان المراجعة — افتتاحي · خلال الفترة المحددة · ختامي، من القيود المرحّلة فقط."
      crumbs={['المحاسبة', 'تقارير محاسبية']}
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
                'trial-balance.csv',
                COLUMNS,
                rows.map((row) => [
                  row.code,
                  row.name,
                  row.openingDebit,
                  row.openingCredit,
                  row.debit,
                  row.credit,
                  row.balanceDebit,
                  row.balanceCredit,
                  row.closingDebit,
                  row.closingCredit,
                ]),
              )
            }
          >
            📊 تصدير Excel
          </button>
          <button className="btn" type="button" onClick={trial.reload}>
            🔄 تحديث
          </button>
        </>
      }
    >
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 220, flex: 1 }}>
            <span>الحساب الرئيسي</span>
            <select className="input" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value="">كل الحسابات</option>
              {mains.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.nameAr ?? ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>الفرع</span>
            <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)} disabled={false}>
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr ?? branch.name ?? branch.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>المندوب</span>
            <select className="input" value={salesmanId} onChange={(event) => setSalesmanId(event.target.value)}>
              <option value="">كل المندوبين</option>
              {(salesmen.data ?? []).map((salesman) => (
                <option key={salesman.id} value={salesman.id}>
                  {salesman.name ?? salesman.fullName ?? salesman.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>من</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={allPeriod} />
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>إلى</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={allPeriod} />
          </label>
          <button
            className="btn primary"
            type="button"
            onClick={() => setApplied({ parentId, branchId, salesmanId, from: allPeriod ? '' : from, to: allPeriod ? '' : to })}
          >
            عرض
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <label className="check">
            <input type="checkbox" checked={allPeriod} onChange={(event) => setAllPeriod(event.target.checked)} />
            كل الفترة
          </label>
        </div>
      </div>

      {trial.status === 'loading' && <Loading />}
      {trial.status === 'forbidden' && <Forbidden />}
      {trial.status === 'error' && <ErrorBox message={trial.error} onRetry={trial.reload} />}
      {trial.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="حركة مدين" value={money(totals.debit)} tone="ok" />
            <StatTile label="حركة دائن" value={money(totals.credit)} tone="brand" />
            <StatTile label="رصيد ختامي مدين" value={money(totals.closingDebit)} />
            <StatTile label="رصيد ختامي دائن" value={money(totals.closingCredit)} />
            <StatTile
              label="الرصيد"
              value={money(totals.balance)}
              hint={totals.status || undefined}
              tone={totals.balanced ? 'ok' : 'warn'}
            />
          </StatTiles>

          {rows.length === 0 ? (
            <Empty title="لا توجد حركة مرحّلة" detail="سجّل قيداً واحداً على الأقل ليظهر ميزان المراجعة." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>الحساب</th>
                    <th rowSpan={2}>اسم الحساب</th>
                    <th colSpan={2} className="num">
                      افتتاحي
                    </th>
                    <th colSpan={2} className="num">
                      خلال الفترة المحددة
                    </th>
                    <th colSpan={2} className="num">
                      الرصيد
                    </th>
                    <th colSpan={2} className="num">
                      ختامي
                    </th>
                    <th rowSpan={2}>الحالة</th>
                    <th rowSpan={2} className="no-print" />
                  </tr>
                  <tr>
                    <th className="num">مدين</th>
                    <th className="num">دائن</th>
                    <th className="num">مدين</th>
                    <th className="num">دائن</th>
                    <th className="num">مدين</th>
                    <th className="num">دائن</th>
                    <th className="num">مدين</th>
                    <th className="num">دائن</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.accountId}>
                      <td dir="ltr">{row.code}</td>
                      <td>{row.name}</td>
                      <td className="num">{money(row.openingDebit)}</td>
                      <td className="num">{money(row.openingCredit)}</td>
                      <td className="num">{money(row.debit)}</td>
                      <td className="num">{money(row.credit)}</td>
                      <td className="num">{money(row.balanceDebit)}</td>
                      <td className="num">{money(row.balanceCredit)}</td>
                      <td className="num">{money(row.closingDebit)}</td>
                      <td className="num">{money(row.closingCredit)}</td>
                      <td>{row.status}</td>
                      <td className="no-print">
                        <a className="btn sm" href={`/accounting/ledger?account=${row.accountId}`}>
                          تفاصيل
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>المجموع</th>
                    <th className="num">{money(totals.openingDebit)}</th>
                    <th className="num">{money(totals.openingCredit)}</th>
                    <th className="num">{money(totals.debit)}</th>
                    <th className="num">{money(totals.credit)}</th>
                    <th className="num">{money(totals.balanceDebit)}</th>
                    <th className="num">{money(totals.balanceCredit)}</th>
                    <th className="num">{money(totals.closingDebit)}</th>
                    <th className="num">{money(totals.closingCredit)}</th>
                    <th>{totals.status || '—'}</th>
                    <th className="no-print" />
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
