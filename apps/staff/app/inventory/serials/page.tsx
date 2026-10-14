'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import type { SerialTrace } from '../../../lib/lookups';
import { FilterBar, StatTile, StatTiles, Tabs } from '../../../components/ui';
import { ApiError, apiPost } from '../../../lib/api';
import {
  arabicName,
  consumeSerials,
  deleteSerial,
  generateSerials,
  itemLabel,
  listItems,
  listLots,
  listSerials,
  listWarehouses,
  releaseSerials,
  reserveSerials,
  returnSerials,
  shortDate,
  traceSerial,
  type Item,
  type Lot,
  type Serial,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * الأرقام التسلسلية — `frmItemSerialNo.xaml` split the world in two: `📋 الأرقام المتاحة`
 * and `📤 الأرقام المباعة`, with `⚙️ توليد` making a batch off one prefix and `🗑️`
 * withdrawing a number that never left the shelf. The cloud has always had the state
 * machine (available → reserved → sold → available) but no screen that could drive it,
 * so the numbers were a list to read instead of a shelf to work.
 */
const DOC_LABELS: Record<string, string> = {
  stock_voucher: 'سند إدخال / إخراج مخزني',
  opening: 'بضاعة أول المدة',
  stock_adjustment: 'جرد وتسوية',
  stock_transfer: 'مناقلة',
  production_order: 'أمر إنتاج',
};

const STATUS_LABELS: Record<string, string> = {
  available: 'متاح',
  reserved: 'محجوز',
  sold: 'مُباع',
  returned: 'مُرتجع',
};

type TabId = 'available' | 'sold';

/** Which statuses each of the desktop's two grids holds. */
const TAB_STATUSES: Record<TabId, string[]> = {
  available: ['available', 'reserved'],
  sold: ['sold', 'returned'],
};

export default function SerialsPage() {
  const { can } = useSession();
  const manage = can('inventory.adjust');

  const [tab, setTab] = useState<TabId>('available');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  // The generator: one prefix, a starting number, a count — the desktop's ⚙️ توليد.
  const [draft, setDraft] = useState({ itemId: '', prefix: 'SN-', startAt: '1', count: '10', warehouseId: '', lotId: '' });
  const [single, setSingle] = useState({ itemId: '', serialNo: '', warehouseId: '' });
  const [trace, setTrace] = useState<SerialTrace | undefined>();

  const serials = useQuery<Serial[]>(
    () => listSerials({ itemId: itemId || undefined, warehouseId: warehouseId || undefined, q: search.trim() || undefined }),
    [itemId, warehouseId, search],
  );
  const items = useQuery<Item[]>(() => listItems(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const lots = useQuery<Lot[]>(() => (draft.itemId ? listLots({ itemId: draft.itemId }) : Promise.resolve([])), [draft.itemId]);

  const allRows = serials.data ?? [];
  const rows = allRows.filter((row) => TAB_STATUSES[tab].includes(row.status));
  const visibleIds = rows.map((row) => row.id);
  const checked = selected.filter((id) => visibleIds.includes(id));
  const allChecked = rows.length > 0 && checked.length === rows.length;

  const itemName = (id: string) => {
    const item = (items.data ?? []).find((row) => row.id === id);
    return item ? itemLabel(item) : id;
  };
  const warehouseName = (id?: string | null) => {
    if (!id) return '—';
    const warehouse = (warehouses.data ?? []).find((row) => row.id === id);
    return warehouse ? arabicName(warehouse) : id;
  };
  const lotNo = (id?: string | null) => {
    if (!id) return '—';
    const lot = (lots.data ?? []).find((row) => row.id === id);
    return lot ? lot.lotNo : '—';
  };

  async function showTrace(row: Serial) {
    setBusy(true);
    setNotice(undefined);
    try {
      setTrace(await traceSerial(row.id));
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await run();
      setNotice({ kind: 'ok', text: okText });
      setSelected([]);
      serials.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const count = (status: string) => allRows.filter((row) => row.status === status).length;

  return (
    <Screen
      title="تقرير الأرقام التسلسلية"
      subtitle="تتبّع كل قطعة برقمها التسلسلي: ما زال على الرف، وما خرج منه، وما أُعيد إليه."
      crumbs={['المستودعات', 'تقارير مستودعية']}
    >
      <StatTiles>
        <StatTile label="إجمالي الأرقام" value={allRows.length} hint="رقم تسلسلي مسجّل" tone="brand" />
        <StatTile label="متاح" value={count('available')} hint="جاهز للبيع" tone="ok" />
        <StatTile label="محجوز" value={count('reserved')} hint="مرتبط بمستند" tone="warn" />
        <StatTile label="مُباع" value={count('sold')} hint="خرج من المخزون" />
        <StatTile label="مُرتجع" value={count('returned')} hint="أُعيد إلى المخزون" />
      </StatTiles>

      <FilterBar
        actions={
          manage ? (
            <>
              <button
                className="btn sm"
                type="button"
                disabled={busy || checked.length === 0}
                onClick={() => void act(() => reserveSerials(checked), 'حُجزت الأرقام المحددة.')}
              >
                حجز
              </button>
              <button
                className="btn sm"
                type="button"
                disabled={busy || checked.length === 0}
                onClick={() => void act(() => releaseSerials(checked), 'أُفرج عن الأرقام المحجوزة.')}
              >
                إفراج
              </button>
              <button
                className="btn sm primary"
                type="button"
                disabled={busy || checked.length === 0}
                onClick={() => void act(() => consumeSerials(checked), 'خُرّجت الأرقام من المخزون.')}
              >
                استهلاك (بيع)
              </button>
              <button
                className="btn sm"
                type="button"
                disabled={busy || checked.length === 0}
                onClick={() => void act(() => returnSerials(checked), 'أُعيدت الأرقام إلى المخزون.')}
              >
                إرجاع
              </button>
              <button
                className="btn sm danger"
                type="button"
                disabled={busy || checked.length === 0}
                onClick={() => {
                  if (!window.confirm(`حذف ${checked.length} رقم تسلسلي؟ الأرقام غير المتاحة لا تُحذف.`)) return;
                  void act(() => Promise.all(checked.map((id) => deleteSerial(id))), 'حُذفت الأرقام المحددة.');
                }}
              >
                حذف
              </button>
            </>
          ) : undefined
        }
      >
        <label className="field">
          <span>المادة</span>
          <select className="input" value={itemId} onChange={(event) => setItemId(event.target.value)}>
            <option value="">كل المواد</option>
            {(items.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {itemLabel(row)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>المستودع</span>
          <select className="input" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
            <option value="">كل المستودعات</option>
            {(warehouses.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {arabicName(row)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>بحث بالرقم</span>
          <input
            className="input"
            dir="ltr"
            placeholder="SN-104"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </FilterBar>

      {notice ? <Notice notice={notice} /> : null}

      <Tabs<TabId>
        items={[
          { id: 'available', label: `📋 الأرقام المتاحة (${count('available') + count('reserved')})` },
          { id: 'sold', label: `📤 الأرقام المباعة (${count('sold') + count('returned')})` },
        ]}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setSelected([]);
        }}
      />

      <QueryView
        query={serials}
        empty={tab === 'available' ? 'لا توجد أرقام متاحة' : 'لا توجد أرقام مباعة'}
        emptyDetail={
          manage
            ? 'استخدم «توليد» لإنتاج دفعة من الأرقام، أو «إدراج» لإضافة رقم واحد.'
            : undefined
        }
      >
        {() => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            footer={[
              <>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(event) =>
                    setSelected(event.target.checked ? rows.map((row) => row.id) : [])
                  }
                  aria-label="تحديد الكل"
                />
              </>,
              <>المجموع ({rows.length})</>,
              '',
              '',
              '',
              '',
              '',
            ]}
            columns={[
              {
                key: 'pick',
                header: '',
                cell: (row) => (
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, row.id]
                          : current.filter((id) => id !== row.id),
                      )
                    }
                    aria-label={`تحديد ${row.serialNo}`}
                  />
                ),
              },
              {
                key: 'serial',
                header: '🔢 الرقم التسلسلي',
                align: 'ltr',
                cell: (row) => row.serialNo,
              },
              { key: 'item', header: 'الصنف', cell: (row) => itemName(row.itemId) },
              { key: 'warehouse', header: 'المستودع', cell: (row) => warehouseName(row.warehouseId) },
              { key: 'lot', header: 'رقم الدفعة', cell: (row) => lotNo(row.lotId) },
              {
                key: 'trace',
                header: '',
                cell: (row) => (
                  <button className="btn sm" type="button" disabled={busy} onClick={() => void showTrace(row)}>
                    🔍
                  </button>
                ),
              },
              {
                key: 'status',
                header: '⚙️ الحالة',
                cell: (row) => (
                  <span
                    className={`badge ${
                      row.status === 'available' ? 'ok' : row.status === 'reserved' ? 'warn' : ''
                    }`}
                  >
                    {STATUS_LABELS[row.status] ?? row.status}
                  </span>
                ),
              },
            ]}
          />
        )}
      </QueryView>

      {trace && (
        <div className="card">
          <div className="section-title">
            <h4>{`🔍 مسار الرقم ${trace.serial.serialNo}`}</h4>
            <button className="btn sm" type="button" onClick={() => setTrace(undefined)}>
              إغلاق
            </button>
          </div>
          {trace.documents.length === 0 ? (
            <p className="muted">لم يتحرك هذا الرقم على أي مستند بعد.</p>
          ) : (
            <div className="table-wrap">
              <table className="zebra">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>المستند</th>
                    <th>السطر</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.documents.map((row, index) => (
                    <tr key={`${row.docId}-${row.lineNo}`}>
                      <td className="num">{index + 1}</td>
                      <td>{DOC_LABELS[row.docType] ?? row.docType}</td>
                      <td className="num">{row.lineNo}</td>
                      <td dir="ltr">{shortDate(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {manage && (
        <div className="card">
          <h4>⚙️ توليد — دفعة أرقام من بادئة واحدة</h4>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                () =>
                  generateSerials({
                    itemId: draft.itemId,
                    prefix: draft.prefix,
                    startAt: Number(draft.startAt) || 1,
                    count: Number(draft.count) || 1,
                    warehouseId: draft.warehouseId || undefined,
                    lotId: draft.lotId || undefined,
                  }),
                `تم توليد ${draft.count} رقم تسلسلي.`,
              );
            }}
          >
            <label className="field">
              <span>الصنف *</span>
              <select
                className="input"
                value={draft.itemId}
                onChange={(event) => setDraft({ ...draft, itemId: event.target.value, lotId: '' })}
                required
              >
                <option value="">— اختر —</option>
                {(items.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {itemLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>البادئة *</span>
              <input
                className="input"
                dir="ltr"
                value={draft.prefix}
                onChange={(event) => setDraft({ ...draft, prefix: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>يبدأ من</span>
              <input
                className="input"
                inputMode="numeric"
                dir="ltr"
                value={draft.startAt}
                onChange={(event) => setDraft({ ...draft, startAt: event.target.value })}
              />
            </label>
            <label className="field">
              <span>العدد</span>
              <input
                className="input"
                inputMode="numeric"
                dir="ltr"
                value={draft.count}
                onChange={(event) => setDraft({ ...draft, count: event.target.value })}
              />
            </label>
            <label className="field">
              <span>المستودع</span>
              <select
                className="input"
                value={draft.warehouseId}
                onChange={(event) => setDraft({ ...draft, warehouseId: event.target.value })}
              >
                <option value="">— غير محدد —</option>
                {(warehouses.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>رقم الدفعة</span>
              <select
                className="input"
                value={draft.lotId}
                onChange={(event) => setDraft({ ...draft, lotId: event.target.value })}
                disabled={!draft.itemId}
              >
                <option value="">— بدون دفعة —</option>
                {(lots.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.lotNo}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || !draft.itemId}>
                {busy ? 'جارٍ التوليد…' : '⚙️ توليد'}
              </button>
            </div>
          </form>

          <h4>✅ إدراج — رقم واحد</h4>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                () =>
                  apiPost('/inventory/serials', {
                    itemId: single.itemId,
                    serialNo: single.serialNo.trim(),
                    warehouseId: single.warehouseId || undefined,
                  }),
                `أُدرج الرقم ${single.serialNo}.`,
              );
              setSingle({ ...single, serialNo: '' });
            }}
          >
            <label className="field">
              <span>الصنف *</span>
              <select
                className="input"
                value={single.itemId}
                onChange={(event) => setSingle({ ...single, itemId: event.target.value })}
                required
              >
                <option value="">— اختر —</option>
                {(items.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {itemLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>الرقم التسلسلي *</span>
              <input
                className="input"
                dir="ltr"
                value={single.serialNo}
                onChange={(event) => setSingle({ ...single, serialNo: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>المستودع</span>
              <select
                className="input"
                value={single.warehouseId}
                onChange={(event) => setSingle({ ...single, warehouseId: event.target.value })}
              >
                <option value="">— غير محدد —</option>
                {(warehouses.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button className="btn" type="submit" disabled={busy || !single.itemId || !single.serialNo.trim()}>
                إدراج
              </button>
            </div>
          </form>
          <p className="muted small">
            {`الأرقام غير المتاحة (محجوزة أو مباعة) لا تُحذف — أعدها إلى المخزون أولاً. ${shortDate(new Date().toISOString())}`}
          </p>
        </div>
      )}
    </Screen>
  );
}
