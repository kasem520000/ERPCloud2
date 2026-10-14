'use client';

import { useState } from 'react';

import { DataTable, QueryView } from '../../../components/data-view';
import {
  ItemPicker,
  PeriodPicker,
  WarehousePicker,
  docTypeLabel,
} from '../../../components/inventory-filters';
import { Screen } from '../../../components/screen';
import { DocField, DocHead, FilterBar, StatTile, StatTiles, Totals } from '../../../components/ui';
import { itemCard, money, quantity, shortDate, type ItemCardRow } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * بطاقة الصنف — the item card, which is the stock ledger read the way a storekeeper
 * reads it: opening balance, every movement of the period with a running balance beside
 * it, and the closing balance that has to agree with the balance table.
 *
 * The desktop answered this from `Inventorybalance()` and `TotalItemStock(branch, date)`
 * and printed it as `rptItemDetails` — whose footer carried إجمالي الكميات and إجمالي
 * المجموع, both reproduced here. The value column matters as much as the quantity one: a
 * card that only counts units cannot answer what the stock is worth.
 */
export default function ItemCardPage() {
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState<
    { itemId: string; warehouseId: string; from: string; to: string } | undefined
  >();

  const card = useQuery(
    () =>
      applied
        ? itemCard({
            item_id: applied.itemId,
            warehouse_id: applied.warehouseId,
            from: applied.from,
            to: applied.to,
          })
        : Promise.resolve(undefined),
    [applied?.itemId, applied?.warehouseId, applied?.from, applied?.to],
  );

  return (
    <Screen
      title="بطاقة الصنف"
      subtitle="حركة الصنف خلال فترة: رصيد افتتاحي، كل حركة ورصيدها المتحرك، والرصيد الختامي وقيمته."
      crumbs={['المستودعات', 'التقارير']}
    >
      <FilterBar
        actions={
          <>
            <button
              className="btn primary"
              type="button"
              disabled={!itemId}
              onClick={() => setApplied({ itemId, warehouseId, from, to })}
            >
              عرض البطاقة
            </button>
            {applied && (
              <button className="btn" type="button" onClick={() => setApplied(undefined)}>
                تفريغ
              </button>
            )}
            {applied && (
              <button className="btn" type="button" onClick={() => window.print()}>
                طباعة
              </button>
            )}
          </>
        }
      >
        <ItemPicker value={itemId} onChange={setItemId} />
        <WarehousePicker value={warehouseId} onChange={setWarehouseId} includeAll />
        <PeriodPicker from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </FilterBar>

      {!applied ? (
        <div className="card">
          <p className="muted">
            اختر صنفاً وفترة لعرض بطاقته. ترك الفترة فارغاً يعرض كل الحركات منذ أول حركة للصنف.
          </p>
        </div>
      ) : (
        <QueryView
          query={card}
          empty="لا حركات لهذا الصنف"
          emptyDetail="لا توجد حركات مخزون مطابقة للفلاتر المختارة."
        >
          {(data) =>
            data ? (
              <>
                <div className="card">
                  <h2>{`${data.sku ?? ''} — ${data.nameAr ?? ''}`}</h2>
                  <DocHead>
                    <DocField label="الرمز">{data.sku ?? '—'}</DocField>
                    <DocField label="الصنف">{data.nameAr ?? '—'}</DocField>
                    <DocField label="المستودع">{data.warehouseId ? 'مستودع محدد' : 'كل المستودعات'}</DocField>
                    <DocField label="الفترة">
                      {data.from || data.to ? `${shortDate(data.from) ?? ''} → ${shortDate(data.to) ?? ''}` : 'كل الفترات'}
                    </DocField>
                  </DocHead>
                </div>

                <StatTiles>
                  <StatTile
                    label="رصيد افتتاحي"
                    value={quantity(data.opening.quantity)}
                    hint={money(data.opening.value)}
                  />
                  <StatTile
                    label="وارد الفترة"
                    value={quantity(data.totals.inQty)}
                    hint={money(data.totals.inValue)}
                    tone="ok"
                  />
                  <StatTile
                    label="صادر الفترة"
                    value={quantity(data.totals.outQty)}
                    hint={money(data.totals.outValue)}
                    tone="danger"
                  />
                  <StatTile
                    label="رصيد ختامي"
                    value={quantity(data.closing.quantity)}
                    hint={money(data.closing.value)}
                    tone="brand"
                  />
                </StatTiles>

                <DataTable
                  rows={data.rows}
                  rowKey={(row) => row.id}
                  expanded={(row: ItemCardRow) => (
                    <DocHead>
                      <DocField label="المستند">{docTypeLabel(row.docType)}</DocField>
                      <DocField label="الوحدة">{row.unitNameAr ?? 'الوحدة الأساسية'}</DocField>
                      <DocField label="معامل التحويل">
                        <span dir="ltr">{`×${Number(row.factor).toLocaleString('ar-EG')}`}</span>
                      </DocField>
                      <DocField label="متوسط التكلفة بعد الحركة">
                        <span dir="ltr">{money(row.averageCost)}</span>
                      </DocField>
                      <DocField label="الرصيد بعد الحركة">
                        <span dir="ltr">{`${quantity(row.balanceQty)} — ${money(row.balanceValue)}`}</span>
                      </DocField>
                    </DocHead>
                  )}
                  footer={[
                    <>إجمالي الكميات</>,
                    '',
                    '',
                    <>
                      <span dir="ltr" style={{ color: 'var(--ok)' }}>
                        {`+${quantity(data.totals.inQty)}`}
                      </span>
                      {' / '}
                      <span dir="ltr" style={{ color: 'var(--danger)' }}>
                        {`−${quantity(data.totals.outQty)}`}
                      </span>
                    </>,
                    '',
                    quantity(data.closing.quantity),
                    '',
                    money(data.closing.value),
                  ]}
                  columns={[
                    {
                      key: 'date',
                      header: 'التاريخ',
                      align: 'ltr',
                      cell: (row) => shortDate(row.occurredAt),
                    },
                    { key: 'doc', header: 'المستند', cell: (row) => docTypeLabel(row.docType) },
                    { key: 'warehouse', header: 'المستودع', cell: (row) => row.warehouseNameAr ?? '—' },
                    {
                      key: 'qty',
                      header: 'الكمية',
                      align: 'num',
                      cell: (row) => (
                        <span
                          dir="ltr"
                          style={{ color: row.direction === 'in' ? 'var(--ok)' : 'var(--danger)' }}
                        >
                          {`${row.direction === 'in' ? '+' : '−'}${quantity(row.baseQty)}`}
                        </span>
                      ),
                    },
                    {
                      key: 'unit',
                      header: 'الوحدة',
                      cell: (row) => (
                        <>
                          {row.unitNameAr ?? 'الوحدة الأساسية'}
                          {row.qty !== row.baseQty && (
                            <span className="muted small" dir="ltr">{` (${quantity(row.qty)} ×${Number(
                              row.factor,
                            ).toLocaleString('ar-EG')})`}</span>
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'balance',
                      header: 'الرصيد',
                      align: 'num',
                      cell: (row) => (
                        <strong dir="ltr">{quantity(row.balanceQty)}</strong>
                      ),
                    },
                    { key: 'cost', header: 'التكلفة', align: 'num', cell: (row) => money(row.unitCost) },
                    { key: 'value', header: 'القيمة', align: 'num', cell: (row) => money(row.totalCost) },
                  ]}
                />

                <div className="card">
                  <Totals
                    items={[
                      { label: 'إجمالي الكميات', value: quantity(data.totals.inQty) },
                      { label: 'إجمالي المجموع (وارد)', value: money(data.totals.inValue) },
                      { label: 'إجمالي المجموع (صادر)', value: money(data.totals.outValue) },
                      { label: 'الرصيد الختامي', value: quantity(data.closing.quantity) },
                      { label: 'قيمة الرصيد', value: money(data.closing.value) },
                    ]}
                  />
                </div>
              </>
            ) : (
              <div className="card">
                <p className="muted">—</p>
              </div>
            )
          }
        </QueryView>
      )}
    </Screen>
  );
}
