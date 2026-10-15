'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { trialBalance, type TrialBalanceRow } from '../../lib/accounting';

/**
 * M3 — ⚖️ ميزان المراجعة (read-only): opening / movement / closing columns with the
 * server's own totals row. The date range maps onto the report's `from`/`to`.
 */
export default function TrialBalancePage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const report = useQuery(() => trialBalance(from ? { from } : {}), [from, to]);

  return (
    <Screen
      title="ميزان المراجعة"
      subtitle="افتتاحي · حركة · ختامي، مع مجاميع التقرير الرسمية"
      crumbs={['المحاسبة', 'التقارير', 'ميزان المراجعة']}
      actions={
        <div className="row">
          <input className="input" style={{ width: 150 }} type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="من تاريخ" />
          <input className="input" style={{ width: 150 }} type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="إلى تاريخ" />
        </div>
      }
    >
      {report.status === 'loading' ? <Loading rows={8} /> : null}
      {report.status === 'forbidden' ? <Forbidden /> : null}
      {report.status === 'error' ? <ErrorBox message={report.error} onRetry={report.reload} /> : null}
      {report.status === 'success' && (report.data?.rows ?? []).length === 0 ? <Empty hint="لا توجد حركات في هذا النطاق." /> : null}
      {report.status === 'success' && (report.data?.rows ?? []).length > 0 ? (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>الحساب</th>
                  <th className="num">افتتاحي مدين</th>
                  <th className="num">افتتاحي دائن</th>
                  <th className="num">حركة مدين</th>
                  <th className="num">حركة دائن</th>
                  <th className="num">ختامي مدين</th>
                  <th className="num">ختامي دائن</th>
                </tr>
              </thead>
              <tbody>
                {(report.data?.rows ?? []).map((row: TrialBalanceRow, i: number) => (
                  <tr key={row.accountId ?? row.account_id ?? i}>
                    <td>{row.code ?? '—'}</td>
                    <td>{row.nameAr ?? row.name_ar ?? row.accountName ?? ''}</td>
                    <td className="num">{fmt(row.openingDebit ?? row.opening_debit)}</td>
                    <td className="num">{fmt(row.openingCredit ?? row.opening_credit)}</td>
                    <td className="num">{fmt(row.periodDebit ?? row.period_debit)}</td>
                    <td className="num">{fmt(row.periodCredit ?? row.period_credit)}</td>
                    <td className="num">{fmt(row.closingDebit ?? row.closing_debit)}</td>
                    <td className="num">{fmt(row.closingCredit ?? row.closing_credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card tight row" style={{ justifyContent: 'space-between' }}>
            <strong>المجاميع</strong>
            <span className="small">
              حركة: {fmt(report.data?.totals?.periodDebit ?? report.data?.totals?.period_debit)} /{' '}
              {fmt(report.data?.totals?.periodCredit ?? report.data?.totals?.period_credit)} · ختامي:{' '}
              {fmt(report.data?.totals?.closingDebit ?? report.data?.totals?.closing_debit)} /{' '}
              {fmt(report.data?.totals?.closingCredit ?? report.data?.totals?.closing_credit)}
            </span>
          </div>
        </>
      ) : null}
    </Screen>
  );
}

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
