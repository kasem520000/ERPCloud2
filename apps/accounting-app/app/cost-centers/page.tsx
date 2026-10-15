'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { listCostCenters, nameOfCost, type CostCenter } from '../../lib/accounting';

/**
 * M3 — 🛡️ مراكز التكلفة (read-only): the centres with their balances
 * (`with_balances=1`), searchable server-side.
 */
export default function CostCentersPage() {
  const [search, setSearch] = useState('');
  const centers = useQuery(() => listCostCenters(search.trim() ? { q: search.trim() } : {}), [search]);

  return (
    <Screen
      title="مراكز التكلفة"
      subtitle="المراكز وأرصدتها من القيود المُرحَّلة"
      crumbs={['المحاسبة', 'مراكز التكلفة']}
      actions={
        <input
          className="input"
          style={{ width: 220 }}
          type="search"
          placeholder="بحث…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="بحث"
        />
      }
    >
      {centers.status === 'loading' ? <Loading rows={5} /> : null}
      {centers.status === 'forbidden' ? <Forbidden /> : null}
      {centers.status === 'error' ? <ErrorBox message={centers.error} onRetry={centers.reload} /> : null}
      {centers.status === 'success' && (centers.data ?? []).length === 0 ? <Empty hint="لا توجد مراكز تكلفة." /> : null}
      {centers.status === 'success' && (centers.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الرمز</th>
                <th>اسم المركز</th>
                <th>الحالة</th>
                <th className="num">مدين</th>
                <th className="num">دائن</th>
                <th className="num">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {(centers.data ?? []).map((center: CostCenter) => (
                <tr key={center.id}>
                  <td>{center.code ?? '—'}</td>
                  <td>{nameOfCost(center)}</td>
                  <td>{center.isActive ?? center.is_active ? <span className="badge active">نشط</span> : <span className="badge closed">موقوف</span>}</td>
                  <td className="num">{fmt(center.balance?.debit)}</td>
                  <td className="num">{fmt(center.balance?.credit)}</td>
                  <td className="num">
                    <strong>{fmt(center.balance?.balance)}</strong>
                  </td>
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
