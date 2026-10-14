'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import {
  ActionBar,
  DocField,
  DocHead,
  FilterBar,
  StatTile,
  StatTiles,
  StatusTrack,
  Tabs,
  Totals,
} from '../../../components/ui';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import {
  arabicName,
  dateTime,
  defaultOf,
  itemLabel,
  listBranches,
  listItemUnits,
  listItems,
  listLots,
  listWarehouses,
  money,
  quantity,
  shortDate,
  statusLabel,
  type Branch,
  type Item,
  type ItemUnit,
  type Lot,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type TransferLine = {
  lineNo: number;
  itemId: string;
  qty: string;
  receivedQty: string;
  unitCost: string;
  /** 🔢 الأرقام التسلسلية riding with the goods — one per piece. */
  serialNos?: string[];
  /** 📁 رقم الدفعة وتواريخها على السطر (R5). */
  batchNo?: string | null;
  productionDate?: string | null;
  expiryDate?: string | null;
};
type Transfer = {
  id: string;
  number: string;
  status: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  createdAt?: string;
  lines: TransferLine[];
};

const TRANSFER_STATUS: Record<string, string> = {
  draft: 'مسودة',
  in_transit: 'في الطريق',
  partially_received: 'مستلم جزئياً',
  received: 'مستلم',
  closed: 'مُغلقة',
  cancelled: 'ملغاة',
};

/** Where each status sits on the lifecycle track below. */
const STATUS_STEP: Record<string, number> = {
  draft: 0,
  in_transit: 1,
  partially_received: 1,
  received: 2,
  closed: 3,
  cancelled: 1,
};

const STEPS = ['مسودة', 'في الطريق', 'مُستلمة', 'مُغلقة'];

type Bucket = 'open' | 'draft' | 'in_transit' | 'partially_received' | 'received' | 'cancelled';

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'open', label: 'قيد التنفيذ' },
  { id: 'draft', label: 'مسودة' },
  { id: 'in_transit', label: 'في الطريق' },
  { id: 'partially_received', label: 'مستلم جزئياً' },
  { id: 'received', label: 'مستلم' },
  { id: 'cancelled', label: 'ملغاة' },
];

const lineValue = (line: TransferLine) => Number(line.qty) * Number(line.unitCost ?? 0);

