'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { WarehousePicker } from '../../../components/inventory-filters';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles, Tabs } from '../../../components/ui';
import { ApiError } from '../../../lib/api';
import {
  closeTransfer,
  inTransitReport,
  listWarehouses,
  money,
  quantity,
  shortDate,
  type InTransitRow,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * بضاعة في الطريق — goods that left the source warehouse and never fully arrived.
 *
 * A transfer that sits here is not a statistic: the source has already lost the stock,
 * the destination never gained it, and بضاعة تحت التحويل keeps a balance nobody can
 * explain. This screen is where it is settled — either the remainder comes home
 * (`return`) or it is written off as a shortage — and in both cases the transit account
 * is cleared by a balanced entry.
 *
 * The views are the ones the desktop never had: the value parked in transit, how old
 * each consignment is, and the two closures that end it.
 */

type Bucket = 'all' | 'fresh' | 'late' | 'stuck';

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'fresh', label: '٠–٢ يوم' },
  { id: 'late', label: '٣–٧ أيام' },
  { id: 'stuck', label: 'أكثر من ٧ أيام' },
];

function bucketOf(row: InTransitRow): Bucket {
  const age = row.daysInTransit ?? 0;
  if (age > 7) return 'stuck';
  if (age >= 3) return 'late';
  return 'fresh';
}

