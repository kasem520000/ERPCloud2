'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../components/data-view';
import { Screen } from '../../components/screen';
import { ZatcaQrSvg, printThermalReceipt80mm } from '../../components/zatca-qr-svg';
import { ApiError, apiData, apiPost } from '../../lib/api';
import {
  defaultOf,
  itemLabel,
  listCashLocations,
  listItems,
  listParties,
  listSalesmen,
  listWarehouses,
  today,
  type CashLocation,
  type Item,
  type Party,
  type Salesman,
  type Warehouse,
} from '../../lib/lookups';

/**
 * صف من الرصيد الرسمي — one row of `stock_balances`, the ledger the item card and the
 * stock report read. The factory tab shows these instead of a number derived from the
 * add-on tables, so the two screens can never disagree about what the warehouse holds.
 */
type OfficialStockRow = {
  itemId: string;
  itemName: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  branchId: string | null;
  quantity: string;
  value: string;
  averageCost: string;
};

/** 🧑‍💼 مندوب التوزيع — the official `salesmen` card with its employee, login and custody. */
type VanSalesman = {
  id: string;
  name: string;
  active: boolean;
  employeeId: string | null;
  employeeNo: string | null;
  employeeName: string | null;
  employeeStatus: string | null;
  membershipId: string | null;
  membershipStatus: string | null;
  userEmail: string | null;
  userStatus: string | null;
  roleCount: number;
  permissions: string[];
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  vehiclePlate: string | null;
  tel: string | null;
  mobile: string | null;
  email: string | null;
  custody: {
    openLoadOrders: number;
    pendingReceipts: number;
    pendingClosings: number;
    custodyQty: string;
    outstandingCash: string;
    items: Array<{ itemId: string; itemName: string; warehouseName: string; quantity: string; value: string }>;
  };
  readiness: {
    hasEmployee: boolean;
    hasLoginAccount: boolean;
    loginActive: boolean;
    hasVanWarehouse: boolean;
    hasVanSalesPermissions: boolean;
  };
};

type ProductionBatch = {
  id: string;
  batchNo: string;
  productionDate: string;
  itemId: string | null;
  itemName: string;
  producedQty: string;
  issuedQty: string;
  returnedGoodQty: string;
  damagedQty: string;
  availableWarehouseQty: string;
  unitCost: string;
  totalCost: string;
  /** 💵 أساس التكلفة: أمر تصنيع رسمي، أم إدخال يدوي/تكلفة البطاقة. */
  costBasis?: string;
  /** 🗑️ قيمة الفاقد، وهل حُمِّلت على تكلفة المنتج الجيد. */
  scrapQty?: string;
  scrapValue?: string;
  scrapCostLoaded?: boolean;
  status: string;
  supervisorName: string;
  notes: string;
};

type RepPerformance = {
  salesmanId: string;
  salesmanName: string;
  loadedKg: string;
  soldKg: string;
  bonusKg: string;
  returnedKg: string;
  damagedKg: string;
  shortageKg: string;
  shortageSar: string;
  custodyRemainingKg: string;
  revenueSar: string;
  collectedSar: string;
  creditDebtSar: string;
  netProfitSar: string;
  pendingClosings: number;
};

type LoadOrder = {
  id: string;
  number: string;
  loadDate: string;
  productionBatchNo: string;
  vehiclePlate: string;
  status: string;
  salesmanId: string;
  salesmanName: string;
  itemId: string | null;
  itemName: string;
  loadedQty: string;
  /** ما أكّد المندوب استلامه فعلًا — أساس العهدة بعد خطوة الاستلام. */
  receivedQty?: string;
  discrepancyQty?: string;
  discrepancyNotes?: string;
  receivedAt?: string | null;
  awaitingReceipt?: boolean;
  warehouseId?: string | null;
  vanWarehouseId?: string | null;
  stockTransferId?: string | null;
  soldQty: string;
  bonusQty: string;
  returnedQty: string;
  damagedQty: string;
  shortageQty: string;
  shortageValue: string;
  remainingQty: string;
  /** ما أعلنته الوردية فعلياً عند الجرد. */
  actualRemainingQty?: string;
  /** ما تقول المستندات إنه يجب أن يبقى في السيارة. */
  expectedRemainingQty?: string;
  /** موجب = عجز عن الجرد، سالب = فائض. */
  countVarianceQty?: string;
  /** 💵 قيمة فرق الجرد على أساس التكلفة — قيمة تسوية مخزنية، لا دين على المندوب. */
  countVarianceCostValue?: string;
  /** ما كتبه مستند الجرد الرسمي نفسه بعد ترحيله. */
  countDocumentVarianceValue?: string | null;
  countDocumentExpectedQty?: string | null;
  /**
   * 🧾 تسوية المخزون الرسمية — مستند الجرد الرسمي، مصير المتبقي الفعلي، وحالة التسوية.
   * العهدة لا تُغلق (`settled`) ورصيد السيارة الرسمي يختلف عن الجرد الفعلي.
   */
  stockAdjustmentId?: string | null;
  remainingAction?: 'return_to_main' | 'carry_over' | null;
  remainingInventoryTxId?: string | null;
  stockSettlementStatus?: string;
  stockSettlementNote?: string;
  damageJournalEntryId?: string | null;
  awaitingStockSettlement?: boolean;
  awaitingTransitDecision?: boolean;
  maxBonusQty: string;
  maxBonusPct: string;
  expectedCash: string;
  collectedCash: string;
  cashVariance: string;
  damageReason: string;
  damageInspected: boolean;
  salaryDeductionApproved: boolean;
  closingNotes: string;
  closingSubmittedAt: string | null;
  approvedAt: string | null;
  approvedByLabel: string;
  notes: string;
};

type CustomerPrice = {
  id: string;
  partyId: string;
  partyName: string;
  partyCode: string;
  partyTaxNo: string;
  itemId: string | null;
  itemName: string;
  priceTierLabel: string;
  unitPrice: string;
  maxBonusPct: string;
  maxBonusKgPerInvoice: string;
  preferredInvoiceMode: 'zatca_tax' | 'internal_delivery';
  creditLimit: string;
  paymentTermsDays: number;
  lockPrice: boolean;
  maxDiscountPct: string;
  notes: string;
};

type VanDocument = {
  id: string;
  number: string;
  docDate: string;
  invoiceMode: 'zatca_tax' | 'internal_delivery';
  paymentMethod: string;
  documentKind?: string;
  referenceDocumentId?: string | null;
  /** رقم وحالة الفاتورة الرسمية في `sales_invoices`. */
  invoiceNumber?: string | null;
  invoiceStatus?: string | null;
  productionBatchNo: string;
  loadOrderId: string | null;
  salesmanId: string | null;
  salesmanName: string;
  partyId: string | null;
  customerName: string;
  customerTaxNo: string;
  itemId: string | null;
  itemName: string;
  soldQty: string;
  bonusQty: string;
  bonusReason: string;
  unitPrice: string;
  discountAmount: string;
  discountReason: string;
  subtotal: string;
  taxRate: string;
  taxTotal: string;
  total: string;
  paidAmount: string;
  unitCost: string;
  netProfit: string;
  customerBonusConfirmed: boolean;
  customerConfirmationCode: string;
  bonusAnomaly: boolean;
  anomalyReason: string;
  /** رمز ZATCA (TLV) المبني على الخادم من ملف المنشأة الرسمي. */
  qrPayload?: string;
  notes: string;
  createdAt: string;
};

type StockMovement = {
  id: string;
  movementType: string;
  batchNo: string;
  qty: string;
  unitPrice: string;
  amount: string;
  reason: string;
  salesmanName: string;
  customerName: string;
  actorLabel: string;
  approvedByLabel: string;
  createdAt: string;
};

type CustomerPriceHistoryItem = {
  id: string;
  customerPriceId: string;
  partyId: string;
  itemId: string | null;
  previousUnitPrice: string | null;
  newUnitPrice: string;
  maxBonusPct: string;
  maxBonusKgPerInvoice: string;
  maxDiscountPct: string;
  lockPrice: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  changeReason: string;
  changedBy: string | null;
  changedAt: string;
};

type LegacyReconciliationPreview = {
  mode: 'dry_run' | 'execute';
  inspectedAt: string;
  batches: { total: number; linkedToCore: number; unlinkedLegacy: number };
  loadOrders: { total: number; linkedToTransfer: number; unlinkedLegacy: number };
  documents: { total: number; linkedToSalesInvoice: number; unlinkedLegacy: number; conflicts: string[] };
  reconciledCount: number;
};

type DashboardData = {
  policy?: {
    internalDeliveryEnabled: boolean;
    internalDeliveryTaxMode: string;
    shortageValuationBasis: string;
    productionCostBasis: string;
    bonusAccountingMode: string;
    defaultVatRatePct: string;
  };
  /** الأرصدة الرسمية من `stock_balances` — نفس ما تقرأه شاشة المخزون وبطاقة الصنف. */
  officialStock?: OfficialStockRow[];
  mainWarehouseId?: string | null;
  postingReadiness?: {
    branchId: string | null;
    salesInvoice: boolean;
    stockTransfer: boolean;
    receiptVoucher: boolean;
    message: string | null;
  };
  summary: {
    totalProducedKg: string;
    totalScrapKg?: string;
    mainWarehouseBalanceKg: string;
    vanWarehousesBalanceKg?: string;
    /** 🚚 بضاعة خرجت ولم يؤكّد المندوب استلامها: ليست في السيارة ولا في المستودع. */
    inTransitKg?: string;
    inTransitValueSar?: string;
    inTransitTransfersCount?: number;
    derivedMainWarehouseBalanceKg?: string;
    stockLedgerAgrees?: boolean;
    pendingReceiptsCount?: number;
    totalProductionCostSar: string;
    totalLoadedKg: string;
    totalSoldKg: string;
    totalBonusKg: string;
    totalReturnedKg: string;
    totalDamagedKg: string;
    totalShortageKg: string;
    totalShortageSar: string;
    remainingInVansKg: string;
    totalZatcaSalesSar: string;
    totalInternalSalesSar: string;
    totalRevenueSar: string;
    totalCollectedCashSar: string;
    totalCreditReceivablesSar: string;
    totalNetProfitSar: string;
    anomalyCount: number;
    pendingClosingsCount: number;
    /** عهد اعتُمدت كمياتها ولم تُسوَّ مخزنياً بعد — لا تُغلق قبل تسويتها. */
    pendingStockSettlementsCount?: number;
    /** فروق استلام بلا قرار (return / shortage). */
    pendingTransitDecisionsCount?: number;
  };
  productionBatches: ProductionBatch[];
  repPerformance: RepPerformance[];
  loadOrders: LoadOrder[];
  customerPrices: CustomerPrice[];
  customerPriceHistory?: CustomerPriceHistoryItem[];
  documents: VanDocument[];
  movements: StockMovement[];
};

/** 🖨️ نسخة الطباعة — what `/van-sales/documents/:id/print-view` returns. */
type PrintCopy = {
  copyIndex: number;
  kind: 'customer' | 'rep';
  copyLabel: string;
  requiresCustomerSignature: boolean;
  signatureBlock: {
    customerSignatureLabel: string;
    repSignatureLabel: string;
    accountantNote: string;
  } | null;
};

