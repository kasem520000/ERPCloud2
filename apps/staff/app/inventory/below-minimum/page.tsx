'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles } from '../../../components/ui';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import {
  arabicName,
  defaultOf,
  itemLabel,
  listBranches,
  listWarehouses,
  quantity,
  type Branch,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * حد الطلب — the reorder report (`CalcItemsStockLimits` in the desktop).
 *
 * An item below its reorder point is not a statistic, it is a purchase nobody has raised
 * yet. This screen lists them with the shortage already computed, and turns a row into a
 * سند إدخال draft in one click so the fix is a document, not a note.
 */
type ShortRow = {
  itemId: string;
  sku: string;
  nameAr: string;
  warehouseId: string;
  quantity: string;
  minQty: string;
  maxQty?: string | null;
  shortage: string;
};

export default function BelowMinimumPage() {
  const { can } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];

  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows)?.id || '';

  const rows = useQuery<ShortRow[]>(
    () =>
      apiList<ShortRow>(
        `/inventory/below-minimum${effectiveWarehouse ? `?warehouse_id=${effectiveWarehouse}` : ''}`,
      ),
    [effectiveWarehouse],
  );

  async function requestStock(row: ShortRow) {
    setNotice(undefined);
    setBusy(row.itemId);
    try {
      const created = await apiPost<{ number: string }>('/inventory/vouchers', {
        branchId: branchId || defaultOf(branchRows)?.id || '',
        warehouseId: row.warehouseId,
        kind: 'stock_in',
        reason: `تغطية حد الطلب — ${arabicName({ nameAr: row.nameAr })}`,
        lines: [{ itemId: row.itemId, qty: row.shortage }],
      });
      setNotice({
        kind: 'ok',
        text: `أُنشئ سند إدخال ${created.number} لتغطية العجز. حدّد التكلفة ثم رحّله.`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy('');
    }
  }

  const data = rows.data ?? [];
  const totalShortage = data.reduce((sum, row) => sum + Number(row.shortage), 0);
  const critical = data.filter((row) => {
    const min = Number(row.minQty);
    return min > 0 && Number(row.quantity) <= min / 2;
  }).length;
  const worst = data.reduce<ShortRow | undefined>(
    (top, row) => (!top || Number(row.shortage) > Number(top.shortage) ? row : top),
    undefined,
  );

  return (
    <Screen
      title="أصناف تحت حد الطلب"
      subtitle="كل صنف نزل رصيده عن حد الطلب المعرّف على بطاقته — مع العجز المطلوب تغطيته."
      crumbs={['المستودعات', 'التقارير']}
    >
      <StatTiles>
        <StatTile
          label="أصناف تحت حد الطلب"
          value={data.length}
          hint="صنف رصيده دون الحد المعرّف على بطاقته"
          tone={data.length > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="إجمالي العجز"
          value={quantity(totalShortage)}
          hint="الكمية المطلوبة للعودة إلى الحد"
          tone="brand"
        />
        <StatTile
          label="أصناف حرجة"
          value={critical}
          hint="رصيدها نصف الحد أو أقل"
          tone={critical > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="أكبر عجز"
          value={worst ? quantity(worst.shortage) : '—'}
          hint={worst ? `${worst.sku} — ${worst.nameAr}` : 'لا عجز'}
        />
      </StatTiles>

      <FilterBar
        actions={<span className="small muted">{data.length === 0 ? 'لا عجز' : `${data.length} صنفاً بحاجة تغطية`}</span>}
      >
        <label className="field">
          <span>المستودع</span>
          <select
              className="input"
              value={effectiveWarehouse}
              onChange={(event) => setWarehouseId(event.target.value)}
            >
              <option value="">— كل المستودعات —</option>
              {warehouseRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {arabicName(row)}
                </option>
              ))}
            </select>
        </label>
        <label className="field">
          <span>الفرع (لسند التغطية)</span>
          <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">— الافتراضي —</option>
            {branchRows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code ? `${row.code} — ` : ''}
                {arabicName(row)}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      <Notice notice={notice} />

      <QueryView
        query={rows}
        empty="لا توجد أصناف تحت حد الطلب"
        emptyDetail="كل الأصناف أعلى من حد الطلب، أو أن بطاقات الأصناف لم يُحدَّد لها حد بعد."
      >
        {(data) => (
          <DataTable
            rows={data}
            rowKey={(row) => `${row.itemId}:${row.warehouseId}`}
            columns={[
              { key: 'sku', header: 'الرمز', align: 'ltr', cell: (row) => row.sku },
              {
                key: 'item',
                header: 'المادة',
                cell: (row) => itemLabel({ id: row.itemId, sku: row.sku, nameAr: row.nameAr }),
              },
              {
                key: 'warehouse',
                header: 'المستودع',
                cell: (row) =>
                  arabicName(warehouseRows.find((warehouse) => warehouse.id === row.warehouseId) ?? {}),
              },
              {
                key: 'qty',
                header: 'الرصيد',
                align: 'num',
                cell: (row) => {
                  const min = Number(row.minQty);
                  const cover = min > 0 ? Math.round((Number(row.quantity) / min) * 100) : 100;
                  const tone = cover <= 50 ? 'دanger' : cover < 100 ? 'warn' : 'ok';
                  return (
                    <span style={{ display: 'grid', gap: 2 }}>
                      <span dir="ltr">{quantity(row.quantity)}</span>
                      <span className={`bar ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'danger'}`}>
                        <span style={{ width: `${Math.min(100, cover)}%` }} />
                      </span>
                      <span className="small muted" dir="ltr">{`تغطية ${cover}٪`}</span>
                    </span>
                  );
                },
              },
              { key: 'min', header: 'حد الطلب', align: 'num', cell: (row) => quantity(row.minQty) },
              {
                key: 'shortage',
                header: 'العجز',
                align: 'num',
                cell: (row) => <strong dir="ltr">{quantity(row.shortage)}</strong>,
              },
              {
                key: 'actions',
                header: '',
                cell: (row) =>
                  can('inventory.adjust') ? (
                    <button
                      className="btn sm primary"
                      type="button"
                      disabled={busy === row.itemId}
                      onClick={() => void requestStock(row)}
                    >
                      {busy === row.itemId ? 'جارٍ الإنشاء…' : 'سند إدخال بالعجز'}
                    </button>
                  ) : null,
              },
            ]}
          />
        )}
      </QueryView>

      <p className="muted" style={{ fontSize: 13 }}>
        حد الطلب يُضبط من بطاقة الصنف (دليل المواد). السند يُنشأ كمسودة — حدّد تكلفة الوحدة ثم رحّله من شاشة
        سندات المخزون.
      </p>
    </Screen>
  );
}