export default function InTransitPage() {
  const { can } = useSession();
  const manage = can('inventory.adjust');
  const [warehouseId, setWarehouseId] = useState('');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const rows = useQuery<InTransitRow[]>(() => inTransitReport(warehouseId || undefined), [warehouseId]);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const warehouse of warehouses.data ?? []) map.set(warehouse.id, warehouse.nameAr ?? warehouse.code ?? '');
    return map;
  }, [warehouses.data]);

  async function settle(row: InTransitRow, mode: 'return' | 'shortage') {
    const question =
      mode === 'return'
        ? `إعادة ${row.qty} من ${row.sku ?? row.nameAr ?? ''} إلى مستودع المصدر؟`
        : `اعتبار ${row.qty} من ${row.sku ?? row.nameAr ?? ''} عجزاً وتحميل قيمته؟`;
    if (!window.confirm(question)) return;
    const reason = window.prompt(mode === 'return' ? 'سبب العودة' : 'سبب العجز') ?? undefined;
    setBusy(`${row.transferId}:${row.lineNo}`);
    setNotice(undefined);
    try {
      const result = await closeTransfer(row.transferId, { mode, reason: reason || undefined });
      setNotice({
        kind: 'ok',
        text:
          mode === 'return'
            ? `أُغلقت المناقلة ${result.number} بعودة البضاعة إلى المصدر — بقيمة ${money(result.value)}.`
            : `أُغلقت المناقلة ${result.number} كعجز — بقيمة ${money(result.value)}.`,
      });
      rows.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy('');
    }
  }

  const data = rows.data ?? [];
  const totalValue = data.reduce((sum, row) => sum + Number(row.value), 0);
  const totalQty = data.reduce((sum, row) => sum + Number(row.qty), 0);
  const stale = data.filter((row) => (row.daysInTransit ?? 0) >= 3).length;
  const oldest = data.reduce((max, row) => Math.max(max, row.daysInTransit ?? 0), 0);
  const shown = bucket === 'all' ? data : data.filter((row) => bucketOf(row) === bucket);

  return (
    <Screen
      title="بضاعة في الطريق"
      subtitle="مناقلات أُرسلت ولم تُستلم كاملة — ما زال في حساب بضاعة تحت التحويل حتى تُعاد أو تُقفل."
      crumbs={['المستودعات', 'العمليات']}
    >
      <StatTiles>
        <StatTile label="أصناف معلّقة" value={data.length} hint="سطر مناقلة لم يُستلم" tone="brand" />
        <StatTile label="الكمية المعلّقة" value={quantity(totalQty)} hint="بوحدات الإرسال" />
        <StatTile label="قيمة البضاعة المعلّقة" value={money(totalValue)} hint="مرصودة في حساب بضاعة تحت التحويل" />
        <StatTile
          label="متأخرة (٣ أيام فأكثر)"
          value={stale}
          hint={stale > 0 ? 'تحتاج تسوية: استلام أو عودة أو عجز' : 'لا شيء متأخر'}
          tone={stale > 0 ? 'danger' : 'ok'}
        />
        <StatTile
          label="أقدم بضاعة"
          value={`${oldest} يوم`}
          hint={oldest > 7 ? 'تجاوزت أسبوعاً في الطريق' : 'داخل المدة المقبولة'}
          tone={oldest > 7 ? 'warn' : 'default'}
        />
      </StatTiles>

      <FilterBar
        actions={
          <span className="small muted">
            {data.length === 0 ? 'لا بضاعة في الطريق' : `${data.length} سطراً بقيمة ${money(totalValue)}`}
          </span>
        }
      >
        <div className="field">
          <span>المستودع</span>
          <WarehousePicker value={warehouseId} onChange={setWarehouseId} includeAll />
        </div>
      </FilterBar>

      {stale > 0 && (
        <p className="alert warn">
          توجد أصناف في الطريق منذ ثلاثة أيام أو أكثر. راجعها: إما أن تُستلم، أو تُعاد إلى مصدرها، أو تُقفل كعجز.
        </p>
      )}

      <Notice notice={notice} />

      <Tabs items={BUCKETS} value={bucket} onChange={setBucket} />

      <QueryView
        query={rows}
        empty="لا توجد بضاعة في الطريق"
        emptyDetail="كل المناقلات إما استُلمت كاملة أو أُلغيت."
      >
        {() => (
          <DataTable
            rows={shown}
            rowKey={(row) => `${row.transferId}:${row.lineNo}`}
            expanded={(row) => (
              <div className="doc-head">
                <div className="doc-field">
                  <span>من مستودع</span>
                  <b>{names.get(row.fromWarehouseId) ?? '—'}</b>
                </div>
                <div className="doc-field">
                  <span>إلى مستودع</span>
                  <b>{names.get(row.toWarehouseId) ?? '—'}</b>
                </div>
                <div className="doc-field">
                  <span>حالة المناقلة</span>
                  <b>{row.status}</b>
                </div>
                <div className="doc-field">
                  <span>سطر</span>
                  <b dir="ltr">{row.lineNo}</b>
                </div>
              </div>
            )}
            footer={[
              <>المجموع ({shown.length})</>,
              '',
              '',
              '',
              '',
              quantity(shown.reduce((sum, row) => sum + Number(row.qty), 0)),
              quantity(shown.reduce((sum, row) => sum + Number(row.baseQty), 0)),
              money(shown.reduce((sum, row) => sum + Number(row.value), 0)),
              ...(manage ? [''] : []),
            ]}
            columns={[
              { key: 'number', header: 'المناقلة', align: 'ltr', cell: (row) => row.number },
              { key: 'sent', header: 'تاريخ الإرسال', align: 'ltr', cell: (row) => shortDate(row.sentAt) },
              {
                key: 'age',
                header: 'أيام في الطريق',
                align: 'num',
                cell: (row) =>
                  (row.daysInTransit ?? 0) >= 3 ? (
                    <span className="badge failed" dir="ltr">{`${row.daysInTransit} يوم`}</span>
                  ) : (
                    <span dir="ltr">{`${row.daysInTransit ?? 0} يوم`}</span>
                  ),
              },
              { key: 'item', header: 'الصنف', cell: (row) => `${row.sku ?? ''} — ${row.nameAr ?? ''}` },
              { key: 'from', header: 'من مستودع', cell: (row) => names.get(row.fromWarehouseId) ?? '—' },
              { key: 'qty', header: 'الكمية المعلّقة', align: 'num', cell: (row) => quantity(row.qty) },
              { key: 'base', header: 'بالوحدة الأساسية', align: 'num', cell: (row) => quantity(row.baseQty) },
              { key: 'value', header: 'القيمة', align: 'num', cell: (row) => money(row.value) },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: '',
                      cell: (row: InTransitRow) => (
                        <span className="row">
                          <button
                            className="btn sm"
                            type="button"
                            disabled={busy === `${row.transferId}:${row.lineNo}`}
                            onClick={() => void settle(row, 'return')}
                          >
                            إعادة للمصدر
                          </button>
                          <button
                            className="btn sm danger"
                            type="button"
                            disabled={busy === `${row.transferId}:${row.lineNo}`}
                            onClick={() => void settle(row, 'shortage')}
                          >
                            إقفال كعجز
                          </button>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
