'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { arabicName, itemLabel, listItems, listWarehouses, money, quantity, type Item, type Warehouse } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type BomCard = { id: string; name: string; version: number; productItemId: string };
type OrderRow = {
  id: string;
  number: string;
  status: string;
  productItemId: string;
  qtyPlanned: string;
  qtyProduced: string;
  plannedCost: string;
  plannedUnitCost: string;
  actualCost: string;
  actualUnitCost: string | null;
};

const STATUS: Record<string, string> = { draft: 'مسودة', in_progress: 'قيد التنفيذ', done: 'مكتمل' };

export default function ManufacturingOrdersPage() {
  const boms = useQuery<BomCard[]>(() => apiList<BomCard>('/manufacturing/boms'), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const orders = useQuery<OrderRow[]>(() => apiList<OrderRow>('/manufacturing/orders'), []);
  const [bomId, setBomId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [qty, setQty] = useState('5');
  const [produceQty, setProduceQty] = useState('5');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();
  const itemRows = items.data ?? [];
  const nameOf = (id: string) => itemRows.find((row) => row.id === id) ? itemLabel(itemRows.find((row) => row.id === id) as Item) : id;

  function fail(error: unknown) {
    setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تنفيذ العملية' });
  }

  return (
    <Screen
      title="أوامر التصنيع"
      subtitle="عند التنفيذ يُصرف المكوّنات بمتوسط التكلفة ويُستلم المنتج النهائي بنفس القيمة. لا تخطيط احتياجات في هذه المرحلة."
      crumbs={['التصنيع', 'الأوامر']}
    >
      <Notice notice={notice} />
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void apiPost('/manufacturing/orders', { bomId, warehouseId, qty })
            .then(() => orders.reload())
            .then(() => setNotice({ kind: 'ok', text: 'أُنشئ أمر التصنيع.' }))
            .catch(fail);
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>قائمة المواد</span>
            <select className="input" value={bomId} onChange={(event) => setBomId(event.target.value)} required>
              <option value="">اختر</option>
              {(boms.data ?? []).map((row) => <option key={row.id} value={row.id}>{row.name} · v{row.version}</option>)}
            </select>
          </label>
          <label className="field">
            <span>المستودع</span>
            <select className="input" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} required>
              <option value="">اختر</option>
              {(warehouses.data ?? []).map((row) => <option key={row.id} value={row.id}>{arabicName(row)}</option>)}
            </select>
          </label>
          <label className="field"><span>الكمية المخططة</span><input className="input" dir="ltr" value={qty} onChange={(event) => setQty(event.target.value)} required /></label>
        </div>
        <button className="btn primary" type="submit">إنشاء أمر</button>
      </form>
      <label className="field" style={{ maxWidth: 220 }}>
        <span>كمية التنفيذ</span>
        <input className="input" dir="ltr" value={produceQty} onChange={(event) => setProduceQty(event.target.value)} />
      </label>
      <DataTable
        rows={orders.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          { key: 'number', header: 'الأمر', cell: (row) => row.number },
          { key: 'product', header: 'المنتج', cell: (row) => nameOf(row.productItemId) },
          { key: 'qty', header: 'منتج / مخطط', align: 'num', cell: (row) => `${quantity(row.qtyProduced)} / ${quantity(row.qtyPlanned)}` },
          { key: 'status', header: 'الحالة', cell: (row) => STATUS[row.status] ?? row.status },
          { key: 'planned', header: 'مخطط', align: 'num', cell: (row) => money(row.plannedCost) },
          { key: 'actual', header: 'فعلي', align: 'num', cell: (row) => money(row.actualCost) },
          {
            key: 'act',
            header: '',
            cell: (row) => row.status === 'done' ? null : (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  void apiPost(`/manufacturing/orders/${row.id}/produce`, { qty: produceQty })
                    .then(() => orders.reload())
                    .then(() => setNotice({ kind: 'ok', text: 'صُرف المكوّنات واستُلم المنتج بتكلفة المتوسط.' }))
                    .catch(fail);
                }}
              >
                تنفيذ
              </button>
            ),
          },
        ]}
      />
    </Screen>
  );
}
