'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { useQuery } from '../../../lib/use-query';
import { assetSchedule, statusLabelOf, type FixedAsset, type ScheduleRow } from '../../../lib/assets';

/**
 * M6.1 — 🏭 بطاقة الأصل وجدول إهلاكه: the schedule endpoint's view — planned instalment
 * against what is actually posted, month by month, with the journal number that posted
 * each one. Read-only; the run lives on the register screen.
 */
export default function AssetSchedulePage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const view = useQuery(() => assetSchedule(id), [id]);

  const asset = view.data?.asset;
  const rows = view.data?.schedule ?? [];

  return (
    <Screen
      title={asset ? `${asset.code} — ${asset.nameAr ?? asset.name_ar ?? ''}` : 'بطاقة أصل'}
      subtitle="جدول الإهلاك الشهري: القسط المخطط مقابل المرحَّل فعلًا، وقيود كل شهر"
      crumbs={['المحاسبة', 'الأصول الثابتة', asset?.code ?? '…']}
      actions={
        <Link className="btn ghost sm" href="/assets">
          ← السجل
        </Link>
      }
    >
      {view.status === 'loading' ? <Loading rows={6} /> : null}
      {view.status === 'forbidden' ? <Forbidden /> : null}
      {view.status === 'error' ? <ErrorBox message={view.error} onRetry={view.reload} /> : null}

      {view.status === 'success' && !asset ? <Empty hint="الأصل غير موجود في هذه المنشأة." /> : null}

      {asset ? <AssetCard asset={asset} /> : null}
      {asset && rows.length === 0 ? <Empty hint="لا أشهر إهلاك لهذا الأصل." /> : null}
      {asset && rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الشهر</th>
                <th className="num">القسط المخطط</th>
                <th className="num">المرحَّل</th>
                <th>الحالة</th>
                <th>قيد الشهر</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: ScheduleRow, index) => {
                const posted = row.posted ?? false;
                return (
                  <tr key={row.period ?? index}>
                    <td >{row.period ?? '—'}</td>
                    <td className="num">{fmt(row.plannedAmount ?? row.planned_amount)}</td>
                    <td className="num">{posted ? fmt(row.postedAmount ?? row.posted_amount) : '—'}</td>
                    <td>
                      <span className={`badge ${posted ? 'posted' : 'draft'}`}>{posted ? 'مُرحَّل' : 'مستحق'}</span>
                    </td>
                    <td className="small">
                      {posted ? (row.journalNumber ?? row.journal_number ?? '—') : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Screen>
  );
}

function AssetCard({ asset }: { asset: FixedAsset }) {
  const stats: Array<{ label: string; value: string }> = [
    { label: 'تاريخ الاقتناء', value: (asset.acquisitionDate ?? asset.acquisition_date ?? '').slice(0, 10) || '—' },
    { label: 'التكلفة', value: fmt(asset.acquisitionCost ?? asset.acquisition_cost) },
    { label: 'قيمة الإنقاذ', value: fmt(asset.salvageValue ?? asset.salvage_value) },
    { label: 'العمر (شهر)', value: String(asset.usefulLifeMonths ?? asset.useful_life_months ?? '—') },
    { label: 'مجمع الإهلاك', value: fmt(asset.accumulatedDepreciation ?? asset.accumulated_depreciation) },
    { label: 'القيمة الدفترية', value: fmt(asset.netBookValue ?? asset.net_book_value) },
    { label: 'الأشهر المرحَّلة', value: String(asset.depreciatedMonths ?? 0) },
    { label: 'الحالة', value: statusLabelOf(asset) },
  ];
  return (
    <section className="card">
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        {stats.map((stat) => (
          <div key={stat.label}>
            <div className="muted small">{stat.label}</div>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
