'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Notice } from '../../../../components/data-view';
import { InvoiceLines, TotalsPanel, computeTotals, emptyLine, filledLines, serialList, toApiLines, type LineDraft } from '../../../../components/invoice-editor';
import { Screen } from '../../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../../lib/api';
import {
  arabicName,
  branchOptions,
  defaultOf,
  listCostCenters,
  listBranches,
  listItems,
  listParties,
  listSalesmen,
  listTaxGroups,
  listUnits,
  listWarehouses,
  partyLabel,
  type Branch,
  type CostCenter,
  type Item,
  type Party,
  type Salesman,
  type TaxGroup,
  type Unit,
  type Warehouse,
} from '../../../../lib/lookups';
import { SERIAL_MESSAGES, decideSerial, type SerialLookup } from '../../../../lib/serial-numbers';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

export default function NewSalesInvoicePage() {
  const router = useRouter();
  const { can, me } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const parties = useQuery<Party[]>(() => listParties('customer'), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const taxGroups = useQuery<TaxGroup[]>(() => listTaxGroups(), []);
  const salesmen = useQuery<Salesman[]>(() => listSalesmen(), []);
  // R9 — 📊 مركز التكلفة: القائمة التي كانت في نافذة الديسكتوب («📊 مركز التكلفة:» L530)
  // وتحتها `➕ إضافة مركز تكلفة` — والقائمة هنا تقرأ ما يُدار في شاشة «مراكز التكلفة».
  const costCenters = useQuery<CostCenter[]>(() => listCostCenters(), []);
  const units = useQuery<Unit[]>(() => listUnits(), []);
  const tenantSettings = useQuery<Record<string, unknown>>(
    () => apiData<Record<string, unknown>>('/settings').catch(() => ({})),
    [],
  );
  const saveAsDraftByDefault =
    tenantSettings.data?.['sales.saveAsDraft'] === true ||
    tenantSettings.data?.['sales.saveAsDraft'] === 'true';

  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [cashName, setCashName] = useState('عميل عام');
  const [cashMobile, setCashMobile] = useState('');
  const [salesmanId, setSalesmanId] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [includesVat, setIncludesVat] = useState(false);
  const [invoiceDiscountText, setInvoiceDiscountText] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [serialQuery, setSerialQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'danger'; text: string } | undefined>();

  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows.filter((row) => !effectiveBranch || row.branchId === effectiveBranch))?.id || '';
  const selectedParty = (parties.data ?? []).find((row) => row.id === partyId);
  const selectedPartyTaxNo = String(selectedParty?.taxNo ?? selectedParty?.tax_no ?? '').trim();
  const isGeneralCustomer =
    !partyId ||
    selectedParty?.code === 'CUST-GEN' ||
    selectedParty?.name === 'عميل عام';
  const isStandardTaxInvoice = Boolean(!isGeneralCustomer && selectedPartyTaxNo.length > 0);
  const taxInvoiceTypeLabel = isStandardTaxInvoice ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة';
  const totals = computeTotals(lines, { priceIncludesVat: includesVat, invoiceDiscount: invoiceDiscountText });
  /**
   * حدّ الخصم على العضوية (R1، بديل `OperMaxDiscount`). عرضٌ لا فرض: الفرض في
   * `assertDiscountWithinLimit` على الخادم، وهذه الشاشة تُعلن السقف قبل الكتابة.
   */
  const discountLimitText = ((): string => {
    const pct = me?.membership.maxDiscountPct ?? null;
    // الاسم `capAmount` لا `amount`: قاعدة الفحص (`eslint.config.mjs`) تمنع تعريف
    // معرّفٍ باسمٍ نقديّ بلا نوع Decimal — والحدّ نصٌّ لا رقم.
    const capAmount = me?.membership.maxDiscountAmount ?? null;
    if (pct === null && capAmount === null) return '';
    const parts: string[] = [];
    if (pct !== null) parts.push(`أعلى نسبة ${pct}%`);
    if (capAmount !== null) parts.push(`أعلى قيمة ${capAmount}`);
    return `حدّك: ${parts.join(' · ')}`;
  })();

  /**
   * «🔢 التسلسلي:» — الخانة التي في رأس نافذة الديسكتوب (`frmInvSale.xaml` L592):
   * يُدخل المُدخِل الرقم فيَجد الصنفَ وحالَه. فإن كان على الرفّ أُضيف سطرٌ بالرقم، وإلا
   * ظهرت إحدى رسائل النافذة الثلاث بحروفها (`lib/serial-numbers.ts`).
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
      const verdict = decideSerial({
        lookup: { ...lookup, serialNo: value },
        lines,
        parse: serialList,
      });
      if (verdict.decision.kind === 'reject') {
        setNotice({ kind: 'warn', text: verdict.decision.text });
        return;
      }
      const decision = verdict.decision;
      const item = (items.data ?? []).find((row) => row.id === decision.itemId);
      const group = item?.taxGroupId ? (taxGroups.data ?? []).find((row) => row.id === item.taxGroupId) : undefined;
      const base = emptyLine(group ? String(Number(group.rate) * 100) : '15');
      const next: LineDraft = {
        ...base,
        itemId: decision.itemId,
        unitPriceText: String(item?.salePrice ?? item?.sale_price ?? ''),
        taxGroupId: group?.id ?? '',
        serialText: decision.serialNo,
      };
      // السطر الجديد بالرقم، والصفوف الفارغة تُنظَّف قبله: الرقم نفسه هو الرسالة.
      setLines([
        ...lines.filter((line) => line.itemId || line.description.trim() || line.serialText.trim()),
        next,
      ]);
      setSerialQuery('');
    } catch (error) {
      const text = error instanceof ApiError && error.status === 403 ? SERIAL_MESSAGES.forbidden : String(error);
      setNotice({ kind: 'warn', text });
    }
  }

  /**
   * «💾 حفظ» و«💾🖨️ حفظ + طباعة» — زرّا الديسكتوب `frmInvSale.xaml` L1263 وL1257.
   * الاثنان يكتبان المستند؛ الثاني يفتح ورقة الطباعة بعده (`Print.cs` نفسها التي
   * تفتحها «🖨️ طباعة» L1254) بدل شاشة الفاتورة.
   */
  async function save(event: React.SyntheticEvent, print = false, forceDraft?: boolean) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (filledLines(lines).length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أضف سطراً واحداً على الأقل.');
      const resolvedCashName = cashName.trim() || 'عميل عام';
      const shouldAutoPost = forceDraft === true ? false : forceDraft === false ? true : !saveAsDraftByDefault;
      const invoice = await apiPost<{ id: string }>('/sales/invoices', {
        branchId: effectiveBranch,
        warehouseId: effectiveWarehouse || undefined,
        partyId: partyId || undefined,
        salesmanId: salesmanId || undefined,
        costCenterId: costCenterId || undefined,
        cashCustomerName: partyId ? undefined : resolvedCashName,
        cashCustomerMobile: partyId ? undefined : cashMobile.trim() || undefined,
        kind: 'sale',
        priceIncludesVat: includesVat,
        invoiceDiscount: invoiceDiscountText.trim() || undefined,
        autoPost: shouldAutoPost,
        lines: toApiLines(lines),
      });
      router.push(print ? `/print/sales-invoice/${invoice.id}` : `/sales/invoices/${invoice.id}`);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
      setBusy(false);
    }
  }

  if (!can('sales.invoice.create')) {
    return (
      <Screen title="🧾 فاتورة مبيعات" crumbs={['المبيعات', 'العمليات']}>
        <div className="card state">
          <strong>لا تملك صلاحية إنشاء فواتير المبيعات</strong>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      // «🧾 فاتورة مبيعات» — `Form_WPF/frmInvSale.xaml` L347.
      title="🧾 فاتورة مبيعات"
      subtitle={
        saveAsDraftByDefault
          ? 'وضع المسودة مفعّل من الإعدادات العامة: تُحفظ الفاتورة كمسودة أولاً، أو يمكنك ترحيلها فوراً.'
          : 'تُحفظ الفاتورة وتُرحَّل فوراً بشكل افتراضي فتأخذ رقمها الضريبي وباركود QR وتتحرك بها المخازن والقيود (يمكنك تفعيل خيار المسودة من الإعدادات العامة).'
      }
      crumbs={['المبيعات', 'العمليات']}
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
            <span>🏪 المستودع{filledLines(lines).some((line) => line.itemId) ? ' *' : ''}</span>
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
            <span>👤 العميل</span>
            <select className="input" value={partyId} onChange={(event) => setPartyId(event.target.value)}>
              <option value="">— عميل عام (فاتورة ضريبية مبسطة) —</option>
              {(parties.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {partyLabel(row)}
                  {(row.taxNo ?? row.tax_no ?? '').trim() && row.name !== 'عميل عام' && row.code !== 'CUST-GEN'
                    ? ` — رقم ضريبي: ${row.taxNo ?? row.tax_no}`
                    : ' — فاتورة ضريبية مبسطة'}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>🧾 تصنيف الفاتورة الضريبية</span>
            <div
              className="input"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                background: 'var(--surface-2)',
              }}
            >
              <span className={`badge ${isStandardTaxInvoice ? 'active' : 'neutral'}`}>
                {taxInvoiceTypeLabel}
              </span>
              <small className="muted" dir="ltr">
                {isStandardTaxInvoice ? `الرقم الضريبي: ${selectedPartyTaxNo}` : 'عميل عام / بدون رقم ضريبي'}
              </small>
            </div>
          </div>
          {!partyId && (
            <>
              <label className="field">
                <span>💵 اسم العميل (الافتراضي: عميل عام)</span>
                <input
                  className="input"
                  value={cashName}
                  placeholder="عميل عام"
                  onChange={(event) => setCashName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>📱 الجوال</span>
                <input className="input" dir="ltr" value={cashMobile} onChange={(event) => setCashMobile(event.target.value)} />
              </label>
            </>
          )}
          <label className="field">
            <span>👨‍💼 المندوب</span>
            <select className="input" value={salesmanId} onChange={(event) => setSalesmanId(event.target.value)}>
              <option value="">— بدون مندوب —</option>
              {(salesmen.data ?? []).filter((row) => row.active !== false).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          {/*
            «🔢 التسلسلي:» — `frmInvSale.xaml` L592، وخانتها `txtSrchSerialNo` تقرأ
            الرقم عند `Enter` (L3599 ← `SearchBySerialNo` L722). الإدخال هنا يضيف سطراً
            بالصنف والرقم، والرسائل الثلاث من النافذة نفسها بحروفها.
          */}
          {/*
            «📊 مركز التكلفة:» — `frmInvSale.xaml` L530 (القائمة `cmbCostCenter`) وتحتها زرّ
            «إضافة مركز تكلفة» يفتح `frmCostCenter`. وهو مركز الفاتورة كلها: السطر الذي لا
            يذكر مركزاً يأخذه، والسطر الذي يذكر مركزاً يسبقه — كما في بناء القيد بالديسكتوب
            (`InvoiceOper.cs` L2461 ثم L2432).
          */}
          <label className="field">
            <span>📊 مركز التكلفة:</span>
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
            <span className="muted small">يُضيف الصنف بسطرٍ يحمل الرقم — تماماً كما في النافذة المكتبية.</span>
          </label>
          <label className="field">
            <span>🔻 خصم</span>
            <input className="input" dir="ltr" inputMode="decimal" value={invoiceDiscountText} onChange={(event) => setInvoiceDiscountText(event.target.value)} />
            <span className="muted small">يُخفّض وعاء الضريبة قبل احتسابها.{discountLimitText ? ` ${discountLimitText}.` : ''}</span>
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
          units={units.data ?? []}
          priceField="salePrice"
          withNumbers
          costCenters={costCenters.data ?? []}
        />

        <h2>الإجماليات</h2>
        <TotalsPanel totals={totals} />

        <Notice notice={notice} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {/* «💾 حفظ» L1263 و«💾🖨️ حفظ + طباعة» L1257 في `frmInvSale.xaml`. */}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : saveAsDraftByDefault ? '💾 حفظ كمسودة' : '⚡ حفظ وترحيل فوري'}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={(event) => void save(event, true)}>
            {saveAsDraftByDefault ? '💾🖨️ حفظ + طباعة' : '⚡🖨️ حفظ وترحيل + طباعة'}
          </button>
          {saveAsDraftByDefault ? (
            <button className="btn" type="button" disabled={busy} onClick={(event) => void save(event, false, false)}>
              ⚡ حفظ وترحيل فوري
            </button>
          ) : (
            <button className="btn" type="button" disabled={busy} onClick={(event) => void save(event, false, true)}>
              📝 حفظ كمسودة فقط
            </button>
          )}
        </div>
      </form>
    </Screen>
  );
}
