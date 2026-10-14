'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { apiFetch } from '../../../lib/api';
import { accountLabel, downloadCsv, nameOf, postableOf, type Account } from '../../../lib/accounts';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 📄 كشف الحساب — the two statement windows of the desktop on one screen.
 *
 * `Form_WPF/frmAccountBalance.xaml` («كشف حساب تفصيلي») is the model: the filters are
 * `اسم الحساب` · `رقم الحساب` · `⚖️ نوع الرصيد` (`الكل`/`مدين`/`دائن`) ·
 * `📊 طريقة العرض` (`تجميعي (ملخص)`/`تفصيلي (كامل)`) · `عدم إظهار الرصيد السابق` ·
 * `فترة كاملة (من البداية)` · `الفرع` + `كل الفروع` · `من تاريخ` · `إلى تاريخ` ·
 * `🚀 عرض البيانات`, the grid is
 * `م · التاريخ · النوع · رقم السند · الرقم العام · الفرع · البيان · مدين · دائن ·
 * الرصيد · الحالة · تفاصيل`, and the footer is
 * `إجمالي مدين · إجمالي دائن · رصيد الفترة (مدين) · رصيد الفترة (دائن)`.
 *
 * `Form_WPF/frmAccountsStatement.xaml` («كشف حساب رئيسي») is the same report over an
 * account **and its branch** (`GetAccountStatement` walks `AccountHierarchy`), and its
 * grid carries `رمز الحساب` and `الحساب` instead of a running balance — which is why
 * turning كشف حساب رئيسي on replaces those two columns here.
 *
 * What the cloud lacked was the whole left half: the endpoint answered with bare lines,
 * so the screen filtered by date *after* the fact and started every الرصيد at zero. The
 * period, the رصيد سابق row and the running total are now counted once, on the server,
 * from posted entries only — the same arithmetic 📂 شجرة الحسابات uses.
 */
