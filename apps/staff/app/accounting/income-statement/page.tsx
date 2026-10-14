'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { downloadCsv } from '../../../lib/accounts';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 📊 أرباح وخسائر حسابات رئيسية — `Form_WPF/frmRptIncomeStatement.xaml` printing
 * `Reports/RptIncomeStatement.repx`.
 *
 * The window's filter bar is `كل الفروع` · `كل الفترة` (`من`/`إلى` and `من وقت`/`إلى وقت`)
 * · `🔍 عرض`; its grid `📊 الحسابات` is `الحساب · اسم الحساب · رصيد مدين · رصيد دائن`;
 * and under it three rows: `قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ`,
 * `صافي أرباح العام` (or `صافي خسائر العام`) and «✅ الحسابات متوازنة», with
 * `خروج · طباعة · معاينة · تصدير Excel` in the footer.
 *
 * Which accounts are on it is `Accounts_Index.FinalAcc = 2` — the codes the desktop
 * writes for codes beginning `3` or `4` — which the cloud calls `revenue` and `expense`.
 * `تجميعي` is the window's own default: every account is carried up to its parent, which
 * is why the title says «حسابات رئيسية».
 */
type Row = {
  kind: 'account' | 'stock' | 'profit';
  code: string | null;
  name: string;
  debit: string;
  credit: string;
  balanceDebit: string;
  balanceCredit: string;
  status: string;
};

type Totals = {
  debit: string;
  credit: string;
  stock: string;
  profit: string;
  profitLabel: string;
  balanced: boolean;
  balancedLabel: string;
};

type Envelope = { data: Row[]; totals: Totals };
type Branch = { id: string; nameAr?: string; name?: string };

const EMPTY: Totals = { debit: '0', credit: '0', stock: '0', profit: '0', profitLabel: '', balanced: true, balancedLabel: '' };

export default function IncomeStatementPage() {
  const branches = useQuery<Branch[]>(() => apiFetch<{ data: Branch[] }>('/branches').then((body) => body.data), []);

  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [allPeriod, setAllPeriod] = useState(true);
  const [summary, setSummary] = useState(true); // 📑 تجميعي — حسابات رئيسية
  const [withStock, setWithStock] = useState(true);
  const [applied, setApplied] = useState({ branchId: '', from: '', to: '', summary: true, withStock: true });

  const statement = useQuery<Envelope>(() => {
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.branchId) params.set('branch_id', applied.branchId);
    params.set('summary', applied.summary ? '1' : '0');
    params.set('with_stock', applied.withStock ? '1' : '0');
    return apiFetch<Envelope>(`/statements/income-statement?${params.toString()}`);
  }, [applied]);

  const rows = statement.data?.data ?? [];
  const totals = statement.data?.totals ?? EMPTY;

  return (
    <Screen
      title="أرباح وخسائر حسابات رئيسية"
      subtitle="📊 قائمة الدخل — حسابات الإيرادات والمصروفات (FinalAcc = 2)، من القيود المرحّلة فقط."
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
                'income-statement.csv',
                ['الحساب', 'اسم الحساب', 'رصيد مدين', 'رصيد دائن'],
                rows.map((row) => [row.code ?? '', row.name, row.balanceDebit, row.balanceCredit]),
              )
            }
          >
            📊 تصدير Excel
          </button>
        </>
      }
    >
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 200 }}>
            <span>الفروع</span>
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
            onClick={() => setApplied({ branchId, from: allPeriod ? '' : from, to: allPeriod ? '' : to, summary, withStock })}
          >
            🔍 عرض
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <label className="check">
            <input type="checkbox" checked={allPeriod} onChange={(event) => setAllPeriod(event.target.checked)} />
            كل الفترة
          </label>
          <span className="group-label" style={{ marginInlineStart: 12 }}>
            📑 نوع التقرير
          </span>
          <button type="button" className={`btn sm${summary ? ' primary' : ''}`} onClick={() => setSummary(true)}>
            تجميعي (حسابات رئيسية)
          </button>
          <button type="button" className={`btn sm${summary ? '' : ' primary'}`} onClick={() => setSummary(false)}>
            تفصيلي
          </button>
          <label className="check" style={{ marginInlineStart: 12 }}>
            <input type="checkbox" checked={withStock} onChange={(event) => setWithStock(event.target.checked)} />
            قيمة مخزون بضاعة آخر المدة
          </label>
        </div>
      </div>

      {statement.status === 'loading' && <Loading />}
      {statement.status === 'forbidden' && <Forbidden />}
      {statement.status === 'error' && <ErrorBox message={statement.error} onRetry={statement.reload} />}
      {statement.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="💵 رصيد مدين" value={money(totals.debit)} tone="ok" />
            <StatTile label="رصيد دائن" value={money(totals.credit)} tone="brand" />
            <StatTile label="قيمة مخزون آخر المدة" value={money(totals.stock)} />
            <StatTile
              label={totals.profitLabel || 'النتيجة'}
              value={money(totals.profit)}
              tone={totals.profitLabel === 'صافي أرباح العام' ? 'ok' : 'danger'}
            />
          </StatTiles>

          {rows.filter((row) => row.kind === 'account').length === 0 ? (
            <Empty
              title="لا توجد حسابات إيرادات أو مصروفات"
              detail="القائمة تُبنى من الحسابات التي يبدأ رمزها بـ3 أو بـ4 (FinalAcc = 2)."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الحساب</th>
                    <th>اسم الحساب</th>
                    <th className="num">رصيد مدين</th>
                    <th className="num">رصيد دائن</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.kind}-${row.code ?? index}`} className={row.kind === 'profit' ? 'opening' : undefined}>
                      <td dir="ltr">{row.code ?? '—'}</td>
                      <td>{row.name}</td>
                      <td className="num">{money(row.balanceDebit)}</td>
                      <td className="num">{money(row.balanceCredit)}</td>
                      <td>{row.status}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>المجموع</th>
                    <th className="num">{money(totals.debit)}</th>
                    <th className="num">{money(totals.credit)}</th>
                    <th>{totals.balanced ? totals.balancedLabel : '—'}</th>
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
