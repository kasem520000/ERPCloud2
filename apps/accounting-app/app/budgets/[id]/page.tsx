'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { useQuery } from '../../../lib/use-query';
import { budgetVariance, readBudget, varianceTone, type BudgetLine, type VarianceRow } from '../../../lib/budgets';

/**
 * 📊 M6.4 — الموازنة مقابل الفعلي: التقرير المحسوب من القيود المُرحَّلة.
 * الفعلي بإشارة الرصيد الطبيعي للحساب، والانحراف = الموازنة − الفعلي، ونتيجة الموازنة
 * على الحسابات الربحية وحدها. `to` يحدّ «حتى تاريخ كذا» — بفتراتٍ منقضية كاملةً فقط.
 */
export default function BudgetVariancePage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const [to, setTo] = useState('');
  const card = useQuery(() => readBudget(id), [id]);
  const report = useQuery(() => budgetVariance(id, to || undefined), [id, to]);

  const rows = report.data?.rows ?? [];
  const totals = report.data?.totals;

  return (
    <Screen
      title={card.data?.name ? `«${card.data.name}» مقابل الفعلي` : 'الموازنة مقابل الفعلي'}
      subtitle={`من ${report.data?.from ?? '—'} حتى ${report.data?.to ?? '—'} — الفعلي حركة القيود المُرحَّلة بإشارة الرصيد الطبيعي`}
      crumbs={['المحاسبة', 'الموازنات', card.data?.name ?? '…']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="حتى تاريخ" style={{ width: 150 }} />
          {to ? (
            <button type="button" className="btn ghost sm" onClick={() => setTo('')}>
              السنة كاملة
            </button>
          ) : null}
          <Link className="btn ghost sm" href="/budgets">
            ← القائمة
          </Link>
        </div>
      }
    >
      {report.status === 'loading' ? <Loading rows={6} /> : null}
      {report.status === 'forbidden' ? <Forbidden /> : null}
      {report.status === 'error' ? <ErrorBox message={report.error} onRetry={report.reload} /> : null}

      {report.status === 'success' && rows.length === 0 ? (
        <Empty hint="لا سطور موازنة ولا حركة قيود في هذا النطاق بعد." />
      ) : null}

      {report.status === 'success' && rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الحساب</th>
                <th>النوع</th>
                <th className="num">الموازنة</th>
                <th className="num">الفعلي</th>
                <th className="num">الانحراف</th>
                <th className="num">النسبة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: VarianceRow) => {
                const tone = varianceTone(row);
                return (
                  <tr key={row.accountId}>
                    <td>
                      {row.accountCode} — {row.accountNameAr}
                      {row.inBudget ? null : <span className="muted small"> (غير موظف في الموازنة)</span>}
                    </td>
                    <td className="muted small">{typeLabel(row.accountType)}</td>
                    <td className="num">{fmt(row.budgeted)}</td>
                    <td className="num">{fmt(row.actual)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {tone === 'flat' ? '' : tone === 'good' ? '↓ ' : '↑ '}
                      {fmt(row.variance)}
                    </td>
                    <td className="num">{row.variancePct ? `${row.variancePct}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            {totals ? (
              <tfoot>
                <tr>
                  <td colSpan={2}>
                    <strong>نتيجة الموازنة (الإيرادات − المصروفات)</strong>
                  </td>
                  <td className="num">
                    <strong>{fmt(totals.budgetedResult)}</strong>
                  </td>
                  <td className="num">
                    <strong>{fmt(totals.actualResult)}</strong>
                  </td>
                  <td className="num">
                    <strong>{fmt(totals.variance)}</strong>
                  </td>
                  <td />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      ) : null}

      {card.status === 'success' && (card.data?.lines ?? []).length > 0 ? (
        <details className="card">
          <summary className="small">السطور الشهرية ({(card.data?.lines ?? []).length})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الحساب</th>
                  <th>الفترة</th>
                  <th className="num">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {(card.data?.lines ?? []).map((line: BudgetLine, index) => (
                  <tr key={line.id ?? index}>
                    <td className="small">
                      {line.accountCode} — {line.accountNameAr}
                    </td>
                    <td className="muted small">{line.periodName ?? '—'}</td>
                    <td className="num">{fmt(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Screen>
  );
}

function typeLabel(type?: string): string {
  return (
    {
      asset: 'أصول',
      liability: 'خصوم',
      equity: 'حقوق ملكية',
      revenue: 'إيرادات',
      expense: 'مصروفات',
    } as Record<string, string>
  )[type ?? ''] ?? (type ?? '—');
}

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