type StatementRow = {
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

type Envelope = {
  data: StatementRow[];
  totals: Totals;
  account: { id: string; code: string; nameAr: string; type: string; normalBalance: string | null } | null;
};

const EMPTY_TOTALS: Totals = {
  debit: '0',
  credit: '0',
  periodDebit: '0',
  periodCredit: '0',
  closing: '0',
  closingStatus: null,
};

export default function AccountStatementPage() {
  const search = useSearchParams();
  const accounts = useQuery<Account[]>(
    () => apiFetch<{ data: Account[] }>('/accounts?with_balances=1').then((body) => body.data),
    [],
  );
  const branches = useQuery<Array<{ id: string; nameAr?: string; name?: string }>>(
    () => apiFetch<{ data: Array<{ id: string; nameAr?: string; name?: string }> }>('/branches').then((body) => body.data),
    [],
  );
  const branchRows = branches.data ?? [];

  // 📂 دليل الحسابات opens this screen with `?account=<id>` from its كشف حساب column.
  const [accountId, setAccountId] = useState(search.get('account') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // R16 — ⏰ الوقت — `frmAccountBalance.xaml` صندوقا وقت لكل نهاية فترة (BuildDateTimeFilter L458-L463).
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [allBranches, setAllBranches] = useState(true);
  const [branchId, setBranchId] = useState('');
  const [fullPeriod, setFullPeriod] = useState(true);
  const [hidePrevious, setHidePrevious] = useState(false);
  const [summary, setSummary] = useState(true); // 📊 طريقة العرض — تجميعي (ملخص)
  const [descendants, setDescendants] = useState(false); // كشف حساب رئيسي
  const [balanceType, setBalanceType] = useState<'all' | 'debit' | 'credit'>('all');
  // R14 — 📋 نوع القيد — `cmbEntryType` في `frmAccountBalance` L108-L127، 13 نوعاً.
  const [entryKind, setEntryKind] = useState('');
  const [applied, setApplied] = useState({
    accountId: search.get('account') ?? '',
    from: '',
    to: '',
    fromTime: '',
    toTime: '',
    branchId: '',
    fullPeriod: true,
    hidePrevious: false,
    summary: true,
    descendants: false,
    entryKind: '',
  });

  // A different account arrives from the directory: follow it without a second click.
  const linked = search.get('account') ?? '';
  useEffect(() => {
    if (!linked || linked === applied.accountId) return;
    setAccountId(linked);
    setApplied((current) => ({ ...current, accountId: linked }));
  }, [linked, applied.accountId]);

  const statement = useQuery<Envelope>(() => {
    if (!applied.accountId) return Promise.resolve({ data: [], totals: EMPTY_TOTALS, account: null });
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.fromTime) params.set('from_time', applied.fromTime);
    if (applied.toTime) params.set('to_time', applied.toTime);
    if (!applied.fullPeriod && !applied.from && !applied.to) params.set('full_period', '0');
    if (applied.fullPeriod) params.set('full_period', '1');
    if (applied.branchId) params.set('branch_id', applied.branchId);
    if (applied.summary) params.set('summary', '1');
    if (applied.descendants) params.set('with_descendants', '1');
    if (applied.hidePrevious) params.set('hide_previous_balance', '1');
    if (applied.entryKind) params.set('kind', applied.entryKind);
    const query = params.toString();
    return apiFetch<Envelope>(`/statements/general-ledger/${applied.accountId}${query ? `?${query}` : ''}`);
  }, [applied]);

  const rows = statement.data?.data ?? [];
  const totals = statement.data?.totals ?? EMPTY_TOTALS;
  const reported = statement.data?.account;
  const account = useMemo(
    () => (accounts.data ?? []).find((entry) => entry.id === applied.accountId),
    [accounts.data, applied.accountId],
  );

  const showDebit = balanceType !== 'credit';
  const showCredit = balanceType !== 'debit';

  const exportCsv = () => {
    const headers = [
      'م',
      'التاريخ',
      'النوع',
      'رقم السند',
      'الرقم العام',
      'الفرع',
      'البيان',
      'مدين',
      'دائن',
      'الرصيد',
      'الحالة',
    ];
    downloadCsv(
      `statement-${reported?.code ?? 'account'}.csv`,
      headers,
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
    );
  };

  return (
    <Screen
      title="كشف حساب"
      subtitle={
        descendants
          ? 'كشف حساب رئيسي — الحساب وفرعه، كما في نافذة «كشف حساب رئيسي».'
          : 'كشف حساب تفصيلي — الحركة والرصيد التراكمي، كما في نافذة «كشف حساب تفصيلي».'
      }
      crumbs={['المحاسبة', 'تقارير محاسبية']}
      actions={
        <>
          <button className="btn" type="button" onClick={() => window.print()} disabled={!applied.accountId}>
            🖨️ طباعة
          </button>
          <button className="btn" type="button" onClick={exportCsv} disabled={rows.length === 0}>
            تصدير CSV
          </button>
        </>
      }
    >
      {/* فلاتر البحث المتقدم — the header of the window's own filter panel. */}
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 260, flex: 1 }}>
            <span>اسم الحساب</span>
            <select
              className="input"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">— اختر الحساب —</option>
              {(accounts.data ?? [])
                .filter(postableOf)
                .sort((left, right) => left.code.localeCompare(right.code))
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {accountLabel(entry)}
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, width: 150 }}>
            <span>رقم الحساب</span>
            <input className="input" dir="ltr" value={account?.code ?? ''} readOnly placeholder="—" />
          </label>
          <label className="field" style={{ margin: 0, width: 170 }}>
            <span>الفرع</span>
            <select
              className="input"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              disabled={allBranches}
            >
              <option value="">—</option>
              {branchRows.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr ?? branch.name ?? branch.id}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={allBranches} onChange={(event) => setAllBranches(event.target.checked)} />
            كل الفروع
          </label>
          <label className="field" style={{ margin: 0, width: 150 }}>
            <span>من تاريخ</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={fullPeriod} />
          </label>
          <label className="field" style={{ margin: 0, width: 120 }}>
            <span>من وقت</span>
            <input className="input" type="time" value={fromTime} onChange={(event) => setFromTime(event.target.value)} disabled={fullPeriod || !from} title="⏰ الوقت — صندوق الوقت في frmAccountBalance L458-L463" />
          </label>
          <label className="field" style={{ margin: 0, width: 150 }}>
            <span>إلى تاريخ</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={fullPeriod} />
          </label>
          <label className="field" style={{ margin: 0, width: 120 }}>
            <span>إلى وقت</span>
            <input className="input" type="time" value={toTime} onChange={(event) => setToTime(event.target.value)} disabled={fullPeriod || !to} title="⏰ الوقت — صندوق الوقت في frmAccountBalance L458-L463" />
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
          <button className="btn primary" type="button" onClick={() => setApplied({
            accountId,
            from,
            to,
            fromTime,
            toTime,
            branchId: allBranches ? '' : branchId,
            fullPeriod,
            hidePrevious,
            summary,
            descendants,
            entryKind,
          })}>
            🚀 عرض البيانات
          </button>
        </div>

        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <span className="group-label">⚖️ نوع الرصيد</span>
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
            📊 طريقة العرض
          </span>
          <button
            type="button"
            className={`btn sm${summary ? ' primary' : ''}`}
            onClick={() => setSummary(true)}
          >
            تجميعي (ملخص)
          </button>
          <button
            type="button"
            className={`btn sm${summary ? '' : ' primary'}`}
            onClick={() => setSummary(false)}
          >
            تفصيلي (كامل)
          </button>
          <label className="check" style={{ marginInlineStart: 12 }}>
            <input
              type="checkbox"
              checked={descendants}
              onChange={(event) => setDescendants(event.target.checked)}
            />
            كشف حساب رئيسي (الحساب وفرعه)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={fullPeriod}
              onChange={(event) => setFullPeriod(event.target.checked)}
            />
            فترة كاملة (من البداية)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={hidePrevious}
              onChange={(event) => setHidePrevious(event.target.checked)}
            />
            عدم إظهار الرصيد السابق
          </label>
        </div>
      </div>

      {!applied.accountId && <Empty title="اختر حساباً لعرض كشفه" detail="يُفتح هذا الكشف أيضاً من 📂 دليل الحسابات بزرّ «كشف حساب»." />}
      {applied.accountId && statement.status === 'loading' && <Loading />}
      {applied.accountId && statement.status === 'forbidden' && <Forbidden />}
      {applied.accountId && statement.status === 'error' && (
        <ErrorBox message={statement.error} onRetry={statement.reload} />
      )}
      {applied.accountId && statement.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="إجمالي مدين" value={money(totals.debit)} tone="ok" />
            <StatTile label="إجمالي دائن" value={money(totals.credit)} tone="brand" />
            <StatTile label="رصيد الفترة (مدين)" value={money(totals.periodDebit)} />
            <StatTile label="رصيد الفترة (دائن)" value={money(totals.periodCredit)} />
            <StatTile
              label="الرصيد الختامي"
              value={money(totals.closing)}
              hint={totals.closingStatus ?? undefined}
            />
          </StatTiles>

          <div className="card tight">
            <dl className="kv">
              <dt>الحساب</dt>
              <dd>
                <span dir="ltr">{reported?.code ?? account?.code}</span> — {nameOf(account ?? (reported as Account))}
              </dd>
              <dt>الفترة</dt>
              <dd dir="ltr">
                {applied.fullPeriod ? 'من البداية' : `${applied.from || '…'}${applied.fromTime ? ` ${applied.fromTime}` : ''} → ${applied.to || '…'}${applied.toTime ? ` ${applied.toTime}` : ''}`}
              </dd>
              <dt>عدد الحركات</dt>
              <dd>{rows.filter((row) => row.rank !== 0).length}</dd>
              <dt>الفرع</dt>
              <dd>
                {!applied.branchId
                  ? 'كل الفروع'
                  : (branchRows.find((branch) => branch.id === applied.branchId)?.nameAr ?? applied.branchId)}
              </dd>
            </dl>
          </div>

          {rows.length === 0 ? (
            <Empty title="لا توجد حركات على هذا الحساب في المدى المحدد" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>م</th>
                    <th>التاريخ</th>
                    <th>النوع</th>
                    <th>رقم السند</th>
                    <th>الرقم العام</th>
                    <th>الفرع</th>
                    <th>البيان</th>
                    {descendants && <th>رمز الحساب</th>}
                    {descendants && <th>الحساب</th>}
                    {showDebit && <th className="num">مدين</th>}
                    {showCredit && <th className="num">دائن</th>}
                    {!descendants && <th className="num">الرصيد</th>}
                    {!descendants && <th>الحالة</th>}
                    <th>تفاصيل</th>
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
                      {descendants && <td dir="ltr">{row.accountCode ?? '—'}</td>}
                      {descendants && <td>{row.accountName ?? '—'}</td>}
                      {showDebit && <td className="num">{money(row.debit)}</td>}
                      {showCredit && <td className="num">{money(row.credit)}</td>}
                      {!descendants && <td className="num">{money(row.runningBalance ?? '')}</td>}
                      {!descendants && <td>{row.balanceStatus ?? '—'}</td>}
                      <td>
                        {/* 👁️ — يفتح القيد في شاشته (R10)، حيث متنقّل ⏮ ◀ ▶ ⏭ وطباعته. */}
                        {row.entryId ? (
                          <Link className="btn sm" href={`/accounting/journal-entries/${row.entryId}`}>
                            👁️
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={descendants ? 8 : 7}>الإجمالي</th>
                    {showDebit && <th className="num">{money(totals.debit)}</th>}
                    {showCredit && <th className="num">{money(totals.credit)}</th>}
                    {!descendants && <th className="num">{money(totals.closing)}</th>}
                    {!descendants && <th>{totals.closingStatus ?? '—'}</th>}
                    <th />
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
