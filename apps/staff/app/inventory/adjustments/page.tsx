'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ActionBar, DocField, DocHead, StatTile, StatTiles, StatusTrack, Tabs, Totals } from '../../../components/ui';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
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

/**
 * جرد وتسوية — a counted variance against the stock ledger.
 *
 * The desktop counted one item at a time and left the accountant to build the entry by
 * hand. The cloud keeps the count as one document with as many lines as the shelf had:
 * every line remembers what the book said, what the count found, and what that
 * difference was worth; posting moves the stock to the counted quantity and writes ONE
 * balanced entry for the net variance — because a count is one decision, not one
 * decision per line.
 */

type Level = { itemId: string; warehouseId: string; quantity: string; averageCost: string };

type AdjustmentLine = {
  lineNo: number;
  itemId: string;
  expectedQty: string;
  countedQty: string;
  varianceQty?: string | null;
  varianceValue?: string | null;
  unitCost?: string | null;
  /** 📁 رقم الدفعة وتواريخها على السطر (R5). */
  batchNo?: string | null;
  productionDate?: string | null;
  expiryDate?: string | null;
  /** 🔢 الأرقام التسلسلية counted on the line. */
  serialNos?: string[];
};

type Bucket = 'all' | 'draft' | 'posted';

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'draft', label: 'مسودة' },
  { id: 'posted', label: 'مُرحَّل' },
];

const STEPS = ['مسودة', 'مُعتمد', 'مُرحَّل'];

type Adjustment = {
  id: string;
  number: string;
  status: string;
  branchId: string;
  warehouseId: string;
  reason: string;
  journalEntryId?: string | null;
  createdAt?: string;
  lines: AdjustmentLine[];
};