export default function TransfersPage() {
  const { can } = useSession();
  /**
   * 🔍 البحث — `frmSafesTransfer` narrows the grid by `🔢 رقم التحويل` and by a
   * `📅 من تاريخ` / `📅 إلى تاريخ` window, and `📋 كل الفترة` puts the whole history
   * back. The server does the narrowing so the clerk searches a year of transfers, not
   * the one page the browser happened to have cached.
   */
  const [search, setSearch] = useState<{ number: string; from: string; to: string }>({
    number: '',
    from: '',
    to: '',
  });
  const searchKey = `${search.number}|${search.from}|${search.to}`;
  const transfers = useQuery<Transfer[]>(() => {
    const params = new URLSearchParams();
    if (search.number.trim()) params.set('number', search.number.trim());
    if (search.from) params.set('from', search.from);
    if (search.to) params.set('to', search.to);
    const query = params.toString();
    return apiList<Transfer>(`/inventory/transfers${query ? `?${query}` : ''}`);
  }, [searchKey]);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const itemRows = (items.data ?? []).filter((row) => (row.kind ?? 'stock') === 'stock');

  /**
   * The branch is what lets the transfer find a posting profile, so the goods keep a
   * value while they are on the road: Dr بضاعة تحت التحويل / Cr المخزون on send, and the
   * mirror of it on receipt.
   */
  const [branchId, setBranchId] = useState('');
  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';

  const [open, setOpen] = useState(false);
  const [fromWarehouseId, setFrom] = useState('');
  const [toWarehouseId, setTo] = useState('');
  const [lines, setLines] = useState<
    Array<{
      itemId: string;
      qtyText: string;
      unitId: string;
      unitCostText: string;
      /** 📁 رقم الدفعة — المناقلة تنقل دفعةً بعينها، فيُكتب رقمها على السطر (R5). */
      batchNo: string;
      productionDate: string;
      expiryDate: string;
      serialNos: string;
    }>
  >([
    {
      itemId: '',
      qtyText: '',
      unitId: '',
      unitCostText: '',
      batchNo: '',
      productionDate: '',
      expiryDate: '',
      serialNos: '',
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [selectedId, setSelectedId] = useState('');
  const [bucket, setBucket] = useState<Bucket>('open');

  const nameOfWarehouse = (id: string) => {
    const warehouse = warehouseRows.find((row) => row.id === id);
    return warehouse ? arabicName(warehouse) : id;
  };

  /** وحدات القياس المتعددة للصنف — a transfer counted in cartons moves pieces. */
  const itemIds = lines
    .map((line) => line.itemId)
    .filter(Boolean)
    .join(',');
  const unitRows = useQuery<ItemUnit[]>(async () => {
    const ids = Array.from(new Set(itemIds.split(',').filter(Boolean)));
    const lists = await Promise.all(ids.map((id) => listItemUnits(id)));
    return lists.flat();
  }, [itemIds]);
  const unitsOf = (id: string) => (unitRows.data ?? []).filter((row) => row.itemId === id);
  const itemOf = (id: string) => itemRows.find((row) => row.id === id);
  /** الدفعات المسجَّلة — اقتراحٌ في خانة الرقم، والكتابة تبقى مفتوحة للدفعة الجديدة. */
  const lots = useQuery<Lot[]>(() => listLots(), []);

  function updateLine(
    index: number,
    patch: Partial<{
      itemId: string;
      qtyText: string;
      unitId: string;
      unitCostText: string;
      batchNo: string;
      productionDate: string;
      expiryDate: string;
      serialNos: string;
    }>,
  ) {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );
  }

  async function createTransfer(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const filled = lines.filter((line) => line.itemId && Number(line.qtyText) > 0);
      if (filled.length === 0)
        throw new ApiError(422, 'VALIDATION_FAILED', 'أضف سطراً واحداً على الأقل بكمية أكبر من صفر.');
      // No client-side number: the API allocates `TR-…` from the document sequence, so the
      // series stays gap-free and unique even with two users saving at once.
      await apiPost('/inventory/transfers/draft', {
        branchId: effectiveBranch,
        fromWarehouseId,
        toWarehouseId,
        lines: filled.map((line) => ({
          itemId: line.itemId,
          qty: line.qtyText,
          unitId: line.unitId || undefined,
          unitCost: line.unitCostText || undefined,
          batchNo: line.batchNo.trim() || undefined,
          productionDate: line.productionDate || undefined,
          expiryDate: line.expiryDate || undefined,
          serialNos: line.serialNos
            .split(/[\s,،;؛]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        })),
      });
      setNotice({ kind: 'ok', text: 'تم إنشاء المناقلة كمسودة. أرسِلها لخصم الكمية من المستودع المصدر.' });
      setLines([
        {
          itemId: '',
          qtyText: '',
          unitId: '',
          unitCostText: '',
          batchNo: '',
          productionDate: '',
          expiryDate: '',
          serialNos: '',
        },
      ]);
      transfers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function act(action: () => Promise<unknown>, okText: string) {
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      transfers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  const rows = transfers.data ?? [];
  const inFlight = rows.filter((row) => ['in_transit', 'partially_received'].includes(row.status));
  const shown =
    bucket === 'open'
      ? rows.filter((row) => ['draft', 'in_transit', 'partially_received'].includes(row.status))
      : rows.filter((row) => row.status === bucket);
  const selected = rows.find((row) => row.id === selectedId);
  const transitQty = inFlight
    .flatMap((row) => row.lines)
    .reduce((sum, line) => sum + (Number(line.qty) - Number(line.receivedQty)), 0);
  const transitValue = inFlight
    .flatMap((row) => row.lines)
    .reduce((sum, line) => sum + (Number(line.qty) - Number(line.receivedQty)) * Number(line.unitCost ?? 0), 0);

  return (
    <Screen
      title="مناقلة مخزنية"
      subtitle="مسودة ← إرسال (بضاعة تحت التحويل) ← استلام (إدخال للمخزون) — المناقلة محايدة القيمة: ما يخرج من مستودع يدخل الآخر بنفس التكلفة."
      crumbs={['المستودعات', 'العمليات']}
      actions={
        can('inventory.adjust') ? (
          <button className="btn primary" type="button" onClick={() => setOpen(!open)}>
            {open ? 'إغلاق' : 'مناقلة جديدة'}
          </button>
        ) : null
      }
    >
      {open && (
        <form className="card" onSubmit={createTransfer}>
          <h2>مناقلة جديدة</h2>
          <div className="form-grid">
            <label className="field">
              <span>الفرع *</span>
              <select
                className="input"
                value={effectiveBranch}
                onChange={(event) => setBranchId(event.target.value)}
                required
              >
                <option value="">— اختر —</option>
                {branchRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code ? `${row.code} — ` : ''}
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>من مستودع *</span>
              <select
                className="input"
                value={fromWarehouseId}
                onChange={(event) => setFrom(event.target.value)}
                required
              >
                <option value="">— اختر —</option>
                {warehouseRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>إلى مستودع *</span>
              <select
                className="input"
                value={toWarehouseId}
                onChange={(event) => setTo(event.target.value)}
                required
              >
                <option value="">— اختر —</option>
                {warehouseRows
                  .filter((row) => row.id !== fromWarehouseId)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {arabicName(row)}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <h3>الأصناف</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>الكمية</th>
                  <th>الوحدة</th>
                  <th>تكلفة الوحدة</th>
                  <th>📁 رقم الدفعة</th>
                  <th>📅 تاريخ الإنتاج</th>
                  <th>⏳ تاريخ الانتهاء</th>
                  <th>🔢 الأرقام التسلسلية</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <select
                        className="input"
                        value={line.itemId}
                        onChange={(event) =>
                          updateLine(index, {
                            itemId: event.target.value,
                            batchNo: '',
                            productionDate: '',
                            expiryDate: '',
                            serialNos: '',
                          })
                        }
                      >
                        <option value="">— اختر —</option>
                        {itemRows.map((row) => (
                          <option key={row.id} value={row.id}>
                            {itemLabel(row)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        dir="ltr"
                        inputMode="decimal"
                        value={line.qtyText}
                        onChange={(event) => updateLine(index, { qtyText: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        value={line.unitId}
                        onChange={(event) => updateLine(index, { unitId: event.target.value })}
                        disabled={!line.itemId}
                      >
                        <option value="">الوحدة الأساسية</option>
                        {unitsOf(line.itemId)
                          .filter(
                            (unit) =>
                              unit.unitId !==
                              (itemOf(line.itemId)?.baseUnitId ?? itemOf(line.itemId)?.base_unit_id),
                          )
                          .map((unit) => (
                            <option key={unit.unitId} value={unit.unitId}>
                              {`${unit.unitNameAr ?? ''} (×${Number(unit.ratio).toLocaleString('ar-EG')})`}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        dir="ltr"
                        inputMode="decimal"
                        value={line.unitCostText}
                        onChange={(event) => updateLine(index, { unitCostText: event.target.value })}
                      />
                    </td>
                    <td>
                      {/* دفعةٌ بعينها تنتقل — والصنف الذي لا يُتتبَّع بالدفعات لا يقبل رقماً */}
                      <input
                        className="input"
                        dir="ltr"
                        list={`tr-lots-${index}`}
                        placeholder={itemOf(line.itemId)?.trackLot ? 'LOT-1' : '—'}
                        value={line.batchNo}
                        disabled={!itemOf(line.itemId)?.trackLot}
                        onChange={(event) => updateLine(index, { batchNo: event.target.value })}
                      />
                      <datalist id={`tr-lots-${index}`}>
                        {(lots.data ?? [])
                          .filter((lot) => lot.itemId === line.itemId)
                          .map((lot) => (
                            <option key={lot.id} value={lot.lotNo}>
                              {lot.expiryDate ? shortDate(lot.expiryDate) : ''}
                            </option>
                          ))}
                      </datalist>
                    </td>
                    <td>
                      <input
                        className="input"
                        type="date"
                        dir="ltr"
                        value={line.productionDate}
                        disabled={!itemOf(line.itemId)?.trackLot}
                        onChange={(event) => updateLine(index, { productionDate: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        type="date"
                        dir="ltr"
                        value={line.expiryDate}
                        disabled={!itemOf(line.itemId)?.trackLot}
                        onChange={(event) => updateLine(index, { expiryDate: event.target.value })}
                      />
                    </td>
                    <td>
                      {itemOf(line.itemId)?.trackSerial ? (
                        <>
                          <textarea
                            className="input"
                            rows={2}
                            dir="ltr"
                            placeholder="A-1 A-2"
                            value={line.serialNos}
                            onChange={(event) => updateLine(index, { serialNos: event.target.value })}
                          />
                          <span className="chip">
                            {`${line.serialNos.split(/[\s,،;؛]+/).filter(Boolean).length} من ${line.qtyText || '—'}`}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn sm"
                        type="button"
                        onClick={() =>
                          setLines((current) => current.filter((_, position) => position !== index))
                        }
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="btn sm"
            type="button"
            onClick={() =>
              setLines((current) => [
                ...current,
                {
                  itemId: '',
                  qtyText: '',
                  unitId: '',
                  unitCostText: '',
                  batchNo: '',
                  productionDate: '',
                  expiryDate: '',
                  serialNos: '',
                },
              ])
            }
          >
            + سطر
          </button>

          <Notice notice={notice} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ كمسودة'}
          </button>
        </form>
      )}

      {!open && <Notice notice={notice} />}

      <StatTiles>
        <StatTile
          label="مناقلات في الطريق"
          value={rows.filter((row) => row.status === 'in_transit').length}
          hint="خرجت من المصدر ولم تصل"
          tone="warn"
        />
        <StatTile
          label="مستلمة جزئياً"
          value={rows.filter((row) => row.status === 'partially_received').length}
          hint="وصل بعضها وبقي بعضها"
          tone="warn"
        />
        <StatTile
          label="الكمية المعلّقة"
          value={quantity(transitQty)}
          hint="لم تُستلم بعد"
        />
        <StatTile label="قيمة ما في الطريق" value={money(transitValue)} hint="في حساب بضاعة تحت التحويل" tone="brand" />
        <StatTile label="مسودات" value={rows.filter((row) => row.status === 'draft').length} hint="تنتظر الإرسال" />
      </StatTiles>

      <FilterBar
        actions={
          <>
            <button
              className="btn"
              type="button"
              onClick={() => setSearch({ number: '', from: '', to: '' })}
            >
              📋 كل الفترة
            </button>
            <button className="btn primary" type="button" onClick={() => transfers.reload()}>
              🔍 بحث
            </button>
          </>
        }
      >
        <label className="field">
          <span>🔢 رقم التحويل</span>
          <input
            dir="ltr"
            value={search.number}
            onChange={(event) => setSearch((current) => ({ ...current, number: event.target.value }))}
            placeholder="TR-0001"
          />
        </label>
        <label className="field">
          <span>📅 من تاريخ</span>
          <input
            type="date"
            value={search.from}
            onChange={(event) => setSearch((current) => ({ ...current, from: event.target.value }))}
          />
        </label>
        <label className="field">
          <span>📅 إلى تاريخ</span>
          <input
            type="date"
            value={search.to}
            onChange={(event) => setSearch((current) => ({ ...current, to: event.target.value }))}
          />
        </label>
      </FilterBar>

      <Tabs items={BUCKETS} value={bucket} onChange={setBucket} />

      <div className="split">
        <div className="card tight split-list">
          <QueryView query={transfers} empty="لا توجد مناقلات" emptyDetail="أنشئ مناقلة لنقل بضاعة بين مستودعين.">
            {() => (
              <>
                {shown.length === 0 ? (
                  <p className="muted" style={{ padding: 12 }}>لا مناقلات في هذا التبويب.</p>
                ) : (
                  shown.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className={`list-row${row.id === selectedId ? ' active' : ''}`}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <span className="list-title" dir="ltr">{row.number}</span>
                      <span className="list-sub">
                        {`${nameOfWarehouse(row.fromWarehouseId)} ← ${nameOfWarehouse(row.toWarehouseId)}`}
                      </span>
                      <span className="row" style={{ justifyContent: 'space-between' }}>
                        <span className={`badge ${row.status === 'received' ? 'ok' : row.status === 'cancelled' ? 'danger' : ''}`}>
                          {TRANSFER_STATUS[row.status] ?? statusLabel(row.status)}
                        </span>
                        <span className="list-sub" dir="ltr">{dateTime(row.createdAt)}</span>
                      </span>
                    </button>
                  ))
                )}
              </>
            )}
          </QueryView>
        </div>

        <div className="card">
          {!selected ? (
            <p className="muted">اختر مناقلة من القائمة لعرض خطواتها وأسطرها وأفعالها.</p>
          ) : (
            <>
              <div className="section-title">
                <h2 dir="ltr">{selected.number}</h2>
                <span className={`badge ${selected.status === 'received' ? 'ok' : selected.status === 'cancelled' ? 'danger' : ''}`}>
                  {TRANSFER_STATUS[selected.status] ?? statusLabel(selected.status)}
                </span>
              </div>

              <StatusTrack
                steps={STEPS}
                current={STATUS_STEP[selected.status] ?? 0}
                cancelled={selected.status === 'cancelled'}
              />

              <DocHead>
                <DocField label="الرقم">
                  <span dir="ltr">{selected.number}</span>
                </DocField>
                <DocField label="من مستودع">{nameOfWarehouse(selected.fromWarehouseId)}</DocField>
                <DocField label="إلى مستودع">{nameOfWarehouse(selected.toWarehouseId)}</DocField>
                <DocField label="أُنشئت">{dateTime(selected.createdAt)}</DocField>
                <DocField label="الأسطر">{selected.lines.length}</DocField>
              </DocHead>

              <DataTable
                rows={selected.lines}
                rowKey={(line) => String(line.lineNo)}
                footer={[
                  <>المجموع</>,
                  '',
                  quantity(selected.lines.reduce((sum, line) => sum + Number(line.qty), 0)),
                  quantity(selected.lines.reduce((sum, line) => sum + Number(line.receivedQty), 0)),
                  quantity(
                    selected.lines.reduce(
                      (sum, line) => sum + (Number(line.qty) - Number(line.receivedQty)),
                      0,
                    ),
                  ),
                  '',
                  money(selected.lines.reduce((sum, line) => sum + lineValue(line), 0)),
                  '', // 📁 رقم الدفعة
                ]}
                columns={[
                  {
                    key: 'item',
                    header: 'الصنف',
                    cell: (line) => {
                      const item = itemOf(line.itemId);
                      return item ? (
                        itemLabel(item)
                      ) : (
                        <span className="muted" dir="ltr">{line.itemId.slice(0, 8)}</span>
                      );
                    },
                  },
                  { key: 'cost', header: 'تكلفة الوحدة', align: 'num', cell: (line) => money(line.unitCost) },
                  { key: 'qty', header: 'الكمية', align: 'num', cell: (line) => quantity(line.qty) },
                  {
                    key: 'serials',
                    header: '🔢 الأرقام التسلسلية',
                    cell: (line) =>
                      line.serialNos?.length ? (
                        <span dir="ltr" className="small">
                          {line.serialNos.join(' · ')}
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                  {
                    key: 'batch',
                    header: '📁 رقم الدفعة',
                    cell: (line) =>
                      line.batchNo ? (
                        <span dir="ltr" className="small">
                          {line.batchNo}
                          {line.productionDate ? ` · 📅 ${shortDate(line.productionDate)}` : ''}
                          {line.expiryDate ? ` · ⏳ ${shortDate(line.expiryDate)}` : ''}
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                  { key: 'received', header: 'المُستلَم', align: 'num', cell: (line) => quantity(line.receivedQty) },
                  {
                    key: 'left',
                    header: 'المتبقي',
                    align: 'num',
                    cell: (line) => {
                      const left = Number(line.qty) - Number(line.receivedQty);
                      return <strong dir="ltr" style={{ color: left > 0 ? 'var(--warn)' : 'var(--ok)' }}>{quantity(left)}</strong>;
                    },
                  },
                  {
                    key: 'progress',
                    header: 'نسبة الاستلام',
                    cell: (line) => {
                      const sent = Number(line.qty);
                      const got = Number(line.receivedQty);
                      const pct = sent > 0 ? Math.round((got / sent) * 100) : 0;
                      return (
                        <span style={{ display: 'grid', gap: 2 }}>
                          <span className="small muted" dir="ltr">{`${pct}٪`}</span>
                          <span className={`bar ${pct >= 100 ? 'ok' : pct > 0 ? 'warn' : 'danger'}`}>
                            <span style={{ width: `${Math.min(100, pct)}%` }} />
                          </span>
                        </span>
                      );
                    },
                  },
                  { key: 'value', header: 'القيمة', align: 'num', cell: (line) => money(String(lineValue(line))) },
                ]}
              />

              <Totals
                items={[
                  { label: 'إجمالي الكمية', value: quantity(selected.lines.reduce((sum, line) => sum + Number(line.qty), 0)) },
                  { label: 'المُستلَم', value: quantity(selected.lines.reduce((sum, line) => sum + Number(line.receivedQty), 0)) },
                  {
                    label: 'المتبقي في الطريق',
                    value: quantity(
                      selected.lines.reduce((sum, line) => sum + (Number(line.qty) - Number(line.receivedQty)), 0),
                    ),
                  },
                  { label: 'القيمة', value: money(selected.lines.reduce((sum, line) => sum + lineValue(line), 0)) },
                ]}
              />

              <ActionBar>
                {selected.status === 'draft' && can('inventory.adjust') && (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() =>
                      act(
                        () => apiPost(`/inventory/transfers/${selected.id}/send`, {}),
                        'تم إرسال المناقلة وخُصمت الكمية من المصدر.',
                      )
                    }
                  >
                    إرسال
                  </button>
                )}
                {['in_transit', 'partially_received'].includes(selected.status) && can('inventory.adjust') && (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() =>
                      act(
                        () =>
                          apiPost(`/inventory/transfers/${selected.id}/receive`, {
                            received: selected.lines
                              .map((line) => ({
                                lineNo: line.lineNo,
                                qty: String(Number(line.qty) - Number(line.receivedQty)),
                              }))
                              .filter((line) => Number(line.qty) > 0),
                          }),
                        'تم استلام المناقلة: دخلت البضاعة المخزون الهدف وخلا حساب بضاعة تحت التحويل.',
                      )
                    }
                  >
                    استلام كامل
                  </button>
                )}
                {['draft', 'in_transit'].includes(selected.status) && can('inventory.adjust') && (
                  <button
                    className="btn danger"
                    type="button"
                    onClick={() => {
                      const why =
                        selected.status === 'in_transit'
                          ? window.prompt(`إلغاء مناقلة في الطريق ${selected.number} — يرجى ذكر السبب:`)
                          : '';
                      if (selected.status !== 'in_transit' || (why && why.trim())) {
                        void act(
                          () =>
                            apiPost(
                              `/inventory/transfers/${selected.id}/cancel`,
                              why && why.trim() ? { reason: why.trim() } : {},
                            ),
                          selected.status === 'in_transit'
                            ? 'أُلغيت المناقلة وعادت البضاعة إلى المستودع المصدر.'
                            : 'تم إلغاء المناقلة.',
                        );
                      }
                    }}
                  >
                    إلغاء
                  </button>
                )}
                <button className="btn" type="button" onClick={() => window.print()}>
                  طباعة
                </button>
              </ActionBar>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}
