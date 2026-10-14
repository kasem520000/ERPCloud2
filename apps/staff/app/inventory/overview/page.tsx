'use client';

import Link from 'next/link';
import { useState } from 'react';

import { QueryView } from '../../../components/data-view';
import { WarehousePicker } from '../../../components/inventory-filters';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles } from '../../../components/ui';
import { apiList } from '../../../lib/api';
import {
  expiryReport,
  inTransitReport,
  listWarehouses,
  money,
  quantity,
  type ExpiryRow,
  type InTransitRow,
  type Warehouse,
} from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * لوحة المخزون — the module landing page the desktop never had.
 *
 * Every one of these numbers used to require opening its own report: what the stock is
 * worth, what has fallen under its reorder point, what is close to expiring, what is
 * still parked in transit, and which documents are still drafts waiting to be posted.
 * Here they sit side by side, each one a link to the screen that settles it.
 */

type Level = { itemId: string; warehouseId: string; quantity: string; value: string; averageCost: string };
type ShortRow = { itemId: string; sku: string; nameAr: string; warehouseId: string; quantity: string; minQty: string; shortage: string };
type Voucher = { id: string; number: string; kind: string; status: string; totalCost: string };

const QUICK = [
  { href: '/inventory/vouchers?kind=stock_in', icon: '📥', label: 'سند إدخال' },
  { href: '/inventory/vouchers?kind=stock_out', icon: '📤', label: 'سند إخراج' },
  { href: '/inventory/transfers', icon: '🔄', label: 'مناقلة' },
  { href: '/inventory/adjustments', icon: '🧮', label: 'جرد وتسوية' },
  { href: '/inventory/item-card', icon: '🧾', label: 'بطاقة صنف' },
  { href: '/inventory/in-transit', icon: '🚚', label: 'بضاعة في الطريق' },
  { href: '/inventory/below-minimum', icon: '⚠️', label: 'تحت حد الطلب' },
  { href: '/inventory/expiry', icon: '⏰', label: 'تواريخ الصلاحية' },
];

export default function InventoryOverviewPage() {
  const [warehouseId, setWarehouseId] = useState('');

  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const levels = useQuery<Level[]>(
    () => apiList<Level>(`/inventory/levels${warehouseId ? `?warehouse_id=${warehouseId}` : ''}`),
    [warehouseId],
  );
  const short = useQuery<ShortRow[]>(
    () => apiList<ShortRow>(`/inventory/below-minimum${warehouseId ? `?warehouse_id=${warehouseId}` : ''}`),
    [warehouseId],
  );
  const expiry = useQuery<ExpiryRow[]>(() => expiryReport(30), []);
  const transit = useQuery<InTransitRow[]>(() => inTransitReport(warehouseId || undefined), [warehouseId]);
  const vouchers = useQuery<Voucher[]>(() => apiList<Voucher>('/inventory/vouchers'), []);

  const warehouseName = (warehouses.data ?? []).find((row) => row.id === warehouseId)?.nameAr;
  const levelRows = levels.data ?? [];
  const stockValue = levelRows.reduce((sum, row) => sum + Number(row.value), 0);
  const stockQty = levelRows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const shortRows = short.data ?? [];
  const expiryRows = expiry.data ?? [];
  const transitRows = transit.data ?? [];
  const drafts = (vouchers.data ?? []).filter((voucher) => voucher.status === 'draft');
  const transitValue = transitRows.reduce((sum, row) => sum + Number(row.value), 0);
  const expired = expiryRows.filter((row) => row.expired).length;

  return (
    <Screen
      title="لوحة المخزون"
      subtitle="ما يملكه المستودع، وما يحتاج قراراً اليوم: أرصدة، عجز، صلاحية، بضاعة في الطريق، ومسودات تنتظر الترحيل."
      crumbs={['المستودعات', 'نظرة عامة']}
    >
      <FilterBar
        actions={
          <span className="small muted">{warehouseId ? (warehouseName ?? 'مستودع محدد') : 'كل المستودعات'}</span>
        }
      >
        <div className="field">
          <span>المستودع</span>
          <WarehousePicker value={warehouseId} onChange={setWarehouseId} includeAll />
        </div>
      </FilterBar>

      <StatTiles>
        <StatTile
          label="قيمة المخزون"
          value={money(stockValue)}
          hint={`${quantity(stockQty)} وحدة بمتوسط تكلفة`}
          tone="brand"
        />
        <StatTile
          label="أصناف في الأرصدة"
          value={levelRows.length}
          hint="صف رصيد لكل صنف ومستودع"
        />
        <StatTile
          label="تحت حد الطلب"
          value={shortRows.length}
          hint={
            shortRows.length > 0
              ? `عجز ${quantity(shortRows.reduce((sum, row) => sum + Number(row.shortage), 0))}`
              : 'كل الأصناف فوق حدها'
          }
          tone={shortRows.length > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="دفعات قاربت الانتهاء"
          value={expiryRows.length}
          hint={expired > 0 ? `منها ${expired} منتهية` : 'داخل ثلاثين يوماً'}
          tone={expired > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="بضاعة في الطريق"
          value={transitRows.length}
          hint={transitRows.length > 0 ? `بقيمة ${money(transitValue)}` : 'لا شيء معلق'}
          tone={transitRows.length > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="مسودات تنتظر الترحيل"
          value={drafts.length}
          hint={drafts.length > 0 ? 'سندات لم تُرحَّل بعد' : 'كل السندات مُرحَّلة'}
          tone={drafts.length > 0 ? 'warn' : 'ok'}
        />
      </StatTiles>

      <div className="card">
        <h2>إجراءات سريعة</h2>
        <div className="grid cols">
          {QUICK.map((item) => (
            <Link key={item.href} className="card tight" href={item.href}>
              <span style={{ fontSize: 20 }}>{item.icon}</span>
              <strong>{item.label}</strong>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>أكبر الأرصدة قيمةً</h2>
          <QueryView query={levels} empty="لا أرصدة" emptyDetail="لا توجد أرصدة مسجّلة في هذا المستودع.">
            {() => (
              <ol className="grid" style={{ gap: 8, margin: 0, paddingInlineStart: 18 }}>
                {[...levelRows]
                  .sort((left, right) => Number(right.value) - Number(left.value))
                  .slice(0, 6)
                  .map((row) => (
                    <li key={`${row.itemId}:${row.warehouseId}`} className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="muted small" dir="ltr">{`${row.itemId.slice(0, 8)}`}</span>
                      <span dir="ltr">
                        {quantity(row.quantity)} — <strong>{money(row.value)}</strong>
                      </span>
                    </li>
                  ))}
              </ol>
            )}
          </QueryView>
        </div>

        <div className="card">
          <h2>أكبر العجز</h2>
          <QueryView query={short} empty="لا عجز" emptyDetail="كل الأصناف أعلى من حد الطلب المعرّف لها.">
            {() => (
              <ol className="grid" style={{ gap: 8, margin: 0, paddingInlineStart: 18 }}>
                {[...shortRows]
                  .sort((left, right) => Number(right.shortage) - Number(left.shortage))
                  .slice(0, 6)
                  .map((row) => (
                    <li key={`${row.itemId}:${row.warehouseId}`} className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        {row.sku} — {row.nameAr}
                      </span>
                      <span dir="ltr">
                        <strong>{quantity(row.shortage)}</strong>
                      </span>
                    </li>
                  ))}
              </ol>
            )}
          </QueryView>
        </div>
      </div>
    </Screen>
  );
}
