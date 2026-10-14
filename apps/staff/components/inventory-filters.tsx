'use client';

/**
 * The three filters every inventory report needs, in one place.
 *
 * Item, warehouse and period are asked for again and again across the inventory
 * screens; putting them here means a new report states *what* it filters by instead of
 * re-building three `<select>`s — and a document type is named the same way everywhere
 * it is shown.
 */
import { arabicName, itemLabel, listItems, listWarehouses, type Item, type Warehouse } from '../lib/lookups';
import { useQuery } from '../lib/use-query';

export function ItemPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const items = useQuery<Item[]>(() => listItems(), []);
  const rows = (items.data ?? []).filter((row) => (row.kind ?? 'stock') === 'stock');
  return (
    <label className="field">
      <span>الصنف</span>
      <select
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">— اختر صنفاً —</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {itemLabel(row)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WarehousePicker({
  value,
  onChange,
  includeAll,
}: {
  value: string;
  onChange: (id: string) => void;
  includeAll?: boolean;
}) {
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  return (
    <label className="field">
      <span>المستودع</span>
      <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{includeAll ? '— كل المستودعات —' : '— اختر —'}</option>
        {(warehouses.data ?? []).map((row) => (
          <option key={row.id} value={row.id}>
            {arabicName(row)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PeriodPicker({
  from,
  to,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  return (
    <>
      <label className="field">
        <span>من تاريخ</span>
        <input
          className="input"
          type="date"
          dir="ltr"
          value={from}
          onChange={(event) => onFrom(event.target.value)}
        />
      </label>
      <label className="field">
        <span>إلى تاريخ</span>
        <input
          className="input"
          type="date"
          dir="ltr"
          value={to}
          onChange={(event) => onTo(event.target.value)}
        />
      </label>
    </>
  );
}

const DOC_TYPES: Record<string, string> = {
  sales_invoice: 'فاتورة بيع',
  sales_return: 'مرتجع بيع',
  purchase_invoice: 'فاتورة شراء',
  purchase_return: 'مرتجع شراء',
  stock_voucher: 'سند مخزني',
  stock_adjustment: 'جرد وتسوية',
  stock_transfer: 'مناقلة — صادر',
  stock_transfer_receipt: 'مناقلة — وارد',
  stock_transfer_cancel: 'مناقلة — إلغاء',
  stock_transfer_return: 'مناقلة — عودة',
  production_order: 'أمر إنتاج',
  opening: 'بضاعة أول مدة',
  pos_sale: 'بيع نقطة بيع',
};

export function docTypeLabel(docType: string): string {
  return DOC_TYPES[docType] ?? docType;
}
