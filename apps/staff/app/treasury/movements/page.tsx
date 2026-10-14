'use client';

import Decimal from 'decimal.js';
import { useMemo, useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { apiData } from '../../../lib/api';
import { cashLocationLabel, defaultOf, listCashLocations, money, today, type CashLocation } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 🏦 حركة الصندوق — `Form_WPF/frmRptKhzna.xaml` (`Title="حركة الصندوق"`).
 *
 * The desktop does not read receipts for this report. It resolves the safe's account
 * (`frmRptKhzna.xaml.cs` L156) and then walks `Entry_sub` grouped by entry (L229), so
 * anything that touched that account is a movement — a receipt, a sale, a salary, a
 * transfer. It opens with `رصيد سابق` when a period is chosen (L200), carries a running
 * balance, and closes with the two cards `⚖️ الرصيد الإجمالي` and
 * `📅 رصيد الفترة المحددة` (L482/L502).
 *
 * Our endpoint does the same against the ledger, so this screen is a statement of the
 * safe, not a list of vouchers with a sum underneath.
 */

type MovementRow = {
  seq: number;
  processType: string;
  number: string;
  date: string;
  income: string;
  outcome: string;
  balance: string;
  note: string;
  isOpening?: boolean;
};

type MovementStatement = {
  cashLocationId: string;
  cashLocation: string;
  currencyCode: string;
  from: string | null;
  to: string | null;
  fromTime: string;
  toTime: string;
  all: boolean;
  openingBalance: string;
  totalAll: string;
  totalPeriod: string;
  rows: MovementRow[];
};

const BLANK_ROWS: MovementRow[] = [];

export default function MovementsPage() {
  const [locationId, setLocationId] = useState('');
  const [allPeriod, setAllPeriod] = useState(true);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [fromTime, setFromTime] = useState('00:00');
  const [toTime, setToTime] = useState('23:59');
  const [notice, setNotice] = useState<{ kind: 'danger' | 'info'; text: string } | undefined>();

  const locations = useQuery(() => listCashLocations(), []);
  const boxes = useMemo(() => locations.data ?? [], [locations.data]);
  const effectiveLocation = locationId || defaultOf(boxes)?.id || '';

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (allPeriod) {
      params.set('all', '1');
    } else {
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (fromTime) params.set('fromTime', fromTime);
      if (toTime) params.set('toTime', toTime);
    }
    return params.toString();
  }, [allPeriod, from, to, fromTime, toTime]);

  const statement = useQuery(
    () =>
      effectiveLocation
        ? apiData<MovementStatement>(`/cash-locations/${effectiveLocation}/movements?${query}`)
        : Promise.resolve(undefined),
    [effectiveLocation, query],
  );

  const rows = statement.data?.rows ?? BLANK_ROWS;
  const currency = statement.data?.currencyCode ?? 'SAR';

  const totals = useMemo(() => {
    const movements = rows.filter((row) => !row.isOpening);
    const addUp = (pick: (row: MovementRow) => string) =>
      movements.reduce((running, row) => running.plus(new Decimal(pick(row) || '0')), new Decimal(0));
    return {
      income: addUp((row) => row.income),
      outcome: addUp((row) => row.outcome),
      count: movements.length,
    };
  }, [rows]);

  /**
   * 📊 تصدير Excel — the desktop writes a CSV with this exact header
   * (`frmRptKhzna.xaml.cs`, `Button1_Click`): م,العملية,الرقم,التاريخ,وارد,صادر,الرصيد,البيان
   */
  function exportCsv() {
    if (rows.length === 0) {
      setNotice({ kind: 'info', text: 'لا توجد بيانات للتصدير.' });
      return;
    }
    const head = 'م,العملية,الرقم,التاريخ,وارد,صادر,الرصيد,البيان';
    const body = rows.map((row) =>
      [row.seq, row.processType, row.number, row.date, row.income, row.outcome, row.balance, row.note]
        .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([`\uFEFF${[head, ...body].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `حركة_صندوق_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Screen
      title="🏦 حركة الصندوق"
      subtitle={`كشف حساب الصندوق من دفتر الأستاذ — كما في frmRptKhzna: كل ما حرّك الحساب، برصيد متحرك.${
        statement.data ? ` ${statement.data.cashLocation}` : ''
      }`}
      crumbs={['الخزينة', 'التقارير']}
      actions={
        <button className="btn sm" type="button" onClick={exportCsv}>
          📊 تصدير Excel
        </button>
      }
    >
      <StatTiles>
        <StatTile
          label="⚖️ الرصيد الإجمالي"
          value={money(statement.data?.totalAll ?? '0', currency)}
          hint={allPeriod ? 'رصيد الصندوق حتى آخر حركة' : `حتى ${to} ${toTime}`}
          tone={new Decimal(statement.data?.totalAll ?? '0').lt(0) ? 'danger' : 'ok'}
        />
        <StatTile
          label="📅 رصيد الفترة المحددة"
          value={money(statement.data?.totalPeriod ?? '0', currency)}
          hint={allPeriod ? 'كل الفترة' : `${from} → ${to}`}
          tone="brand"
        />
        <StatTile
          label="🧾 رصيد سابق"
          value={money(statement.data?.openingBalance ?? '0', currency)}
          hint={allPeriod ? 'بلا فترة محددة' : `قبل ${from}`}
        />
        <StatTile label="📥 إجمالي الوارد" value={money(totals.income.toFixed(4), currency)} tone="ok" />
        <StatTile label="📤 إجمالي الصادر" value={money(totals.outcome.toFixed(4), currency)} tone="danger" />
        <StatTile label="🔢 عدد الحركات" value={totals.count} hint="بلا سطر الرصيد السابق" />
      </StatTiles>

      {/* لوحة الترشيح — `frmRptKhzna.xaml` L245–L300 */}
      <div className="card toolbar">
        <label className="field">
          <span>🏦 الصندوق</span>
          <select
            className="input"
            value={effectiveLocation}
            onChange={(event) => setLocationId(event.target.value)}
          >
            {(boxes as CashLocation[]).map((box) => (
              <option key={box.id} value={box.id}>
                {cashLocationLabel(box)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>📅 من تاريخ</span>
          <input
            className="input"
            type="date"
            dir="ltr"
            value={from}
            disabled={allPeriod}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="field">
          <span>من وقت (HH:mm)</span>
          <input
            className="input"
            dir="ltr"
            value={fromTime}
            placeholder="00:00"
            disabled={allPeriod}
            onChange={(event) => setFromTime(event.target.value)}
          />
        </label>
        <label className="field">
          <span>📅 إلى تاريخ</span>
          <input
            className="input"
            type="date"
            dir="ltr"
            value={to}
            disabled={allPeriod}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label className="field">
          <span>إلى وقت (HH:mm)</span>
          <input
            className="input"
            dir="ltr"
            value={toTime}
            placeholder="23:59"
            disabled={allPeriod}
            onChange={(event) => setToTime(event.target.value)}
          />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={allPeriod} onChange={(event) => setAllPeriod(event.target.checked)} />
          <span className="small">📅 كل الفترة</span>
        </label>
        <button className="btn primary" type="button" onClick={() => statement.reload()}>
          🏦 عرض حركة الصندوق
        </button>
      </div>

      {(statement.status === 'error' || statement.status === 'forbidden') && (
        <div className="card">
          <Notice
            notice={{
              kind: 'danger',
              text:
                statement.error?.includes('CASH_ACCOUNT_REQUIRED') ||
                statement.error?.includes('حساب مرتبط')
                  ? 'لم يتم العثور على حساب مرتبط بهذا الصندوق — اربط الصندوق بحساب من «🏦 تعريف الخزينة».'
                  : (statement.error ?? 'تعذر تحميل حركة الصندوق'),
            }}
          />
          <button className="btn" type="button" style={{ marginTop: 10 }} onClick={() => statement.reload()}>
            إعادة المحاولة
          </button>
        </div>
      )}
      {notice && <Notice notice={notice} />}

      <div className="card">
        {statement.status === 'loading' ? (
          <p className="muted">… جارٍ تحميل حركة الصندوق</p>
        ) : rows.length === 0 ? (
          <p className="muted">لا توجد حركات على هذا الصندوق في الفترة المحددة.</p>
        ) : (
          <DataTable
            rows={rows}
            rowKey={(row) => `${row.seq}-${row.number}-${row.date}`}
            columns={[
              { key: 'seq', header: 'م', align: 'num', cell: (row) => row.seq },
              {
                key: 'processType',
                header: 'العملية',
                cell: (row) =>
                  row.isOpening ? (
                    <strong>{row.processType}</strong>
                  ) : (
                    <span>{row.processType}</span>
                  ),
              },
              { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number || '—' },
              { key: 'date', header: '📅 التاريخ', align: 'ltr', cell: (row) => row.date },
              {
                key: 'income',
                header: '📥 وارد',
                align: 'num',
                cell: (row) => (new Decimal(row.income || '0').isZero() ? '—' : money(row.income)),
              },
              {
                key: 'outcome',
                header: '📤 صادر',
                align: 'num',
                cell: (row) => (new Decimal(row.outcome || '0').isZero() ? '—' : money(row.outcome)),
              },
              {
                key: 'balance',
                header: '⚖️ الرصيد',
                align: 'num',
                cell: (row) => (
                  <strong style={new Decimal(row.balance || '0').lt(0) ? { color: 'var(--danger)' } : undefined}>
                    {money(row.balance)}
                  </strong>
                ),
              },
              { key: 'note', header: '📝 البيان', cell: (row) => row.note || '—' },
            ]}
            footer={[
              '',
              <strong key="foot-label">المجموع</strong>,
              '',
              '',
              <strong key="foot-in">{money(totals.income.toFixed(4))}</strong>,
              <strong key="foot-out">{money(totals.outcome.toFixed(4))}</strong>,
              <strong key="foot-bal">{money(statement.data?.totalAll ?? '0')}</strong>,
              '',
            ]}
          />
        )}
      </div>
    </Screen>
  );
}
