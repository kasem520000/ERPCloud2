'use client';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { listFiscalYears, listPeriods, type FiscalPeriod, type FiscalYear } from '../../lib/accounting';

/**
 * M3 — 🗂️ الفترات المالية (read-only): the periods grid (الاسم · من · إلى · نشطة ·
 * مغلقة · أغلقت بواسطة) plus the fiscal years above it, exactly as the register
 * orders them (newest first).
 */
export default function PeriodsPage() {
  const periods = useQuery(listPeriods, []);
  const years = useQuery(listFiscalYears, []);

  return (
    <Screen
      title="الفترات المالية"
      subtitle="شبكة الفترات كما تُرتِّبها الإدارة: الأحدث أولاً"
      crumbs={['المحاسبة', 'الفترات المالية']}
    >
      {years.status === 'success' && (years.data ?? []).length > 0 ? (
        <div className="card tight" style={{ marginBottom: 14 }}>
          <strong className="small">السنوات المالية</strong>
          <div className="row" style={{ marginTop: 8 }}>
            {(years.data ?? []).map((year: FiscalYear) => (
              <span key={year.id} className="badge">
                {year.name ?? year.yearName ?? ''} {year.status ? `· ${year.status}` : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {periods.status === 'loading' ? <Loading rows={6} /> : null}
      {periods.status === 'forbidden' ? <Forbidden /> : null}
      {periods.status === 'error' ? <ErrorBox message={periods.error} onRetry={periods.reload} /> : null}
      {periods.status === 'success' && (periods.data ?? []).length === 0 ? <Empty hint="لم تُنشأ فترات بعد." /> : null}
      {periods.status === 'success' && (periods.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>اسم الفترة</th>
                <th>من</th>
                <th>إلى</th>
                <th>نشطة</th>
                <th>مغلقة</th>
                <th>أغلقت بواسطة</th>
                <th>تاريخ الإغلاق</th>
                <th>ملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {(periods.data ?? []).map((period: FiscalPeriod) => (
                <tr key={period.id}>
                  <td>{period.name ?? period.periodName ?? '—'}</td>
                  <td>{date(period.startDate ?? period.start_date)}</td>
                  <td>{date(period.endDate ?? period.end_date)}</td>
                  <td>{period.isActive ?? period.is_active ? <span className="badge active">نشطة</span> : '—'}</td>
                  <td>
                    {period.isClosed ?? period.is_closed ? <span className="badge closed">مغلقة</span> : <span className="badge open">مفتوحة</span>}
                  </td>
                  <td className="muted small">{period.closedByName ?? period.closed_by_name ?? '—'}</td>
                  <td className="small">{date(period.closedAt ?? period.closed_at)}</td>
                  <td className="muted small">{period.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Screen>
  );
}

function date(value?: string | null): string {
  return value ? String(value).slice(0, 10) : '—';
}
