'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Notice } from '../../../../components/data-view';
import { InvoiceLines, TotalsPanel, computeTotals, emptyLine, filledLines, serialList, toApiLines, type LineDraft } from '../../../../components/invoice-editor';
import { Screen } from '../../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../../lib/api';
import {
  arabicName,
  branchOptions,
  defaultOf,
  listBranches,
  listCostCenters,
  listItems,
  listParties,
  listTaxGroups,
  listWarehouses,
  partyLabel,
  today,
  type Branch,
  type CostCenter,
  type Item,
  type Party,
  type TaxGroup,
  type Warehouse,
} from '../../../../lib/lookups';
import { SERIAL_MESSAGES, decideSerial, type SerialLookup } from '../../../../lib/serial-numbers';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

export default function NewPurchaseInvoicePage() {
  const router = useRouter();
  const { can } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const taxGroups = useQuery<TaxGroup[]>(() => listTaxGroups(), []);
  /**
   * «عفوآ رقم المرجع موجود مسبقآ هل تريد الاستمرار ؟» — `frmInvPurch.xaml.cs:1211`.
   * الديسكتوب **ينبّه ولا يمنع**، والسحابة لا تفرض قيداً على تكرار المرجع — فالتحذير هنا
   * للإعلام فقط، تماماً كما في النافذة.
   */
  const invoices = useQuery<{ supplierReferenceNo: string | null }[]>(() => apiList('/purchase-invoices'), []);
  /** R9 — 📊 مركز التكلفة: قائمة الرأس كما في `frmInvPurch.xaml` L467. */
  const costCenters = useQuery<CostCenter[]>(() => listCostCenters(), []);

  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [kind, setKind] = useState<'purchase' | 'purchase_return'>('purchase');
  const [supplierRef, setSupplierRef] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [supplierRefDate, setSupplierRefDate] = useState(today());
  const [includesVat, setIncludesVat] = useState(false);
  const [allocation, setAllocation] = useState<'value' | 'qty'>('value');
  const [invoiceDiscountText, setInvoiceDiscountText] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [serialQuery, setSerialQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'danger'; text: string } | undefined>();

  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const supplierRows = suppliers.data ?? [];
  const defaultSupplier =
    supplierRows.find((row) => row.code === 'SUPP-GEN' || row.name === 'مورد عام') ?? supplierRows[0];
  const effectivePartyId = partyId || defaultSupplier?.id || '';
  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows.filter((row) => !effectiveBranch || row.branchId === effectiveBranch))?.id || '';
  const totals = computeTotals(lines, { priceIncludesVat: includesVat, invoiceDiscount: invoiceDiscountText });
  const duplicateRef =
    supplierRef.trim().length > 0 &&
    (invoices.data ?? []).some((row) => (row.supplierReferenceNo ?? '').trim() === supplierRef.trim());

  /**
   * «💾 حفظ» L1428 و«🖨️💾 حفظ مع طباعة» L1424 — زرّا `frmInvPurch.xaml` (وبترتيب
   * رموزٍ معكوس عن نافذة البيع). الاثنان يكتبان المسودّة، والثاني يفتح ورقة الطباعة
   * بعدها بدل شاشة الفاتورة.
   */
  /**
   * «🔢 التسلسلي:» — نافذة المشتريات تعرض الأرقام من قائمة السياق («🔢 الرقم التسلسلي»
   * `frmInvPurch.xaml` L714 ← `MenuItemSerialNo_Click` L897)، وهذا الإدخال يجعلها في
   * متناول اليد كما في نافذة البيع: الإدخال يقرأ الرقم عن العبوة فيأتي بالسطر.
   */
  async function findSerial() {
    const value = serialQuery.trim();
    setNotice(undefined);
    if (!value) {
      setNotice({ kind: 'warn', text: SERIAL_MESSAGES.empty });
      return;
    }
    try {
      const lookup = await apiData<SerialLookup>(`/inventory/serials/lookup?serialNo=${encodeURIComponent(value)}`);
      const verdict = decideSerial({ lookup: { ...lookup, serialNo: value }, lines, parse: serialList });
      if (verdict.decision.kind === 'reject') {
        setNotice({ kind: 'warn', text: verdict.decision.text });
        return;
      }
      const decision = verdict.decision;
      const item = (items.data ?? []).find((row) => row.id === decision.itemId);
      const group = item?.taxGroupId ? (taxGroups.data ?? []).find((row) => row.id === item.taxGroupId) : undefined;
      const base = emptyLine(group ? String(Number(group.rate) * 100) : '15');
      setLines([
        ...lines.filter((line) => line.itemId || line.description.trim() || line.serialText.trim()),
        {
          ...base,
          itemId: decision.itemId,
          unitPriceText: String(item?.purchasePrice ?? item?.purchase_price ?? ''),
          taxGroupId: group?.id ?? '',
          serialText: decision.serialNo,
        },
      ]);
      setSerialQuery('');
    } catch (error) {
      const text = error instanceof ApiError && error.status === 403 ? SERIAL_MESSAGES.forbidden : String(error);
      setNotice({ kind: 'warn', text });
    }
  }

  async function save(event: React.SyntheticEvent, print = false) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (filledLines(lines).length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'لا يمكن حفظ الفاتورة بدون أصناف.');
      const invoice = await apiPost<{ id: string }>('/purchase-invoices', {
        branchId: effectiveBranch,
        warehouseId: effectiveWarehouse || undefined,
        partyId: effectivePartyId,
        kind,
        supplierReferenceNo: supplierRef.trim() || undefined,
        supplierReferenceDate: supplierRefDate || undefined,
        priceIncludesVat: includesVat,
        invoiceDiscount: invoiceDiscountText.trim() || undefined,
        landedCostAlloc: allocation,
        costCenterId: costCenterId || undefined,
        lines: toApiLines(lines).map((line) => ({ ...line, itemId: line.itemId })),
      });
      router.push(print ? `/print/purchase-invoice/${invoice.id}` : `/purchases/invoices/${invoice.id}`);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
      setBusy(false);
    }
  }

  if (!can('purchase.invoice.create')) {
    return (
      <Screen title="فاتورة المشتريات" crumbs={['المشتريات', 'العمليات']}>
        <div className="card state">
          <strong>لا تملك صلاحية إنشاء فواتير المشتريات</strong>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      // «فاتورة المشتريات» — `Form_WPF/frmInvPurch.xaml` L7، وتبويبها «📄  الفاتورة  » L290.
      title="فاتورة المشتريات"
      subtitle="تُحفظ كمسودة يمكن إضافة مصاريف الشحن والتخليص إليها، ثم تُرحَّل فتُحمَّل تلك المصاريف على تكلفة الأصناف."
      crumbs={['المشتريات', 'العمليات']}
    >
      <form className="card" onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span>الفرع *</span>
            <select className="input" value={effectiveBranch} onChange={(event) => setBranchId(event.target.value)} required>
              {branchOptions(branchRows).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>🏪 المستودع</span>
            <select className="input" value={effectiveWarehouse} onChange={(event) => setWarehouseId(event.target.value)}>
              <option value="">— بدون حركة مخزنية —</option>
              {warehouseRows
                .filter((row) => !effectiveBranch || row.branchId === effectiveBranch)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
            </select>
            {filledLines(lines).some((line) => line.itemId) && !effectiveWarehouse && (
              <span className="muted small">ترحيل فاتورة فيها أصناف مخزنية يتطلب اختيار مستودع.</span>
            )}
          </label>
          <label className="field">
            <span>👤 اسم المورد *</span>
            <select className="input" value={effectivePartyId} onChange={(event) => setPartyId(event.target.value)}>
              {supplierRows.length === 0 && <option value="">مورد عام (الافتراضي)</option>}
              {supplierRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {partyLabel(row)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>النوع</span>
            <select className="input" value={kind} onChange={(event) => setKind(event.target.value as 'purchase' | 'purchase_return')}>
              <option value="purchase">فاتورة مشتريات</option>
              <option value="purchase_return">مردود مشتريات</option>
            </select>
          </label>
          <label className="field">
            {/* «📋 المرجع» — `frmInvPurch.xaml` L545 (`txtRefNo` = رقم فاتورة المورد). */}
            <span>📋 المرجع</span>
            <input className="input" dir="ltr" value={supplierRef} onChange={(event) => setSupplierRef(event.target.value)} />
            {duplicateRef && <span className="muted small">عفوآ رقم المرجع موجود مسبقآ هل تريد الاستمرار ؟</span>}
          </label>
          <label className="field">
            <span>تاريخ فاتورة المورد</span>
            <input className="input" type="date" dir="ltr" value={supplierRefDate} onChange={(event) => setSupplierRefDate(event.target.value)} />
          </label>
          <label className="field">
            <span>خصم على الفاتورة</span>
            <input className="input" dir="ltr" inputMode="decimal" value={invoiceDiscountText} onChange={(event) => setInvoiceDiscountText(event.target.value)} />
            <span className="muted small">يُخفّض وعاء الضريبة قبل احتسابها.</span>
          </label>
          {/* «🔢 التسلسلي:» — الإدخال يقرأ الرقم عن العبوة فيُضيف السطر (R8). */}
          <label className="field">
            <span>🔢 التسلسلي:</span>
            <span className="row">
              <input
                className="input"
                dir="ltr"
                value={serialQuery}
                placeholder="امسح الرقم أو اكتبه"
                onChange={(event) => setSerialQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void findSerial();
                  }
                }}
              />
              <button className="btn sm" type="button" onClick={() => void findSerial()}>
                بحث
              </button>
            </span>
            <span className="muted small">الرقم المسجَّل عندنا يُضاف سطره، والمباع يُنبَّه عليه.</span>
          </label>
          {/* «📊 مركز التكلفة» — `frmInvPurch.xaml` L467 (بلا نقطتين، كما في نافذة الشراء). */}
          <label className="field">
            <span>📊 مركز التكلفة</span>
            <select className="input" value={costCenterId} onChange={(event) => setCostCenterId(event.target.value)}>
              <option value="">— بلا مركز —</option>
              {(costCenters.data ?? []).map((center) => (
                <option key={center.id} value={center.id}>
                  {center.code} — {arabicName(center)}
                </option>
              ))}
            </select>
            <span className="muted small">مركز الفاتورة كلها — ولكل سطرٍ أن يخالفه من عموده.</span>
          </label>
          <label className="field">
            <span>توزيع المصاريف</span>
            <select className="input" value={allocation} onChange={(event) => setAllocation(event.target.value as 'value' | 'qty')}>
              <option value="value">بحسب القيمة</option>
              <option value="qty">بحسب الكمية</option>
            </select>
          </label>
          <label className="field">
            <span>الأسعار شاملة الضريبة</span>
            <span className="row">
              <input type="checkbox" checked={includesVat} onChange={(event) => setIncludesVat(event.target.checked)} />
              <span className="muted small">تُستخرج الضريبة من السعر بدل إضافتها إليه.</span>
            </span>
          </label>
        </div>

        <h2>الأصناف</h2>
        <InvoiceLines
          lines={lines}
          onChange={setLines}
          items={items.data ?? []}
          taxGroups={taxGroups.data ?? []}
          priceField="purchasePrice"
          withNumbers
          costCenters={costCenters.data ?? []}
        />

        <h2>الإجماليات</h2>
        <TotalsPanel totals={totals} variant="purchase" />

        <Notice notice={notice} />
        <div className="row">
          {/* «💾 حفظ» L1428 و«🖨️💾 حفظ مع طباعة» L1424 في `frmInvPurch.xaml`. */}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : '💾 حفظ'}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={(event) => void save(event, true)}>
            🖨️💾 حفظ مع طباعة
          </button>
        </div>
      </form>
    </Screen>
  );
}
