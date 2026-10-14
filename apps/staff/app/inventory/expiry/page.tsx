'use client';

import { useState } from 'react';

import { DataTable, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles, Tabs } from '../../../components/ui';
import { expiryReport, quantity, shortDate, type ExpiryRow } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * تواريخ الصلاحية — what is on the shelf, and how long it has left.
 *
 * A lot you cannot see is a lot that quietly becomes waste: the desktop carried this
 * report next to the item card, and it is the reason a lot carries an expiry date at
 * all. Rows already past their date lead the list and are marked منتهية — the tiles
 * above the grid are what the desktop report printed as a footer total.
 */

const HORIZONS = [
  { days: 7, label: 'أسبوع' },
  { days: 30, label: 'شهر' },
  { days: 90, label: 'ثلاثة أشهر' },
  { days: 365, label: 'سنة' },
];

type Bucket = 'all' | 'expired' | 'week' | 'month' | 'rest';

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'expired', label: 'منتهية' },
  { id: 'week', label: 'خلال أسبوع' },
  { id: 'month', label: 'خلال شهر' },
  { id: 'rest', label: 'أبعد من شهر' },
];

function bucketOf(row: ExpiryRow): Bucket {
  if (row.expired) return 'expired';
  if (row.daysLeft <= 7) return 'week';
  if (row.daysLeft <= 30) return 'month';
  return 'rest';
}

export default function ExpiryPage() {
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState<Bucket>('all');
  const rows = useQuery<ExpiryRow[]>(() => expiryReport(days), [days]);

  const data = rows.data ?? [];
  const expired = data.filter((row) => row.expired);
  const inWeek = data.filter((row) => !row.expired && row.daysLeft <= 7);
  const inMonth = data.filter((row) => !row.expired && row.daysLeft > 7 && row.daysLeft <= 30);
  const totalQty = data.reduce((sum, row) => sum + Number(row.quantity), 0);
  const shown = bucket === 'all' ? data : data.filter((row) => bucketOf(row) === bucket);

  return (
    <Screen
      title="تواريخ الصلاحية"
      subtitle="الدفعات التي تنتهي خلال المدة المحددة، وما انتهى منها فعلاً — مرتبة بالأقرب أولاً."
      crumbs={['المستودعات', 'التقارير']}
    >
      <StatTiles>
        <StatTile
          label="منتهية"
          value={expired.length}
          hint={expired.length > 0 ? quantity(expired.reduce((sum, row) => sum + Number(row.quantity), 0)) : 'لا شيء منتهٍ'}
          tone={expired.length > 0 ? 'danger' : 'ok'}
        />
        <StatTile
          label="خلال أسبوع"
          value={inWeek.length}
          hint={inWeek.length > 0 ? quantity(inWeek.reduce((sum, row) => sum + Number(row.quantity), 0)) : 'مطمئن'}
          tone={inWeek.length > 0 ? 'warn' : 'default'}
        />
        <StatTile
          label="خلال شهر"
          value={inMonth.length}
          hint={inMonth.length > 0 ? quantity(inMonth.reduce((sum, row) => sum + Number(row.quantity), 0)) : 'مطمئن'}
        />
        <StatTile label="إجمالي الدفعات" value={data.length} hint={`خلال ${HORIZONS.find((h) => h.days === days)?.label}`} />
        <StatTile label="إجمالي الكمية" value={quantity(totalQty)} hint="مجموع أرصدة الدفعات المعروضة" tone="brand" />
      </StatTiles>

      <FilterBar
        actions={<span className="small muted">{data.length === 0 ? 'لا دفعات في هذه المدة' : `${data.length} دفعة`}</span>}
      >
        <label className="field">
          <span>خلال</span>
          <select className="input" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
            {HORIZONS.map((horizon) => (
              <option key={horizon.days} value={horizon.days}>
                {horizon.label}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {expired.length > 0 && (
        <p className="alert warn">
          {`يوجد ${expired.length} دفعة منتهية الصلاحية في الأرصدة. راجعها بجرد أو سند صرف قبل البيع.`}
        </p>
      )}

      <Tabs items={BUCKETS} value={bucket} onChange={setBucket} />

      <QueryView
        query={rows}
        empty="لا توجد دفعات قاربت على الانتهاء"
        emptyDetail="لم تُسجَّل أي دفعة بتاريخ صلاحية داخل هذه المدة. أنشئ الدفعات من شاشة الدفعات عند الاستلام."
      >
        {() => (
          <DataTable
            rows={shown}
            rowKey={(row) => row.lotId}
            footer={[
              <>المجموع ({shown.length})</>,
              '',
              '',
              '',
              '',
              quantity(shown.reduce((sum, row) => sum + Number(row.quantity), 0)),
            ]}
            columns={[
              { key: 'lot', header: 'رقم الدفعة', align: 'ltr', cell: (row) => row.lotNo },
              { key: 'sku', header: 'الرمز', align: 'ltr', cell: (row) => row.sku },
              { key: 'item', header: 'المادة', cell: (row) => row.nameAr },
              { key: 'expiry', header: 'تاريخ الانتهاء', align: 'ltr', cell: (row) => shortDate(row.expiryDate) },
              {
                key: 'left',
                header: 'المتبقي',
                align: 'num',
                cell: (row) =>
                  row.expired ? (
                    <span className="badge failed" dir="ltr">{`انتهت منذ ${Math.abs(row.daysLeft)} يوم`}</span>
                  ) : (
                    <span dir="ltr">{`${row.daysLeft} يوم`}</span>
                  ),
              },
              { key: 'qty', header: 'الرصيد', align: 'num', cell: (row) => quantity(row.quantity) },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
