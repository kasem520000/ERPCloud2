'use client';

import { useState } from 'react';

import { DataTable, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles } from '../../../components/ui';
import {
  ItemPicker,
  PeriodPicker,
  WarehousePicker,
  docTypeLabel,
} from '../../../components/inventory-filters';
import {
  dateTime,
  itemLabel,
  listItems,
  money,
  movements as movementsReport,
  quantity,
  type Item,
  type MovementRow,
} from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

export default function MovementsPage() {
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const items = useQuery<Item[]>(() => listItems(), []);
  const movements = useQuery<MovementRow[]>(
    () =>
      movementsReport({
        item_id: itemId || undefined,
        warehouse_id: warehouseId || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    [itemId, warehouseId, from, to],
  );

  const itemRows = items.data ?? [];
  const rows = movements.data ?? [];
  const inward = rows.filter((row) => row.direction === 'in');
  const outward = rows.filter((row) => row.direction === 'out');
  const sum = (list: MovementRow[], field: 'qty' | 'baseQty') => list.reduce((acc, row) => acc + Number(row[field]), 0);
  const sumValue = (list: MovementRow[]) => list.reduce((acc, row) => acc + Number(row.totalCost ?? 0), 0);

  return (
    <Screen
      title="حركة مادة (تفصيلي)"
      subtitle="كل حركة دخول وخروج بترتيب زمني، بالتكلفة التي رُحّلت بها."
      crumbs={['المستودعات', 'تقارير مستودعية']}
    >
      <StatTiles>
        <StatTile label="عدد الحركات" value={rows.length} hint="داخل الفلاتر المختارة" tone="brand" />
        <StatTile
          label="حركات واردة"
          value={inward.length}
          hint={quantity(sum(inward, 'baseQty'))}
          tone="ok"
        />
        <StatTile
          label="حركات صادرة"
          value={outward.length}
          hint={quantity(sum(outward, 'baseQty'))}
          tone="danger"
        />
        <StatTile label="صافي الكمية" value={quantity(sum(inward, 'baseQty') - sum(outward, 'baseQty'))} hint="وارد − صادر" />
        <StatTile label="قيمة الحركات" value={money(sumValue(rows))} hint="مجموع قيمة الوارد والصادر" />
      </StatTiles>

      <FilterBar
        actions={<span className="small muted">{rows.length === 0 ? 'لا حركات' : `${rows.length} حركة`}</span>}
      >
        <ItemPicker value={itemId} onChange={setItemId} />
        <WarehousePicker value={warehouseId} onChange={setWarehouseId} includeAll />
        <PeriodPicker from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </FilterBar>

      <QueryView
        query={movements}
        empty="لا توجد حركات"
        emptyDetail="تظهر الحركات بعد ترحيل فاتورة أو مناقلة أو تسوية."
      >
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'at', header: 'التاريخ', align: 'ltr', cell: (row) => dateTime(row.occurredAt) },
              {
                key: 'item',
                header: 'المادة',
                cell: (row) => {
                  const item = itemRows.find((entry) => entry.id === row.itemId);
                  return item ? itemLabel(item) : row.itemId;
                },
              },
              { key: 'doc', header: 'المستند', cell: (row) => docTypeLabel(row.docType) },
              {
                key: 'dir',
                header: 'الاتجاه',
                cell: (row) => (
                  <span
                    style={{
                      color: row.direction === 'in' ? 'var(--ok)' : 'var(--danger)',
                      fontWeight: 700,
                    }}
                  >
                    {row.direction === 'in' ? 'وارد' : 'صادر'}
                  </span>
                ),
              },
              { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => quantity(row.qty) },
              { key: 'unit', header: 'تكلفة الوحدة', align: 'num', cell: (row) => money(row.unitCost) },
              { key: 'total', header: 'الإجمالي', align: 'num', cell: (row) => money(row.totalCost) },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
