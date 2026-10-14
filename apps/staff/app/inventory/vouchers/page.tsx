'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ActionBar, DocField, DocHead, StatTile, StatTiles, StatusTrack, Tabs, Totals } from '../../../components/ui';
import { accountLabel, listAccounts, postableOf, type Account } from '../../../lib/accounts';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import {
  amountLabel,
  arabicName,
  dateTime,
  defaultOf,
  itemLabel,
  listBranches,
  listItemUnits,
  listItems,
  listLots,
  listSerials,
  listWarehouses,
  money,
  quantity,
  scanBarcode,
  shortDate,
  statusLabel,
  today,
  type Branch,
  type Item,
  type ItemUnit,
  type Lot,
  type Serial,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/** One number per piece: typed one per line, or separated by spaces, commas or newlines. */
const splitSerials = (value: string): string[] =>
  value
    .split(/[\s,،;؛]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * سند إدخال / إخراج مخزني — and بضاعة أول المدة as its third kind.
 *
 * The desktop (`frmInvInOutput`) saved these documents with no journal at all and let
 * the accountant repair the ledger later with `frmReGenerateEntries`. This screen is
 * the cloud replacement: a numbered, branch-scoped document that is saved as a draft,
 * then posted — which moves the stock *and* writes the balanced entry in one step, so
 * the inventory account can never drift away from the stock ledger.
 */

type VoucherLine = {
  lineNo: number;
  itemId: string;
  qty: string;
  /** Unit the quantity was counted in; the ledger holds `qty × factor` base units. */
  unitId?: string | null;
  unitCost?: string | null;
  lineCost?: string | null;
  lotId?: string | null;
  /** 📁 رقم الدفعة وتواريخها على السطر — كما كُتبت على العبوة، وما ينشئ الدفعة (R5). */
  batchNo?: string | null;
  productionDate?: string | null;
  expiryDate?: string | null;
  serialId?: string | null;
  /** 🔢 الأرقام التسلسلية — one number per piece, as `Class/InvoiceOper.cs` stores them. */
  serialNos?: string[];
  note?: string | null;
};

type Voucher = {
  id: string;
  number: string;
  kind: string;
  status: string;
  branchId: string;
  warehouseId: string;
  voucherDate: string;
  reason?: string | null;
  totalCost: string;
  journalEntryId?: string | null;
  createdAt?: string;
  lines: VoucherLine[];
};

const KINDS = [
  { id: 'stock_in', label: 'سند إدخال', hint: 'زيادة المخزون بكمية وتكلفة معلومتين (إيداع، مرتجع، هدية…)' },
  { id: 'stock_out', label: 'سند إخراج', hint: 'صرف كمية بمتوسط التكلفة (تالف، هالك، عينة، استهلاك داخلي…)' },
  { id: 'opening', label: 'بضاعة أول المدة', hint: 'رصيد الافتتاح — يقيد في حساب بضاعة أول المدة' },
] as const;

type KindId = (typeof KINDS)[number]['id'];

const KIND_LABELS: Record<string, string> = { stock_in: 'إدخال', stock_out: 'إخراج', opening: 'أول المدة' };
const PREFIXES: Record<string, string> = { stock_in: 'SIN', stock_out: 'SOU', opening: 'OP' };

export default function VouchersPage() {
  const params = useSearchParams();
  const requested = params.get('kind');
  const { can } = useSession();

  const [kind, setKind] = useState<KindId>(
    requested === 'opening' || requested === 'stock_out' ? (requested as KindId) : 'stock_in',
  );
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Voucher | undefined>();
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [voucherDate, setVoucherDate] = useState(today());
  const [reason, setReason] = useState('');
  const [counterAccountId, setCounterAccountId] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [lines, setLines] = useState<
    Array<{
      itemId: string;
      qtyText: string;
      unitId: string;
      costText: string;
      /** 📁 رقم الدفعة كما هو على العبوة — يُبحث أو يُنشأ عند الحفظ (R5). */
      batchNo: string;
      /** 📅 تاريخ الإنتاج المطبوع على العبوة. */
      productionDate: string;
      /** ⏳ تاريخ الانتهاء المطبوع على العبوة. */
      expiryDate: string;
      /** The numbers as typed — one per line, or separated by spaces and commas. */
      serialNos: string;
      note: string;
    }>
  >([
    {
      itemId: '',
      qtyText: '',
      unitId: '',
      costText: '',
      batchNo: '',
      productionDate: '',
      expiryDate: '',
      serialNos: '',
      note: '',
    },
  ]);
  const [scan, setScan] = useState('');
  const blankLine = {
    itemId: '',
    qtyText: '',
    unitId: '',
    costText: '',
    batchNo: '',
    productionDate: '',
    expiryDate: '',
    serialNos: '',
    note: '',
  };
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);
  const lots = useQuery<Lot[]>(() => listLots(), []);
  const serials = useQuery<Serial[]>(() => listSerials(), []);

  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const itemRows = (items.data ?? []).filter((row) => (row.kind ?? 'stock') === 'stock');
  const accountRows = (accounts.data ?? []).filter((row) => postableOf(row));
  const lotRows = lots.data ?? [];
  const serialRows = serials.data ?? [];

  /** وحدات كل سطر — the box/carton choices of the item that line is writing about. */
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

  /**
   * وحدات سند محدد — the card above loads units for the lines being typed; a saved
   * document needs its own, or the base quantity column would silently read ×1 for
   * every line that was counted in a carton.
   */
  const selectedItemIds = (selected?.lines ?? []).map((line) => line.itemId).join(',');
  const selectedUnits = useQuery<ItemUnit[]>(async () => {
    const ids = Array.from(new Set(selectedItemIds.split(',').filter(Boolean)));
    if (ids.length === 0) return [];
    const lists = await Promise.all(ids.map((id) => listItemUnits(id)));
    return lists.flat();
  }, [selectedItemIds]);
  const baseOf = (line: VoucherLine) => {
    const ratio = line.unitId
      ? Number(
          (selectedUnits.data ?? []).find(
            (row) => row.itemId === line.itemId && row.unitId === line.unitId,
          )?.ratio ?? 1,
        )
      : 1;
    return Number(line.qty) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
  };
  const factorOf = (line: { itemId: string; unitId: string }) => {
    if (!line.unitId) return 1;
    return Number(unitsOf(line.itemId).find((row) => row.unitId === line.unitId)?.ratio ?? 1);
  };

  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows)?.id || '';

  const vouchers = useQuery<Voucher[]>(
    () => apiList<Voucher>(`/inventory/vouchers${kind ? `?kind=${kind}` : ''}`),
    [kind],
  );

  const isIssue = kind === 'stock_out';
  const lineTotal = lines.reduce(
    (sum, line) => sum + Number(line.qtyText || 0) * Number(line.costText || 0),
    0,
  );

  function itemOf(id: string) {
    return itemRows.find((row) => row.id === id);
  }

  /**
   * قارئ الباركود — one label answers the item, the unit and the factor, so a whole
   * carton can be scanned in without anyone converting anything by hand.
   */
  async function applyScan() {
    const code = scan.trim();
    if (!code) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const found = await scanBarcode(code);
      setLines((current) => {
        const blank = current.findIndex((line) => !line.itemId);
        const next = {
          ...blankLine,
          itemId: found.itemId,
          qtyText: '1',
          unitId: found.unitId,
          costText: found.purchasePrice ?? '',
        };
        return blank >= 0
          ? current.map((line, position) => (position === blank ? next : line))
          : [...current, next];
      });
      setScan('');
      setNotice({
        kind: 'ok',
        text: `${found.nameAr}${found.unitNameAr ? ` — ${found.unitNameAr}` : ''} (×${Number(found.factor).toLocaleString('ar-EG')})`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function updateLine(
    index: number,
    patch: Partial<{
      itemId: string;
      qtyText: string;
      unitId: string;
      costText: string;
      batchNo: string;
      productionDate: string;
      expiryDate: string;
      serialNos: string;
      note: string;
    }>,
  ) {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );
  }

  async function reload() {
    await vouchers.reload();
    if (selected) {
      try {
        setSelected(await apiData<Voucher>(`/inventory/vouchers/${selected.id}`));
      } catch {
        setSelected(undefined);
      }
    }
  }

  async function saveVoucher(postImmediately: boolean) {
    setBusy(true);
    setNotice(undefined);
    try {
      const filled = lines.filter((line) => line.itemId && Number(line.qtyText) > 0);
      if (filled.length === 0)
        throw new ApiError(422, 'VALIDATION_FAILED', 'أضف سطراً واحداً على الأقل بكمية أكبر من صفر.');
      if (!isIssue && filled.some((line) => Number(line.costText) < 0)) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'تكلفة الوحدة لا يمكن أن تكون سالبة.');
      }
      const created = await apiPost<Voucher>('/inventory/vouchers', {
        branchId: effectiveBranch,
        warehouseId: effectiveWarehouse,
        kind,
        voucherDate,
        reason: reason || (kind === 'opening' ? 'رصيد مخزون أول المدة' : undefined),
        counterAccountId: counterAccountId || undefined,
        lines: filled.map((line) => ({
          itemId: line.itemId,
          qty: line.qtyText,
          unitId: line.unitId || undefined,
          unitCost: isIssue ? undefined : line.costText || undefined,
          // الدفعة تُكتب بالاسم على السطر؛ الخادم يبحث عن الدفعة أو يُنشئها بتواريخ السطر.
          batchNo: line.batchNo.trim() || undefined,
          productionDate: line.productionDate || undefined,
          expiryDate: line.expiryDate || undefined,
          serialNos: splitSerials(line.serialNos),
          note: line.note || undefined,
        })),
      });
      if (postImmediately) {
        const posted = await apiPost<Voucher>(`/inventory/vouchers/${created.id}/post`, {});
        setSelected(posted);
        setNotice({
          kind: 'ok',
          text: `تم حفظ وترحيل السند ${posted.number} فوراً، وتحديث أرصدة المخزون وإنشاء القيد المحاسبي.`,
        });
      } else {
        setSelected(created);
        setNotice({
          kind: 'ok',
          text: `حُفظ السند ${created.number} كمسودة. يمكنك ترحيله الآن ليحرّك المخزون ويُنشئ القيد.`,
        });
      }
      setLines([blankLine]);
      setReason('');
      setOpen(false);
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createVoucher(event: React.FormEvent) {
    event.preventDefault();
    await saveVoucher(true);
  }

  async function act(action: () => Promise<unknown>, okText: string) {
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  const rows = vouchers.data ?? [];

  return (
    <Screen
      title="سندات المخزون"
      subtitle="إدخال · إخراج · بضاعة أول المدة — كل سند مرحّل ينشئ قيداً متزناً في نفس اللحظة التي يحرك فيها المخزون."
      crumbs={['المستودعات', 'العمليات']}
      actions={
        can('inventory.adjust') ? (
          <button className="btn primary" type="button" onClick={() => setOpen(!open)}>
            {open ? 'إغلاق' : 'سند جديد'}
          </button>
        ) : null
      }
    >
      <Tabs
        items={KINDS.map((option) => ({ id: option.id, label: option.label }))}
        value={kind}
        onChange={(next) => {
          setKind(next);
          setNotice(undefined);
        }}
      />
      <p className="muted" style={{ marginTop: -4 }}>
        {KINDS.find((option) => option.id === kind)?.hint}
      </p>

      {open && (
        <form className="card" onSubmit={createVoucher}>
          <h2>
            سند {KIND_LABELS[kind]} جديد <span className="muted">({PREFIXES[kind]}…)</span>
          </h2>
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
              <span>التاريخ</span>
              <input
                className="input"
                type="date"
                dir="ltr"
                value={voucherDate}
                onChange={(event) => setVoucherDate(event.target.value)}
              />
            </label>
            <label className="field">
              <span>السبب</span>
              <input
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="تالف، هالك، عينة، افتتاح…"
              />
            </label>
            <label className="field">
              <span>الحساب المقابل (اختياري)</span>
              <select
                className="input"
                value={counterAccountId}
                onChange={(event) => setCounterAccountId(event.target.value)}
              >
                <option value="">— من دليل الحسابات الافتراضي —</option>
                {accountRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {accountLabel(row)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h3>الأصناف</h3>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              dir="ltr"
              placeholder="امسح باركود الصنف…"
              value={scan}
              onChange={(event) => setScan(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void applyScan();
                }
              }}
            />
            <button
              className="btn sm"
              type="button"
              onClick={() => void applyScan()}
              disabled={busy || !scan.trim()}
            >
              إضافة بالباركود
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>الكمية</th>
                  <th>الوحدة</th>
                  {!isIssue && <th>تكلفة الوحدة</th>}
                  <th>📁 رقم الدفعة</th>
                  <th>📅 تاريخ الإنتاج</th>
                  <th>⏳ تاريخ الانتهاء</th>
                  <th>رقم تسلسلي</th>
                  <th>ملاحظة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const item = itemOf(line.itemId);
                  return (
                    <tr key={index}>
                      <td>
                        <select
                          className="input"
                          value={line.itemId}
                          onChange={(event) => {
                            const picked = itemOf(event.target.value);
                            const defaultCost = String(
                              picked?.purchasePrice ?? picked?.purchase_price ?? line.costText ?? '',
                            );
                            updateLine(index, {
                              itemId: event.target.value,
                              costText: line.costText || defaultCost,
                              batchNo: '',
                              productionDate: '',
                              expiryDate: '',
                              serialNos: '',
                            });
                          }}
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
                        {line.unitId && Number(line.qtyText) > 0 && (
                          <span className="muted small" dir="ltr">
                            {`= ${(Number(line.qtyText) * factorOf(line)).toLocaleString('ar-EG')} `}
                            {arabicName(itemOf(line.itemId) ?? {}) ? '' : ''}
                          </span>
                        )}
                      </td>
                      {!isIssue && (
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={line.costText}
                            onChange={(event) => updateLine(index, { costText: event.target.value })}
                          />
                        </td>
                      )}
                      <td>
                        {/*
                          الديسكتوب يكتب رقم الدفعة على السطر ولا يطلب اختيارها من قائمة
                          (`InvoiceItemDetail.BatchNo`, `frmInvSale.xaml:876`). فنُبقي الكتابة
                          ممكنةً للدفعة الجديدة، ونعرض الدفعات المسجَّلة اقتراحاً لمن يريد
                          الاصطفاف على دفعةٍ قائمة.
                        */}
                        <input
                          className="input"
                          dir="ltr"
                          list={`lots-${index}`}
                          placeholder={item?.trackLot ? 'LOT-1' : '—'}
                          value={line.batchNo}
                          disabled={!item || !item.trackLot}
                          onChange={(event) => updateLine(index, { batchNo: event.target.value })}
                        />
                        <datalist id={`lots-${index}`}>
                          {lotRows
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
                          disabled={!item || !item.trackLot}
                          onChange={(event) => updateLine(index, { productionDate: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="date"
                          dir="ltr"
                          value={line.expiryDate}
                          disabled={!item || !item.trackLot}
                          onChange={(event) => updateLine(index, { expiryDate: event.target.value })}
                        />
                      </td>
                      <td>
                        {item?.trackSerial ? (
                          <>
                            <textarea
                              className="input"
                              rows={2}
                              dir="ltr"
                              placeholder={isIssue ? 'A-1 A-2' : 'A-1 A-2 A-3'}
                              value={line.serialNos}
                              onChange={(event) => updateLine(index, { serialNos: event.target.value })}
                            />
                            <span
                              className={`chip ${
                                splitSerials(line.serialNos).length > 0 &&
                                splitSerials(line.serialNos).length !== Number(line.qtyText || '0')
                                  ? 'warn'
                                  : ''
                              }`}
                            >
                              {`${splitSerials(line.serialNos).length} من ${line.qtyText || '—'}`}
                            </span>
                            {!isIssue && serialRows.some((serial) => serial.itemId === line.itemId) && (
                              <span className="muted small">
                                {' '}
                                رقم جديد لكل قطعة — أو ألصق أرقاماً مولَّدة من شاشة الأرقام التسلسلية.
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <input
                          className="input"
                          value={line.note}
                          onChange={(event) => updateLine(index, { note: event.target.value })}
                        />
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
              onClick={() => setLines((current) => [...current, blankLine])}
            >
              + سطر
            </button>
            {!isIssue && (
              <span className="muted">
                الإجمالي التقديري: <strong dir="ltr">{money(amountLabel(lineTotal))}</strong>
              </span>
            )}
            {isIssue && (
              <span className="muted">يُصرف بمتوسط التكلفة — تُحسب القيمة تلقائياً عند الترحيل.</span>
            )}
          </div>

          <Notice notice={notice} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'جارٍ الحفظ والترحيل…' : '⚡ حفظ وترحيل فوري'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void saveVoucher(false)}
            >
              💾 حفظ كمسودة
            </button>
          </div>
        </form>
      )}

      {!open && <Notice notice={notice} />}

      <StatTiles>
        <StatTile
          label={`سندات ${KIND_LABELS[kind]}`}
          value={rows.length}
          hint={PREFIXES[kind]}
          tone="brand"
        />
        <StatTile label="إجمالي القيمة" value={money(rows.reduce((sum, row) => sum + Number(row.totalCost), 0))} hint="مجموع السندات المعروضة" />
        <StatTile
          label="مسودات تنتظر الترحيل"
          value={rows.filter((row) => row.status === 'draft').length}
          hint="لم تُحرّك المخزون بعد"
          tone={rows.some((row) => row.status === 'draft') ? 'warn' : 'ok'}
        />
        <StatTile
          label="مُرحَّلة"
          value={rows.filter((row) => row.status === 'posted').length}
          hint="لها قيد محاسبي"
          tone="ok"
        />
        <StatTile
          label="إجمالي الكمية"
          value={quantity(rows.reduce((sum, row) => sum + row.lines.reduce((inner, line) => inner + Number(line.qty), 0), 0))}
          hint="بوحدات السندات"
        />
      </StatTiles>

      <div className="split">
        <div className="card tight split-list">
          <QueryView query={vouchers} empty="لا توجد سندات" emptyDetail="أنشئ سند إدخال أو إخراج لتحريك المخزون بقيد متزن.">
            {() => (
              <>
                {rows.length === 0 ? (
                  <p className="muted" style={{ padding: 12 }}>لا سندات من هذا النوع.</p>
                ) : (
                  rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className={`list-row${row.id === selected?.id ? ' active' : ''}`}
                      onClick={() => {
                        setSelected(row);
                        if (!row.lines || row.lines.length === 0) {
                          void apiData<Voucher>(`/inventory/vouchers/${row.id}`)
                            .then((full) => setSelected(full))
                            .catch(() => undefined);
                        }
                      }}
                    >
                      <span className="list-title" dir="ltr">{row.number}</span>
                      <span className="list-sub">{`${shortDate(row.voucherDate)} · ${arabicName(
                        warehouseRows.find((warehouse) => warehouse.id === row.warehouseId) ?? {},
                      )}`}</span>
                      <span className="row" style={{ justifyContent: 'space-between' }}>
                        <span
                          className={`badge ${
                            row.status === 'posted' ? 'ok' : row.status === 'voided' ? 'danger' : ''
                          }`}
                        >
                          {statusLabel(row.status)}
                        </span>
                        <span className="list-sub" dir="ltr">{money(row.totalCost)}</span>
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
            <p className="muted">اختر سنداً من القائمة لعرض بياناته وأسطره وأفعاله.</p>
          ) : (
            <>
              <div className="section-title">
                <h2 dir="ltr">{selected.number}</h2>
                <span
                  className={`badge ${
                    selected.status === 'posted' ? 'ok' : selected.status === 'voided' ? 'danger' : ''
                  }`}
                >
                  {statusLabel(selected.status)}
                </span>
              </div>

              <StatusTrack
                steps={['مسودة', 'مُرحَّل', 'مُلغى']}
                current={selected.status === 'draft' ? 0 : selected.status === 'posted' ? 1 : 2}
                cancelled={selected.status === 'voided'}
              />

              <DocHead>
                <DocField label="الرقم">
                  <span dir="ltr">{selected.number}</span>
                </DocField>
                <DocField label="النوع">{KIND_LABELS[selected.kind] ?? selected.kind}</DocField>
                <DocField label="التاريخ">{shortDate(selected.voucherDate)}</DocField>
                <DocField label="المستودع">
                  {arabicName(warehouseRows.find((warehouse) => warehouse.id === selected.warehouseId) ?? {})}
                </DocField>
                <DocField label="السبب">{selected.reason ?? '—'}</DocField>
                <DocField label="القيد">{selected.journalEntryId ? 'له قيد محاسبي' : 'لم يُرحَّل'}</DocField>
                <DocField label="أُنشئ">{dateTime(selected.createdAt)}</DocField>
              </DocHead>

              <DataTable
                rows={selected.lines}
                rowKey={(line) => String(line.lineNo)}
                footer={[
                  <>المجموع</>,
                  '',
                  quantity(selected.lines.reduce((sum, line) => sum + Number(line.qty), 0)),
                  '',
                  quantity(selected.lines.reduce((sum, line) => sum + baseOf(line), 0)),
                  '',
                  money(selected.totalCost),
                  '',
                  '', // 🔢 الأرقام التسلسلية
                  '', // 📁 رقم الدفعة
                  '', // ملاحظة
                ]}
                columns={[
                  { key: 'no', header: '#', align: 'num', cell: (line) => line.lineNo },
                  {
                    key: 'item',
                    header: 'المادة',
                    cell: (line) => itemLabel(itemOf(line.itemId) ?? ({ id: line.itemId, sku: '—' } as Item)),
                  },
                  { key: 'qty', header: 'الكمية', align: 'num', cell: (line) => quantity(line.qty) },
                  {
                    key: 'unit',
                    header: 'الوحدة',
                    cell: (line) =>
                      line.unitId
                        ? (selectedUnits.data ?? []).find(
                            (row) => row.itemId === line.itemId && row.unitId === line.unitId,
                          )?.unitNameAr ?? '—'
                        : 'الوحدة الأساسية',
                  },
                  {
                    key: 'base',
                    header: 'الكمية بالوحدة الأساسية',
                    align: 'num',
                    cell: (line) => <strong dir="ltr">{quantity(baseOf(line))}</strong>,
                  },
                  { key: 'cost', header: 'تكلفة الوحدة', align: 'num', cell: (line) => money(line.unitCost) },
                  { key: 'value', header: 'القيمة', align: 'num', cell: (line) => money(line.lineCost) },
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
                  { key: 'note', header: 'ملاحظة', cell: (line) => line.note ?? '—' },
                ]}
              />

              <Totals
                items={[
                  { label: 'إجمالي الكمية', value: quantity(selected.lines.reduce((sum, line) => sum + Number(line.qty), 0)) },
                  {
                    label: 'بالوحدة الأساسية',
                    value: quantity(selected.lines.reduce((sum, line) => sum + baseOf(line), 0)),
                  },
                  { label: 'الأسطر', value: selected.lines.length },
                  { label: 'إجمالي السند', value: money(selected.totalCost) },
                ]}
              />

              <ActionBar>
                {selected.status === 'draft' && can('inventory.adjust') && (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => {
                      if (window.confirm(`ترحيل السند ${selected.number}؟ سيُحرَّك المخزون ويُنشأ القيد.`)) {
                        void act(
                          () => apiPost(`/inventory/vouchers/${selected.id}/post`, { allowNegative }),
                          `تم ترحيل ${selected.number} وتحريك المخزون وإنشاء القيد.`,
                        );
                      }
                    }}
                  >
                    ترحيل
                  </button>
                )}
                {selected.status === 'posted' && can('inventory.adjust') && (
                  <button
                    className="btn danger"
                    type="button"
                    onClick={() => {
                      const why = window.prompt(`سبب إلغاء السند ${selected.number}:`);
                      if (why && why.trim()) {
                        void act(
                          () => apiPost(`/inventory/vouchers/${selected.id}/void`, { reason: why.trim() }),
                          `تم إلغاء ${selected.number} وعكس قيده.`,
                        );
                      }
                    }}
                  >
                    إلغاء
                  </button>
                )}
                <button className="btn" type="button" onClick={() => setSelected(undefined)}>
                  إغلاق التفاصيل
                </button>
                <button className="btn" type="button" onClick={() => window.print()}>
                  طباعة
                </button>
              </ActionBar>
            </>
          )}
        </div>
      </div>

      {can('inventory.negative.override') && (
        <label className="field no-print" style={{ maxWidth: 420 }}>
          <span>
            <input
              type="checkbox"
              checked={allowNegative}
              onChange={(event) => setAllowNegative(event.target.checked)}
            />{' '}
            السماح بالصرف تحت الصفر
          </span>
          <span className="muted">صالح فقط للجلسات التي تملك صلاحية تجاوز الرصيد السالب.</span>
        </label>
      )}
    </Screen>
  );
}
