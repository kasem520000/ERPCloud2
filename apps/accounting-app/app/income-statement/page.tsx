'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { incomeStatement, type IncomeStatementRow } from '../../lib/accounting';

/**
 * M3 — 📊 قائمة الدخل (read-only): the revenue/expense accounts carried to their
 * parents, as the report itself computes them (summary rows included).
 */
export default function IncomeStatementPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const report = useQuery(() => incomeStatement(from ? { from } : {}), [from, to]);

  return (
    <Screen
      title="قائمة الدخل — أرباح وخسائر حسابات رئيسية"
      subtitle="الإيرادات والمصروفات مرفوعة إلى حساباتها الرئيسية"
      crumbs={['المحاسبة', 'التقارير', 'قائمة الدخل']}
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
      {report.status === 'success' && (report.data ?? []).length === 0 ? <Empty hint="لا توجد بيانات في هذا النطاق." /> : null}
      {report.status === 'success' && (report.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الرمز</th>
                <th>البند</th>
                <th className="num">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {(report.data ?? []).map((row: IncomeStatementRow, i: number) => (
                <tr key={`${row.code ?? ''}-${i}`}>
                  <td>{row.code ?? ''}</td>
                  <td>{row.nameAr ?? row.name_ar ?? row.accountName ?? ''}</td>
                  <td className="num">{fmt(row.amount ?? row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Screen>
  );
}

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
