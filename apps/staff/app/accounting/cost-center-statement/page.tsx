'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { downloadCsv } from '../../../lib/accounts';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 📊 كشف مركز الكلفة — `Form_WPF/frmCostCenterBalance.xaml` («تقرير مركز كلفة»).
 *
 * The window's `🔍 خيارات البحث` are `🏢 مركز الكلفة` · `📊 نوع الرصيد`
 * (`الكل`/`مدين`/`دائن`) · `اسم الحساب` · `🌿 الفرع` · `📋 نوع القيد` ·
 * `📑 نوع التقرير` (`تجميعي`/`تفصيلي`) · `عدم إظهار الرصيد السابق` · `فترة كاملة` ·
 * `📅 الفترة` (`من`/`إلى`) · `🔍 عرض`, and its grid `📊 كشف مركز الكلفة` is
 * `م · 💸 مدين · 💰 دائن · ⚖️ الرصيد · 📌 الحالة · 🔢 الرقم العام · 📄 رقم السند` plus
 * الفرع · النوع · التاريخ · البيان (`BuildDataTable`).
 *
 * It is the account statement pointed at a cost centre: the same `رصيد سابق` row, the
 * same running الرصيد and the same totals. One difference is deliberate — the window
 * guesses the centre's nature from the first character of its code
 * (`costCenterCode.Substring(0, 1)`), the trick it also uses for accounts; a cost centre
 * accumulates costs, so here الرصيد grows on the debit side and `📌 الحالة` names the
 * side the money is actually on.
 *
 * `📋 نوع القيد` — `cmbEntryType` في `frmCostCenterBalance` L108-L127، والخادم
 * يطبّقها عبر `STATEMENT_KINDS` (13 نوعاً) في `accounting.service.ts:320`، والشاشة
 * تُمرّرها كـ`?kind=` إلى `GET /statements/cost-center/:id`.
 */
type Row = {
  rank: number;
  date: string;
  entryId: string | null;
  number: string | null;
  branchName: string | null;
  entryType: string;
  description: string | null;
  debit: string;
  credit: string;
  runningBalance: string | null;
  balanceStatus: string | null;
  accountCode: string | null;
  accountName: string | null;
};

type Totals = {
  debit: string;
  credit: string;
  periodDebit: string;
  periodCredit: string;
  closing: string;
  closingStatus: string | null;
};

type Envelope = { data: Row[]; totals: Totals; costCenter: { code: string; nameAr: string } | null };

type CostCenter = { id: string; code: string; nameAr: string };
type Account = { id: string; code: string; nameAr?: string; isPostable?: boolean };
type Branch = { id: string; nameAr?: string; name?: string };

const EMPTY: Totals = { debit: '0', credit: '0', periodDebit: '0', periodCredit: '0', closing: '0', closingStatus: null };