export default function StockAdjustmentsPage() {
  const { can } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);

  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const itemRows = (items.data ?? []).filter((row) => (row.kind ?? 'stock') === 'stock');

  const [open, setOpen] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [reason, setReason] = useState('جرد دوري');
  const [lines, setLines] = useState<
    Array<{
      itemId: string;
      countedText: string;
      unitId: string;
      costText: string;
      /** 📁 رقم الدفعة على السطر — يُبحث أو يُنشأ عند الحفظ (R5). */
      batchNo: string;
      productionDate: string;
      expiryDate: string;
      serialNos: string;
    }>
  >([
    {
      itemId: '',
      countedText: '',
      unitId: '',
      costText: '',
      batchNo: '',
      productionDate: '',
      expiryDate: '',
      serialNos: '',
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  const [selected, setSelected] = useState<Adjustment | undefined>();
  const [bucket, setBucket] = useState<Bucket>('all');

  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows)?.id || '';

  const adjustments = useQuery<Adjustment[]>(() => apiList<Adjustment>('/inventory/adjustments'), []);
  /**
   * What the ledger currently says, so the clerk sees the expected column while typing
   * the count instead of discovering the variance afterwards.
   */
  const levels = useQuery<Level[]>(
    () =>
      effectiveWarehouse
        ? apiList<Level>(`/inventory/levels?warehouse_id=${effectiveWarehouse}`)
        : Promise.resolve([]),
    [effectiveWarehouse],
  );
  const levelOf = (itemId: string) => (levels.data ?? []).find((row) => row.itemId === itemId);
  /** الدفعات المسجَّلة — تُعرض اقتراحاً في خانة رقم الدفعة، والكتابة تبقى مفتوحة. */
  const lots = useQuery<Lot[]>(() => listLots(), []);

  /**
   * وحدات القياس — a count is usually taken in the unit the goods are packed in, so the
   * line needs the same unit choices the item card defines. The book quantity shown
   * beside it is divided by the same factor before the two are compared.
   */
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
  const factorOf = (line: { itemId: string; unitId?: string }) =>
    line.unitId ? Number(unitsOf(line.itemId).find((row) => row.unitId === line.unitId)?.ratio ?? 1) : 1;

  const itemOf = (id: string) => itemRows.find((row) => row.id === id);

  function updateLine(
    index: number,
    patch: Partial<{
      itemId: string;
      countedText: string;
      unitId: string;
      costText: string;
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

  async function reload() {
    await adjustments.reload();
    await levels.reload();
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const filled = lines.filter((line) => line.itemId && line.countedText !== '');
      if (!filled.length)
        throw new ApiError(422, 'VALIDATION_FAILED', 'أضف صنفاً واحداً على الأقل بكمية مجرودة.');
      if (!reason.trim()) throw new ApiError(422, 'VALIDATION_FAILED', 'سبب الجرد مطلوب.');
      const created = await apiPost<Adjustment>('/inventory/adjustments', {
        branchId: effectiveBranch,
        warehouseId: effectiveWarehouse,
        reason: reason.trim(),
        lines: filled.map((line) => ({
          itemId: line.itemId,
          countedQty: line.countedText,
          unitId: line.unitId || undefined,
          unitCost: line.costText || undefined,
          // الجرد يعدّ ما في الرفّ، فإن كان الرفّ يحمل دفعةً بعينها فالسطر يقولها (R5).
          batchNo: line.batchNo.trim() || undefined,
          productionDate: line.productionDate || undefined,
          expiryDate: line.expiryDate || undefined,
          serialNos: line.serialNos
            .split(/[\s,،;؛]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        })),
      });
      setNotice({ kind: 'ok', text: `حُفظ الجرد ${created.number} كمسودة. راجع الفروقات ثم اعتمده.` });
      setLines([
        {
          itemId: '',
          countedText: '',
          unitId: '',
          costText: '',
          batchNo: '',
          productionDate: '',
          expiryDate: '',
          serialNos: '',
        },
      ]);
      setOpen(false);
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function post(row: Adjustment) {
    setNotice(undefined);
    try {
      await apiPost(`/inventory/adjustments/${row.id}/post`, { approved: true });
      setNotice({
        kind: 'ok',
        text: `تم اعتماد ${row.number}: حُرّك المخزون إلى الكمية المجرودة وأُنشئ قيد التسوية.`,
      });
      await reload();
      if (selected?.id === row.id) setSelected(await apiData<Adjustment>(`/inventory/adjustments/${row.id}`));
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  /**
   * The book quantity is held in base units; a count is taken in whatever unit the clerk
   * is holding. The book side is divided by the same factor the engine will use, so the
   * variance on screen is the variance that will be posted.
   */
  const varianceOf = (line: { itemId: string; countedText: string; unitId?: string; costText: string }) => {
    const factor = factorOf(line);
    const current = Number(levelOf(line.itemId)?.quantity ?? 0) / (factor || 1);
    const counted = Number(line.countedText || 0);
    return Number.isFinite(counted) ? counted - current : 0;
  };
  const netVariance = lines.reduce((sum, line) => {
    const variance = varianceOf(line);
    const unitValue = Number(line.costText || levelOf(line.itemId)?.averageCost || 0);
    return sum + variance * unitValue;
  }, 0);

  const rows = adjustments.data ?? [];
  const shown = bucket === 'all' ? rows : rows.filter((row) => row.status === bucket);
  const countedRows = rows.reduce((sum, row) => sum + row.lines.length, 0);
  const netVarianceQty = rows.reduce(
    (sum, row) => sum + row.lines.reduce((inner, line) => inner + Number(line.varianceQty ?? 0), 0),
    0,
  );
  const shortageValue = rows.reduce(
    (sum, row) =>
      sum +
      row.lines.reduce(
        (inner, line) => (Number(line.varianceQty ?? 0) < 0 ? inner + Number(line.varianceValue ?? 0) : inner),
        0,
      ),
    0,
  );
  const surplusValue = rows.reduce(
    (sum, row) =>
      sum +
      row.lines.reduce(
        (inner, line) => (Number(line.varianceQty ?? 0) > 0 ? inner + Number(line.varianceValue ?? 0) : inner),
        0,
      ),
    0,
  );

  return (
    <Screen
      title="جرد وتسوية المخزون"
      subtitle="عدّ الأرفف، سجّل الفروقات، واعتمد التسوية — قيد واحد متزن بصافي الفرق، وحركة مخزون لكل سطر."
      crumbs={['المستودعات', 'العمليات']}
      actions={
        can('inventory.adjust') ? (
          <button className="btn primary" type="button" onClick={() => setOpen(!open)}>
            {open ? 'إغلاق' : 'جرد جديد'}
          </button>
        ) : null
      }
    >
      {open && (
        <form className="card" onSubmit={create}>
          <h2>جرد جديد</h2>
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
              <span>المستودع *</span>
              <select
                className="input"
                value={effectiveWarehouse}
                onChange={(event) => setWarehouseId(event.target.value)}
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
              <span>السبب *</span>
              <input
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="جرد سنوي، جرد مفاجئ…"
                required
              />
            </label>
          </div>

          <h3>الأصناف المجرودة</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>الرصيد الدفتري</th>
                  <th>الكمية المجرودة</th>
                  <th>الوحدة</th>
                  <th>الفرق</th>
                  <th>تكلفة الوحدة</th>
                  <th>📁 رقم الدفعة</th>
                  <th>📅 تاريخ الإنتاج</th>
                  <th>⏳ تاريخ الانتهاء</th>
                  <th>رقم تسلسلي</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const variance = varianceOf(line);
                  return (
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
                      <td dir="ltr">
                        {quantity(Number(levelOf(line.itemId)?.quantity ?? 0) / (factorOf(line) || 1))}
                      </td>
                      <td>
                        <input
                          className="input"
                          dir="ltr"
                          inputMode="decimal"
                          value={line.countedText}
                          onChange={(event) => updateLine(index, { countedText: event.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          className="input"
                          value={line.unitId ?? ''}
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
                      <td
                        dir="ltr"
                        style={{
                          color:
                            variance === 0
                              ? undefined
                              : variance > 0
                                ? 'var(--ok, #1a7f37)'
                                : 'var(--danger, #b42318)',
                        }}
                      >
                        {line.itemId && line.countedText !== ''
                          ? variance > 0
                            ? `+${quantity(variance)}`
                            : quantity(variance)
                          : '—'}
                      </td>
                      <td>
                        <input
                          className="input"
                          dir="ltr"
                          inputMode="decimal"
                          value={line.costText}
                          placeholder={levelOf(line.itemId)?.averageCost ?? ''}
                          onChange={(event) => updateLine(index, { costText: event.target.value })}
                        />
                      </td>
                      <td>
                        {/* الدفعة تُكتب على السطر كما على العبوة — والصنف الذي لا يُتتبَّع بها لا يقبلها */}
                        <input
                          className="input"
                          dir="ltr"
                          list={`adj-lots-${index}`}
                          placeholder={itemOf(line.itemId)?.trackLot ? 'LOT-1' : '—'}
                          value={line.batchNo}
                          disabled={!itemOf(line.itemId)?.trackLot}
                          onChange={(event) => updateLine(index, { batchNo: event.target.value })}
                        />
                        <datalist id={`adj-lots-${index}`}>
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
                          <textarea
                            className="input"
                            rows={2}
                            dir="ltr"
                            placeholder="A-1 A-2"
                            value={line.serialNos}
                            onChange={(event) => updateLine(index, { serialNos: event.target.value })}
                          />
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
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn sm"
              type="button"
              onClick={() =>
                setLines((current) => [
                  ...current,
                  {
                    itemId: '',
                    countedText: '',
                    unitId: '',
                    costText: '',
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
            <span className="muted">
              صافي قيمة الفروقات:{' '}
              <strong dir="ltr">{money(String(Math.round(netVariance * 10000) / 10000))}</strong>
            </span>
          </div>

          <Notice notice={notice} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ الجرد كمسودة'}
          </button>
        </form>
      )}

      {!open && <Notice notice={notice} />}

      <StatTiles>
        <StatTile
          label="جردات مسودة"
          value={rows.filter((row) => row.status === 'draft').length}
          hint="تنتظر الاعتماد والترحيل"
          tone={rows.some((row) => row.status === 'draft') ? 'warn' : 'ok'}
        />
        <StatTile label="أصناف مجرودة" value={countedRows} hint="سطر جرد مسجّل" />
        <StatTile
          label="صافي الفرق"
          value={quantity(netVarianceQty)}
          hint={netVarianceQty < 0 ? 'عجز في المخزون' : netVarianceQty > 0 ? 'زيادة في المخزون' : 'مطابق'}
          tone={netVarianceQty < 0 ? 'danger' : netVarianceQty > 0 ? 'ok' : 'default'}
        />
        <StatTile label="قيمة العجز" value={money(shortageValue)} hint="ما نقص عن الدفاتر" tone="danger" />
        <StatTile label="قيمة الزيادة" value={money(surplusValue)} hint="ما زاد عن الدفاتر" tone="ok" />
      </StatTiles>

      <Tabs items={BUCKETS} value={bucket} onChange={setBucket} />

      <div className="split">
        <div className="card tight split-list">
          <QueryView query={adjustments} empty="لا توجد عمليات جرد" emptyDetail="أنشئ جرداً لمطابقة الأرصدة مع الرفوف.">
            {() => (
              <>
                {shown.length === 0 ? (
                  <p className="muted" style={{ padding: 12 }}>لا جردات في هذا التبويب.</p>
                ) : (
                  shown.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className={`list-row${row.id === selected?.id ? ' active' : ''}`}
                      onClick={() => setSelected(row)}
                    >
                      <span className="list-title" dir="ltr">{row.number}</span>
                      <span className="list-sub">{row.reason}</span>
                      <span className="row" style={{ justifyContent: 'space-between' }}>
                        <span className={`badge ${row.status === 'posted' ? 'ok' : ''}`}>{statusLabel(row.status)}</span>
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
            <p className="muted">اختر جرداً من القائمة لعرض أسطره وفروقه.</p>
          ) : (
            <>
              <div className="section-title">
                <h2 dir="ltr">{selected.number}</h2>
                <span className={`badge ${selected.status === 'posted' ? 'ok' : ''}`}>
                  {statusLabel(selected.status)}
                </span>
              </div>

              <StatusTrack steps={STEPS} current={selected.status === 'posted' ? 2 : 0} />

              <DocHead>
                <DocField label="الرقم">
                  <span dir="ltr">{selected.number}</span>
                </DocField>
                <DocField label="السبب">{selected.reason}</DocField>
                <DocField label="المستودع">
                  {arabicName(warehouseRows.find((warehouse) => warehouse.id === selected.warehouseId) ?? {})}
                </DocField>
                <DocField label="التاريخ">{dateTime(selected.createdAt)}</DocField>
                <DocField label="القيد">{selected.journalEntryId ? 'له قيد تسوية' : 'لم يُرحَّل'}</DocField>
              </DocHead>

              <DataTable
                rows={selected.lines}
                rowKey={(line) => String(line.lineNo)}
                footer={[
                  <>المجموع</>,
                  '',
                  quantity(selected.lines.reduce((sum, line) => sum + Number(line.expectedQty), 0)),
                  quantity(selected.lines.reduce((sum, line) => sum + Number(line.countedQty), 0)),
                  quantity(selected.lines.reduce((sum, line) => sum + Number(line.varianceQty ?? 0), 0)),
                  money(
                    selected.lines.reduce(
                      (sum, line) =>
                        sum + (Number(line.varianceQty ?? 0) >= 0 ? 1 : -1) * Number(line.varianceValue ?? 0),
                      0,
                    ),
                  ),
                  '', // 📁 رقم الدفعة
                ]}
                columns={[
                  { key: 'no', header: '#', align: 'num', cell: (line) => line.lineNo },
                  {
                    key: 'item',
                    header: 'المادة',
                    cell: (line) =>
                      itemLabel(
                        itemRows.find((row) => row.id === line.itemId) ?? ({ id: line.itemId, sku: '—' } as Item),
                      ),
                  },
                  {
                    key: 'expected',
                    header: 'الرصيد الدفتري',
                    align: 'num',
                    cell: (line) => quantity(line.expectedQty),
                  },
                  {
                    key: 'counted',
                    header: 'المجرود',
                    align: 'num',
                    cell: (line) => <strong dir="ltr">{quantity(line.countedQty)}</strong>,
                  },
                  {
                    key: 'variance',
                    header: 'الفرق',
                    align: 'num',
                    cell: (line) => {
                      const variance = Number(line.varianceQty ?? 0);
                      return (
                        <span
                          dir="ltr"
                          style={{
                            color: variance === 0 ? 'var(--muted)' : variance > 0 ? 'var(--ok)' : 'var(--danger)',
                            fontWeight: 700,
                          }}
                        >
                          {variance === 0 ? 'مطابق' : `${variance > 0 ? '+' : '−'}${quantity(Math.abs(variance))}`}
                        </span>
                      );
                    },
                  },
                  { key: 'value', header: 'قيمة الفرق', align: 'num', cell: (line) => money(line.varianceValue) },
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
                ]}
              />

              <Totals
                items={[
                  {
                    label: 'إجمالي العجز',
                    value: money(
                      selected.lines.reduce(
                        (sum, line) => (Number(line.varianceQty ?? 0) < 0 ? sum + Number(line.varianceValue ?? 0) : sum),
                        0,
                      ),
                    ),
                  },
                  {
                    label: 'إجمالي الزيادة',
                    value: money(
                      selected.lines.reduce(
                        (sum, line) => (Number(line.varianceQty ?? 0) > 0 ? sum + Number(line.varianceValue ?? 0) : sum),
                        0,
                      ),
                    ),
                  },
                  {
                    label: 'صافي قيمة الفرق',
                    value: money(
                      selected.lines.reduce(
                        (sum, line) =>
                          sum + (Number(line.varianceQty ?? 0) >= 0 ? 1 : -1) * Number(line.varianceValue ?? 0),
                        0,
                      ),
                    ),
                  },
                  { label: 'الأصناف', value: selected.lines.length },
                ]}
              />

              <ActionBar>
                {selected.status === 'draft' && can('inventory.adjust') && (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          `اعتماد وترحيل الجرد ${selected.number}؟ سيُعدَّل المخزون إلى الكميات المجرودة ويُنشأ قيد تسوية واحد بصافي الفرق.`,
                        )
                      ) {
                        void post(selected);
                      }
                    }}
                  >
                    اعتماد وترحيل
                  </button>
                )}
                <button className="btn" type="button" onClick={() => setSelected(undefined)}>
                  إغلاق التفاصيل
                </button>
                <button className="btn" type="button" onClick={() => window.print()}>
                  طباعة
                </button>
              </ActionBar>
              <p className="muted small">آخر تحديث للسجل: {shortDate(new Date())}</p>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}