type PrintView = {
  documentId: string;
  documentNumber: string;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  saleDate: string;
  companyName: string;
  companyNameEn: string;
  companyTaxNo: string;
  companyCrNo: string;
  companyEmail: string;
  companyPhones: string[];
  companyAddress: Record<string, unknown> | null;
  customerName: string;
  customerTaxNo: string;
  customerPhone: string;
  customerMobile: string;
  salesmanName: string;
  salesmanMobile: string;
  vanWarehouseName: string;
  loadOrderNumber: string;
  productionBatchNo: string;
  invoiceMode: string;
  taxPolicyStatus: string;
  paymentMethod: string;
  lines: Array<{
    kind: string;
    itemName: string;
    sku: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    lineTotal: string;
    reason?: string;
  }>;
  subtotal: string;
  discountTotal: string;
  vatRate: string;
  vatTotal: string;
  grandTotal: string;
  paidAmount: string;
  outstandingAmount: string;
  bonusQtyTotal: string;
  qrPayload: string;
  notes: string;
  printedAt: string;
  copies: PrintCopy[];
  copiesCount: number;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatPrintedAt = (value: string): string => {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return `${at.toLocaleDateString('ar-SA-u-ca-gregory')} ${at.toLocaleTimeString('ar-SA-u-ca-gregory')}`;
};

/**
 * 🖨️ نسختان من مستند بيع واحد — one official document, printed twice: the customer's copy
 * and the rep's copy that comes back signed. Opening a print window (the same pattern the
 * thermal receipt uses) keeps the browser's own dialog in charge of the printer, and no
 * second invoice is ever created here.
 */
function openPrintWindow(view: PrintView): void {
  const address = view.companyAddress
    ? [
        view.companyAddress.street ? String(view.companyAddress.street) : '',
        view.companyAddress.district ? String(view.companyAddress.district) : '',
        view.companyAddress.city ? String(view.companyAddress.city) : '',
      ]
        .filter(Boolean)
        .join(' — ')
    : '';

  const renderCopy = (copy: PrintCopy): string => `
  <section class="copy">
    <header>
      <div class="company">
        <h1>${escapeHtml(view.companyName || 'المنشأة')}</h1>
        ${view.companyNameEn ? `<div class="en">${escapeHtml(view.companyNameEn)}</div>` : ''}
        <div class="meta">
          ${view.companyTaxNo ? `<span>الرقم الضريبي: <b dir="ltr">${escapeHtml(view.companyTaxNo)}</b></span>` : ''}
          ${view.companyCrNo ? `<span>السجل التجاري: <b dir="ltr">${escapeHtml(view.companyCrNo)}</b></span>` : ''}
          ${view.companyPhones.length ? `<span>هاتف: <b dir="ltr">${escapeHtml(view.companyPhones.join(' ، '))}</b></span>` : ''}
          ${view.companyEmail ? `<span>بريد: <b dir="ltr">${escapeHtml(view.companyEmail)}</b></span>` : ''}
          ${address ? `<span>العنوان: ${escapeHtml(address)}</span>` : ''}
        </div>
      </div>
      <div class="doc">
        <div class="copy-label">${escapeHtml(copy.copyLabel)}</div>
        <h2>${view.invoiceMode === 'zatca_tax' ? 'فاتورة ضريبية إلكترونية (مبيعات توزيع)' : 'إشعار تسليم / فاتورة توزيع داخلية'}</h2>
        <table class="kv">
          <tr><td>رقم المستند</td><th dir="ltr">${escapeHtml(view.documentNumber)}</th></tr>
          ${view.invoiceNumber ? `<tr><td>رقم الفاتورة الرسمية</td><th dir="ltr">${escapeHtml(view.invoiceNumber)}</th></tr>` : ''}
          <tr><td>تاريخ البيع</td><th dir="ltr">${escapeHtml(view.saleDate)}</th></tr>
          <tr><td>تاريخ ووقت الطباعة</td><th dir="ltr">${escapeHtml(formatPrintedAt(view.printedAt))}</th></tr>
          <tr><td>طريقة الدفع</td><th>${escapeHtml(view.paymentMethod === 'cash' ? 'نقدًا' : view.paymentMethod === 'card' ? 'شبكة' : 'آجل')}</th></tr>
        </table>
      </div>
    </header>

    <div class="parties">
      <div>
        <h3>بيانات العميل</h3>
        <div><b>${escapeHtml(view.customerName || 'عميل نقدي')}</b></div>
        ${view.customerTaxNo ? `<div>الرقم الضريبي: <b dir="ltr">${escapeHtml(view.customerTaxNo)}</b></div>` : ''}
        ${view.customerPhone || view.customerMobile ? `<div>جوال: <b dir="ltr">${escapeHtml(view.customerMobile || view.customerPhone)}</b></div>` : ''}
      </div>
      <div>
        <h3>المندوب وسيارة التوزيع</h3>
        <div><b>${escapeHtml(view.salesmanName)}</b></div>
        ${view.salesmanMobile ? `<div>جوال: <b dir="ltr">${escapeHtml(view.salesmanMobile)}</b></div>` : ''}
        <div>العهدة: ${escapeHtml(view.vanWarehouseName)}</div>
        ${view.loadOrderNumber ? `<div>أمر التحميل: <b dir="ltr">${escapeHtml(view.loadOrderNumber)}</b></div>` : ''}
        ${view.productionBatchNo ? `<div>دفعة الإنتاج: <b dir="ltr">${escapeHtml(view.productionBatchNo)}</b></div>` : ''}
      </div>
    </div>

    <table class="lines">
      <thead>
        <tr><th>#</th><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الخصم</th><th>الإجمالي</th></tr>
      </thead>
      <tbody>
        ${view.lines
          .map(
            (line, index) => `<tr class="${line.kind === 'bonus' ? 'bonus' : ''}">
              <td>${index + 1}</td>
              <td>${escapeHtml(line.itemName)}${line.reason ? ` <span class="muted">(${escapeHtml(line.reason)})</span>` : ''}</td>
              <td dir="ltr">${escapeHtml(line.quantity)}</td>
              <td dir="ltr">${escapeHtml(line.unitPrice)}</td>
              <td dir="ltr">${escapeHtml(line.discount)}</td>
              <td dir="ltr">${escapeHtml(line.lineTotal)}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>

    ${Number(view.bonusQtyTotal) > 0 ? `<div class="bonus-note">🎁 الكميات المجانية (البونص): <b dir="ltr">${escapeHtml(view.bonusQtyTotal)}</b> — مُسلَّمة بلا قيمة وبلا ضريبة، وتُخصم من المخزون بالتكلفة.</div>` : ''}

    <table class="totals">
      <tr><td>الإجمالي قبل الضريبة</td><th dir="ltr">${escapeHtml(view.subtotal)}</th></tr>
      ${Number(view.discountTotal) > 0 ? `<tr><td>الخصم</td><th dir="ltr">${escapeHtml(view.discountTotal)}</th></tr>` : ''}
      <tr><td>ضريبة القيمة المضافة (${escapeHtml(view.vatRate)}%)</td><th dir="ltr">${escapeHtml(view.vatTotal)}</th></tr>
      <tr class="grand"><td>الإجمالي المستحق</td><th dir="ltr">${escapeHtml(view.grandTotal)}</th></tr>
      <tr><td>المدفوع</td><th dir="ltr">${escapeHtml(view.paidAmount)}</th></tr>
      <tr><td>المتبقي</td><th dir="ltr">${escapeHtml(view.outstandingAmount)}</th></tr>
    </table>

    ${view.qrPayload ? `<div class="qr"><img alt="ZATCA QR" src="data:image/png;base64,${''}" data-qr="${escapeHtml(view.qrPayload)}" /><div class="muted small">رمز الاستجابة السريعة (TLV): <span dir="ltr">${escapeHtml(view.qrPayload)}</span></div></div>` : ''}

    ${
      copy.requiresCustomerSignature && copy.signatureBlock
        ? `<div class="sign">
            <div class="sign-box"><span>${escapeHtml(copy.signatureBlock.customerSignatureLabel)}</span></div>
            <div class="sign-box"><span>${escapeHtml(copy.signatureBlock.repSignatureLabel)}</span></div>
            <div class="muted small">${escapeHtml(copy.signatureBlock.accountantNote)}</div>
          </div>`
        : ''
    }
    ${view.notes ? `<div class="notes">ملاحظات: ${escapeHtml(view.notes)}</div>` : ''}
    <footer class="muted small">
      ${view.invoiceMode === 'zatca_tax' ? 'مستند ضريبي إلكتروني — الحالة: ' + escapeHtml(view.invoiceStatus || '—') : 'حالة السياسة الضريبية: ' + escapeHtml(view.taxPolicyStatus)}
    </footer>
  </section>`;

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(view.documentNumber)} — نسختا الطباعة</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; margin: 0; padding: 16px; background: #fff; color: #111; }
  .no-print { text-align: center; margin-bottom: 12px; }
  .copy { border: 1px solid #999; border-radius: 6px; padding: 14px; margin: 0 auto 18px; max-width: 780px; page-break-after: always; }
  .copy:last-child { page-break-after: auto; }
  header { display: flex; justify-content: space-between; gap: 14px; border-bottom: 2px solid #111; padding-bottom: 8px; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 0 0 6px; }
  h3 { font-size: 13px; margin: 0 0 4px; }
  .en { font-size: 12px; color: #444; }
  .meta { font-size: 11px; color: #333; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .copy-label { display: inline-block; background: #111; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .kv td, .kv th { text-align: right; padding: 1px 4px; font-weight: 400; }
  .kv th { font-weight: 700; }
  .parties { display: flex; gap: 24px; margin: 10px 0; }
  .lines th, .lines td { border: 1px solid #bbb; padding: 4px 6px; text-align: right; }
  .lines thead th { background: #f2f2f2; }
  .lines tr.bonus td { background: #fffbe8; }
  .bonus-note { margin: 8px 0; font-size: 12px; background: #fffbe8; border: 1px dashed #c9a227; padding: 6px 8px; border-radius: 4px; }
  .totals { width: 320px; margin: 10px 0 10px auto; }
  .totals td, .totals th { border-bottom: 1px solid #ddd; padding: 3px 6px; text-align: right; }
  .totals tr.grand td, .totals tr.grand th { border-top: 2px solid #111; font-size: 14px; }
  .sign { display: flex; gap: 18px; margin-top: 18px; }
  .sign-box { flex: 1; border: 1px solid #999; border-radius: 4px; height: 62px; display: flex; align-items: flex-end; padding: 6px; font-size: 11px; color: #555; }
  .notes { margin-top: 10px; font-size: 12px; }
  .muted { color: #555; }
  .small { font-size: 11px; }
  footer { margin-top: 10px; border-top: 1px solid #ddd; padding-top: 6px; }
  @media print { .no-print { display: none !important; } body { padding: 0; } .copy { border: none; } }
</style>
</head>
<body>
  <div class="no-print">
    <button onclick="window.print()" style="padding:8px 16px;font-weight:700;cursor:pointer;">🖨️ طباعة النسختين</button>
    <span class="muted small"> نسخة للعميل ونسخة للمندوب تُعاد موقّعة إلى المحاسب — مستند بيع رسمي واحد بنسختين مطبوعتين</span>
  </div>
  ${view.copies.map(renderCopy).join('')}
</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
}

const MOVEMENT_TYPE_AR: Record<string, string> = {
  production_in: '🏭 إنتاج يومي للمستودع الرئيسي',
  van_load: '🚚 صرف وتحميل عهدة مندوب',
  van_sale: '🧾 بيع فعلي لعميل',
  van_bonus: '🎁 كمية مجانية / عينات',
  van_return: '↩️ إرجاع سليم للمستودع',
  van_damage: '⚠️ تالف مفحوص ومعتمد',
  van_shortage: '🔴 عجز عهدة مخصوم من راتب المندوب',
  stocktake_adjustment: '📋 تسوية جرد فعلي',
  collection_receipt: '💵 سند قبض وتحصيل مديونية',
};

const LOAD_STATUS_AR: Record<string, string> = {
  draft: 'مسودة',
  /** صُرفت البضاعة من المستودع الرئيسي وهي رسميًّا «تحت التحويل» — لم تدخل عهدة المندوب بعد. */
  pending_receipt: '🚚 مصروف وبانتظار تأكيد استلام المندوب',
  loaded: 'محمّل في السيارة (بعد تأكيد الاستلام)',
  in_route: 'قيد التوزيع اليومي',
  pending_closing: '⏳ معلق بانتظار فحص التالف واعتماد المحاسب',
  /** الكميات اعتُمدت، لكن رصيد السيارة الرسمي ما زال يختلف عن الجرد الفعلي. */
  pending_stock_settlement: '🧾 بانتظار تسوية المخزون الرسمية (العهدة لم تُغلق)',
  settled: '✅ معتمد ومُصفّى ومُسوّى مخزنياً',
  reconciled: '✅ مُطابَق',
  rejected: '❌ مرفوض من المندوب (أُعيدت الكمية رسمياً)',
  canceled: '🗑️ ملغى (أُلغيت المناقلة الرسمية)',
};

/** حالة تسوية المخزون الرسمية كما يراها المحاسب. */
const SETTLEMENT_STATUS_AR: Record<string, string> = {
  not_required: 'لا يلزم تسوية',
  pending_transit_decision: '🚦 فرق استلام بلا قرار',
  pending_count_decision: '🧾 جرد بلا تسوية مُرحّلة',
  settled_officially: '✅ سُوّي رسمياً',
  blocked_missing_accounts: '⛔ حسابات ملف الترحيل ناقصة',
};

const BONUS_REASONS = [
  'بونص ترويجي متفق عليه مع العميل',
  'عينات مجانية لتجربة صنف جديد',
  'تعويض تلف سابق معتمد',
  'عرض كميات خاص بالموسم / رمضان',
];

type TabKey = 'owner' | 'production' | 'reps' | 'loads' | 'invoice' | 'prices' | 'audit';

export default function VanSalesPage() {
  const [tab, setTab] = useState<TabKey>('owner');
  const [data, setData] = useState<DashboardData | null>(null);
  const [salesmen, setSalesmen] = useState<Salesman[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [cashLocations, setCashLocations] = useState<CashLocation[]>([]);
  /** 🧑‍💼 مندوبو التوزيع ببطاقاتهم الرسمية وعهدهم الحيّة — من `/van-sales/salesmen`. */
  const [vanSalesmen, setVanSalesmen] = useState<VanSalesman[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'warn'; text: string }>();
  const [busy, setBusy] = useState(false);

  // Pillar 1: Production batch form state
  const [prodItemName, setProdItemName] = useState('');
  const [prodItemId, setProdItemId] = useState('');
  /** المستودع الرئيسي الذي يدخله الإنتاج — يُقرأ من المستودعات الرسمية لا يُخترَع. */
  const [prodWarehouseId, setProdWarehouseId] = useState('');
  const [prodDate, setProdDate] = useState(today());
  const [prodQty, setProdQty] = useState('500');
  const [prodScrapQty, setProdScrapQty] = useState('0');
  /** سبب الفاقد — إلزامي مع أي كمية فاقد: الخادم يرفض فاقدًا بلا سبب. */
  const [prodScrapReason, setProdScrapReason] = useState('');
  const [prodUnitCost, setProdUnitCost] = useState('');
  const [prodSupervisor, setProdSupervisor] = useState('مشرف خط الإنتاج');
  const [reconciliationPreview, setReconciliationPreview] = useState<LegacyReconciliationPreview | null>(null);

  // 🧑‍💼 شاشة المندوبين: ربط الموظف وحساب الدخول ومستودع السيارة
  const [repTarget, setRepTarget] = useState<VanSalesman | null>(null);
  const [repEmail, setRepEmail] = useState('');
  const [repFullName, setRepFullName] = useState('');
  const [repScopeToVan, setRepScopeToVan] = useState(true);

  // Pillar 2: Load order form state (default 150 kg per client proposal example)
  const [loadSalesmanId, setLoadSalesmanId] = useState('');
  const [loadItemId, setLoadItemId] = useState('');
  const [loadWarehouseId, setLoadWarehouseId] = useState('');
  const [loadVanWarehouseId, setLoadVanWarehouseId] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('أ ب ج 4521');
  const [productionBatchNo, setProductionBatchNo] = useState('');
  const [loadedQty, setLoadedQty] = useState('150');
  const [maxBonusQty, setMaxBonusQty] = useState('20');
  const maxBonusPct = '20';

  // Pillar 2: Shift Closing & Accountant Approval Modal State
  const [closingTarget, setClosingTarget] = useState<LoadOrder | null>(null);
  const [closingReturnedQty, setClosingReturnedQty] = useState('0');
  const [closingDamagedQty, setClosingDamagedQty] = useState('0');
  const [closingDamageReason, setClosingDamageReason] = useState('');
  const [closingCollectedCash, setClosingCollectedCash] = useState('0');
  /** 🧮 المتبقي الفعلي بالجرد — يُعبّأ بما أعلنته الوردية ولا يُفتَرَض صفرًا ولا رقمًا من الكود. */
  const [closingActualRemaining, setClosingActualRemaining] = useState('0');
  const [closingNotes, setClosingNotes] = useState('');
  const [closingDamageInspected, setClosingDamageInspected] = useState(false);
  const [closingSalaryDeduction, setClosingSalaryDeduction] = useState(false);
  /** مصير المتبقي الفعلي — قرار صريح، و'' تعني أن المحاسب لم يختر بعد. */
  const [closingRemainingAction, setClosingRemainingAction] = useState<
    'return_to_main' | 'carry_over' | ''
  >('');
  /** 🖋️ تفويض ترحيل مستند الجرد الرسمي — بدونه يبقى المستند مسودة وتبقى العهدة معلّقة. */
  const [closingSettleStock, setClosingSettleStock] = useState(false);
  /** ⚖️ إقرار صريح بأن الجرد الفعلي أكبر من العهدة (فائض). */
  const [closingSurplusAck, setClosingSurplusAck] = useState(false);

  // Pillar 4 & 5: Customer price tier & credit limit form state
  const [tierPartyId, setTierPartyId] = useState('');
  const [tierUnitPrice, setTierUnitPrice] = useState('6.50');
  const [tierLabel, setTierLabel] = useState('شريحة جملة محلات — 6.50 ريال/كجم');
  const [tierMaxBonusPct, setTierMaxBonusPct] = useState('20');
  const [tierMaxBonusKg, setTierMaxBonusKg] = useState('20');
  const [tierCreditLimit, setTierCreditLimit] = useState('5000');
  const [tierPaymentTerms, setTierPaymentTerms] = useState('15');
  const [tierLockPrice, setTierLockPrice] = useState(true);
  const [tierMaxDiscountPct, setTierMaxDiscountPct] = useState('0');
  const [tierPreferredMode, setTierPreferredMode] = useState<'zatca_tax' | 'internal_delivery'>('zatca_tax');
  const [tierChangeReason, setTierChangeReason] = useState('اعتماد وتحديث شريحة سعر العميل');

  // Pillar 3, 4, 8: Van invoice / delivery form state
  const [docLoadOrderId, setDocLoadOrderId] = useState('');
  const [docPartyId, setDocPartyId] = useState('');
  const [docWalkinName, setDocWalkinName] = useState('');
  const [docMode, setDocMode] = useState<'zatca_tax' | 'internal_delivery'>('zatca_tax');
  const [docPayment, setDocPayment] = useState<'cash' | 'card' | 'credit'>('cash');
  /** 💵 الصندوق الذي يستقر فيه نقد المندوب — يُمرَّر إلى تسوية الفاتورة الرسمية. */
  const [docCashLocationId, setDocCashLocationId] = useState('');
  const [docSoldQty, setDocSoldQty] = useState('100');
  const [docBonusQty, setDocBonusQty] = useState('20');
  const [docBonusReason, setDocBonusReason] = useState(BONUS_REASONS[0] ?? 'بونص ترويجي متفق عليه مع العميل');
  const [docUnitPrice, setDocUnitPrice] = useState('6.50');
  const [docDiscountAmount, setDocDiscountAmount] = useState('0');
  const [docDiscountReason, setDocDiscountReason] = useState('');
  const [docAllowOverride, setDocAllowOverride] = useState(false);
  const [docBonusConfirmed, setDocBonusConfirmed] = useState(true);
  const [docConfirmCode, setDocConfirmCode] = useState('');
  const [selectedDoc, setSelectedDoc] = useState<VanDocument | null>(null);

  async function reload() {
    const dash = await apiData<DashboardData>('/van-sales/dashboard');
    const [smRes, custRes, itRes, whRes, cashRes, vanSmRes] = await Promise.allSettled([
      listSalesmen(),
      listParties('customer'),
      listItems(),
      listWarehouses(),
      listCashLocations(),
      apiData<VanSalesman[]>('/van-sales/salesmen'),
    ]);
    const sm = smRes.status === 'fulfilled' ? smRes.value : [];
    const cust = custRes.status === 'fulfilled' ? custRes.value : [];
    const it = itRes.status === 'fulfilled' ? itRes.value : [];
    const wh = whRes.status === 'fulfilled' ? whRes.value : [];
    const cash = cashRes.status === 'fulfilled' ? cashRes.value : [];
    const vanSm = vanSmRes.status === 'fulfilled' ? vanSmRes.value : [];
    setData(dash);
    setSalesmen(sm);
    setCustomers(cust);
    setItems(it);
    setWarehouses(wh);
    setCashLocations(cash);
    setVanSalesmen(vanSm);
    if (!loadSalesmanId && sm[0]?.id) setLoadSalesmanId(sm[0].id);
    /**
     * المستودع الرئيسي الافتراضي — pre-selected so production always lands somewhere real;
     * the server resolves the same default when the field is left empty.
     */
    if (!prodWarehouseId) {
      const mainWarehouse = defaultOf(wh) ?? wh[0];
      if (mainWarehouse?.id) setProdWarehouseId(mainWarehouse.id);
    }
    if (!prodItemId && it[0]?.id) setProdItemId(it[0].id);
    if (!loadWarehouseId) {
      const mainWarehouse = defaultOf(wh) ?? wh[0];
      if (mainWarehouse?.id) setLoadWarehouseId(mainWarehouse.id);
    }
    if (!productionBatchNo && dash.productionBatches?.[0]?.batchNo) {
      setProductionBatchNo(dash.productionBatches[0].batchNo);
    }
    const activeLoads = (dash.loadOrders ?? []).filter((l) => l.status !== 'settled');
    if (!docLoadOrderId && activeLoads[0]?.id) setDocLoadOrderId(activeLoads[0].id);
    if (!selectedDoc && dash.documents?.[0]) setSelectedDoc(dash.documents[0]);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialTab = params.get('tab') as TabKey | null;
    if (
      initialTab &&
      ['owner', 'production', 'reps', 'loads', 'invoice', 'prices', 'audit'].includes(initialTab)
    ) {
      setTab(initialTab);
    }
    void reload().catch((error: unknown) =>
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تحميل بيانات المصنع والتوزيع' }),
    );
  }, []);

  function onSelectCustomer(partyId: string) {
    setDocPartyId(partyId);
    const rule = data?.customerPrices.find((cp) => cp.partyId === partyId);
    if (rule) {
      setDocUnitPrice(rule.unitPrice);
      setDocMode(rule.preferredInvoiceMode);
    }
  }

  async function submitProductionBatch(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>('/van-sales/production-batches', {
        /**
         * الصنف والمستودع — both mandatory now. Without them the batch row was written and
         * **no official stock movement happened**, so the main warehouse balance never grew:
         * the exact defect reported from the floor.
         */
        itemId: prodItemId,
        warehouseId: prodWarehouseId || undefined,
        productionDate: prodDate || undefined,
        itemName: prodItemName || undefined,
        producedQty: prodQty,
        scrapQty: prodScrapQty || '0',
        scrapReason: prodScrapReason.trim() || undefined,
        unitCost: prodUnitCost || undefined,
        supervisorName: prodSupervisor,
      });
      setData(next);
      const newestBatch = next.productionBatches[0];
      if (newestBatch) setProductionBatchNo(newestBatch.batchNo);
      const warehouseName =
        warehouses.find((row) => row.id === (newestBatch as { warehouseId?: string | null }).warehouseId)?.name ??
        'المستودع الرئيسي';
      setNotice({
        kind: 'ok',
        text: `تم تسجيل دفعة الإنتاج (${newestBatch?.batchNo ?? ''}) بكمية ${prodQty} كجم، ودخلت الرصيد الرسمي في ${warehouseName} — الرصيد الرسمي الآن ${next.summary.mainWarehouseBalanceKg} كجم.`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تسجيل دفعة الإنتاج' });
    } finally {
      setBusy(false);
    }
  }

  /** ✅ تأكيد استلام التوريد — what turns "sent" into custody on the official balance. */
  async function confirmLoadReceipt(loadOrderId: string, receivedQty: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(
        `/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
        { receivedQty },
      );
      setData(next);
      setNotice({
        kind: 'ok',
        text: `تم تأكيد استلام ${receivedQty} كجم ودخولها الرصيد الرسمي لمستودع سيارة المندوب.`,
      });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر تأكيد استلام التوريد',
      });
    } finally {
      setBusy(false);
    }
  }

  /** 🔗 ربط المندوب بحساب دخول رسمي (مستخدم + عضوية + دور + نطاق مستودع السيارة). */
  async function linkRepAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!repTarget) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiPost<{
        membershipId: string;
        email: string;
        status: string;
        roleName: string;
        activationRequired: boolean;
        scopedToVanWarehouse: boolean;
      }>(`/van-sales/salesmen/${repTarget.id}/account`, {
        email: repEmail,
        fullName: repFullName || undefined,
        restrictToVanWarehouse: repScopeToVan,
      });
      setNotice({
        kind: 'ok',
        text: `تم ربط المندوب (${repTarget.name}) بحساب الدخول ${result.email} على دور «${result.roleName}»${
          result.scopedToVanWarehouse ? ' مع قصر صلاحيته على مستودع سيارته' : ''
        }${result.activationRequired ? ' — الحساب بانتظار تفعيل كلمة المرور من رابط الدعوة الرسمي' : ''}.`,
      });
      setRepTarget(null);
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر ربط حساب المندوب' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 🖨️ طباعة نسختين — customer copy + rep copy (with a signature box) of the *same*
   * official document. Rendered from `/van-sales/documents/:id/print-view`, so the numbers
   * on paper are the numbers in the ledger.
   */
  async function printDocumentCopies(documentId: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      const view = await apiData<PrintView>(`/van-sales/documents/${documentId}/print-view?copies=2`);
      openPrintWindow(view);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تجهيز نسخة الطباعة' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 🧾 الإيصال الحراري — built from the same official print view, so the company name and
   * tax number come from the company profile instead of a string in the code.
   */
  async function printThermalFromView(documentId: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      const view = await apiData<PrintView>(`/van-sales/documents/${documentId}/print-view?copies=1`);
      printThermalReceipt80mm({
        companyName: view.companyName,
        taxNo: view.companyTaxNo,
        branchName: `دفعة إنتاج: ${view.productionBatchNo}`,
        invoiceNumber: view.invoiceNumber ?? view.documentNumber,
        invoiceTypeLabel:
          view.invoiceMode === 'zatca_tax'
            ? 'فاتورة ضريبية مبسطة (ZATCA)'
            : 'إيصال تسليم بضاعة (توزيع)',
        issuedAt: view.saleDate,
        customerName: view.customerName,
        cashierName: view.salesmanName,
        paymentMethodLabel:
          view.paymentMethod === 'cash'
            ? 'نقدي (Cash)'
            : view.paymentMethod === 'card'
              ? 'شبكة مدى'
              : 'آجل (Credit)',
        lines: view.lines.map((line) => ({
          name: line.itemName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.lineTotal,
        })),
        subtotal: view.subtotal,
        discount: view.discountTotal,
        taxTotal: view.vatTotal,
        total: view.grandTotal,
        paidAmount: view.paidAmount,
        qrPayload: view.qrPayload,
      });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر تجهيز الإيصال الحراري',
      });
    } finally {
      setBusy(false);
    }
  }

  /** ↩️ مرتجع العميل — official `sale_return` against the original document. */
  async function submitReturn(documentId: string, returnedQty: string, reason: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(`/van-sales/documents/${documentId}/returns`, {
        returnedQty,
        reason,
      });
      setData(next);
      setNotice({
        kind: 'ok',
        text: `تم تسجيل مرتجع العميل (${returnedQty} كجم) وإصدار فاتورة مرتجع رسمية وإرجاع الكمية إلى عهدة المندوب.`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تسجيل المرتجع' });
    } finally {
      setBusy(false);
    }
  }

  async function submitLoadOrder(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>('/van-sales/load-orders', {
        salesmanId: loadSalesmanId,
        itemId: loadItemId || undefined,
        warehouseId: loadWarehouseId || undefined,
        vanWarehouseId: loadVanWarehouseId || undefined,
        vehiclePlate,
        productionBatchNo: productionBatchNo || undefined,
        loadedQty,
        maxBonusQty,
        maxBonusPct,
      });
      setData(next);
      const newestLoad = next.loadOrders[0];
      if (newestLoad) setDocLoadOrderId(newestLoad.id);
      setNotice({
        kind: 'ok',
        text: `تم إنشاء مناولة مخزنية رسمية وصرف ${loadedQty} كجم من المستودع الرئيسي لأمر التحميل ${newestLoad?.number ?? ''} — الحالة الآن «بانتظار تأكيد استلام المندوب»، ولن تدخل عهدة المندوب قبل تأكيده.`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر إنشاء أمر التحميل' });
    } finally {
      setBusy(false);
    }
  }

  async function submitCustomerTier(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>('/van-sales/customer-prices', {
        partyId: tierPartyId,
        priceTierLabel: tierLabel,
        unitPrice: tierUnitPrice,
        maxBonusPct: tierMaxBonusPct,
        maxBonusKgPerInvoice: tierMaxBonusKg,
        creditLimit: tierCreditLimit,
        paymentTermsDays: Number(tierPaymentTerms || 15),
        lockPrice: tierLockPrice,
        maxDiscountPct: tierMaxDiscountPct,
        preferredInvoiceMode: tierPreferredMode,
        changeReason: tierChangeReason,
      });
      setData(next);
      setNotice({
        kind: 'ok',
        text: 'تم حفظ سعر العميل المخصص، تثبيت السعر، سقف الائتمان، وسياسة الكميات المجانية مع توثيق التعديل في سجل الأسعار.',
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر حفظ شريحة السعر' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRunLegacyPreview() {
    setBusy(true);
    setNotice(undefined);
    try {
      const preview = await apiPost<LegacyReconciliationPreview>('/van-sales/legacy-reconciliation', {
        mode: 'dry_run',
      });
      setReconciliationPreview(preview);
      setNotice({
        kind: 'ok',
        text: 'تم تنفيذ فحص توافق البيانات السابقة (Dry-Run) بنجاح دون أي تعديل على البيانات.',
      });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر تنفيذ فحص توافق البيانات السابقة',
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitVanDocument(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>('/van-sales/documents', {
        loadOrderId: docLoadOrderId,
        partyId: docPartyId || undefined,
        customerName: docPartyId ? undefined : docWalkinName.trim() || 'محل تجزئة نقدي',
        invoiceMode: docMode,
        paymentMethod: docPayment,
        cashLocationId: docCashLocationId || undefined,
        soldQty: docSoldQty,
        bonusQty: docBonusQty || '0',
        bonusReason: Number(docBonusQty || 0) > 0 ? docBonusReason : undefined,
        unitPrice: docUnitPrice,
        discountAmount: docDiscountAmount || '0',
        discountReason: docDiscountReason.trim() || undefined,
        allowPriceDiscountOverride: docAllowOverride,
        customerBonusConfirmed: docBonusConfirmed,
        customerConfirmationCode: docConfirmCode.trim() || undefined,
      });
      setData(next);
      const newestDoc = next.documents[0] ?? null;
      setSelectedDoc(newestDoc);
      setNotice({
        kind: 'ok',
        text: `تم إصدار ${newestDoc?.invoiceMode === 'zatca_tax' ? 'فاتورة ضريبية إلكترونية (ZATCA)' : 'فاتورة توزيع عادية محفوظة محاسبياً'} رقم ${newestDoc?.number ?? ''} وخصم الكمية من عهدة المندوب.`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر إصدار المستند' });
    } finally {
      setBusy(false);
    }
  }

  function openClosingModal(load: LoadOrder) {
    setClosingTarget(load);
    setClosingReturnedQty(load.returnedQty && Number(load.returnedQty) > 0 ? load.returnedQty : '0');
    setClosingDamagedQty(load.damagedQty && Number(load.damagedQty) > 0 ? load.damagedQty : '0');
    setClosingDamageReason(load.damageReason || '');
    setClosingCollectedCash(Number(load.collectedCash) > 0 ? load.collectedCash : load.expectedCash);
    // ما سجّله المندوب فعلياً إن وُجد، وإلا المتبقي المتوقع حتى يعدّله المحاسب بعد الجرد.
    setClosingActualRemaining(
      Number(load.actualRemainingQty ?? 0) > 0
        ? String(load.actualRemainingQty)
        : String(load.expectedRemainingQty ?? load.remainingQty ?? '0'),
    );
    setClosingNotes(load.closingNotes || '');
    // لا يُفتَرَض الفحص ولا الخصم: إقراران صريحان من المحاسب في كل مرة.
    setClosingDamageInspected(load.damageInspected === true);
    setClosingSalaryDeduction(load.salaryDeductionApproved === true);
    // قرار مصير المتبقي لا يُفتَرَض: يُقرأ إن سبق تسجيله، وإلا يبقى بلا اختيار.
    setClosingRemainingAction(
      load.remainingAction === 'return_to_main' || load.remainingAction === 'carry_over'
        ? load.remainingAction
        : '',
    );
    setClosingSettleStock(false);
    setClosingSurplusAck(false);
  }

  async function handleSubmitPendingClosing() {
    if (!closingTarget) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(`/van-sales/load-orders/${closingTarget.id}/submit-closing`, {
        returnedQty: closingReturnedQty,
        damagedQty: closingDamagedQty,
        damageReason: closingDamageReason,
        collectedCash: closingCollectedCash,
        actualRemainingQty: closingActualRemaining,
        closingNotes,
      });
      setData(next);
      const updated = next.loadOrders.find((l) => l.id === closingTarget.id) ?? null;
      setClosingTarget(updated);
      setNotice({
        kind: 'warn',
        text: `⏳ تم تقديم طلب إغلاق الوردية (${closingTarget.number}) وحساب العجز تلقائياً، وباتت الحالة «معلق بانتظار فحص التالف واعتماد المحاسب».`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تقديم إغلاق الوردية' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * ♻️ استكمال تسوية المخزون — the recovery path for a custody whose quantities were approved
   * but whose official count settlement did not complete. Same official mechanism, safe to repeat.
   */
  async function handleSettleLoadOrderStock(load: LoadOrder, settleStockAdjustment: boolean) {
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(`/van-sales/load-orders/${load.id}/settle-stock`, {
        settleStockAdjustment,
        ...(load.remainingAction ? { remainingAction: load.remainingAction } : {}),
      });
      setData(next);
      const updated = next.loadOrders.find((l) => l.id === load.id) ?? null;
      setNotice({
        kind: updated?.status === 'settled' ? 'ok' : 'warn',
        text:
          updated?.status === 'settled'
            ? `✅ سُوّي رصيد السيارة الرسمي مع الجرد الفعلي (${load.number}) وأُغلقت العهدة. مسؤولية أي عجز ما زالت معلّقة بانتظار السياسة.`
            : `⏳ ${updated?.stockSettlementNote ?? 'لم تكتمل تسوية المخزون بعد'} (${load.number}).`,
      });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذّر استكمال تسوية المخزون',
      });
    } finally {
      setBusy(false);
    }
  }

  /** 🚦 قرار فرق الاستلام — financial decision taken explicitly, never assumed by the system. */
  async function handleCloseTransitDifference(load: LoadOrder, mode: 'return' | 'shortage') {
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(
        `/van-sales/load-orders/${load.id}/close-transit-difference`,
        { mode, reason: mode === 'return' ? 'إرجاع الفرق إلى المستودع المصدر' : 'اعتبار الفرق عجز تحويل' },
      );
      setData(next);
      setNotice({
        kind: 'ok',
        text:
          mode === 'return'
            ? `↩️ أُعيد فرق الاستلام (${load.discrepancyQty ?? '0'} كجم) رسمياً إلى المستودع المصدر بقيد من ملف الترحيل (${load.number}).`
            : `⚠️ اعتُبر فرق الاستلام (${load.discrepancyQty ?? '0'} كجم) عجز تحويل ورُحّل رسمياً (Dr تسوية المخزون / Cr بضاعة تحت التحويل) (${load.number}).`,
      });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذّر إقفال فرق الاستلام',
      });
    } finally {
      setBusy(false);
    }
  }

  /** 🗑️ إلغاء توريد لم يُستلَم — عبر الإلغاء الرسمي للمناقلة (يعيد الكميات ويعكس القيد). */
  async function handleCancelLoadOrder(load: LoadOrder) {
    const reason = window.prompt(
      `سبب إلغاء أمر التحميل (${load.number}) — ستُعاد الكميات رسمياً إلى المستودع المصدر ويُلغى قيد الإرسال:`,
      '',
    );
    if (reason === null) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(`/van-sales/load-orders/${load.id}/cancel`, {
        reason: reason.trim() || undefined,
      });
      setData(next);
      setNotice({ kind: 'ok', text: `🗑️ أُلغي أمر التحميل (${load.number}) وأُلغيت المناقلة الرسمية وأعادت الكميات وقيد الإرسال.` });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذّر إلغاء أمر التحميل',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleAccountantApproveClosing() {
    if (!closingTarget) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>(`/van-sales/load-orders/${closingTarget.id}/approve-closing`, {
        returnedQty: closingReturnedQty,
        damagedQty: closingDamagedQty,
        collectedCash: closingCollectedCash,
        damageInspected: closingDamageInspected,
        salaryDeductionApproved: closingSalaryDeduction,
        notes: closingNotes,
        // 🧮 الجرد الفعلي كما يقرّره المحاسب، ومصير المتبقي، وتفويض ترحيل مستند الجرد.
        actualRemainingQty: closingActualRemaining,
        ...(closingRemainingAction ? { remainingAction: closingRemainingAction } : {}),
        settleStockAdjustment: closingSettleStock,
        ...(modalSurplusKg > 0 ? { surplusAcknowledged: closingSurplusAck } : {}),
      });
      setData(next);
      const updated = next.loadOrders.find((l) => l.id === closingTarget.id) ?? null;
      setClosingTarget(null);
      const stillOpen = updated?.status === 'pending_stock_settlement';
      setNotice({
        kind: stillOpen ? 'warn' : 'ok',
        text: stillOpen
          ? `⏳ اعتُمدت كميات الوردية (${closingTarget.number}) لكن **العهدة لم تُغلق**: ${
              updated?.stockSettlementNote ?? 'رصيد السيارة الرسمي ما زال يختلف عن الجرد الفعلي'
            } — استخدم «♻️ استكمال تسوية المخزون» بعد تفويض ترحيل مستند الجرد الرسمي.`
          : `✅ اعتُمدت الوردية (${closingTarget.number}) وسُوّي رصيد السيارة الرسمي مع الجرد الفعلي${
              closingRemainingAction === 'return_to_main'
                ? ' وأُعيد المتبقي رسمياً إلى المستودع الرئيسي'
                : closingRemainingAction === 'carry_over'
                  ? ' وبقي المتبقي عهدة الوردية التالية'
                  : ''
            }.${
              modalShortageKg > 0
                ? ` العجز (${modalShortageKg.toFixed(2)} كجم ≈ ${modalShortageSar.toFixed(2)} ريال) مسجّل وقيمته مثبتة في مستند الجرد الرسمي، ومسؤوليته المالية ما زالت معلّقة — لا قيد على راتب المندوب أو ذمته قبل اعتماد السياسة.`
                : ''
            }`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر اعتماد إغلاق الوردية' });
    } finally {
      setBusy(false);
    }
  }

  async function handleCollectDebt(doc: VanDocument) {
    const unpaid = Math.max(0, Number(doc.total) - Number(doc.paidAmount)).toFixed(2);
    const input = window.prompt(`أدخل المبلغ المحصّل من العميل (${doc.customerName}) للفاتورة ${doc.number}:`, unpaid);
    if (!input) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await apiPost<DashboardData>('/van-sales/collections', {
        documentId: doc.id,
        collectedAmount: input,
        notes: 'تحصيل مديونية عميل توزيع',
      });
      setData(next);
      setNotice({ kind: 'ok', text: `تم تسجيل سند قبض بمبلغ ${input} ريال للفاتورة ${doc.number}.` });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تسجيل التحصيل' });
    } finally {
      setBusy(false);
    }
  }

  const activeLoadOrder = data?.loadOrders.find((l) => l.id === docLoadOrderId);
  const selectedCustomerRule = data?.customerPrices.find((cp) => cp.partyId === docPartyId);
  const configuredVatFactor = Number(data?.policy?.defaultVatRatePct ?? 15) / 100;
  const previewGross = Number(docSoldQty || 0) * Number(docUnitPrice || 0);
  const previewDiscount = Number(docDiscountAmount || 0);
  const previewSubtotal = Math.max(0, previewGross - previewDiscount);
  const previewVat = docMode === 'zatca_tax' ? previewSubtotal * configuredVatFactor : 0;
  const previewTotal = previewSubtotal + previewVat;

  /**
   * 🧮 حساب مباشر داخل نافذة الإغلاق على **أساس العهدة الحقيقي**: ما أكّد المندوب استلامه
   * (`receivedQty`) لا ما خرج من المستودع الرئيسي، مطروحاً منه المباع والبونص والمرتجع
   * والتالف = المتبقي المتوقع، والفرق بينه وبين الجرد الفعلي هو العجز.
   */
  const modalReceived = Number(closingTarget?.receivedQty ?? 0);
  const modalLoaded = modalReceived > 0 ? modalReceived : Number(closingTarget?.loadedQty ?? 0);
  const modalSold = Number(closingTarget?.soldQty ?? 0);
  const modalBonus = Number(closingTarget?.bonusQty ?? 0);
  const modalReturned = Number(closingReturnedQty || 0);
  const modalDamaged = Number(closingDamagedQty || 0);
  const modalActualRemaining = Number(closingActualRemaining || 0);
  const modalExpectedRemaining = modalLoaded - (modalSold + modalBonus + modalReturned + modalDamaged);
  const modalShortageKg = Math.max(0, modalExpectedRemaining - modalActualRemaining);
  const modalSurplusKg = Math.max(0, modalActualRemaining - modalExpectedRemaining);
  const targetShortageUnitRate =
    closingTarget && Number(closingTarget.shortageQty) > 0
      ? Number(closingTarget.shortageValue) / Number(closingTarget.shortageQty)
      : Number(data?.customerPrices?.[0]?.unitPrice ?? docUnitPrice ?? 0);
  const modalShortageSar = modalShortageKg * targetShortageUnitRate;

  return (
    <Screen
      title="🏭 نظام المصنع والمخابز ومناديب التوزيع المتكامل"
      subtitle="الحل الشامل لإدارة الإنتاج اليومي، المستودع الرئيسي، عهد المناديب، إغلاق الوردية المعلق لاعتماد المحاسب وفحص التالف وخصم العجز من الراتب، ضبط الأسعار والبونص، والفوترة الإلكترونية ZATCA."
      crumbs={['توزيع المناديب والمخابز']}
    >
      {notice ? <Notice notice={notice} /> : null}

      {/* Navigation Tabs for the 10-Pillar System */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={tab === 'owner' ? 'btn primary' : 'btn'}
          onClick={() => setTab('owner')}
        >
          📊 1. لوحة صاحب المصنع والملخص التنفيذي
        </button>
        <button
          type="button"
          className={tab === 'production' ? 'btn primary' : 'btn'}
          onClick={() => setTab('production')}
        >
          🏭 2. الإنتاج اليومي والمستودع وحركة البضاعة ({data?.productionBatches.length ?? 0})
        </button>
        <button
          type="button"
          className={tab === 'reps' ? 'btn primary' : 'btn'}
          onClick={() => setTab('reps')}
        >
          🧑‍💼 3. مندوبو التوزيع وحساباتهم ومستودعات سياراتهم ({vanSalesmen.length})
        </button>
        <button
          type="button"
          className={tab === 'loads' ? 'btn primary' : 'btn'}
          onClick={() => setTab('loads')}
        >
          🚚 4. توريد المنتجات وعهد المناديب وإغلاق الوردية ({data?.loadOrders.length ?? 0})
          {(data?.summary.pendingReceiptsCount ?? 0) > 0 ? ` · ⏳ ${data?.summary.pendingReceiptsCount} بانتظار الاستلام` : ''}
          {(data?.summary.pendingStockSettlementsCount ?? 0) > 0
            ? ` · 🧾 ${data?.summary.pendingStockSettlementsCount} بلا تسوية مخزون`
            : ''}
        </button>
        <button
          type="button"
          className={tab === 'invoice' ? 'btn primary' : 'btn'}
          onClick={() => setTab('invoice')}
        >
          🧾 4. فواتير التوزيع (ZATCA / عادية) والتحصيل ({data?.documents.length ?? 0})
        </button>
        <button
          type="button"
          className={tab === 'prices' ? 'btn primary' : 'btn'}
          onClick={() => setTab('prices')}
        >
          💰 5. ضبط أسعار العملاء والائتمان والبونص ({data?.customerPrices.length ?? 0})
        </button>
        <button
          type="button"
          className={tab === 'audit' ? 'btn primary' : 'btn'}
          onClick={() => setTab('audit')}
        >
          🛡️ 6. رادار البونص والصلاحيات والأمان
        </button>
      </div>

      {/* Pending Shift Closings Alert Banner */}
      {(data?.summary.pendingClosingsCount ?? 0) > 0 && (
        <div
          className="card"
          style={{
            border: '2px solid var(--warn)',
            background: 'var(--warn-soft, var(--surface-2))',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div>
            <strong>
              ⏳ يوجد ({data?.summary.pendingClosingsCount}) طلب إغلاق وردية مندوب معلق بانتظار فحص التالف واعتماد المحاسب!
            </strong>
            <div className="muted small">
              لا يتم تصفير عهدة المندوب أو قيد التالف والعجز على راتب المندوب إلا بعد مراجعة المحاسب والاعتماد النهائي.
            </div>
          </div>
          <button type="button" className="btn primary" onClick={() => setTab('loads')}>
            مراجعة واعتماد إغلاقات الورديات الآن ←
          </button>
        </div>
      )}

      {/* 🧾 عهد لم تُغلق: الرصيد الرسمي ما زال يختلف عن الجرد الفعلي */}
      {((data?.summary.pendingStockSettlementsCount ?? 0) > 0 ||
        (data?.summary.pendingTransitDecisionsCount ?? 0) > 0) && (
        <div className="card" style={{ border: '2px solid var(--danger)' }}>
          <strong>
            🧾 يوجد ({data?.summary.pendingStockSettlementsCount ?? 0}) وردية اعتُمدت كمياتها ولم تُسوَّ
            مخزنياً
            {(data?.summary.pendingTransitDecisionsCount ?? 0) > 0
              ? ` و(${data?.summary.pendingTransitDecisionsCount}) فرق استلام بلا قرار`
              : ''}
          </strong>
          <div className="muted small">
            العهدة <b>لم تُغلق</b>: رصيد السيارة الرسمي في دفتر المخزون ما زال يختلف عن الجرد الفعلي. لا تُغلق
            أي عهدة مع بقاء فرق بلا تسوية في دفتر المخزون — استخدم «♻️ استكمال تسوية المخزون» على الأمر المعنيّ
            بعد تفويض ترحيل مستند الجرد الرسمي. المسؤولية المالية عن أي عجز تبقى معلّقة حتى تعتمد السياسة.
          </div>
          <button type="button" className="btn primary" onClick={() => setTab('loads')}>
            عرض الورديات المعلّقة وتسويتها الآن ←
          </button>
        </div>
      )}

      {/* Pending supply receipts — goods officially in transit, not yet in the rep's custody */}
      {(data?.summary.pendingReceiptsCount ?? 0) > 0 && (
        <div className="card" style={{ border: '2px solid var(--info, #2f6fed)' }}>
          <strong>🚚 يوجد ({data?.summary.pendingReceiptsCount}) توريد بانتظار تأكيد استلام المندوب</strong>
          <div className="muted small">
            البضاعة خرجت من المستودع الرئيسي وهي رسميًّا «تحت التحويل» — لا تدخل عهدة المندوب ولا يظهر لها رصيد في
            سيارته إلا بعد أن يؤكّد الاستلام من تطبيق المندوب (أو يؤكده المحاسب نيابةً عنه).
          </div>
          <button type="button" className="btn" onClick={() => setTab('loads')}>
            عرض التوريدات المنتظرة ←
          </button>
        </div>
      )}

      {/* جاهزية الترحيل المحاسبي — named per operation so the message is actionable */}
      {data?.postingReadiness && !data.postingReadiness.salesInvoice && (
        <div className="card" style={{ border: '2px solid var(--warn)' }}>
          <strong>⚠️ ملف الترحيل المحاسبي غير مكتمل</strong>
          <div className="muted small">{data.postingReadiness.message}</div>
          <div className="muted small">
            الحالة الآن: فاتورة المبيعات الرسمية {data.postingReadiness.salesInvoice ? '✅' : '❌'} · المناولات
            المخزنية {data.postingReadiness.stockTransfer ? '✅' : '❌'} · سندات القبض{' '}
            {data.postingReadiness.receiptVoucher ? '✅' : '❌'} — تسجيل الإنتاج وحركة الأرصدة يعملان بدونها.
          </div>
        </div>
      )}

      {/* الأرصدة الرسمية — the same rows the inventory screens read */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>📦 الأرصدة الرسمية في المستودعات (من دفتر المخزون الموحّد)</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>
          هذه هي الأرصدة نفسها التي تراها في شاشة أرصدة المخزون وبطاقة الصنف والتقارير الرسمية — تُقرأ من
          <code> stock_balances</code> ولا تُحتسب من جداول الإضافة.
          {data?.summary.stockLedgerAgrees === false ? (
            <b style={{ color: 'var(--danger)' }}>
              {' '}⚠️ يوجد اختلاف بين الرصيد الرسمي والرصيد المشتق من سجلات التوزيع — راجع الحركات.
            </b>
          ) : null}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>المستودع</th>
                <th>الصنف</th>
                <th>البطاقة</th>
                <th align="left">الرصيد الرسمي</th>
                <th align="left">متوسط التكلفة</th>
                <th align="left">قيمة الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {(data?.officialStock ?? []).map((row) => (
                <tr key={`${row.warehouseId}-${row.itemId}`}>
                  <td>
                    {row.warehouseName}
                    {row.warehouseId === data?.mainWarehouseId ? ' 🏭 (رئيسي)' : ''}
                  </td>
                  <td>{row.itemName}</td>
                  <td dir="ltr">{row.sku}</td>
                  <td align="left" dir="ltr">{row.quantity}</td>
                  <td align="left" dir="ltr">{row.averageCost}</td>
                  <td align="left" dir="ltr">{row.value}</td>
                </tr>
              ))}
              {(data?.officialStock ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    لا توجد أرصدة رسمية بعد — سجّل دفعة إنتاج وستظهر هنا وفي شاشة المخزون معًا.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* 🚚 بضاعة تحت التحويل — الكمية التي لا هي في المستودع ولا في السيارة */}
      {Number(data?.summary.inTransitKg ?? 0) > 0 && (
        <div className="card" style={{ border: '2px solid var(--info, #2f6fed)' }}>
          <strong>
            🚚 بضاعة تحت التحويل: {data?.summary.inTransitKg} كجم بقيمة{' '}
            {data?.summary.inTransitValueSar} ريال ({data?.summary.inTransitTransfersCount ?? 0} مناولة)
          </strong>
          <div className="muted small">
            خرجت من المستودع الرسمي ولم يؤكّد المندوب استلامها بعد: ليست في رصيد السيارة ولا في رصيد
            المستودع، وقيمتها واقفة في حساب «بضاعة تحت التحويل» بقيد (Dr بضاعة تحت التحويل / Cr
            المخزون). أي فرق عند الاستلام يبقى معلّقاً حتى يُتخذ فيه قرار صريح (إرجاع إلى المصدر أو
            اعتباره عجز تحويل) — لا يُرحَّل تلقائياً.
          </div>
        </div>
      )}

      {/* TAB 1: FACTORY OWNER DASHBOARD (Pillar 9) */}
      {tab === 'owner' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 10 }}>
            <div className="card">
              <div className="muted small">إجمالي الإنتاج اليومي</div>
              <strong style={{ fontSize: 21 }} dir="ltr">{data?.summary.totalProducedKg ?? '0.00'} kg</strong>
              <div className="muted small">رصيد المستودع: {data?.summary.mainWarehouseBalanceKg ?? '0.00'} kg</div>
            </div>
            <div className="card">
              <div className="muted small">إجمالي المسلم لعهد المناديب</div>
              <strong style={{ fontSize: 21 }} dir="ltr">{data?.summary.totalLoadedKg ?? '0.00'} kg</strong>
              <div className="muted small">متبقي بالعهد: {data?.summary.remainingInVansKg ?? '0.00'} kg</div>
            </div>
            <div className="card">
              <div className="muted small">المباع الفعلي + البونص</div>
              <strong style={{ fontSize: 21, color: 'var(--ok)' }} dir="ltr">
                {data?.summary.totalSoldKg ?? '0.00'} kg
              </strong>
              <div className="muted small" style={{ color: 'var(--warn)' }}>
                بونص وعينات: {data?.summary.totalBonusKg ?? '0.00'} kg
              </div>
            </div>
            <div className="card">
              <div className="muted small">التالف المفحوص + العجز</div>
              <strong style={{ fontSize: 21, color: 'var(--danger)' }} dir="ltr">
                عجز: {data?.summary.totalShortageKg ?? '0.00'} kg
              </strong>
              <div className="muted small">
                تالف: {data?.summary.totalDamagedKg ?? '0.00'} kg · خصم رواتب: {data?.summary.totalShortageSar ?? '0.00'} SAR
              </div>
            </div>
            <div className="card">
              <div className="muted small">إجمالي المبيعات (ZATCA + عادية)</div>
              <strong style={{ fontSize: 21, color: 'var(--brand)' }} dir="ltr">
                {data?.summary.totalRevenueSar ?? '0.00'} SAR
              </strong>
              <div className="muted small">
                ضريبية: {data?.summary.totalZatcaSalesSar ?? '0.00'} · عادية: {data?.summary.totalInternalSalesSar ?? '0.00'}
              </div>
            </div>
            <div className="card">
              <div className="muted small">التحصيل والمديونيات وصافي الربح</div>
              <strong style={{ fontSize: 21, color: 'var(--ok)' }} dir="ltr">
                ربح: {data?.summary.totalNetProfitSar ?? '0.00'} SAR
              </strong>
              <div className="muted small">
                محصّل: {data?.summary.totalCollectedCashSar ?? '0.00'} · آجل: {data?.summary.totalCreditReceivablesSar ?? '0.00'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div>
                <h2 style={{ margin: 0 }}>👨‍✈️ ملخص رقابة المناديب والعهد والربحية والعجز المخصوم من الراتب</h2>
                <p className="muted small" style={{ margin: 0 }}>
                  مقارنة شاملة لكل مندوب: المستلم، المباع، البونص، التالف، العجز المحسوب على المندوب، التحصيل، المديونيات، وصافي الربح.
                </p>
              </div>
              <button type="button" className="btn sm primary" onClick={() => setTab('loads')}>
                ➕ تحميل عهدة / إغلاق وردية
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>المندوب</th>
                    <th>المستلم (كجم)</th>
                    <th>المباع (كجم)</th>
                    <th>البونص (كجم)</th>
                    <th>مرتجع سليم</th>
                    <th>تالف مفحوص</th>
                    <th>عجز على المندوب</th>
                    <th>خصم الراتب (SAR)</th>
                    <th>العهدة المتبقية</th>
                    <th>المبيعات (SAR)</th>
                    <th>المحصّل</th>
                    <th>مديونية العملاء</th>
                    <th>صافي الربح</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.repPerformance ?? []).map((rep) => (
                    <tr key={rep.salesmanId}>
                      <td>
                        <strong>{rep.salesmanName}</strong>
                        {rep.pendingClosings > 0 && (
                          <div>
                            <span className="badge warn">إغلاق معلق ({rep.pendingClosings})</span>
                          </div>
                        )}
                      </td>
                      <td dir="ltr">{rep.loadedKg}</td>
                      <td dir="ltr" style={{ color: 'var(--ok)', fontWeight: 700 }}>{rep.soldKg}</td>
                      <td dir="ltr" style={{ color: 'var(--warn)' }}>{rep.bonusKg}</td>
                      <td dir="ltr">{rep.returnedKg}</td>
                      <td dir="ltr">{rep.damagedKg}</td>
                      <td dir="ltr" style={{ color: Number(rep.shortageKg) > 0 ? 'var(--danger)' : undefined, fontWeight: 700 }}>
                        {rep.shortageKg} kg
                      </td>
                      <td dir="ltr" style={{ color: Number(rep.shortageSar) > 0 ? 'var(--danger)' : undefined, fontWeight: 700 }}>
                        {rep.shortageSar} SAR
                      </td>
                      <td dir="ltr">
                        <span className={`badge ${Number(rep.custodyRemainingKg) === 0 ? 'ok' : 'warn'}`}>
                          {rep.custodyRemainingKg} kg
                        </span>
                      </td>
                      <td dir="ltr"><strong>{rep.revenueSar}</strong></td>
                      <td dir="ltr">{rep.collectedSar}</td>
                      <td dir="ltr" style={{ color: Number(rep.creditDebtSar) > 0 ? 'var(--warn)' : undefined }}>
                        {rep.creditDebtSar}
                      </td>
                      <td dir="ltr" style={{ color: 'var(--ok)', fontWeight: 700 }}>{rep.netProfitSar} SAR</td>
                    </tr>
                  ))}
                  {(data?.repPerformance ?? []).length === 0 && (
                    <tr>
                      <td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 18 }}>
                        لا توجد حركات مناديب بعد — ابدأ بتسجيل دفعة إنتاج أو أمر تحميل للمندوب.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: FACTORY PRODUCTION & GOODS MOVEMENT LEDGER (Pillar 1 & 6) */}
      {tab === 'production' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <form className="card" onSubmit={submitProductionBatch} style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ margin: 0 }}>🏭 تسجيل دفعة إنتاج يومي للمصنع والمخبز وتوريدها للمستودع الرئيسي</h2>
            <p className="muted small" style={{ margin: 0 }}>
              تُقيَّد الكمية المنتجة في <b>الرصيد الرسمي للمستودع</b> برقم دفعة فريد (نفس الأرصدة التي تظهر في شاشة
              المخزون وبطاقة الصنف)، ولا يستطيع أي مندوب بيع كمية إلا بعد صرفها رسمياً من هذه الدفعات.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>الصنف المنتج من الأصناف المسجلة *</span>
                <select
                  className="input"
                  required
                  value={prodItemId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setProdItemId(nextId);
                    const picked = items.find((it) => it.id === nextId);
                    if (picked) {
                      setProdItemName(itemLabel(picked));
                      /** تكلفة الصنف من بطاقته — لا رقم مخترع في الكود. */
                      const purchasePrice = (picked as { purchasePrice?: string | null }).purchasePrice;
                      if (!prodUnitCost && purchasePrice) setProdUnitCost(purchasePrice);
                    }
                  }}
                >
                  <option value="">— اختر الصنف —</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {itemLabel(it)}
                    </option>
                  ))}
                </select>
                <span className="muted small">
                  لا يمكن تسجيل إنتاج لصنف غير مسجل: الرصيد الرسمي يُحتسب بالصنف والمستودع.
                </span>
              </label>
              <label className="field">
                <span>المستودع الرئيسي المُورَّد إليه *</span>
                <select
                  className="input"
                  value={prodWarehouseId}
                  onChange={(e) => setProdWarehouseId(e.target.value)}
                >
                  {warehouses.map((wh) => (
                    <option key={wh.id} value={wh.id}>
                      {wh.name ?? wh.nameAr ?? wh.code}
                      {wh.isDefault ? ' (افتراضي)' : ''}
                    </option>
                  ))}
                </select>
                <span className="muted small">
                  يُختار المستودع الافتراضي تلقائيًا إن تُرك فارغًا — ولن تُسجَّل الدفعة بلا مستودع.
                </span>
              </label>
              <label className="field">
                <span>تاريخ الإنتاج</span>
                <input
                  className="input"
                  type="date"
                  dir="ltr"
                  value={prodDate}
                  onChange={(e) => setProdDate(e.target.value)}
                />
              </label>
              <label className="field">
                <span>الكمية المنتجة الصالحة (كجم) *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  value={prodQty}
                  onChange={(e) => setProdQty(e.target.value)}
                />
                <span className="muted small">هذه الكمية هي التي تدخل الرصيد الرسمي وتُتاح للبيع.</span>
              </label>
              <label className="field">
                <span>فاقد التصنيع / الهالك (كجم)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  dir="ltr"
                  value={prodScrapQty}
                  onChange={(e) => setProdScrapQty(e.target.value)}
                />
                <span className="muted small">
                  يُسجَّل في حركة مستقلة ولا يدخل الرصيد الصالح للبيع، وتُحسب قيمته منفصلة عن
                  تكلفة المنتج الجيد.
                </span>
              </label>
              <label className="field">
                <span>سبب الفاقد {Number(prodScrapQty) > 0 ? '*' : ''}</span>
                <input
                  className="input"
                  required={Number(prodScrapQty) > 0}
                  value={prodScrapReason}
                  onChange={(e) => setProdScrapReason(e.target.value)}
                  placeholder="مثال: عجين لم يختمر / قطع محترقة في الفرن الثاني"
                />
                <span className="muted small">
                  لا يُرحَّل فاقد بلا سبب: الكمية والسبب والدفعة تُسجَّل معاً حتى يمكن مراجعته.
                </span>
              </label>
              <label className="field">
                <span>تكلفة إنتاج الكيلو (ريال)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={prodUnitCost}
                  onChange={(e) => setProdUnitCost(e.target.value)}
                />
                <span className="muted small">
                  تُقرأ من بطاقة الصنف (سعر الشراء) أو من أمر التصنيع إن وُجد — اتركها فارغة لاستخدام تكلفة الصنف.
                </span>
              </label>
              <label className="field">
                <span>مشرف الإنتاج / أمين المستودع</span>
                <input
                  className="input"
                  value={prodSupervisor}
                  onChange={(e) => setProdSupervisor(e.target.value)}
                />
              </label>
            </div>
            <div>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'جارٍ الحفظ…' : '➕ اعتماد دفعة الإنتاج وتوريدها للمستودع الرئيسي'}
              </button>
            </div>
          </form>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>📦 دفعات الإنتاج وأرصدة المستودع الرئيسي</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>رقم دفعة الإنتاج</th>
                    <th>التاريخ</th>
                    <th>الصنف</th>
                    <th>الكمية المنتجة</th>
                    <th>المصروف للمناديب</th>
                    <th>المرتجع السليم</th>
                    <th>التالف المعتمد</th>
                    <th>الرصيد المتاح بالمستودع</th>
                    <th>تكلفة الكيلو</th>
                    <th>إجمالي تكلفة الدفعة</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.productionBatches ?? []).map((b) => (
                    <tr key={b.id}>
                      <td dir="ltr"><strong>{b.batchNo}</strong></td>
                      <td dir="ltr">{b.productionDate}</td>
                      <td>{b.itemName}</td>
                      <td dir="ltr"><strong>{b.producedQty} kg</strong></td>
                      <td dir="ltr">{b.issuedQty} kg</td>
                      <td dir="ltr" style={{ color: 'var(--ok)' }}>{b.returnedGoodQty} kg</td>
                      <td dir="ltr" style={{ color: 'var(--danger)' }}>{b.damagedQty} kg</td>
                      <td dir="ltr">
                        <span className="badge ok">{b.availableWarehouseQty} kg</span>
                      </td>
                      <td dir="ltr">
                        {b.unitCost} SAR
                        <div className="muted small">
                          {b.costBasis === 'manufacturing_order'
                            ? '✅ تكلفة فعلية من أمر تصنيع رسمي'
                            : '⚠️ تكلفة مدخلة أو من بطاقة الصنف — ليست تكلفة أمر تصنيع'}
                        </div>
                        {Number(b.scrapQty ?? 0) > 0 ? (
                          <div
                            className="muted small"
                            style={{ color: b.scrapCostLoaded ? undefined : 'var(--warn)' }}
                          >
                            🗑️ فاقد {b.scrapQty} كجم بقيمة {b.scrapValue} SAR —{' '}
                            {b.scrapCostLoaded
                              ? 'محمّلة على تكلفة المنتج الجيد'
                              : 'غير محمّلة على المنتج الجيد (لا يدعمها محرك التصنيع الرسمي)'}
                          </div>
                        ) : null}
                      </td>
                      <td dir="ltr"><strong>{b.totalCost} SAR</strong></td>
                    </tr>
                  ))}
                  {(data?.productionBatches ?? []).length === 0 && (
                    <tr>
                      <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                        لم يتم تسجيل دفعة إنتاج بعد.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>🔍 سجل الرقابة على حركة البضاعة والتدقيق (من نفذ العملية ومن اعتمدها)</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الوقت</th>
                    <th>نوع الحركة</th>
                    <th>دفعة الإنتاج</th>
                    <th>المندوب</th>
                    <th>العميل</th>
                    <th>الكمية (كجم)</th>
                    <th>المبلغ (SAR)</th>
                    <th>البيان والسبب</th>
                    <th>منفّذ العملية</th>
                    <th>المعتمد</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.movements ?? []).map((m) => (
                    <tr key={m.id}>
                      <td dir="ltr" className="small">{new Date(m.createdAt).toLocaleString('ar-SA')}</td>
                      <td><strong>{MOVEMENT_TYPE_AR[m.movementType] ?? m.movementType}</strong></td>
                      <td dir="ltr">{m.batchNo || '—'}</td>
                      <td>{m.salesmanName}</td>
                      <td>{m.customerName}</td>
                      <td dir="ltr">{m.qty} kg</td>
                      <td dir="ltr">{m.amount} SAR</td>
                      <td>{m.reason}</td>
                      <td>{m.actorLabel}</td>
                      <td>{m.approvedByLabel || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: DISTRIBUTION REPS — the official `salesmen` card, its employee, its login, its van */}
      {tab === 'reps' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>🧑‍💼 مندوبو التوزيع — البطاقة والموظف وحساب الدخول ومستودع السيارة</h2>
            <p className="muted small" style={{ margin: 0 }}>
              لا يوجد جدول مندوبين منفصل: هذه هي بطاقة المندوب الرسمية نفسها (<code>salesmen</code>) مربوطة ببطاقة
              الموظف (<code>employees</code>) وحساب الدخول (<code>memberships</code> ← <code>users</code>) ومستودع سيارة
              التوزيع. إنشاء المندوب نفسه وتعديل عمولاته من شاشة{' '}
              <a href="/sales/salesmen">المبيعات ← المندوبين</a>، وهنا يُستكمل ربط التوزيع.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>المندوب</th>
                    <th>الموظف المرتبط</th>
                    <th>حساب الدخول</th>
                    <th>مستودع السيارة / اللوحة</th>
                    <th align="left">العهدة الحالية</th>
                    <th align="left">نقد مستحق</th>
                    <th>الحالة والجهوزية</th>
                    <th>إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {vanSalesmen.map((rep) => (
                    <tr key={rep.id}>
                      <td>
                        <b>{rep.name}</b>
                        {!rep.active ? <span className="muted small"> (موقوف)</span> : null}
                        {rep.mobile ? <div className="muted small" dir="ltr">{rep.mobile}</div> : null}
                      </td>
                      <td>
                        {rep.employeeName ? (
                          <>
                            {rep.employeeName}
                            <div className="muted small" dir="ltr">{rep.employeeNo}</div>
                          </>
                        ) : (
                          <span className="muted small">❌ بلا بطاقة موظف</span>
                        )}
                      </td>
                      <td>
                        {rep.userEmail ? (
                          <>
                            <span dir="ltr">{rep.userEmail}</span>
                            <div className="muted small">
                              {rep.membershipStatus === 'active' ? '✅ فعّال' : `⏳ ${rep.membershipStatus ?? 'مدعو'}`}
                              {rep.roleCount ? ` · ${rep.roleCount} دور` : ''}
                            </div>
                          </>
                        ) : (
                          <span className="muted small">❌ بلا حساب دخول</span>
                        )}
                      </td>
                      <td>
                        {rep.warehouseName ? (
                          <>
                            {rep.warehouseName}
                            <div className="muted small" dir="ltr">{rep.warehouseCode}</div>
                            {rep.vehiclePlate ? <div className="muted small">🚐 {rep.vehiclePlate}</div> : null}
                          </>
                        ) : (
                          <span className="muted small">❌ بلا مستودع سيارة</span>
                        )}
                      </td>
                      <td align="left" dir="ltr">
                        {rep.custody.custodyQty} kg
                        <div className="muted small">
                          {rep.custody.openLoadOrders} أمر · {rep.custody.pendingReceipts} بانتظار الاستلام
                        </div>
                      </td>
                      <td align="left" dir="ltr">{rep.custody.outstandingCash}</td>
                      <td>
                        <div className="muted small">
                          {rep.readiness.hasEmployee ? '✅' : '❌'} موظف ·{' '}
                          {rep.readiness.hasLoginAccount ? '✅' : '❌'} حساب دخول ·{' '}
                          {rep.readiness.hasVanWarehouse ? '✅' : '❌'} مستودع ·{' '}
                          {rep.readiness.hasVanSalesPermissions ? '✅' : '❌'} صلاحيات توزيع
                        </div>
                        {rep.custody.items.length ? (
                          <div className="muted small">
                            {rep.custody.items
                              .map((row) => `${row.itemName}: ${row.quantity}`)
                              .join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => {
                              setRepTarget(rep);
                              setRepEmail(rep.userEmail ?? rep.email ?? '');
                              setRepFullName(rep.employeeName ?? rep.name);
                            }}
                          >
                            🔗 {rep.membershipId ? 'إعادة ربط الحساب' : 'ربط حساب دخول'}
                          </button>
                          <a className="btn sm" href="/sales/salesmen">
                            🧑‍💼 بطاقة المندوب
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {vanSalesmen.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="muted">
                        لا يوجد مندوبون — أنشئ بطاقة المندوب من شاشة المبيعات ← المندوبين ثم اربطها هنا.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {repTarget ? (
            <form className="card" onSubmit={linkRepAccount} style={{ display: 'grid', gap: 12 }}>
              <h2 style={{ margin: 0 }}>🔗 ربط المندوب ({repTarget.name}) بحساب دخول رسمي</h2>
              <p className="muted small" style={{ margin: 0 }}>
                يُنشئ النظام مستخدمًا وعضوية عبر مسار الدعوة الرسمي نفسه المستعمل لبقية الموظفين، ويضعها على دور
                «مندوب توزيع» بصلاحيات: رؤية عهدته، إصدار فواتيره، تسجيل تحصيلاته، وتقديم إغلاق ورديته. كلمة المرور لا
                تُخترَع هنا — يصل المندوب رابط التفعيل الرسمي.
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>البريد الإلكتروني لحساب المندوب *</span>
                  <input
                    className="input"
                    type="email"
                    required
                    dir="ltr"
                    value={repEmail}
                    onChange={(e) => setRepEmail(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>الاسم الظاهر</span>
                  <input
                    className="input"
                    value={repFullName}
                    onChange={(e) => setRepFullName(e.target.value)}
                  />
                </label>
              </div>
              <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={repScopeToVan}
                  onChange={(e) => setRepScopeToVan(e.target.checked)}
                />
                <span>
                  🔒 قصر صلاحية الحساب على مستودع سيارة هذا المندوب فقط (يمنعه من قراءة عهدة مندوب آخر)
                </span>
              </label>
              {!repTarget.readiness.hasEmployee ? (
                <div className="muted small" style={{ color: 'var(--warn)' }}>
                  ⚠️ هذه البطاقة غير مربوطة ببطاقة موظف — اربطها أولًا من شاشة المبيعات ← المندوبين حتى تُنسب سندات
                  القبض والإغلاقات إلى الموظف نفسه.
                </div>
              ) : null}
              <div className="row" style={{ gap: 8 }}>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? 'جارٍ الربط…' : '🔗 إنشاء / ربط حساب الدخول'}
                </button>
                <button type="button" className="btn" onClick={() => setRepTarget(null)}>
                  إلغاء
                </button>
              </div>
            </form>
          ) : null}
        </div>
      )}

      {/* TAB 4: SUPPLY TO VANS, CUSTODY & END-OF-DAY SHIFT CLOSING (Pillar 2 & 7) */}
      {tab === 'loads' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <form className="card" onSubmit={submitLoadOrder} style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ margin: 0 }}>🚚 توريد المنتجات من المستودع الرئيسي إلى سيارة المندوب</h2>
            <p className="muted small" style={{ margin: 0 }}>
              يُنشئ النظام <b>مناولة مخزنية رسمية</b> (تحويل بين مستودعين) فتخرج الكمية من رصيد المستودع الرئيسي إلى
              «بضاعة تحت التحويل»، وتبقى هناك حتى <b>يؤكّد المندوب الاستلام</b> — عندها فقط تدخل رصيد سيارة المندوب
              وتصبح عهدة قابلة للبيع. لا تُخصم الكمية مرتين ولا تظهر في العهدة قبل الاستلام.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>المندوب *</span>
                <select
                  className="input"
                  required
                  value={loadSalesmanId}
                  onChange={(e) => setLoadSalesmanId(e.target.value)}
                >
                  <option value="">— اختر المندوب —</option>
                  {salesmen.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>المستودع الرئيسي (مصدر التوريد) *</span>
                <select
                  className="input"
                  value={loadWarehouseId}
                  onChange={(e) => setLoadWarehouseId(e.target.value)}
                >
                  {warehouses.map((wh) => (
                    <option key={wh.id} value={wh.id}>
                      {wh.name ?? wh.nameAr ?? wh.code}
                      {wh.isDefault ? ' (افتراضي)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>مستودع سيارة المندوب (الوجهة) *</span>
                <select
                  className="input"
                  value={loadVanWarehouseId}
                  onChange={(e) => setLoadVanWarehouseId(e.target.value)}
                >
                  <option value="">— مستودع المندوب المُسند في بطاقته —</option>
                  {warehouses
                    .filter((wh) => wh.id !== loadWarehouseId)
                    .map((wh) => (
                      <option key={wh.id} value={wh.id}>
                        {wh.name ?? wh.nameAr ?? wh.code}
                      </option>
                    ))}
                </select>
                <span className="muted small">
                  يُستخدم مستودع السيارة المُسند للمندوب في بطاقته إن تُرك فارغًا — ويجب أن يختلف عن مستودع المصدر.
                </span>
              </label>
              <label className="field">
                <span>رقم دفعة الإنتاج (Batch No)</span>
                <input
                  className="input"
                  dir="ltr"
                  value={productionBatchNo}
                  onChange={(e) => setProductionBatchNo(e.target.value)}
                  placeholder="تلقائي: PROD-YYYYMMDD-XXX"
                />
              </label>
              <label className="field">
                <span>رقم لوحة السيارة</span>
                <input
                  className="input"
                  value={vehiclePlate}
                  onChange={(e) => setVehiclePlate(e.target.value)}
                />
              </label>
              <label className="field">
                <span>الكمية المستلمة كعهدة (كجم) *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  value={loadedQty}
                  onChange={(e) => setLoadedQty(e.target.value)}
                />
              </label>
              <label className="field">
                <span>سقف البونص المسموح في الرحلة (كجم)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={maxBonusQty}
                  onChange={(e) => setMaxBonusQty(e.target.value)}
                />
              </label>
              <label className="field">
                <span>الصنف (اختياري)</span>
                <select className="input" value={loadItemId} onChange={(e) => setLoadItemId(e.target.value)}>
                  <option value="">رقائق سمبوسة وفطائر (عام)</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>{it.nameAr}</option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'جارٍ الإصدار…' : '➕ اعتماد أمر التحميل وتسليم العهدة للمندوب'}
              </button>
            </div>
          </form>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>📋 سجل عهد المناديب وإغلاق الورديات واعتماد المحاسب</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>رقم الأمر</th>
                    <th>المندوب</th>
                    <th>دفعة الإنتاج</th>
                    <th>المصروف من المستودع</th>
                    <th>أكّد المندوب استلامه</th>
                    <th>المباع</th>
                    <th>البونص</th>
                    <th>مرتجع سليم</th>
                    <th>تالف للفحص</th>
                    <th>العجز على المندوب</th>
                    <th>المتبقي (متوقع / جرد فعلي)</th>
                    <th>النقد المتوقع / المسلم</th>
                    <th>الحالة</th>
                    <th>إجراء الإغلاق والاعتماد</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.loadOrders ?? []).map((l) => (
                    <tr key={l.id}>
                      <td dir="ltr"><strong>{l.number}</strong></td>
                      <td><strong>{l.salesmanName}</strong></td>
                      <td dir="ltr">{l.productionBatchNo}</td>
                      <td dir="ltr"><strong>{l.loadedQty} kg</strong></td>
                      <td dir="ltr">
                        {l.awaitingReceipt ? (
                          <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="badge warn">⏳ {l.loadedQty} kg</span>
                            <button
                              type="button"
                              className="btn sm primary"
                              disabled={busy}
                              onClick={() => void confirmLoadReceipt(l.id, l.loadedQty)}
                            >
                              ✅ تأكيد الاستلام نيابةً عن المندوب
                            </button>
                          </div>
                        ) : (
                          <>
                            <strong>{l.receivedQty ?? '0.00'} kg</strong>
                            {Number(l.discrepancyQty ?? 0) > 0 ? (
                              <div className="muted small" style={{ color: 'var(--danger)' }}>
                                فرق {l.discrepancyQty} kg{l.discrepancyNotes ? ` — ${l.discrepancyNotes}` : ''}
                              </div>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td dir="ltr" style={{ color: 'var(--ok)', fontWeight: 700 }}>{l.soldQty} kg</td>
                      <td dir="ltr" style={{ color: 'var(--warn)' }}>{l.bonusQty} kg</td>
                      <td dir="ltr">{l.returnedQty} kg</td>
                      <td dir="ltr" style={{ color: Number(l.damagedQty) > 0 ? 'var(--warn)' : undefined }}>
                        {l.damagedQty} kg
                        {l.damageInspected && Number(l.damagedQty) > 0 ? ' (✔ مفحوص)' : ''}
                      </td>
                      <td dir="ltr" style={{ color: Number(l.shortageQty) > 0 ? 'var(--danger)' : undefined, fontWeight: 700 }}>
                        {l.shortageQty} kg
                        {Number(l.shortageValue) > 0 ? ` (${l.shortageValue} SAR)` : ''}
                      </td>
                      <td dir="ltr">
                        <strong>{l.remainingQty} kg</strong>
                        <div className="muted small">
                          متوقع {l.expectedRemainingQty ?? '0.00'} / جرد {l.actualRemainingQty ?? '0.00'}
                        </div>
                        {Number(l.countVarianceQty ?? 0) !== 0 ? (
                          <div
                            className="muted small"
                            style={{ color: Number(l.countVarianceQty ?? 0) > 0 ? 'var(--danger)' : 'var(--ok)' }}
                          >
                            {Number(l.countVarianceQty ?? 0) > 0
                              ? `عجز جرد ${l.countVarianceQty} kg`
                              : `فائض جرد ${Math.abs(Number(l.countVarianceQty ?? 0)).toFixed(2)} kg`}
                            {l.countVarianceCostValue
                              ? ` ≈ ${l.countVarianceCostValue} ريال على أساس التكلفة`
                              : ''}
                            {l.countDocumentVarianceValue
                              ? ` (مستند الجرد الرسمي: ${l.countDocumentVarianceValue} ريال)`
                              : ' (مستند الجرد لم يُرحَّل بعد)'}
                            <br />
                            قيمة تسوية مخزنية — <b>ليست ديناً على المندوب</b>: المسؤولية المالية تبقى
                            معلّقة حتى تعتمد السياسة.
                          </div>
                        ) : null}
                      </td>
                      <td dir="ltr">{l.expectedCash} / {l.collectedCash} SAR</td>
                      <td>
                        <span
                          className={`badge ${
                            l.status === 'settled' || l.status === 'reconciled'
                              ? 'ok'
                              : l.status === 'pending_closing' || l.status === 'pending_stock_settlement'
                                ? 'warn'
                                : l.status === 'rejected' || l.status === 'canceled'
                                  ? 'neutral'
                                  : 'neutral'
                          }`}
                        >
                          {LOAD_STATUS_AR[l.status] ?? l.status}
                        </span>
                        {l.stockSettlementStatus && l.stockSettlementStatus !== 'not_required' ? (
                          <div
                            className="muted small"
                            style={{
                              color:
                                l.awaitingStockSettlement || l.awaitingTransitDecision
                                  ? 'var(--danger)'
                                  : undefined,
                            }}
                          >
                            {SETTLEMENT_STATUS_AR[l.stockSettlementStatus] ?? l.stockSettlementStatus}
                            {l.remainingAction
                              ? ` · المتبقي: ${
                                  l.remainingAction === 'return_to_main'
                                    ? 'إرجاع للمستودع الرئيسي'
                                    : 'عهدة الوردية التالية'
                                }`
                              : ''}
                            {l.stockSettlementNote ? ` — ${l.stockSettlementNote}` : ''}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {l.awaitingStockSettlement ? (
                            <>
                              <button
                                type="button"
                                className="btn sm primary"
                                disabled={busy}
                                onClick={() => void handleSettleLoadOrderStock(l, true)}
                              >
                                ♻️ استكمال تسوية المخزون وترحيل مستند الجرد
                              </button>
                              <button
                                type="button"
                                className="btn sm"
                                disabled={busy}
                                onClick={() => openClosingModal(l)}
                              >
                                🔍 مراجعة الأرقام
                              </button>
                            </>
                          ) : l.status !== 'settled' && l.status !== 'reconciled' ? (
                            <button
                              type="button"
                              className={`btn sm ${l.status === 'pending_closing' ? 'primary' : ''}`}
                              disabled={l.status === 'rejected' || l.status === 'canceled'}
                              onClick={() => openClosingModal(l)}
                            >
                              {l.status === 'pending_closing'
                                ? '🔍 مراجعة واعتماد المحاسب'
                                : '🔒 إغلاق الوردية وتصفية العهدة'}
                            </button>
                          ) : (
                            <span className="muted small">
                              معتمد ومسوّى {l.approvedByLabel ? `بواسطة ${l.approvedByLabel}` : ''}
                            </span>
                          )}

                          {/* 🚦 فرق استلام بلا قرار — the quantity is still officially in transit */}
                          {l.awaitingTransitDecision ? (
                            <>
                              <button
                                type="button"
                                className="btn sm"
                                disabled={busy}
                                onClick={() => void handleCloseTransitDifference(l, 'return')}
                              >
                                ↩️ إرجاع الفرق إلى المصدر
                              </button>
                              <button
                                type="button"
                                className="btn sm"
                                disabled={busy}
                                onClick={() => void handleCloseTransitDifference(l, 'shortage')}
                              >
                                ⚠️ اعتباره عجز تحويل
                              </button>
                            </>
                          ) : null}

                          {/* 🗑️ إلغاء توريد لم يُستلَم بعد */}
                          {l.status === 'pending_receipt' ? (
                            <button
                              type="button"
                              className="btn sm"
                              disabled={busy}
                              onClick={() => void handleCancelLoadOrder(l)}
                            >
                              🗑️ إلغاء التوريد
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Shift Closing & Accountant Approval Modal */}
          {closingTarget && (
            <div
              role="dialog"
              aria-modal="true"
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.6)',
                display: 'grid',
                placeItems: 'center',
                zIndex: 80,
                padding: 16,
              }}
            >
              <div className="card" style={{ width: '100%', maxWidth: 680, display: 'grid', gap: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ margin: 0 }}>
                    🔒 إغلاق وردية المندوب ({closingTarget.salesmanName}) — أمر رقم {closingTarget.number}
                  </h2>
                  <button type="button" className="btn sm" onClick={() => setClosingTarget(null)}>✕</button>
                </div>

                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--surface-2)',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: 8,
                    textAlign: 'center',
                  }}
                >
                  <div>
                    <div className="muted small">1. الكمية المستلمة</div>
                    <strong dir="ltr">{modalLoaded.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">2. المباع الفعلي</div>
                    <strong style={{ color: 'var(--ok)' }} dir="ltr">{modalSold.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">3. البونص المجاني</div>
                    <strong style={{ color: 'var(--warn)' }} dir="ltr">{modalBonus.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">4. المرتجع السليم</div>
                    <strong dir="ltr">{modalReturned.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">5. التالف (للفحص)</div>
                    <strong style={{ color: 'var(--warn)' }} dir="ltr">{modalDamaged.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">6. المتبقي المتوقع</div>
                    <strong dir="ltr">{modalExpectedRemaining.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">7. المتبقي الفعلي بالجرد</div>
                    <strong dir="ltr">{modalActualRemaining.toFixed(2)} kg</strong>
                  </div>
                  <div>
                    <div className="muted small">8. العجز على المندوب</div>
                    <strong style={{ color: 'var(--danger)', fontSize: 16 }} dir="ltr">
                      {modalShortageKg.toFixed(2)} kg ({modalShortageSar.toFixed(2)} SAR)
                    </strong>
                  </div>
                </div>

                <div className="form-grid">
                  <label className="field">
                    <span>الكمية المرتجعة السليمة للمستودع (كجم)</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      dir="ltr"
                      value={closingReturnedQty}
                      onChange={(e) => setClosingReturnedQty(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>الكمية التالفة الخاضعة للفحص الفعلي (كجم)</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      dir="ltr"
                      value={closingDamagedQty}
                      onChange={(e) => setClosingDamagedQty(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>المتبقي الفعلي بالجرد في السيارة (كجم)</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      dir="ltr"
                      value={closingActualRemaining}
                      onChange={(e) => setClosingActualRemaining(e.target.value)}
                    />
                    <span className="muted small">
                      المتوقع {modalExpectedRemaining.toFixed(2)} كجم —
                      {modalSurplusKg > 0
                        ? ` يوجد فائض ${modalSurplusKg.toFixed(2)} كجم عن المستندات يجب تفسيره.`
                        : modalShortageKg > 0
                          ? ` الفرق ${modalShortageKg.toFixed(2)} كجم عجز يُحال للمحاسب.`
                          : ' لا فرق بين الجرد والمستندات.'}
                    </span>
                  </label>
                  <label className="field">
                    <span>النقد المسلم فعلياً للصندوق (ريال)</span>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      dir="ltr"
                      value={closingCollectedCash}
                      onChange={(e) => setClosingCollectedCash(e.target.value)}
                    />
                  </label>
                </div>

                <label className="field">
                  <span>سبب التلف وتفاصيل الفحص (إلزامي عند وجود تالف)</span>
                  <input
                    className="input"
                    value={closingDamageReason}
                    onChange={(e) => setClosingDamageReason(e.target.value)}
                    placeholder="مثال: تلف أثناء النقل ويحتاج فحص فعلي من أمين المستودع والمحاسب"
                  />
                </label>

                <div
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <strong>✅ ضوابط اعتماد المحاسب النهائي:</strong>
                  <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={closingDamageInspected}
                      onChange={(e) => setClosingDamageInspected(e.target.checked)}
                    />
                    <span>أقرّ بأن الكمية التالفة ({modalDamaged.toFixed(2)} كجم) تم فحصها فعلياً واستلامها.</span>
                  </label>
                  <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={closingSalaryDeduction}
                      onChange={(e) => setClosingSalaryDeduction(e.target.checked)}
                    />
                    <span>
                      إقرار بمراجعة العجز ({modalShortageKg.toFixed(2)} كجم ≈ {modalShortageSar.toFixed(2)} ريال) وسببه، وتصفير رصيد عهدة المندوب إلى (0.00 كجم).
                      <br />
                      <span className="muted small">
                        ⚠️ لا يُنشئ هذا الإقرار أي قيد على راتب المندوب أو ذمته: المعالجة المالية للعجز
                        (أساس التقييم والحساب المقابل) معلّقة حتى تعتمد السياسة من الإعدادات، ويُكتفى
                        بتسجيل الحالة «بانتظار اعتماد السياسة».
                      </span>
                    </span>
                  </label>
                </div>

                <div
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <strong>🧾 تسوية المخزون الرسمية (بدونها لا تُغلق العهدة):</strong>

                  {modalActualRemaining > 0 ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span className="muted small">
                        مصير المتبقي الفعلي ({modalActualRemaining.toFixed(2)} كجم) — قرار صريح، لا يُفتَرَض:
                      </span>
                      <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <input
                          type="radio"
                          name="closing-remaining-action"
                          checked={closingRemainingAction === 'return_to_main'}
                          onChange={() => setClosingRemainingAction('return_to_main')}
                        />
                        <span>
                          ↩️ إرجاعه رسمياً إلى المستودع الرئيسي (حركة مخزنية رسمية وقيد من ملف الترحيل، ورصيد
                          السيارة يصبح صفراً)
                        </span>
                      </label>
                      <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <input
                          type="radio"
                          name="closing-remaining-action"
                          checked={closingRemainingAction === 'carry_over'}
                          onChange={() => setClosingRemainingAction('carry_over')}
                        />
                        <span>
                          🔄 إبقاؤه عهدة المندوب للوردية التالية (يبقى في رصيد السيارة الرسمي بنفس الكمية
                          المجرودة)
                        </span>
                      </label>
                    </div>
                  ) : (
                    <div className="muted small">الجرد الفعلي صفر — لا متبقي يحتاج قراراً.</div>
                  )}

                  {modalSurplusKg > 0 ? (
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={closingSurplusAck}
                        onChange={(e) => setClosingSurplusAck(e.target.checked)}
                      />
                      <span>
                        ⚖️ أقرّ بأن الجرد الفعلي أكبر من العهدة بفائض {modalSurplusKg.toFixed(2)} كجم، ويُسجَّل
                        في مستند الجرد الرسمي (Dr المخزون / Cr تسوية الجرد) — لا إيراداً ولا هديةً ولا تعديلاً
                        على المستندات.
                      </span>
                    </label>
                  ) : null}

                  <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={closingSettleStock}
                      onChange={(e) => setClosingSettleStock(e.target.checked)}
                    />
                    <span>
                      🖋️ فوّضني بترحيل مستند الجرد الرسمي الآن، فيصبح رصيد السيارة الرسمي مساوياً للجرد الفعلي
                      ({modalActualRemaining.toFixed(2)} كجم).
                      <br />
                      <span className="muted small">
                        ⚠️ بدون هذا التفويض يُنشأ مستند الجرد <b>مسودةً</b> وتبقى الوردية «بانتظار تسوية
                        المخزون» ولا تُغلق العهدة — وهذا هو المقصود: لا تُغلق عهدة مع بقاء فرق في دفتر المخزون.
                        المسؤولية المالية عن العجز تبقى معلّقة في الحالتين.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void handleSubmitPendingClosing()}
                  >
                    📤 1. حفظ وتقديم كطلب إغلاق معلق للمحاسب
                  </button>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="btn" onClick={() => setClosingTarget(null)}>
                      إلغاء
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={
                        busy ||
                        (modalActualRemaining > 0 && !closingRemainingAction) ||
                        (modalSurplusKg > 0 && !closingSurplusAck)
                      }
                      onClick={() => void handleAccountantApproveClosing()}
                    >
                      {closingSettleStock
                        ? '✅ 2. اعتماد المحاسب وتسوية المخزون رسمياً'
                        : '✅ 2. اعتماد الكميات (العهدة تبقى بانتظار تسوية المخزون)'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: VAN INVOICING (ZATCA TAX vs INTERNAL DELIVERY) & COLLECTION (Pillar 3, 4, 5, 8) */}
      {tab === 'invoice' && (
        <div className="split">
          <form className="card" onSubmit={submitVanDocument} style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ margin: 0 }}>🧾 إصدار فاتورة توزيع (ضريبية ZATCA أو عادية)</h2>
            <p className="muted small" style={{ margin: 0 }}>
              السعر يُجلب ويُثبّت تلقائياً حسب العميل، وتُخصم الكمية مباشرة من عهدة المندوب، مع دعم الفاتورة الضريبية (15% VAT + QR) أو فاتورة تسليم عادية للمحلات التي لا تطلب فاتورة ضريبية ورقية.
            </p>

            <div className="form-grid">
              <label className="field">
                <span>أمر التحميل / عهدة المندوب *</span>
                <select
                  className="input"
                  required
                  value={docLoadOrderId}
                  onChange={(e) => setDocLoadOrderId(e.target.value)}
                >
                  <option value="">— اختر عهدة المندوب —</option>
                  {(data?.loadOrders ?? [])
                    .filter((l) => l.status !== 'settled')
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.number} · {l.salesmanName} (متبقي: {l.remainingQty} كجم — دفعة {l.productionBatchNo})
                      </option>
                    ))}
                </select>
              </label>

              <label className="field">
                <span>العميل (اختياري لمحلات التجزئة)</span>
                <select className="input" value={docPartyId} onChange={(e) => onSelectCustomer(e.target.value)}>
                  <option value="">— محل تجزئة نقدي / عام —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>

              {!docPartyId && (
                <label className="field">
                  <span>اسم المحل / العميل</span>
                  <input
                    className="input"
                    value={docWalkinName}
                    onChange={(e) => setDocWalkinName(e.target.value)}
                    placeholder="مثال: بوفية البركة"
                  />
                </label>
              )}

              <label className="field">
                <span>نوع المستند (متوافق مع ZATCA) *</span>
                <select
                  className="input"
                  value={docMode}
                  onChange={(e) => setDocMode(e.target.value as 'zatca_tax' | 'internal_delivery')}
                >
                  <option value="zatca_tax">فاتورة ضريبية إلكترونية ZATCA (15% VAT + QR)</option>
                  <option value="internal_delivery">فاتورة توزيع عادية (لمحل لا يطلب ضريبية ورقية)</option>
                </select>
              </label>

              <label className="field">
                <span>طريقة الدفع</span>
                <select
                  className="input"
                  value={docPayment}
                  onChange={(e) => setDocPayment(e.target.value as 'cash' | 'card' | 'credit')}
                >
                  <option value="cash">نقدي (Cash)</option>
                  <option value="card">شبكة مدى / تحويل</option>
                  <option value="credit">آجل على ذمة العميل (Credit)</option>
                </select>
              </label>

              {docPayment !== 'credit' ? (
                <label className="field">
                  <span>الصندوق / موقع النقد *</span>
                  <select
                    className="input"
                    value={docCashLocationId}
                    onChange={(e) => setDocCashLocationId(e.target.value)}
                  >
                    <option value="">— الصندوق الافتراضي للفرع —</option>
                    {cashLocations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                        {location.isDefault ? ' (افتراضي)' : ''}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">
                    البيع النقدي يُرحَّل إلى حساب هذا الصندوق في الفاتورة الرسمية — لا يُخترَع حساب في الكود.
                  </span>
                </label>
              ) : null}

              <label className="field">
                <span>الكمية المباعة (كجم) *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  value={docSoldQty}
                  onChange={(e) => setDocSoldQty(e.target.value)}
                />
              </label>

              <label className="field">
                <span>
                  سعر الكيلو (ريال) {selectedCustomerRule?.lockPrice ? '🔒 مثبّت للعميل' : ''}
                </span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  readOnly={Boolean(selectedCustomerRule?.lockPrice && !docAllowOverride)}
                  value={docUnitPrice}
                  onChange={(e) => setDocUnitPrice(e.target.value)}
                />
              </label>

              <label className="field">
                <span>الكمية المجانية / البونص (كجم)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={docBonusQty}
                  onChange={(e) => setDocBonusQty(e.target.value)}
                />
              </label>

              {Number(docBonusQty || 0) > 0 && (
                <label className="field">
                  <span>سبب منح الكمية المجانية / العينات *</span>
                  <select
                    className="input"
                    value={docBonusReason}
                    onChange={(e) => setDocBonusReason(e.target.value)}
                  >
                    {BONUS_REASONS.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
              )}

              <label className="field">
                <span>خصم استثنائي (ريال — يتطلب صلاحية)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={docDiscountAmount}
                  onChange={(e) => setDocDiscountAmount(e.target.value)}
                />
              </label>

              {Number(docDiscountAmount || 0) > 0 && (
                <label className="field">
                  <span>سبب الخصم الاستثنائي</span>
                  <input
                    className="input"
                    value={docDiscountReason}
                    onChange={(e) => setDocDiscountReason(e.target.value)}
                  />
                </label>
              )}
            </div>

            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={docBonusConfirmed}
                  onChange={(e) => setDocBonusConfirmed(e.target.checked)}
                />
                <span>إقرار استلام العميل للكمية المجانية ({docBonusQty || '0'} كجم)</span>
              </label>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={docAllowOverride}
                  onChange={(e) => setDocAllowOverride(e.target.checked)}
                />
                <span>اعتماد استثنائي من صاحب المصنع / المحاسب لتجاوز السعر أو الخصم</span>
              </label>
              <input
                className="input"
                style={{ maxWidth: 200 }}
                value={docConfirmCode}
                onChange={(e) => setDocConfirmCode(e.target.value)}
                placeholder="رمز/توقيع العميل (اختياري)"
              />
            </div>

            <div
              className="row"
              style={{
                justifyContent: 'space-between',
                padding: 12,
                borderRadius: 10,
                background: 'var(--surface-2)',
              }}
            >
              <div>
                <span>الصافي قبل الضريبة: <strong dir="ltr">{previewSubtotal.toFixed(2)} SAR</strong></span>
                {' · '}
                <span>الضريبة: <strong dir="ltr">{previewVat.toFixed(2)} SAR</strong></span>
                {' · '}
                <span>الإجمالي: <strong dir="ltr" style={{ color: 'var(--brand)' }}>{previewTotal.toFixed(2)} SAR</strong></span>
              </div>
              <button type="submit" className="btn primary" disabled={busy || !activeLoadOrder}>
                {busy ? 'جارٍ الإصدار…' : '🚀 اعتماد الفاتورة وخصم العهدة'}
              </button>
            </div>
          </form>

          {/* 🖨️ Printing: one official document, two copies (customer + rep) and an 80mm receipt */}
          <div className="card" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ margin: 0 }}>🖨️ طباعة مستند البيع — نسختان من فاتورة رسمية واحدة</h3>
              {selectedDoc && (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() => void printDocumentCopies(selectedDoc.id)}
                  >
                    🖨️ طباعة نسختين (عميل + مندوب موقّعة)
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void printThermalFromView(selectedDoc.id)}
                  >
                    🧾 إيصال حراري 80mm
                  </button>
                  {selectedDoc.documentKind !== 'return' ? (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => {
                        const qty = window.prompt(
                          `كمية المرتجع من المستند ${selectedDoc.number} (المباع ${selectedDoc.soldQty} + البونص ${selectedDoc.bonusQty})`,
                          selectedDoc.soldQty,
                        );
                        if (!qty) return;
                        const reason = window.prompt('سبب المرتجع (يُطبع على المستند ويُسجَّل في التدقيق)') ?? '';
                        void submitReturn(selectedDoc.id, qty, reason);
                      }}
                    >
                      ↩️ مرتجع عميل
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              النسخة الأولى للعميل، والثانية للمندوب يعيدها موقّعة من العميل إلى المحاسب. النسختان تُقرأان من الفاتورة
              الرسمية نفسها (بيانات المنشأة من ملف المنشأة، ورقم الفاتورة الرسمية، وتاريخ ووقت الطباعة مستقل عن تاريخ
              البيع) — ولا يُنشأ مستند محاسبي ثانٍ.
            </p>

            {selectedDoc ? (
              <div
                style={{
                  border: '1px dashed var(--line-strong)',
                  borderRadius: 12,
                  padding: 14,
                  display: 'grid',
                  gap: 6,
                  fontSize: 13,
                }}
              >
                <div style={{ textAlign: 'center', fontWeight: 700 }}>
                  {selectedDoc.invoiceMode === 'zatca_tax'
                    ? 'فاتورة ضريبية مبسطة (ZATCA)'
                    : 'إيصال تسليم بضاعة (داخلي)'}
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>رقم المستند: <strong dir="ltr">{selectedDoc.number}</strong></span>
                  <span>الدفعة: <strong dir="ltr">{selectedDoc.productionBatchNo}</strong></span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>العميل: <strong>{selectedDoc.customerName}</strong></span>
                  <span>المندوب: <strong>{selectedDoc.salesmanName}</strong></span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>المباع: <strong dir="ltr">{selectedDoc.soldQty} kg × {selectedDoc.unitPrice}</strong></span>
                  <span>البونص: <strong dir="ltr">{selectedDoc.bonusQty} kg</strong></span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>الإجمالي: <strong dir="ltr">{selectedDoc.total} SAR</strong></span>
                  <span>صافي ربح الفاتورة: <strong dir="ltr" style={{ color: 'var(--ok)' }}>{selectedDoc.netProfit} SAR</strong></span>
                </div>
                <div style={{ display: 'grid', placeItems: 'center', marginTop: 6 }}>
                  <ZatcaQrSvg size={128} payload={selectedDoc.qrPayload ?? ''} />
                </div>
              </div>
            ) : (
              <p className="muted">اختر فاتورة أو أصدر فاتورة جديدة لمعاينتها وطباعتها.</p>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرقم</th>
                    <th>العميل</th>
                    <th>المباع / البونص</th>
                    <th>الإجمالي</th>
                    <th>المدفوع</th>
                    <th>تحصيل</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.documents ?? []).slice(0, 12).map((d) => {
                    const unpaid = Math.max(0, Number(d.total) - Number(d.paidAmount));
                    return (
                      <tr
                        key={d.id}
                        onClick={() => setSelectedDoc(d)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td dir="ltr"><strong>{d.number}</strong></td>
                        <td>{d.customerName}</td>
                        <td dir="ltr">{d.soldQty} + {d.bonusQty} kg</td>
                        <td dir="ltr">{d.total}</td>
                        <td dir="ltr">{d.paidAmount}</td>
                        <td>
                          {unpaid > 0.01 ? (
                            <button
                              type="button"
                              className="btn sm primary"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void handleCollectDebt(d);
                              }}
                            >
                              تحصيل ({unpaid.toFixed(2)})
                            </button>
                          ) : (
                            <span className="badge ok">مسددة</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: CUSTOMER PRICE TIERS, LOCKING & CREDIT LIMITS (Pillar 4 & 5) */}
      {tab === 'prices' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <form className="card" onSubmit={submitCustomerTier} style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ margin: 0 }}>💰 تخصيص وتثبيت سعر العميل (6 / 6.5 / 7 ريال) وسقف الائتمان والبونص</h2>
            <div className="form-grid">
              <label className="field">
                <span>العميل *</span>
                <select className="input" required value={tierPartyId} onChange={(e) => setTierPartyId(e.target.value)}>
                  <option value="">— اختر العميل —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>سعر الكيلو المخصص (ريال) *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  value={tierUnitPrice}
                  onChange={(e) => setTierUnitPrice(e.target.value)}
                />
              </label>
              <label className="field">
                <span>وصف الشريحة</span>
                <input className="input" value={tierLabel} onChange={(e) => setTierLabel(e.target.value)} />
              </label>
              <label className="field">
                <span>سقف الائتمان الآجل (SAR)</span>
                <input
                  className="input"
                  type="number"
                  step="1"
                  dir="ltr"
                  value={tierCreditLimit}
                  onChange={(e) => setTierCreditLimit(e.target.value)}
                />
              </label>
              <label className="field">
                <span>مهلة السداد (أيام)</span>
                <input
                  className="input"
                  type="number"
                  dir="ltr"
                  value={tierPaymentTerms}
                  onChange={(e) => setTierPaymentTerms(e.target.value)}
                />
              </label>
              <label className="field">
                <span>أقصى خصم مسموح للمندوب (%)</span>
                <input
                  className="input"
                  type="number"
                  step="0.5"
                  dir="ltr"
                  value={tierMaxDiscountPct}
                  onChange={(e) => setTierMaxDiscountPct(e.target.value)}
                />
              </label>
              <label className="field">
                <span>أقصى نسبة بونص مجاني (%)</span>
                <input
                  className="input"
                  type="number"
                  step="0.5"
                  dir="ltr"
                  value={tierMaxBonusPct}
                  onChange={(e) => setTierMaxBonusPct(e.target.value)}
                />
              </label>
              <label className="field">
                <span>أقصى بونص في الفاتورة (كجم)</span>
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  dir="ltr"
                  value={tierMaxBonusKg}
                  onChange={(e) => setTierMaxBonusKg(e.target.value)}
                />
              </label>
              <label className="field">
                <span>نوع الفاتورة المفضل للعميل</span>
                <select
                  className="input"
                  value={tierPreferredMode}
                  onChange={(e) => setTierPreferredMode(e.target.value as 'zatca_tax' | 'internal_delivery')}
                >
                  <option value="zatca_tax">فاتورة ضريبية إلكترونية ZATCA</option>
                  <option value="internal_delivery">فاتورة توزيع عادية (بدون ضريبية ورقية)</option>
                </select>
              </label>
              <label className="field">
                <span>سبب اعتماد / تعديل السعر (لسجل التدقيق)</span>
                <input
                  className="input"
                  value={tierChangeReason}
                  onChange={(e) => setTierChangeReason(e.target.value)}
                />
              </label>
            </div>
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={tierLockPrice}
                onChange={(e) => setTierLockPrice(e.target.checked)}
              />
              <span>🔒 تثبيت السعر تلقائياً عند البيع ومنع المندوب من تغييره أو البيع بسعر أقل</span>
            </label>
            <div>
              <button type="submit" className="btn primary" disabled={busy}>
                حفظ سياسة العميل السعرية والائتمانية
              </button>
            </div>
          </form>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>📋 قائمة أسعار وسياسات العملاء المعتمدة</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>العميل</th>
                    <th>الشريحة</th>
                    <th>سعر الكيلو</th>
                    <th>تثبيت السعر</th>
                    <th>سقف الائتمان</th>
                    <th>أقصى بونص</th>
                    <th>أقصى خصم</th>
                    <th>نوع الفاتورة</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.customerPrices ?? []).map((cp) => (
                    <tr key={cp.id}>
                      <td><strong>{cp.partyName}</strong></td>
                      <td>{cp.priceTierLabel}</td>
                      <td dir="ltr"><strong>{cp.unitPrice} SAR</strong></td>
                      <td>{cp.lockPrice ? <span className="badge ok">🔒 مثبّت</span> : 'مرن'}</td>
                      <td dir="ltr">{cp.creditLimit} SAR ({cp.paymentTermsDays} يوم)</td>
                      <td dir="ltr">{cp.maxBonusKgPerInvoice} kg ({cp.maxBonusPct}%)</td>
                      <td dir="ltr">{cp.maxDiscountPct}%</td>
                      <td>{cp.preferredInvoiceMode === 'zatca_tax' ? 'ضريبية ZATCA' : 'توزيع عادية'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>📜 سجل تدقيق وتاريخ تعديلات أسعار العملاء</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>السعر السابق</th>
                    <th>السعر الجديد</th>
                    <th>بداية السريان</th>
                    <th>تثبيت السعر</th>
                    <th>سبب التعديل</th>
                    <th>تاريخ التسجيل</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.customerPriceHistory ?? []).map((h) => (
                    <tr key={h.id}>
                      <td dir="ltr">{h.previousUnitPrice ? `${h.previousUnitPrice} SAR` : '—'}</td>
                      <td dir="ltr"><strong>{h.newUnitPrice} SAR</strong></td>
                      <td dir="ltr">{h.effectiveFrom}</td>
                      <td>{h.lockPrice ? '🔒 مثبّت' : 'مرن'}</td>
                      <td>{h.changeReason || '—'}</td>
                      <td dir="ltr">{new Date(h.changedAt).toLocaleString('ar-SA')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: BONUS RADAR & ROLE PERMISSIONS MATRIX (Pillar 3 & 10) */}
      {tab === 'audit' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>🔍 فحص توافق البيانات السابقة وربطها بالنواة (Dry-Run)</h2>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void handleRunLegacyPreview()}
              >
                تشغيل فحص التوافق الآمن (Dry-Run)
              </button>
            </div>
            {reconciliationPreview ? (
              <div className="form-grid">
                <div>
                  <strong>دفعات الإنتاج:</strong> الإجمالي {reconciliationPreview.batches.total} (مرتبط بالنواة: {reconciliationPreview.batches.linkedToCore} | غير مرتبط: {reconciliationPreview.batches.unlinkedLegacy})
                </div>
                <div>
                  <strong>أوامر التحميل:</strong> الإجمالي {reconciliationPreview.loadOrders.total} (مرتبط بتحويل مخزني: {reconciliationPreview.loadOrders.linkedToTransfer} | غير مرتبط: {reconciliationPreview.loadOrders.unlinkedLegacy})
                </div>
                <div>
                  <strong>فواتير المناديب:</strong> الإجمالي {reconciliationPreview.documents.total} (مرتبط بـ sales_invoices: {reconciliationPreview.documents.linkedToSalesInvoice} | غير مرتبط: {reconciliationPreview.documents.unlinkedLegacy})
                </div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                يعرض هذا الفحص حالة ربط السجلات السابقة بجداول النواة الرسمية (`sales_invoices`, `stock_transfers`, `inventory_transactions`) في وضع المعاينة الآمنة دون أي تعديل على قاعدة البيانات.
              </p>
            )}
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>🛡️ رادار الرقابة على الكميات المجانية (البونص) والعينات والخصومات</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>رقم الفاتورة</th>
                    <th>المندوب</th>
                    <th>العميل</th>
                    <th>المباع</th>
                    <th>البونص المجاني</th>
                    <th>سبب البونص</th>
                    <th>الخصم</th>
                    <th>تأكيد العميل</th>
                    <th>التنبيه الرقابي</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.documents ?? [])
                    .filter((d) => Number(d.bonusQty) > 0 || Number(d.discountAmount) > 0 || d.bonusAnomaly)
                    .map((d) => (
                      <tr key={d.id}>
                        <td dir="ltr"><strong>{d.number}</strong></td>
                        <td>{d.salesmanName}</td>
                        <td>{d.customerName}</td>
                        <td dir="ltr">{d.soldQty} kg</td>
                        <td dir="ltr" style={{ color: 'var(--warn)', fontWeight: 700 }}>{d.bonusQty} kg</td>
                        <td>{d.bonusReason || '—'}</td>
                        <td dir="ltr">{d.discountAmount} SAR</td>
                        <td>{d.customerBonusConfirmed ? '✔ مؤكد' : 'غير مؤكد'}</td>
                        <td>
                          {d.bonusAnomaly ? (
                            <span className="badge danger">{d.anomalyReason || 'تجاوز سقف البونص'}</span>
                          ) : (
                            <span className="badge ok">ضمن السياسة المعتمدة</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>🔐 مصفوفة الصلاحيات والأمان للأدوار الأربعة في المصنع</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الدور الوظيفي</th>
                    <th>صلاحيات الإنتاج والمستودع</th>
                    <th>صلاحيات الأسعار والخصومات والبونص</th>
                    <th>صلاحيات إغلاق الوردية والتالف والعجز</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>👑 صاحب المصنع (Factory Owner)</strong></td>
                    <td>اطلاع كامل على لوحة صاحب المصنع، تكلفة الإنتاج، وهوامش الربح لكل صنف ومندوب وعميل.</td>
                    <td>تحديد وتثبيت شرائح الأسعار (6 / 6.5 / 7 ريال) واعتماد الخصومات الاستثنائية وتجاوز البونص.</td>
                    <td>اعتماد نهائي لإغلاق الورديات، مراجعة سجل التدقيق الكامل، واستلام التنبيهات الفورية.</td>
                  </tr>
                  <tr>
                    <td><strong>🧮 المحاسب (Accountant)</strong></td>
                    <td>مطابقة أرصدة المستودع الرئيسي وعهد المناديب والقيود المحاسبية وتكلفة البضاعة المباعة.</td>
                    <td>مراجعة الفواتير الضريبية (ZATCA) والعادية، ومراقبة السقوف الائتمانية والتحصيل.</td>
                    <td><strong>مراجعة إغلاقات الورديات المعلقة، تأكيد الفحص الفعلي للتالف، تصفير العهد، وقيد العجز خصماً على راتب المندوب.</strong></td>
                  </tr>
                  <tr>
                    <td><strong>📦 أمين المستودع (Warehouse Keeper)</strong></td>
                    <td>تسجيل دفعات الإنتاج اليومية، صرف أوامر التحميل للمناديب، واستلام المرتجع السليم.</td>
                    <td>لا يملك صلاحية تعديل أسعار العملاء أو منح خصومات مالية.</td>
                    <td>المشاركة في الفحص الفعلي للكميات التالفة والجرد الدوري المفاجئ لسيارات المناديب.</td>
                  </tr>
                  <tr>
                    <td><strong>🚚 المندوب (Sales Rep)</strong></td>
                    <td>استلام العهدة المحددة بأمر التحميل فقط (يُمنع بيع أي كمية تتجاوز دفعة المخبز المستلمة).</td>
                    <td>البيع بالسعر المثبّت للعميل تلقائياً، وتسجيل سبب البونص ضمن السقف المسموح فقط.</td>
                    <td><strong>تقديم طلب إغلاق الوردية اليومي في نهاية الدوام (تبقى الحالة معلقة حتى يعتمدها المحاسب).</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