function CostCentreStatement() {
  const search = useSearchParams();
  const centers = useQuery<CostCenter[]>(
    () => apiFetch<{ data: CostCenter[] }>('/cost-centers').then((body) => body.data),
    [],
  );
  const accounts = useQuery<Account[]>(() => apiFetch<{ data: Account[] }>('/accounts').then((body) => body.data), []);
  const branches = useQuery<Branch[]>(() => apiFetch<{ data: Branch[] }>('/branches').then((body) => body.data), []);

  const [centerId, setCenterId] = useState(search.get('center') ?? '');
  const [accountId, setAccountId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // R16 — ⏰ الوقت — نفس صندوقي الوقت في `frmCostCenterBalance` و `frmAccountBalance` (L458-L463).
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [fullPeriod, setFullPeriod] = useState(true);
  const [hidePrevious, setHidePrevious] = useState(false);
  const [summary, setSummary] = useState(true); // 📑 نوع التقرير — تجميعي
  const [balanceType, setBalanceType] = useState<'all' | 'debit' | 'credit'>('all');
  // R14 — 📋 نوع القيد — the filter `cmbEntryType` offers in `frmCostCenterBalance` L108-L127.
  const [entryKind, setEntryKind] = useState('');
  const [applied, setApplied] = useState({ centerId: search.get('center') ?? '', accountId: '', branchId: '', from: '', to: '', fromTime: '', toTime: '', fullPeriod: true, hidePrevious: false, summary: true, entryKind: '' });

  const statement = useQuery<Envelope>(() => {
    if (!applied.centerId) return Promise.resolve({ data: [], totals: EMPTY, costCenter: null });
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.fromTime) params.set('from_time', applied.fromTime);
    if (applied.toTime) params.set('to_time', applied.toTime);
    if (applied.branchId) params.set('branch_id', applied.branchId);
    if (applied.accountId) params.set('account_id', applied.accountId);
    if (applied.summary) params.set('summary', '1');
    if (applied.fullPeriod) params.set('full_period', '1');
    if (applied.hidePrevious) params.set('hide_previous_balance', '1');
    if (applied.entryKind) params.set('kind', applied.entryKind);
    const query = params.toString();
    return apiFetch<Envelope>(`/statements/cost-center/${applied.centerId}${query ? `?${query}` : ''}`);
  }, [applied]);

  const rows = statement.data?.data ?? [];
  const totals = statement.data?.totals ?? EMPTY;
  const reported = statement.data?.costCenter;
  const showDebit = balanceType !== 'credit';
  const showCredit = balanceType !== 'debit';

  return (
    <Screen
      title="تقرير مركز كلفة"
      subtitle="📊 كشف مركز الكلفة — حركة المركز ورصيده من القيود المرحّلة فقط."
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
                `cost-center-${reported?.code ?? 'report'}.csv`,
                ['م', 'التاريخ', 'النوع', 'رقم السند', 'الرقم العام', 'الفرع', 'البيان', 'مدين', 'دائن', 'الرصيد', 'الحالة'],
                rows.map((row) => [
                  row.rank,
                  row.date,
                  row.entryType,
                  row.number ?? '',
                  row.entryId ?? '',
                  row.branchName ?? '',
                  row.description ?? '',
                  row.debit,
                  row.credit,
                  row.runningBalance ?? '',
                  row.balanceStatus ?? '',
                ]),
              )
            }
          >
            تصدير CSV
          </button>
        </>
      }
    >
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 240, flex: 1 }}>
            <span>🏢 مركز الكلفة *</span>
            <select className="input" value={centerId} onChange={(event) => setCenterId(event.target.value)}>
              <option value="">— اختر مركز الكلفة</option>
              {(centers.data ?? []).map((center) => (
                <option key={center.id} value={center.id}>
                  {center.code} — {center.nameAr}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, minWidth: 240 }}>
            <span>اسم الحساب</span>
            <select className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">الكل</option>
              {(accounts.data ?? [])
                .filter((account) => account.isPostable ?? true)
                .sort((left, right) => left.code.localeCompare(right.code))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.nameAr ?? ''}
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>🌿 الفرع</span>
            <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">الكل</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr ?? branch.name ?? branch.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, width: 140 }}>
            <span>من</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={fullPeriod} />
          </label>
          <label className="field" style={{ margin: 0, width: 110 }}>
            <span>من وقت</span>
            <input className="input" type="time" value={fromTime} onChange={(event) => setFromTime(event.target.value)} disabled={fullPeriod || !from} title="⏰ الوقت — frmAccountBalance L458-L463" />
          </label>
          <label className="field" style={{ margin: 0, width: 140 }}>
            <span>إلى</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={fullPeriod} />
          </label>
          <label className="field" style={{ margin: 0, width: 110 }}>
            <span>إلى وقت</span>
            <input className="input" type="time" value={toTime} onChange={(event) => setToTime(event.target.value)} disabled={fullPeriod || !to} title="⏰ الوقت — frmAccountBalance L458-L463" />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>📋 نوع القيد</span>
            <select className="input" value={entryKind} onChange={(event) => setEntryKind(event.target.value)}>
              <option value="">الكل</option>
              <option value="opening">قيد افتتاحي</option>
              <option value="sales_invoice">فاتورة مبيعات</option>
              <option value="pos_sale">نقطة بيع</option>
              <option value="return_sale">مرتجع مبيعات</option>
              <option value="purchase_invoice">فاتورة مشتريات</option>
              <option value="return_purchase">مرتجع مشتريات</option>
              <option value="voucher_receipt">سند قبض</option>
              <option value="voucher_payment">سند صرف</option>
              <option value="inventory_adjust">تسوية جردية</option>
              <option value="shift_close">إغلاق اليومية</option>
              <option value="contract_invoice">فاتورة عقد</option>
              <option value="manual">قيد يدوي</option>
              <option value="reversal">قيد عكسي</option>
            </select>
          </label>
          <button
            className="btn primary"
            type="button"
            onClick={() =>
              setApplied({ centerId, accountId, branchId, from, to, fromTime, toTime, fullPeriod, hidePrevious, summary, entryKind })
            }
          >
            🔍 عرض
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <span className="group-label">📊 نوع الرصيد</span>
          {(
            [
              { id: 'all', label: 'الكل' },
              { id: 'debit', label: 'مدين' },
              { id: 'credit', label: 'دائن' },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              className={`btn sm${balanceType === option.id ? ' primary' : ''}`}
              onClick={() => setBalanceType(option.id)}
            >
              {option.label}
            </button>
          ))}
          <span className="group-label" style={{ marginInlineStart: 12 }}>
            📑 نوع التقرير
          </span>
          <button type="button" className={`btn sm${summary ? ' primary' : ''}`} onClick={() => setSummary(true)}>
            تجميعي
          </button>
          <button type="button" className={`btn sm${summary ? '' : ' primary'}`} onClick={() => setSummary(false)}>
            تفصيلي
          </button>
          <label className="check" style={{ marginInlineStart: 12 }}>
            <input type="checkbox" checked={fullPeriod} onChange={(event) => setFullPeriod(event.target.checked)} />
            فترة كاملة
          </label>
          <label className="check">
            <input type="checkbox" checked={hidePrevious} onChange={(event) => setHidePrevious(event.target.checked)} />
            عدم إظهار الرصيد السابق
          </label>
        </div>
      </div>

      {!applied.centerId && (
        <Empty title="اختر مركز كلفة لعرض كشفه" detail="يُفتح هذا الكشف أيضاً من 🌳 شجرة مراكز التكلفة بزرّ 📊." />
      )}
      {applied.centerId && statement.status === 'loading' && <Loading />}
      {applied.centerId && statement.status === 'forbidden' && <Forbidden />}
      {applied.centerId && statement.status === 'error' && (
        <ErrorBox message={statement.error} onRetry={statement.reload} />
      )}
      {applied.centerId && statement.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="💸 إجمالي مدين" value={money(totals.debit)} tone="ok" />
            <StatTile label="💰 إجمالي دائن" value={money(totals.credit)} tone="brand" />
            <StatTile label="رصيد الفترة (مدين)" value={money(totals.periodDebit)} />
            <StatTile label="رصيد الفترة (دائن)" value={money(totals.periodCredit)} />
            <StatTile label="⚖️ الرصيد" value={money(totals.closing)} hint={totals.closingStatus ?? undefined} />
          </StatTiles>

          {rows.length === 0 ? (
            <Empty
              title="لا توجد حركة على هذا المركز"
              detail="تأكد من الفترة، أو أن القيود التي تحمل هذا المركز مرحّلة."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>م</th>
                    <th>التاريخ</th>
                    <th>النوع</th>
                    <th>📄 رقم السند</th>
                    <th>🔢 الرقم العام</th>
                    <th>الفرع</th>
                    <th>البيان</th>
                    <th>رمز الحساب</th>
                    <th>اسم الحساب</th>
                    {showDebit && <th className="num">💸 مدين</th>}
                    {showCredit && <th className="num">💰 دائن</th>}
                    <th className="num">⚖️ الرصيد</th>
                    <th>📌 الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.rank}-${row.entryId ?? 'opening'}`} className={row.rank === 0 ? 'opening' : undefined}>
                      <td dir="ltr">{row.rank === 0 ? '' : row.rank}</td>
                      <td dir="ltr">{row.date}</td>
                      <td>{row.entryType}</td>
                      <td dir="ltr">{row.number ?? '—'}</td>
                      <td dir="ltr" title={row.entryId ?? ''}>
                        {row.entryId ? row.entryId.slice(0, 8) : '—'}
                      </td>
                      <td>{row.branchName ?? '—'}</td>
                      <td>{row.description ?? '—'}</td>
                      <td dir="ltr">{row.accountCode ?? '—'}</td>
                      <td>{row.accountName ?? '—'}</td>
                      {showDebit && <td className="num">{money(row.debit)}</td>}
                      {showCredit && <td className="num">{money(row.credit)}</td>}
                      <td className="num">{money(row.runningBalance ?? '')}</td>
                      <td>{row.balanceStatus ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={8}>الإجمالي</th>
                    {showDebit && <th className="num">{money(totals.debit)}</th>}
                    {showCredit && <th className="num">{money(totals.credit)}</th>}
                    <th className="num">{money(totals.closing)}</th>
                    <th>{totals.closingStatus ?? '—'}</th>
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
      <CostCentreStatement />
    </Suspense>
  );
}
