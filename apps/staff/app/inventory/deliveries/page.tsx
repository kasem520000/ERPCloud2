'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import {
  arabicName,
  itemLabel,
  listItems,
  listWarehouses,
  money,
  quantity,
  shortDate,
  statusLabel,
  today,
  type Item,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type OutstandingLine = { itemId: string; description: string | null; invoicedQty: string; deliveredQty: string; remainingQty: string };
type OutstandingInvoice = {
  id: string;
  number: string | null;
  branchId: string;
  warehouseId: string | null;
  partyId: string | null;
  cashCustomerName: string | null;
  total: string;
  lines: OutstandingLine[];
};
type DeliveryLine = { lineNo: number; itemId: string; qty: string; note: string | null };
type Delivery = {
  id: string;
  number: string;
  status: string;
  invoiceId: string;
  invoiceNumber: string | null;
  warehouseId: string;
  deliveredOn: string;
  recipientName: string | null;
  driverName: string | null;
  lines: DeliveryLine[];
};

const STATUS_LABELS: Record<string, string> = { draft: 'قيد التجهيز', delivered: 'مُسلَّم', cancelled: 'ملغى' };

export default function StockDeliveriesPage() {
  const { can } = useSession();
  const deliveries = useQuery<Delivery[]>(() => apiList<Delivery>('/inventory/deliveries'), []);
  const outstanding = useQuery<OutstandingInvoice[]>(() => apiList<OutstandingInvoice>('/inventory/deliveries/outstanding'), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const warehouseRows = warehouses.data ?? [];
  const itemRows = items.data ?? [];
  const outstandingRows = useMemo(() => outstanding.data ?? [], [outstanding.data]);

  const [invoiceId, setInvoiceId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [deliveredOn, setDeliveredOn] = useState(today());
  const [recipientName, setRecipient] = useState('');
  const [driverName, setDriver] = useState('');
  const [notes, setNotes] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const invoice = outstandingRows.find((row) => row.id === invoiceId);
  const nameOfWarehouse = (id: string) => {
    const warehouse = warehouseRows.find((row) => row.id === id);
    return warehouse ? arabicName(warehouse) : id;
  };
  const nameOfItem = (id: string, fallback?: string | null) => {
    const item = itemRows.find((row) => row.id === id);
    return item ? itemLabel(item) : fallback || id;
  };

  function pickInvoice(id: string) {
    setInvoiceId(id);
    const picked = outstandingRows.find((row) => row.id === id);
    setQuantities(Object.fromEntries((picked?.lines ?? []).map((line) => [line.itemId, line.remainingQty])));
    setWarehouseId(picked?.warehouseId ?? '');
    setRecipient(picked?.cashCustomerName ?? '');
  }

  function reload() {
    deliveries.reload();
    outstanding.reload();
  }

  async function act(action: () => Promise<unknown>, okText: string) {
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  async function createDelivery(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (!invoice) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر فاتورة مرحَّلة أولاً.');
      const lines = invoice.lines
        .map((line) => ({ itemId: line.itemId, qty: quantities[line.itemId] ?? '0' }))
        .filter((line) => Number(line.qty) > 0);
      if (lines.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أدخل كمية تسليم واحدة على الأقل.');
      await apiPost('/inventory/deliveries', {
        invoiceId: invoice.id,
        warehouseId: warehouseId || undefined,
        deliveredOn,
        recipientName: recipientName || undefined,
        driverName: driverName || undefined,
        notes: notes || undefined,
        lines,
      });
      setNotice({ kind: 'ok', text: 'تم إنشاء سند التوصيل. أكِّد التسليم بعد استلام العميل للبضاعة.' });
      setInvoiceId('');
      setQuantities({});
      setDriver('');
      setNotes('');
      reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const deliveryRows = deliveries.data ?? [];
  const pendingQty = outstandingRows.reduce(
    (sum, row) => sum + row.lines.reduce((inner, line) => inner + Number(line.remainingQty), 0),
    0,
  );
  const pendingValue = outstandingRows.reduce((sum, row) => sum + Number(row.total), 0);
  const deliveredQty = deliveryRows.reduce(
    (sum, row) => sum + (row.lines ?? []).reduce((inner, line) => inner + Number(line.qty ?? 0), 0),
    0,
  );

  return (
    <Screen
      title="توصيل مخزني"
      subtitle="سند تسليم بضاعة فاتورة مبيعات مرحَّلة: يوثّق ما خرج فعلياً ومن استلمه، ولا يحرّك المخزون لأن ترحيل الفاتورة هو ما يخصم الرصيد."
      crumbs={['المستودعات', 'العمليات']}
    >
      <StatTiles>
        <StatTile
          label="فواتير معلقة التوصيل"
          value={outstandingRows.length}
          hint="مرحَّلة ولم تُسلَّم بالكامل"
          tone={outstandingRows.length > 0 ? 'warn' : 'ok'}
        />
        <StatTile label="الكمية المتبقية" value={quantity(pendingQty)} hint="لم تُسلَّم بعد" tone="brand" />
        <StatTile label="قيمة الفواتير المعلقة" value={money(pendingValue)} hint="إجمالي المستحق تسليمه" />
        <StatTile label="سندات التوصيل" value={deliveryRows.length} hint="سند مسجّل" />
        <StatTile label="الكمية المسلَّمة" value={quantity(deliveredQty)} hint="مجموع سندات التوصيل" tone="ok" />
      </StatTiles>

      {can('inventory.delivery.manage') && (
        <form className="card" onSubmit={createDelivery}>
          <h2>سند توصيل جديد</h2>
          <div className="form-grid">
            <label className="field wide">
              <span>الفاتورة (مرحَّلة وعليها كميات لم تُسلَّم) *</span>
              <select className="input" value={invoiceId} onChange={(event) => pickInvoice(event.target.value)} required>
                <option value="">— اختر —</option>
                {outstandingRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`${row.number ?? row.id.slice(0, 8)} — ${row.cashCustomerName ?? 'عميل مسجَّل'} — ${money(row.total)}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المستودع *</span>
              <select className="input" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} required>
                <option value="">— اختر —</option>
                {warehouseRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>تاريخ التسليم</span>
              <input className="input" dir="ltr" type="date" value={deliveredOn} onChange={(event) => setDeliveredOn(event.target.value)} />
            </label>
            <label className="field">
              <span>المستلِم</span>
              <input className="input" value={recipientName} onChange={(event) => setRecipient(event.target.value)} placeholder="اسم من استلم البضاعة" />
            </label>
            <label className="field">
              <span>السائق / المندوب</span>
              <input className="input" value={driverName} onChange={(event) => setDriver(event.target.value)} />
            </label>
            <label className="field wide">
              <span>ملاحظات</span>
              <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>

          {invoice && (
            <>
              <h3>الأصناف</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>المادة</th>
                      <th>بالفاتورة</th>
                      <th>سُلِّم سابقاً</th>
                      <th>المتبقي</th>
                      <th>كمية هذا السند</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lines.map((line) => (
                      <tr key={line.itemId}>
                        <td>{nameOfItem(line.itemId, line.description)}</td>
                        <td className="num">{quantity(line.invoicedQty)}</td>
                        <td className="num">{quantity(line.deliveredQty)}</td>
                        <td className="num">{quantity(line.remainingQty)}</td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={quantities[line.itemId] ?? ''}
                            onChange={(event) => setQuantities((current) => ({ ...current, [line.itemId]: event.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <Notice notice={notice} />
          <button className="btn primary" type="submit" disabled={busy || !invoiceId}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ سند التوصيل'}
          </button>
        </form>
      )}

      {!can('inventory.delivery.manage') && <Notice notice={notice} />}

      <div className="card">
        <h2>فواتير لم تُسلَّم بالكامل</h2>
        <QueryView query={outstanding} empty="لا توجد فواتير معلقة" emptyDetail="كل الفواتير المرحَّلة سُلِّمت بالكامل.">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                { key: 'number', header: 'الفاتورة', align: 'ltr', cell: (row) => row.number ?? '—' },
                { key: 'customer', header: 'العميل', cell: (row) => row.cashCustomerName ?? 'عميل مسجَّل' },
                { key: 'total', header: 'الإجمالي', align: 'num', cell: (row) => money(row.total) },
                { key: 'items', header: 'أصناف معلقة', align: 'num', cell: (row) => row.lines.length },
                { key: 'remaining', header: 'الكمية المتبقية', align: 'num', cell: (row) => quantity(row.lines.reduce((sum, line) => sum + Number(line.remainingQty), 0)) },
              ]}
            />
          )}
        </QueryView>
      </div>

      <QueryView query={deliveries} empty="لا توجد سندات توصيل" emptyDetail="أنشئ سند توصيل مقابل فاتورة مبيعات مرحَّلة.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number },
              { key: 'invoice', header: 'الفاتورة', align: 'ltr', cell: (row) => row.invoiceNumber ?? '—' },
              { key: 'warehouse', header: 'المستودع', cell: (row) => nameOfWarehouse(row.warehouseId) },
              { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.deliveredOn) },
              { key: 'recipient', header: 'المستلِم', cell: (row) => row.recipientName ?? '—' },
              { key: 'driver', header: 'السائق', cell: (row) => row.driverName ?? '—' },
              { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => quantity(row.lines.reduce((sum, line) => sum + Number(line.qty), 0)) },
              { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STATUS_LABELS[row.status] ?? statusLabel(row.status)}</span> },
              {
                key: 'actions',
                header: '',
                cell: (row) => (
                  <span className="row">
                    {row.status === 'draft' && can('inventory.delivery.manage') && (
                      <button className="btn sm primary" type="button" onClick={() => act(() => apiPost(`/inventory/deliveries/${row.id}/deliver`, {}), 'تم تأكيد التسليم.')}>
                        تأكيد التسليم
                      </button>
                    )}
                    {row.status !== 'cancelled' && can('inventory.delivery.manage') && (
                      <button className="btn sm danger" type="button" onClick={() => act(() => apiPost(`/inventory/deliveries/${row.id}/cancel`, {}), 'أُلغي السند وعادت الكمية للمتبقي على الفاتورة.')}>
                        إلغاء
                      </button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
