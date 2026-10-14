import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { calculateInvoiceTotals, DomainError, errorCodes, newId } from '@erp/contracts';
import {
  accounts,
  branches,
  employees,
  inventoryTransactions,
  invoicePayments,
  items,
  journalEntries,
  offers,
  parties,
  salesAdjustmentNotes,
  salesInvoiceLines,
  salesInvoices,
  salesmen,
  shiftCloses,
  stockBalances,
  vouchers,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { assertDiscountWithinLimit, sumDiscount, sumLineGross } from '../../common/discount-limit.js';
import { DATABASE_HANDLE } from '../../database/database.module.js';
import { getRequestContext } from '../../request-context/request-context.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { DomainEventsService } from '../../events/domain-events.service.js';
import { WebhookPublisher } from '../developer/webhook-publisher.service.js';
import { UsageService } from '../usage/index.js';
import { AccountingService } from '../accounting/accounting.service.js';
import { splitByCostCenter } from '../../common/cost-center-split.js';
import { InventoryService, type InventoryLine } from '../inventory/inventory.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { SequencesService } from '../platform-services/index.js';
import { ApprovalService } from '../approvals/approvals.service.js';

/**
 * 🔢 الأرقام التسلسلية كما يكتبها المُدخِل: نصٌّ مقصوص، بلا فراغات ولا تكرار — فالسطر
 * الذي يُدخل «SN-1, SN-1» يقول قطعةً واحدة مرّتين، وهو خطأٌ يُصلَح عند الإدخال لا عند
 * الترحيل (والسبيك يقيس الحالتين).
 */
function cleanSerialNos(values?: string[]): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function buildZatcaPhase1TlvBase64(params: {
  sellerName: string;
  vatRegistrationNumber: string;
  timestampIso: string;
  invoiceTotal: string;
  vatTotal: string;
}): string {
  const fields: Array<[number, string]> = [
    [1, params.sellerName || 'منشأة سحابية'],
    [2, params.vatRegistrationNumber || '300000000000003'],
    [3, params.timestampIso],
    [4, Number(params.invoiceTotal || 0).toFixed(2)],
    [5, Number(params.vatTotal || 0).toFixed(2)],
  ];
  const chunks: Buffer[] = [];
  for (const [tag, value] of fields) {
    const valBuf = Buffer.from(value, 'utf8');
    const len = Math.min(valBuf.length, 255);
    chunks.push(Buffer.from([tag, len]), valBuf.subarray(0, len));
  }
  return Buffer.concat(chunks).toString('base64');
}

export type SalesLineInput = {
  itemId?: string;
  description?: string;
  quantity: string;
  unitPrice: string;
  discountRate?: string;
  discountAmount?: string;
  taxRate?: string;
  taxGroupId?: string;
  /**
   * R8 — الأرقام الأربعة التي يكتبها المُدخِل على السطر كما يقرؤها من العبوة
   * (`Class/InvoiceOper.cs` L1635: `ItemSerialNo`, `BatchNo`, `ItemProductionDate`,
   * `ItemExpireDate`). تُحفظ في المسودّة بلا لمس المخزون، ويُحسم معناها عند الترحيل:
   * الدفعة تُبحث أو تُنشأ، والأرقام التسلسلية تُصرف (بيع) أو **تعود** (مرتجع).
   */
  serialNos?: string[];
  batchNo?: string;
  productionDate?: string;
  expiryDate?: string;
  lotId?: string;
  /**
   * R9 — 📊 مركز تكلفة السطر (`Inv_Sub.ItemCostCenter`، `InvoiceOper.cs` L1635). اختياريّ،
   * ويسبق مركز الرأس عند وسم القيد؛ ومن لم يذكر مركزاً يأخذ مركز الفاتورة إن وُجد.
   */
  costCenterId?: string;
  metadata?: Record<string, unknown>;
};
export type SalesInvoiceInput = {
  branchId: string;
  warehouseId?: string;
  partyId?: string;
  salesmanId?: string;
  /** R9 — 📊 مركز التكلفة الافتراضي للفاتورة (`Invoices.CCcode` · «📊 مركز التكلفة:» L530). */
  costCenterId?: string;
  referenceInvoiceId?: string;
  validUntil?: string;
  kind?: 'sale' | 'sale_return' | 'credit_note' | 'debit_note' | 'quotation';
  currency?: string;
  priceIncludesVat?: boolean;
  invoiceDiscount?: string;
  extraTax?: string;
  withholding?: string;
  lines: SalesLineInput[];
  cashCustomerName?: string;
  cashCustomerMobile?: string;
  orderType?: string;
  shiftId?: string;
  /** R4 — الكاشير الذي قبض: `cashier_id`، ويُملأ من نقطة البيع لا من الشاشات المكتبية. */
  cashierId?: string;
  /** ترحيل فوري للفاتورة عند الحفظ (الخيار الافتراضي في الواجهة السحابية ما لم يُفعَّل خيار المسودة). */
  autoPost?: boolean;
  settlement?: 'credit' | 'cash' | 'card' | 'bank';
};
export type PaymentInput = {
  method: 'cash' | 'card' | 'bank' | 'credit' | 'split';
  amount: string;
  idempotencyKey: string;
  cashLocationId?: string;
  reference?: string;
};
export type PostingInput = {
  fiscalPeriodId?: string;
  journalLines?: {
    accountId: string;
    debit?: string;
    credit?: string;
    partyId?: string;
    description?: string;
  }[];
  inventoryLines?: InventoryLine[];
  settlement?: 'credit' | 'cash' | 'card' | 'bank';
  settlementAccountId?: string;
  settlementCashLocationId?: string;
  /**
   * R4 — تعدّد طرق الدفع في الفاتورة الواحدة («🔀 متعدد»، `frmPOSPay.xaml` L286).
   *
   * الديسكتوب يقبض الفاتورة على أكثر من طريقة (كاش + شبكة + تحويل) في نافذة الدفع،
   * ويطابق مجموعها صافي الفاتورة بـ«⚖️ F6 مطابقة» (L548). والمحرّك كان يكتب **صفّ دفعة
   * واحداً** لقيدٍ واحد فلزمته مصفوفة: كل طريقة بمالها وحسابها.
   *
   * والقاعدة: مجموع الدفعات لا يتجاوز صافي المستند، والباقي إن وُجد يقف على ذمة العميل
   * (`receivableAccountId` بذات الطرف) — فيصحّ «دفعٌ جزئيّ نقداً والباقي آجل» بلا ضريبةٍ
   * ثانية ولا قيدٍ ثانٍ. والمصفوفة تُغني عن `settlement` المفرد ولا تلغيه: مسار POS القديم
   * والبيع المكتبي يمرّان كما هما.
   */
  settlements?: {
    method: 'cash' | 'card' | 'bank';
    amount: string;
    accountId: string;
    cashLocationId?: string;
    reference?: string;
  }[];
};

const money = (value: string) => new Decimal(value);

/** 🧑‍💼 بطاقة المندوب — the writable half of `frmSalesMen.xaml` (see migration 0052). */
export type SalesmanInput = {
  name?: string;
  employeeRef?: string | null;
  /** الموظف — the cloud's bridge to the employee card (migration 0052). */
  employeeId?: string | null;
  active?: boolean;
  /** عمولة المبيعات — `salesmen.comm`. */
  commissionRate?: string;
  /** عمولة التحصيل — `salesmen.Colle_Comm`. */
  collectionCommissionRate?: string;
  /** عمولة الربح — `salesmen.Profit_Comm`. */
  profitCommissionRate?: string;
  /** 📞 الهاتف */
  tel?: string | null;
  /** 📱 الجوال */
  mobile?: string | null;
  /** 📧 البريد الإلكتروني */
  email?: string | null;
  /** ملاحظات */
  notes?: string | null;
  /**
   * 🚐 مستودع المندوب / سيارة التوزيع — the warehouse that holds his custody.
   *
   * Distribution needs a real warehouse per rep: it is the destination of the official
   * stock transfer that supplies him, the source the sales engine relieves when he sells,
   * and the balance his own workspace reads. Without it a supply has nowhere to land.
   */
  warehouseId?: string | null;
  /** رقم لوحة سيارة التوزيع */
  vehiclePlate?: string | null;
};

/**
 * 📋 طباعة فواتير مندوب وعمولاتهم — the filters of `frmInvBySalesMen.xaml`
 * («مبيعات مندوب خلال فترة»): `👤 المندوب` + `🌐 الكل` (both on by default),
 * `📅 الفترة الزمنية` with `كل الفترة` and `من`/`إلى` (both today).
 */
export type SalesmanCommissionQuery = {
  salesmanId?: string;
  allSalesmen?: boolean;
  allPeriod?: boolean;
  from?: string;
  to?: string;
  branchId?: string;
};

export type SalesmanCommissionRow = {
  seq: number;
  /** 📌 نوع الحركة */
  movementType: string;
  /** 📅 التاريخ */
  date: string | null;
  documentId: string;
  /** 🔢 رقم السند */
  number: string | null;
  /** 🔗 رقم المرجع */
  refNumber: string | null;
  salesmanId: string;
  /** 👤 المندوب */
  salesmanName: string;
  branchName: string | null;
  /** 💰 القيمة — net of VAT and of both discounts, as `frmInvBySalesMen` computes it. */
  value: string;
  /** 📈 عمولة المبيعات */
  salesCommission: string;
  /** 💳 عمولة التحصيل */
  collectionCommission: string;
  /** 📊 عمولة الربح */
  profitCommission: string;
  /**
   * `isPlus` — the desktop stores every value unsigned and keeps the direction in this
   * column (`ProcessInvoiceRow` L328), then applies it in `RecalculateSummary` L498.
   */
  isPlus: 1 | -1;
};

@Injectable()
export class SalesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly customFields: CustomFieldsService,
    private readonly inventory: InventoryService,
    private readonly accounting: AccountingService,
    private readonly sequences: SequencesService,
    private readonly profiles: PostingProfilesService,
    private readonly usage: UsageService,
    // P-C11 — الإعلان عن الأحداث يُحقن ولا يُستورَد: الوحدة تُصرّح بتبعيّتها في موديولها.
    private readonly webhooks: WebhookPublisher,
    private readonly domainEvents: DomainEventsService,
    private readonly approvals: ApprovalService,
  ) {}

  async list(tenantId: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(salesInvoices)
        .where(eq(salesInvoices.tenantId, tenantId))
        .orderBy(desc(salesInvoices.createdAt))
        .limit(100),
    );
    return this.customFields.decorate(tenantId, 'invoice', rows);
  }

  /** Reads the invoice, its lines and its payments inside an open transaction. */
  private async getInTx(tx: DrizzleTx, tenantId: string, id: string) {
    const [invoice] = await tx
      .select()
      .from(salesInvoices)
      .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, id)));
    if (!invoice) throw new DomainError('SALES_INVOICE_NOT_FOUND', 'Sales invoice was not found', 404);
    const lines = await tx
      .select()
      .from(salesInvoiceLines)
      .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, id)));
    const payments = await tx
      .select()
      .from(invoicePayments)
      .where(and(eq(invoicePayments.tenantId, tenantId), eq(invoicePayments.invoiceId, id)));
    let partyName: string | null = null;
    let partyTaxNo: string | null = null;
    let partyCode: string | null = null;
    if (invoice.partyId) {
      const [party] = await tx
        .select({ name: parties.name, taxNo: parties.taxNo, code: parties.code })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, invoice.partyId)));
      partyName = party?.name ?? null;
      partyTaxNo = party?.taxNo ?? null;
      partyCode = party?.code ?? null;
    }
    const isStandardTaxInvoice = Boolean(
      partyTaxNo &&
        partyTaxNo.trim().length > 0 &&
        partyName !== 'عميل عام' &&
        partyCode !== 'CUST-GEN',
    );
    const qrCode =
      invoice.zatcaQr ||
      buildZatcaPhase1TlvBase64({
        sellerName: 'ERP Cloud KSA',
        vatRegistrationNumber: '300000000000003',
        timestampIso: (invoice.postedAt ?? invoice.createdAt ?? new Date()).toISOString(),
        invoiceTotal: String(invoice.total ?? '0'),
        vatTotal: String(invoice.taxTotal ?? '0'),
      });
    return {
      ...invoice,
      qrCode,
      partyName,
      partyTaxNo,
      taxInvoiceType: isStandardTaxInvoice ? 'standard' : 'simplified',
      taxInvoiceTypeLabelAr: isStandardTaxInvoice ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة',
      lines,
      payments,
    };
  }

  async get(tenantId: string, id: string) {
    const invoice = await withTenantTx(this.database.db, tenantId, (tx) => this.getInTx(tx, tenantId, id));
    const [decorated] = await this.customFields.decorate(tenantId, 'invoice', [invoice]);
    return decorated ?? invoice;
  }

  /**
   * Creates the invoice and its lines inside an open transaction, returning its id.
   *
   * Split out of `create()` for Phase 04 so a till checkout can create *and* post
   * in one transaction: a sale that exists without its journal and its stock
   * movement is the one thing a cashier must never be able to produce, and three
   * separate round trips from a browser can always leave exactly that behind.
   */
  /**
   * AUD-11 — بوّابات الكتابة والتحقق من المجاميع، مشتركةً بين الإنشاء واستبدال سطور
   * المسوّدة: مسارٌ واحد للحساب وحدود الخصم ومراكز الكلفة، فلا يمرّ كتابٌ من بابٍ بلا
   * الفحوص التي يمرّ منها الباب الآخر.
   */
  private prepareLines(tx: DrizzleTx, tenantId: string, input: SalesInvoiceInput) {
    if (!input.lines.length)
      throw new DomainError('SALES_LINES_REQUIRED', 'At least one invoice line is required', 422);
    if (!input.partyId && !input.cashCustomerName)
      throw new DomainError('SALES_CUSTOMER_REQUIRED', 'Party or cash customer name is required', 422);
    const totals = calculateInvoiceTotals({
      lines: input.lines,
      priceIncludesVat: input.priceIncludesVat,
      invoiceDiscount: input.invoiceDiscount,
      extraTax: input.extraTax,
      withholding: input.withholding,
    });
    // R1 — حدّ الخصم على العضوية (بديل `OperMaxDiscount` في الديسكتوب). الفحص هنا في
    // مسار الإنشاء الوحيد، فيمرّ منه كل ما يُكتب: مسودّة الحقل، وفاتورة الكاشير
    // (`pos.checkout` ← `createAndPost`)، وعرض السعر، والمردود.
    assertDiscountWithinLimit({
      gross: sumLineGross(totals.lines),
      discount: sumDiscount(totals),
      field: 'invoiceDiscount',
    });
    return totals;
  }

  /** صفوف السطور المشتقّة من المجاميع المحسوبة — مصدرٌ واحد للإنشاء والاستبدال. */
  private lineRows(invoiceId: string, tenantId: string, input: SalesInvoiceInput, totals: ReturnType<typeof calculateInvoiceTotals>) {
    return input.lines.map((line, index) => {
      const calculated = totals.lines[index];
      if (!calculated)
        throw new DomainError('SALES_TOTALS_INVALID', 'Invoice totals do not match invoice lines', 422);
      return {
        id: newId(),
        tenantId,
        invoiceId,
        lineNo: index + 1,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountRate: line.discountRate ?? '0',
        discountAmount: calculated.discount,
        taxGroupId: line.taxGroupId,
        taxRate: line.taxRate ?? '0',
        net: calculated.net,
        tax: calculated.tax,
        total: calculated.total,
        serialNos: cleanSerialNos(line.serialNos),
        lotId: line.lotId,
        batchNo: line.batchNo?.trim() || null,
        productionDate: line.productionDate?.trim() || null,
        expiryDate: line.expiryDate?.trim() || null,
        costCenterId: line.costCenterId ?? null,
        metadata: line.metadata ?? {},
      };
    });
  }

  async createInTx(tx: DrizzleTx, tenantId: string, input: SalesInvoiceInput): Promise<string> {
    const totals = this.prepareLines(tx, tenantId, input);
    // R9 — كل مركزٍ مُسمّى (رأساً أو على سطر) يُفحَص قبل أي كتابة: مركزُ مستأجرٍ آخر ليس
    // مركزاً عندنا، والرسالة تسمّي الحقل. الفحص هنا في مسار الإنشاء الوحيد فيمرّ منه كل
    // ما يُكتب — مسودّةُ الحقل، وفاتورة الكاشير، وعرض السعر، والمردود.
    await this.accounting.assertCostCentersInTx(tx, tenantId, [
      input.costCenterId,
      ...input.lines.map((line) => line.costCenterId),
    ]);
    const id = newId();
    await tx
      .insert(salesInvoices)
      .values({
        id,
        tenantId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        referenceInvoiceId: input.referenceInvoiceId,
        partyId: input.partyId,
        salesmanId: input.salesmanId,
        costCenterId: input.costCenterId ?? null,
        kind: input.kind ?? 'sale',
        validUntil: input.validUntil,
        currency: input.currency ?? 'SAR',
        priceIncludesVat: input.priceIncludesVat ?? false,
        cashCustomerName: input.cashCustomerName,
        cashCustomerMobile: input.cashCustomerMobile,
        orderType: input.orderType,
        shiftId: input.shiftId ?? null,
        cashierId: input.cashierId ?? null,
        createdBy: tryGetAuthContext()?.userId,
        invoiceDiscount: totals.discount,
        extraTax: totals.extraTax,
        withholding: totals.withholding,
        subtotal: totals.subtotal,
        taxTotal: totals.tax,
        total: totals.total,
        status: 'draft',
      });
    await tx.insert(salesInvoiceLines).values(this.lineRows(id, tenantId, input, totals));
    return id;
  }

  async create(tenantId: string, input: SalesInvoiceInput) {
    // P-C5: فواتير الشهر مقياسٌ محدود — والعدّ في القاعدة لا في الذاكرة.
    await this.usage.assertWithinLimit(tenantId, 'invoices_per_month');
    if (input.autoPost) {
      return this.createAndPost(tenantId, input, {
        settlement: input.settlement,
      });
    }
    const id = await withTenantTx(this.database.db, tenantId, (tx) => this.createInTx(tx, tenantId, input));
    return this.get(tenantId, id);
  }

  /**
   * Create and post in one transaction — the POS checkout path (Phase 04).
   *
   * Identical gates and identical ledgers as `create` then `post`, but nothing is
   * committed until the invoice, its stock movement, its journal and its
   * settlement payment have all succeeded.
   */
  async createAndPost(tenantId: string, input: SalesInvoiceInput, posting: PostingInput = {}) {
    // Keep the POS checkout atomic when no approval applies.  When a workflow does
    // apply, the draft must commit before the request can be created; otherwise the
    // 202 response would roll the draft and its request back together.
    const totals = calculateInvoiceTotals({
      lines: input.lines,
      priceIncludesVat: input.priceIncludesVat,
      invoiceDiscount: input.invoiceDiscount,
      extraTax: input.extraTax,
      withholding: input.withholding,
    });
    const approvalApplies = await this.approvals.hasApplicableWorkflow(tenantId, 'sales_invoice', {
      amount: totals.total,
      branchId: input.branchId,
      costCenterId: input.costCenterId,
    });
    if (approvalApplies) {
      const id = await withTenantTx(this.database.db, tenantId, (tx) =>
        this.createInTx(tx, tenantId, input),
      );
      const created = await this.get(tenantId, id);
      await this.approvals.ensureApprovalRequired(tenantId, 'sales_invoice', id, {
        amount: created.total,
        branchId: created.branchId,
        costCenterId: created.costCenterId,
        posting: posting as unknown as Record<string, unknown>,
      });
      // A notify-only workflow or a request that was already approved may continue;
      // the normal post path is still bypassed here because the workflow was checked.
      return this.postWithoutApproval(tenantId, id, posting);
    }

    const invoice = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const id = await this.createInTx(tx, tenantId, input);
      const posted = await this.postInTx(tx, tenantId, id, posting);
      return posted ?? this.getInTx(tx, tenantId, id);
    });
    // POS uses this atomic path instead of `post()`, so it must publish the same
    // post-commit events for webhook consumers and e-commerce stock workers.
    this.announcePosted(tenantId, invoice);
    return invoice;
  }

  /**
   * AUD-11 — تعديل المسودّة كلّه في معاملة واحدة، وبهوية الفاتورة نفسها.
   *
   * ما كان: حذف السطور في معاملة، ثم `create()` بديل في معاملة ثانية بمعرّفٍ جديد. فشلُ
   * الإنشاء كان يترك المسودّة **بلا سطور** (تلفُ بيانات ظاهر)، ونجاحُه كان يبدّل المعرّف
   * فيكسر المراجع (المرفقات، سجلّ التدقيق، `referenceInvoiceId`، مفاتيح العملاء). الآن:
   * قفل صفّ الفاتورة (`FOR UPDATE`) يمنع تعديلين متزامنين/ترحيلاً متزامناً من التسلسل
   * الخطأ، والحذف والإدراج وتحديث المجاميع في معاملةٍ واحدة — إما كلها أو لا شيء.
   */
  async updateDraft(tenantId: string, id: string, input: Partial<SalesInvoiceInput>) {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [locked] = await tx
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, id)))
        .for('update');
      if (!locked) throw new DomainError('SALES_INVOICE_NOT_FOUND', 'Sales invoice was not found', 404);
      if (locked.status !== 'draft')
        throw new DomainError('SALES_INVOICE_IMMUTABLE', 'Only draft invoices can be changed', 409);
      await this.assertShiftOpen(tx, tenantId, locked);

      const header = {
        partyId: input.partyId ?? locked.partyId,
        salesmanId: input.salesmanId ?? locked.salesmanId,
        // R9 — مركز الرأس يُعدَّل مع بقية رأس الفاتورة (المسودّة وحدها؛ والمرحَّل لا يُعدَّل).
        costCenterId: input.costCenterId ?? locked.costCenterId,
        warehouseId: input.warehouseId ?? locked.warehouseId,
        cashCustomerName: input.cashCustomerName ?? locked.cashCustomerName,
        cashCustomerMobile: input.cashCustomerMobile ?? locked.cashCustomerMobile,
      };

      if (!input.lines) {
        await tx
          .update(salesInvoices)
          .set({ ...header, updatedAt: new Date() })
          .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, id)));
        return;
      }

      const merged: SalesInvoiceInput = {
        ...input,
        branchId: input.branchId ?? locked.branchId,
        lines: input.lines,
        partyId: header.partyId,
        cashCustomerName: header.cashCustomerName,
        priceIncludesVat: input.priceIncludesVat ?? locked.priceIncludesVat,
        invoiceDiscount: input.invoiceDiscount ?? locked.invoiceDiscount,
        extraTax: input.extraTax ?? locked.extraTax,
        withholding: input.withholding ?? locked.withholding,
      } as SalesInvoiceInput;
      const totals = this.prepareLines(tx, tenantId, merged);
      await this.accounting.assertCostCentersInTx(tx, tenantId, [
        merged.costCenterId,
        ...merged.lines.map((line) => line.costCenterId),
      ]);

      await tx
        .delete(salesInvoiceLines)
        .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, id)));
      await tx.insert(salesInvoiceLines).values(this.lineRows(id, tenantId, merged, totals));
      await tx
        .update(salesInvoices)
        .set({
          ...header,
          priceIncludesVat: merged.priceIncludesVat ?? false,
          invoiceDiscount: totals.discount,
          extraTax: totals.extraTax,
          withholding: totals.withholding,
          subtotal: totals.subtotal,
          taxTotal: totals.tax,
          total: totals.total,
          updatedAt: new Date(),
        })
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, id)));
    });
    return this.get(tenantId, id);
  }

  /**
   * أرقام السطور التسلسلية والدفعات عند الترحيل (R8) — بعد حركة المخزون، فالسطر الذي
   * لم يتحرّك (صنفٌ غير مخزني أو مسودّةٌ بلا مستودع) لا يُطالَب بأرقام.
   *
   * والاتجاه يقرّره نوع الفاتورة لا الحقل: البيع يُخرج القطع، والمرتجع يُعيدها، وما
   * سواهما (`credit_note`/`debit_note`/عرض السعر) لا يمسّ المخزون فلا يُحسَم له رقم.
   */
  private async resolveLineNumbers(
    tx: DrizzleTx,
    tenantId: string,
    invoice: { id: string; kind: string; warehouseId: string | null },
    lines: Array<{
      id: string;
      lineNo: number;
      itemId: string | null;
      quantity: string;
      serialNos?: string[];
      lotId?: string | null;
      batchNo?: string | null;
      productionDate?: string | null;
      expiryDate?: string | null;
    }>,
  ) {
    if (!invoice.warehouseId) return;
    if (invoice.kind !== 'sale' && invoice.kind !== 'sale_return') return;
    const direction = invoice.kind === 'sale_return' ? 'in' : 'out';
    const numeric = lines.filter((line) => line.itemId);
    if (!numeric.length) return;
    const docType = invoice.kind === 'sale_return' ? 'sales_return' : 'sales_invoice';
    const resolved = await this.inventory.resolveInvoiceLineNumbers(tx, tenantId, {
      docType,
      docId: invoice.id,
      warehouseId: invoice.warehouseId,
      direction,
      mode: invoice.kind === 'sale_return' ? 'return' : 'issue',
      lines: numeric.map((line) => ({
        lineNo: line.lineNo,
        itemId: line.itemId as string,
        qty: line.quantity,
        lotId: line.lotId,
        batchNo: line.batchNo,
        productionDate: line.productionDate,
        expiryDate: line.expiryDate,
        serialNos: line.serialNos ?? [],
      })),
    });
    for (const [index, line] of numeric.entries()) {
      const numbers = resolved.get(index);
      if (!numbers) continue;
      await tx
        .update(salesInvoiceLines)
        .set({
          lotId: numbers.lotId,
          batchNo: numbers.batchNo,
          productionDate: numbers.productionDate,
          expiryDate: numbers.expiryDate,
        })
        .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.id, line.id)));
    }
  }

  async post(tenantId: string, id: string, posting: PostingInput = {}) {
    const invoice = await this.get(tenantId, id);
    if (invoice.status === 'posted') return invoice;
    if (invoice.status !== 'draft')
      throw new DomainError('SALES_INVOICE_INVALID_STATUS', 'Only draft invoices can be posted', 409);
    if (posting.journalLines?.length && !posting.fiscalPeriodId)
      throw new DomainError(
        'SALES_FISCAL_PERIOD_REQUIRED',
        'A fiscal period is required for accounting posting',
        422,
      );

    await this.approvals.ensureApprovalRequired(tenantId, 'sales_invoice', id, {
      amount: invoice.total,
      branchId: invoice.branchId,
      costCenterId: invoice.costCenterId,
      posting: posting as unknown as Record<string, unknown>,
    });
    return this.postWithoutApproval(tenantId, id, posting);
  }

  /** Called only by the approval completion event; it cannot open a second chain. */
  async postApproved(tenantId: string, id: string, posting: PostingInput = {}) {
    return this.postWithoutApproval(tenantId, id, posting);
  }

  private async postWithoutApproval(tenantId: string, id: string, posting: PostingInput = {}) {
    // Fail fast, before a transaction is even opened: an explicit-journal posting
    // that names no period can never be written, and the approval gate must fire before
    // any inventory side effect (sales.service.spec).
    if (posting.journalLines?.length && !posting.fiscalPeriodId)
      throw new DomainError(
        'SALES_FISCAL_PERIOD_REQUIRED',
        'A fiscal period is required for accounting posting',
        422,
      );
    const posted = await withTenantTx(this.database.db, tenantId, (tx) =>
      this.postInTx(tx, tenantId, id, posting),
    );
    const invoice = posted ?? (await this.get(tenantId, id));
    // `invoice.posted` is emitted only after the transaction commits. The same helper is
    // used by the atomic POS path (`createAndPost`) so no posting path skips stock sync.
    this.announcePosted(tenantId, invoice);
    return invoice;
  }

  private announcePosted(
    tenantId: string,
    invoice: {
      id: string;
      number: string | null;
      kind: string;
      status: string;
      total: string;
      currency: string;
      partyId: string | null;
      branchId: string;
      warehouseId: string | null;
      lines: Array<{
        itemId: string | null;
        metadata: unknown;
        quantity: string;
      }>;
    },
  ): void {
    // P-C11 — announce only after the posting transaction has committed. The event
    // contains item identifiers and quantities, never provider credentials.
    void this.webhooks.emit('invoice.posted', tenantId, {
      invoiceId: invoice.id,
      number: invoice.number,
      kind: invoice.kind,
      status: invoice.status,
      total: invoice.total,
      currency: invoice.currency,
      partyId: invoice.partyId,
      branchId: invoice.branchId,
    });
    void this.domainEvents.emit({
      type: 'sales.invoice.posted',
      tenantId,
      payload: {
        invoiceId: invoice.id,
        warehouseId: invoice.warehouseId,
        lines: invoice.lines
          .filter((line) => Boolean(line.itemId))
          .map((line) => ({
            itemId: line.itemId,
            remoteItemId:
              typeof line.metadata === 'object' &&
              line.metadata &&
              typeof (line.metadata as Record<string, unknown>).remoteItemId === 'string'
                ? (line.metadata as Record<string, unknown>).remoteItemId
                : undefined,
            quantity: line.quantity,
          })),
      },
    });
  }

  /**
   * Desktop `frmPOS.DeleteInv` — "نأسف! لا يمكن حذف فاتورة بعد إغلاق اليومية".
   *
   * A sale captured by a cashier shift was counted into that shift's closing
   * cash. Editing or voiding it afterwards would change the drawer without
   * changing the report that declared it, so the shift must still be open.
   * Invoices with no shift (back-office sales) are unaffected.
   */
  private async assertShiftOpen(
    tx: DrizzleTx,
    tenantId: string,
    invoice: { shiftId?: string | null },
  ): Promise<void> {
    if (!invoice.shiftId) return;
    const [shift] = await tx
      .select({ status: shiftCloses.status })
      .from(shiftCloses)
      .where(and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, invoice.shiftId)));
    if (!shift || shift.status !== 'open') {
      throw new DomainError(
        'SALES_SHIFT_CLOSED',
        'This sale belongs to a closed cashier shift — issue a return instead',
        409,
      );
    }
  }

  /**
   * The whole posting engine inside an open transaction: gates, numbering, stock,
   * journal and settlement. Returns `undefined` only when a concurrent caller
   * already posted the invoice, so `post()` re-reads the committed row.
   */
  async postInTx(tx: DrizzleTx, tenantId: string, id: string, posting: PostingInput = {}) {
    const invoice = await this.getInTx(tx, tenantId, id);
    if (invoice.status === 'posted') return invoice;
    if (invoice.status !== 'draft')
      throw new DomainError('SALES_INVOICE_INVALID_STATUS', 'Only draft invoices can be posted', 409);
    if (invoice.kind === 'quotation')
      throw new DomainError(
        'SALES_QUOTATION_NOT_POSTABLE',
        'A quotation is converted into an invoice, never posted',
        409,
      );
    // Desktop `SaveInvoice` gates, enforced at posting (drafts may stay incomplete).
    // Service-only invoices (progress bills, retentions) carry no stock, so the
    // warehouse gate applies only when stocked lines are present; callers that hand
    // us no lines (unit mocks) stay on the conservative path and must pass one.
    const stockedLines = (invoice.lines ?? []) as Array<{ itemId?: string | null; quantity?: string }>;
    const candidateIds = stockedLines
      .filter((line) => line.itemId && money(line.quantity ?? '0').gt(0))
      .map((line) => line.itemId!);
    // Unit mocks hand us no lines at all — stay conservative and require a warehouse.
    let movesStock = invoice.lines === undefined || candidateIds.length > 0;
    if (movesStock && invoice.lines !== undefined && candidateIds.length > 0 && !invoice.warehouseId) {
      // Service-only invoices carry item rows too; check their kinds before gating.
      const kinds = await tx
        .select({ kind: items.kind })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), inArray(items.id, candidateIds)));
      movesStock = kinds.some((row) => row.kind === 'stock');
    }
    if ((invoice.kind === 'sale' || invoice.kind === 'sale_return') && movesStock && !invoice.warehouseId) {
      throw new DomainError(
        'SALES_WAREHOUSE_REQUIRED',
        'A warehouse is required to post a stock-moving invoice',
        422,
      );
    }
    if ((invoice.kind === 'sale' || invoice.kind === 'debit_note') && money(invoice.total).lt(0)) {
      throw new DomainError('SALES_TOTAL_INVALID', 'A sales total cannot be negative', 422);
    }
    if (!invoice.partyId && !invoice.cashCustomerName)
      throw new DomainError('SALES_CUSTOMER_REQUIRED', 'Party or cash customer name is required', 422);
    if (posting.journalLines?.length && !posting.fiscalPeriodId)
      throw new DomainError(
        'SALES_FISCAL_PERIOD_REQUIRED',
        'A fiscal period is required for accounting posting',
        422,
      );

    const [locked] = await tx
      .select()
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.tenantId, tenantId),
          eq(salesInvoices.id, id),
          eq(salesInvoices.status, 'draft'),
        ),
      );
    if (!locked)
      throw new DomainError('SALES_INVOICE_INVALID_STATUS', 'Only draft invoices can be posted', 409);
    const prefix =
      locked.kind === 'sale_return'
        ? 'SR-'
        : locked.kind === 'credit_note'
          ? 'CN-'
          : locked.kind === 'debit_note'
            ? 'DN-'
            : 'SI-';
    const allocated = await this.sequences.next(
      { tenantId, branchId: locked.branchId, docType: locked.kind },
      tx,
      { prefix, padding: 6 },
    );
    const number = allocated.display;
    const today = new Date().toISOString().slice(0, 10);

    if (posting.inventoryLines?.length) {
      await this.inventory.recordInTx(
        tx,
        tenantId,
        posting.inventoryLines.map((line) => ({
          ...line,
          docType: line.docType || 'sales_invoice',
          docId: id,
        })),
      );
    } else if (locked.warehouseId && (locked.kind === 'sale' || locked.kind === 'sale_return')) {
      await this.recordAutoStock(tx, tenantId, locked);
    }

    /**
     * R8 — الأرقام التسلسلية والدفعات على سطور الفاتورة، **بعد** حركة المخزون: السطر
     * الذي لم يتحرّك (صنفٌ غير مخزني، أو بيعٌ بلا مستودع) لا يُطالَب بأرقام، والسطر
     * الذي تحرّك يُحسم رقمه الآن — تُصرف القطعة في البيع وتعود في المرتجع — وتُكتب
     * الدفعة المحسومة على السطر نفسه.
     */
    await this.resolveLineNumbers(tx, tenantId, locked, await this.linesInTx(tx, tenantId, id));

    if (posting.journalLines?.length) {
      await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: locked.branchId,
        fiscalPeriodId: posting.fiscalPeriodId!,
        date: today,
        description: `Sales invoice ${number}`,
        lines: posting.journalLines,
        sourceType: 'sales_invoice',
        sourceId: id,
      });
    } else if (money(locked.total).abs().gt(0)) {
      const docType =
        locked.kind === 'sale_return'
          ? 'sales_return'
          : locked.kind === 'credit_note'
            ? 'credit_note'
            : locked.kind === 'debit_note'
              ? 'debit_note'
              : 'sales_invoice';
      const profile = await this.profiles.resolvePostProfileInTx(tx, tenantId, locked.branchId, docType);
      const fiscalPeriodId =
        posting.fiscalPeriodId ?? (await this.accounting.openPeriodForDateInTx(tx, tenantId, today));
      /**
       * R9 — سطور الفاتورة بمبالغها ومراكزها: صافي السطر يوزّع الإيراد، وتكلفته توزّع
       * رجلَي التكلفة، و`costCenterId` على السطر يسبق مركز الرأس. وهذا الاستعلام يقرأ
       * الثلاثة معاً فلم يُضَف استعلامٌ ثانٍ للفاتورة.
       */
      const costRows = await tx
        .select({
          net: salesInvoiceLines.net,
          costTotal: salesInvoiceLines.costTotal,
          costCenterId: salesInvoiceLines.costCenterId,
        })
        .from(salesInvoiceLines)
        .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, id)));
      const cogsTotal = costRows.reduce((sum, row) => sum.plus(row.costTotal ?? '0'), new Decimal(0));
      const mapping = profile.mapping as unknown as Record<string, string | null | undefined>;
      const settlementAccountIds = [
        ...(posting.settlement !== undefined &&
        posting.settlement !== 'credit' &&
        posting.settlementAccountId
          ? [posting.settlementAccountId]
          : []),
        ...(posting.settlements ?? []).map((entry) => entry.accountId),
      ];
      for (const accountId of settlementAccountIds) {
        const [settlementAccount] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
        if (!settlementAccount)
          throw new DomainError(
            'SALES_SETTLEMENT_ACCOUNT_INVALID',
            'The settlement account does not belong to this tenant',
            422,
            { field: 'settlementAccountId' },
          );
      }
      const lines = this.buildAutoJournal(
        locked,
        mapping,
        cogsTotal,
        posting.settlement ?? 'credit',
        posting.settlementAccountId,
        posting.settlements,
        costRows,
      );
      await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: locked.branchId,
        fiscalPeriodId,
        date: today,
        description: `Sales invoice ${number}`,
        lines,
        sourceType: 'sales_invoice',
        sourceId: id,
        idempotencyKey: `sales-post:${id}`,
      });
    }
    // Immediate settlement (cash/bank) is recorded as the invoice's first payment
    // in the same transaction, so a cash sale lands fully paid with a payment
    // row the portal and the statements can see — not just a flipped flag.
    // R2 — الوجه الآخر للحرس: ترحيل مرتجعٍ أو إشعارٍ يشير إلى فاتورة **ملغاة**. بلا هذا
    // الفحص يكفي أن تُنشأ المسودّة قبل الإلغاء ثم تُرحَّل بعده، فيُعاد المرجع المعلّق نفسه
    // الذي منعه الإلغاء. والفحص قبل أي كتابة: لا قيدٌ ولا مخزون لمسودّةٍ مصدرُها ملغى.
    if (
      (locked.kind === 'sale_return' || locked.kind === 'credit_note') &&
      locked.referenceInvoiceId
    ) {
      const [source] = await tx
        .select({ status: salesInvoices.status })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, tenantId),
            eq(salesInvoices.id, locked.referenceInvoiceId),
          ),
        );
      if (source?.status === 'voided') {
        throw new DomainError(
          errorCodes.SALES_REFERENCE_VOIDED,
          'The referenced sales invoice is voided',
          409,
          { referenceInvoiceId: locked.referenceInvoiceId },
        );
      }
    }
    const isReturnKind = locked.kind === 'sale_return' || locked.kind === 'credit_note';
    const splitTenders = posting.journalLines?.length ? [] : (posting.settlements ?? []);
    const settled =
      !posting.journalLines?.length &&
      !isReturnKind &&
      posting.settlement !== undefined &&
      posting.settlement !== 'credit' &&
      money(locked.total).gt(0) &&
      splitTenders.length === 0;
    if (settled) {
      await tx.insert(invoicePayments).values({
        id: newId(),
        tenantId,
        invoiceId: id,
        method: posting.settlement!,
        amount: locked.total,
        cashLocationId: posting.settlementCashLocationId ?? null,
        reference: number,
        idempotencyKey: `sales-settle:${id}`,
      });
    }
    /**
     * R4 — صفٌّ لكل طريقة. ولو كُتب صفٌّ واحد بمجموع الطرق لضاع التمييز الذي بُنيت له
     * `invoice_payments.method`: جردُ اليومية يفرز الكاش عن الشبكة عن التحويل، وصفٌّ
     * واحدٌ يقول «دُفعت» ولا يقول «بماذا».
     */
    if (splitTenders.length && !isReturnKind && !posting.journalLines?.length) {
      let tenderNo = 0;
      for (const tender of splitTenders)
        await tx.insert(invoicePayments).values({
          id: newId(),
          tenantId,
          invoiceId: id,
          method: tender.method,
          amount: tender.amount,
          cashLocationId: tender.cashLocationId ?? null,
          reference: tender.reference ?? number,
          idempotencyKey: `sales-settle:${id}:${tenderNo++}`,
        });
    }
    const tenderedTotal = splitTenders.reduce((sum, tender) => sum.plus(tender.amount), new Decimal(0));
    const paymentStatus =
      locked.total === '0' || settled || (splitTenders.length > 0 && tenderedTotal.gte(money(locked.total)))
        ? 'paid'
        : splitTenders.length > 0 && tenderedTotal.gt(0)
          ? 'partial'
          : 'unpaid';
    await tx
      .update(salesInvoices)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        paidTotal: settled
          ? locked.total
          : splitTenders.length
            ? tenderedTotal.toFixed(4)
            : locked.paidTotal,
        paymentStatus,
      })
      .where(
        and(
          eq(salesInvoices.tenantId, tenantId),
          eq(salesInvoices.id, id),
          eq(salesInvoices.status, 'draft'),
        ),
      );
    return this.getInTx(tx, tenantId, id);
  }

  /**
   * Relieves (sale) or restores (return) stock for every stocked line and stamps
   * each line's `cost_total` from the movement's average cost — the desktop
   * `SumCost` behaviour. Returns restore at the source invoice's original cost
   * (`returnAtOriginalCost`); when the source cost is unknown the current average
   * is used so the return stays value-neutral instead of corrupting the average.
   */
  /** سطور الفاتورة داخل معاملةٍ مفتوحة (R8: يحتاجها حسمُ الأرقام بعد حركة المخزون). */
  private async linesInTx(tx: DrizzleTx, tenantId: string, invoiceId: string) {
    return tx
      .select()
      .from(salesInvoiceLines)
      .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, invoiceId)));
  }

  private async recordAutoStock(
    tx: DrizzleTx,
    tenantId: string,
    locked: { id: string; kind: string; warehouseId: string | null; referenceInvoiceId: string | null },
  ): Promise<void> {
    const lines = await tx
      .select()
      .from(salesInvoiceLines)
      .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, locked.id)));
    const candidates = lines.filter((line) => line.itemId && money(line.quantity).gt(0));
    if (!candidates.length || !locked.warehouseId) return;
    // Services never touch the stock ledger — only `stock`-kind items relieve /
    // restore and stamp costs.
    const itemRows = await tx
      .select({ id: items.id, kind: items.kind })
      .from(items)
      .where(
        and(
          eq(items.tenantId, tenantId),
          inArray(
            items.id,
            candidates.map((line) => line.itemId!),
          ),
        ),
      );
    const stockable = new Set(itemRows.filter((row) => row.kind === 'stock').map((row) => row.id));
    const stocked = candidates.filter((line) => stockable.has(line.itemId!));
    if (!stocked.length) return;

    const sourceCost = new Map<string, Decimal>();
    if (locked.kind === 'sale_return' && locked.referenceInvoiceId) {
      const sourceLines = await tx
        .select()
        .from(salesInvoiceLines)
        .where(
          and(
            eq(salesInvoiceLines.tenantId, tenantId),
            eq(salesInvoiceLines.invoiceId, locked.referenceInvoiceId),
          ),
        );
      const costByItem = new Map<string, Decimal>();
      const qty = new Map<string, Decimal>();
      for (const line of sourceLines) {
        if (!line.itemId) continue;
        costByItem.set(line.itemId, (costByItem.get(line.itemId) ?? new Decimal(0)).plus(line.costTotal ?? '0'));
        qty.set(line.itemId, (qty.get(line.itemId) ?? new Decimal(0)).plus(line.quantity));
      }
      for (const [itemId, costTotal] of costByItem) {
        const totalQty = qty.get(itemId) ?? new Decimal(0);
        if (totalQty.gt(0)) sourceCost.set(itemId, costTotal.div(totalQty));
      }
    }

    const movements: InventoryLine[] = [];
    for (const line of stocked) {
      if (locked.kind === 'sale_return') {
        let unitCost = sourceCost.get(line.itemId!);
        if (!unitCost || unitCost.lte(0)) {
          const [stockBalance] = await tx
            .select({ averageCost: stockBalances.averageCost })
            .from(stockBalances)
            .where(
              and(
                eq(stockBalances.tenantId, tenantId),
                eq(stockBalances.itemId, line.itemId!),
                eq(stockBalances.warehouseId, locked.warehouseId),
              ),
            );
          unitCost = money(stockBalance?.averageCost ?? '0');
        }
        movements.push({
          itemId: line.itemId!,
          warehouseId: locked.warehouseId,
          qty: line.quantity,
          unitCost: unitCost.toFixed(4),
          direction: 'in',
          docType: 'sales_return',
          docId: locked.id,
          lineId: line.id,
          costing: 'returnAtOriginalCost',
        });
      } else {
        movements.push({
          itemId: line.itemId!,
          warehouseId: locked.warehouseId,
          qty: line.quantity,
          direction: 'out',
          docType: 'sales_invoice',
          docId: locked.id,
          lineId: line.id,
          costing: 'outAtAvg',
        });
      }
    }
    await this.inventory.recordInTx(tx, tenantId, movements);

    const txns = await tx
      .select({ lineId: inventoryTransactions.lineId, unitCost: inventoryTransactions.unitCost })
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.tenantId, tenantId), eq(inventoryTransactions.docId, locked.id)));
    for (const txn of txns) {
      if (!txn.lineId) continue;
      const line = stocked.find((candidate) => candidate.id === txn.lineId);
      if (!line) continue;
      const costTotal = money(line.quantity)
        .mul(txn.unitCost ?? '0')
        .toFixed(4);
      await tx
        .update(salesInvoiceLines)
        .set({ costTotal })
        .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.id, line.id)));
    }
  }

  /**
   * The desktop `BindToEntry` journal for sales (Sale/ProcType 1), mirrored for
   * returns and notes:
   *
   * | sale / debit note              | sale_return / credit note          |
   * |--------------------------------|----------------------------------|
   * | Dr receivable — total          | Cr receivable — total              |
   * | Cr sales — gross of discount   | Dr sales return — gross            |
   * | Dr discount given — discount   | Cr discount given — discount       |
   * | Cr VAT output — VAT            | Dr VAT output — VAT                |
   * | Cr excise — extra tax          | Dr excise — extra tax              |
   * | Dr COGS / Cr inventory — cost  | Dr inventory / Cr COGS — cost      |
   *
   * Sales is credited gross of the header discount with a separate discount leg —
   * exactly as the desktop credits `Net − VAT + TotDiscount` and debits 4100003.
   * Line discounts stay netted inside the sales leg (the cloud persists line nets,
   * not grosses). Withholding has no desktop account, so an invoice carrying it
   * must be posted with explicit journal lines.
   */
  private buildAutoJournal(
    locked: {
      kind: string;
      subtotal: string;
      invoiceDiscount: string | null;
      taxTotal: string;
      extraTax: string | null;
      withholding: string | null;
      total: string;
      partyId: string | null;
      /** R9 — مركز الرأس: الافتراضي لكل سطرٍ لا يذكر مركزاً (`InvoiceOper.cs` L2461). */
      costCenterId?: string | null;
    },
    mapping: Record<string, string | null | undefined>,
    cogsTotal: Decimal,
    settlement: 'credit' | 'cash' | 'card' | 'bank',
    settlementAccountId?: string,
    /** R4 — أكثر من طريقة دفع على الفاتورة نفسها («🔀 متعدد»). */
    settlements?: { method: 'cash' | 'card' | 'bank'; amount: string; accountId: string }[],
    /** R9 — سطور الفاتورة بأبعادها: الصافي والتكلفة والمركز. */
    plainCosts: Array<{ net: string | null; costTotal: string | null; costCenterId: string | null }> = [],
  ): { accountId: string; debit?: string; credit?: string; partyId?: string; costCenterId?: string; description?: string }[] {
    const need = (key: string): string => {
      const accountId = mapping[key];
      if (!accountId)
        throw new DomainError('SALES_PROFILE_KEY_MISSING', `Posting profile has no ${key}`, 422, {
          field: key,
        });
      return accountId;
    };
    // Cash and bank sales debit the till/bank account instead of the receivable,
    // exactly like the desktop's payment-method choice at save time. The account
    // must come from a real cash location — never from an unvalidated mapping.
    //
    // R4 — والطرق المتعدّدة تُبنى القيدَ **قبل** الجرد النقدي: كل طريقة بمدينها، وما بقي
    // إن بقي يقف على ذمة العميل. مسار «طريقة واحدة» يبقى كما كان بالحرف (مدينٌ بكامل
    // المستند على الحساب المسمّى) فلا يتغيّر قيدُ فاتورةٍ واحدة في المستودع.
    // حساب كل طريقة يأتي من موقعٍ نقدي حقيقي (لا من الخريطة)، وملكيّتُه للمستأجر تُفحص
    // قبل بناء القيد في `postInTx` — فلا يُقبل حسابٌ من خارج المستأجر ولو جاء في الطلب.
    const tenders = settlements ?? [];
    const settlementAccount =
      settlement === 'credit'
        ? need('receivableAccountId')
        : (settlementAccountId ??
          (() => {
            throw new DomainError(
              'SALES_SETTLEMENT_ACCOUNT_REQUIRED',
              'A cash or bank account is required for immediate settlement',
              422,
              { field: 'settlementAccountId' },
            );
          })());
    if (
      money(locked.withholding ?? '0')
        .abs()
        .gt(0)
    ) {
      throw new DomainError(
        'SALES_WITHHOLDING_MANUAL_POSTING',
        'Invoices with withholding need explicit journal lines',
        422,
      );
    }
    const discount = money(locked.invoiceDiscount ?? '0');
    const extra = money(locked.extraTax ?? '0');
    const tax = money(locked.taxTotal);
    const documentTotal = money(locked.total);
    const gross = money(locked.subtotal).plus(discount);
    const isReturn = locked.kind === 'sale_return' || locked.kind === 'credit_note';
    const lines: { accountId: string; debit?: string; credit?: string; partyId?: string; costCenterId?: string; description?: string }[] = [];
    /**
     * رجلُ قيدٍ واحدة. `costCenterId` تُمرَّر للأرجل التي **تصنّف مالاً** — الإيراد
     * والتكلفة والمخزون — ولا تُمرَّر لرجل الذمة ولا الصندوق ولا الضريبة: الذمة ليست
     * مركزَ تكلفة، والضريبة في الديسكتوب كذلك بلا `CCcode`. والفحص على `undefined` لا على
     * القيمة: رجلٌ **بلا مركز** (`null`) تُكتب بلا وسم، ورجلٌ بمركزٍ تُوسم.
     */
    const leg = (
      accountId: string,
      debit: Decimal,
      credit: Decimal,
      partyId: string | null = locked.partyId,
      costCenterId?: string | null,
    ): void => {
      if (debit.abs().lte(0) && credit.abs().lte(0)) return;
      lines.push({
        accountId,
        debit: debit.toFixed(4),
        credit: credit.toFixed(4),
        partyId: partyId ?? undefined,
        costCenterId: costCenterId ?? undefined,
      });
    };
    const effectiveCenter = (value: string | null): string | null => value ?? locked.costCenterId ?? null;
    /** سطور الفاتورة بمبالغها الموجبة ومركزها الفعلي. */
    const revenueRows = plainCosts
      .map((row) => ({
        amount: money(row.net ?? '0').abs(),
        costCenterId: effectiveCenter(row.costCenterId),
      }))
      .filter((row) => row.amount.gt(0));
    const cogsRows = plainCosts
      .map((row) => ({
        amount: money(row.costTotal ?? '0').abs(),
        costCenterId: effectiveCenter(row.costCenterId),
      }))
      .filter((row) => row.amount.gt(0));
    // The till/bank leg carries no party subledger — cash has no customer account.
    const settlementParty = settlement === 'credit' ? locked.partyId : null;

    /** المبالغ المدفوعة فعلاً بالنقد/الشبكة/التحويل — والباقي على الذمة. */
    const tenderedTotal = tenders.reduce((sum, tender) => sum.plus(tender.amount), new Decimal(0));
    const onAccount = documentTotal.minus(tenderedTotal);
    if (onAccount.lt(0))
      throw new DomainError(
        'SALES_SETTLEMENT_EXCEEDS_TOTAL',
        'The tenders are more than the invoice total',
        422,
        { field: 'settlements' },
      );

    if (!isReturn) {
      if (tenders.length) {
        for (const tender of tenders) leg(tender.accountId, money(tender.amount), new Decimal(0), null);
        // الباقي على ذمة العميل باسمه — فإن دُفع كلُّ شيء لم يُكتب سطرُ ذمةٍ أصلاً.
        if (onAccount.gt(0)) leg(need('receivableAccountId'), onAccount, new Decimal(0), locked.partyId);
      } else {
        leg(settlementAccount, documentTotal, new Decimal(0), settlementParty);
      }
      // R9 — الإيراد يُوزَّع على المراكز بنسبة صافي كل سطر (والباقي بعد التقريب على آخر
      // مركز)، وسطرٌ لا مركز له يأخذ مركز الرأس. وبلا مراكز تبقى رجلٌ واحدة كما كانت.
      this.legByCostCenter(
        (costCenterId, share) => leg(need('salesAccountId'), new Decimal(0), share, locked.partyId, costCenterId),
        gross,
        revenueRows,
        () => leg(need('salesAccountId'), new Decimal(0), gross),
      );
      if (discount.gt(0)) leg(need('discountGivenAccountId'), discount, new Decimal(0));
      if (tax.abs().gt(0)) leg(need('vatOutputAccountId'), new Decimal(0), tax);
      if (extra.abs().gt(0)) leg(need('exciseTaxAccountId'), new Decimal(0), extra);
    } else {
      if (tenders.length) {
        for (const tender of tenders) leg(tender.accountId, new Decimal(0), money(tender.amount), null);
        if (onAccount.gt(0)) leg(need('receivableAccountId'), new Decimal(0), onAccount, locked.partyId);
      } else {
        leg(settlementAccount, new Decimal(0), documentTotal, settlementParty);
      }
      this.legByCostCenter(
        (costCenterId, share) => leg(need('salesReturnAccountId'), share, new Decimal(0), locked.partyId, costCenterId),
        gross,
        revenueRows,
        () => leg(need('salesReturnAccountId'), gross, new Decimal(0)),
      );
      if (discount.gt(0)) leg(need('discountGivenAccountId'), new Decimal(0), discount);
      if (tax.abs().gt(0)) leg(need('vatOutputAccountId'), tax, new Decimal(0));
      if (extra.abs().gt(0)) leg(need('exciseTaxAccountId'), extra, new Decimal(0));
    }
    if (cogsTotal.abs().gt(0)) {
      // R9 — رجلَا التكلفة (المصروف والمخزون) تُوسمان بمركز السطر الذي جاءت منه التكلفة،
      // فكشف مركز الكلفة يقرأ التكلفة الحقيقية لا الإيراد وحده.
      if (!isReturn) {
        this.legByCostCenter(
          (costCenterId, share) => leg(need('cogsAccountId'), share, new Decimal(0), locked.partyId, costCenterId),
          cogsTotal,
          cogsRows,
          () => leg(need('cogsAccountId'), cogsTotal, new Decimal(0)),
        );
        this.legByCostCenter(
          (costCenterId, share) => leg(need('inventoryAccountId'), new Decimal(0), share, locked.partyId, costCenterId),
          cogsTotal,
          cogsRows,
          () => leg(need('inventoryAccountId'), new Decimal(0), cogsTotal),
        );
      } else {
        this.legByCostCenter(
          (costCenterId, share) => leg(need('inventoryAccountId'), share, new Decimal(0), locked.partyId, costCenterId),
          cogsTotal,
          cogsRows,
          () => leg(need('inventoryAccountId'), cogsTotal, new Decimal(0)),
        );
        this.legByCostCenter(
          (costCenterId, share) => leg(need('cogsAccountId'), new Decimal(0), share, locked.partyId, costCenterId),
          cogsTotal,
          cogsRows,
          () => leg(need('cogsAccountId'), new Decimal(0), cogsTotal),
        );
      }
    }
    return lines;
  }

  /**
   * R9 — رجلٌ مجمَّعة بأحد المبلغين: إن سمّت الفاتورة (أو أحد سطورها) مركزَ تكلفةٍ قُسّمت
   * الرجل على المراكز، وإلا بقيت **رجلٌ واحدة** كما كانت بالحرف. ولذلك تُعاد الدالّة بلا
   * قيمة: قرارُ البناء كلّه في `splitByCostCenter` (الوزن، والتقريب، ومن يحمل الباقي).
   */
  private legByCostCenter(
    push: (costCenterId: string | null, share: Decimal) => void,
    legTotal: Decimal,
    rows: Array<{ amount: Decimal; costCenterId: string | null }>,
    fallback: () => void,
  ): void {
    const shares = splitByCostCenter(
      legTotal,
      rows.map((row) => ({ costCenterId: row.costCenterId, weight: row.amount })),
    );
    if (!shares.length) {
      fallback();
      return;
    }
    for (const share of shares) push(share.costCenterId, share.amount);
  }

  async void(tenantId: string, id: string, reason: string) {
    if (!reason.trim()) throw new DomainError('SALES_VOID_REASON_REQUIRED', 'A void reason is required', 422);
    const invoice = await this.get(tenantId, id);
    if (invoice.status !== 'posted')
      throw new DomainError('SALES_INVOICE_INVALID_STATUS', 'Only posted invoices can be voided', 409);
    if (
      invoice.zatcaStatus === 'cleared' ||
      invoice.zatcaStatus === 'reported' ||
      invoice.zatcaStatus === 'signed'
    ) {
      throw new DomainError(
        'SALES_VOID_ZATCA_SEALED',
        'A ZATCA-sealed invoice cannot be voided — issue a credit note',
        409,
      );
    }
    if (money(invoice.paidTotal).abs().gt(0)) {
      throw new DomainError(
        'SALES_VOID_HAS_PAYMENTS',
        'Refund or unallocate the payments before voiding',
        409,
      );
    }
    // R2 — «الفاتورة تم إرجاعها سابقاً أو بعض الأصناف» (`frmInvSale.xaml.cs:1702`): الديسكتوب
    // كان يرفض **الإرجاع الثاني** بـ`isReturned` (`Class/InvoiceOper.cs:812`)، والسحابة
    // تضبط الوجهين. وهذا وجهُ الإلغاء: الإلغاء يعكس قيد الفاتورة ومخزونها، والمستند المشتقّ
    // (مرتجعٌ أو إشعار) يحتفظ بقيده ومخزونه — فيبقى `reference_invoice_id` يشير إلى فاتورة
    // ملغاة. والشرط على **المُرحَّل** وحده: المسودّة أثرها صفر — لا قيدٌ ولا مخزون — فمنعُ
    // الإلغاء بها حبسٌ بلا سبب (لا مسار لحذف مسودّة فاتورة). وترحيلها بعد الإلغاء يمنعه
    // الفحص المقابل في `post`، فيبقى البابان مسدودين بلا بابٍ ثالث مفتوح.
    const derived = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: salesInvoices.id, number: salesInvoices.number, kind: salesInvoices.kind })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, tenantId),
            eq(salesInvoices.referenceInvoiceId, id),
            eq(salesInvoices.status, 'posted'),
          ),
        ),
    );
    if (derived.length) {
      throw new DomainError(
        errorCodes.SALES_VOID_HAS_RETURNS,
        'Void the returns and notes that reference this invoice first',
        409,
        {
          references: derived.map((row) => ({ id: row.id, number: row.number, kind: row.kind })),
          count: derived.length,
        },
      );
    }
    // The desktop only flags the invoice and its entry as deleted and leaves the
    // stock relieved. The cloud reverses all three legs — journal, stock and status —
    // in one transaction, so voiding can never silently unbalance the ledger.
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      /**
       * 🔒 القفل على صف الفاتورة — كل الفحوص أعلاه قرأت الحالة **خارج** المعاملة، فطلبان
       * متزامنان على الفاتورة نفسها كانا يمرّان معاً ويعكس كلٌّ منهما القيد والمخزون:
       * بضاعة تعود مرتين ومرآتان لقيد واحد. القفل يُقرأ بعده الحالة المُودَعة، فيرى الثاني
       * `voided` ويُرفض، ولا يُعكس شيء مرتين.
       */
      const [locked] = await tx
        .select({ status: salesInvoices.status })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, id)))
        .for('update');
      if (!locked || locked.status !== 'posted')
        throw new DomainError(
          'SALES_INVOICE_INVALID_STATUS',
          'Only posted invoices can be voided',
          409,
        );
      await this.assertShiftOpen(tx, tenantId, invoice);
      const today = new Date().toISOString().slice(0, 10);
      const [entry] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.tenantId, tenantId),
            eq(journalEntries.sourceType, 'sales_invoice'),
            eq(journalEntries.sourceId, id),
          ),
        );
      if (entry) {
        /**
         * 🔁 العكس الرسمي الموحَّد — `AccountingService.reverseJournalInTx`: المرآة وحدها،
         * والأصل **يبقى `posted`**. كان هذا المسار يُبطل الأصل ويرحّل مرآته معاً، وكل
         * الأرصدة والتقارير تجمع `status = 'posted'` ⇒ يسقط مبلغ الفاتورة الملغاة من
         * ميزان المراجعة ومن رصيد الحساب ويبقى عكسه معلّقاً فيه (انحراف بمقدار الفاتورة
         * بعد كل إبطال). «لاغي» في التقارير = قيدٌ يشير إليه عكس (`reversal_of`)، فالأثر
         * الظاهر للمستخدم واحد والسجلّ المحاسبي كامل. والأبعاد (الطرف، مركز التكلفة،
         * المندوب، الفرع، العملة) تنقلها الآلية الموحَّدة.
         */
        await this.accounting.reverseJournalInTx(tx, tenantId, entry.id, {
          reason: `إبطال الفاتورة ${invoice.number ?? id}: ${reason}`,
          date: today,
          branchId: invoice.branchId,
          sourceType: 'sales_invoice',
          sourceId: id,
          actorId: getRequestContext().tenant?.userId ?? null,
          // إعادة المحاولة أو طلبان متزامنان: العكس القائم يُعاد، ولا يُنشأ ثانٍ.
          ifAlreadyReversed: 'reuse',
        });
      }

      const movements = await tx
        .select()
        .from(inventoryTransactions)
        .where(and(eq(inventoryTransactions.tenantId, tenantId), eq(inventoryTransactions.docId, id)));
      const mirrors: InventoryLine[] = movements.map((movement) => ({
        itemId: movement.itemId,
        warehouseId: movement.warehouseId,
        qty: movement.qty,
        unitCost: movement.unitCost ?? '0',
        direction: movement.direction === 'out' ? 'in' : 'out',
        docType: 'sales_void',
        docId: id,
        lineId: movement.lineId ?? undefined,
        serialId: movement.serialId ?? undefined,
        costing: movement.direction === 'out' ? 'returnAtOriginalCost' : 'outAtAvg',
      }));
      if (mirrors.length) await this.inventory.recordInTx(tx, tenantId, mirrors);

      /**
       * R8 — الإلغاء يعكس الأرقام أيضاً: قطعةٌ بيعت تعود إلى الرفّ، وقطعةٌ رجعت بمرتجع
       * تعود **مباعة** كما كانت. و«إلغاء» عند الديسكتوب حذفٌ ناعم يترك المخزون على حاله
       * (`InvoiceOper.cs:4419`) — والسحابة تعكس الأرجل الثلاث، فلا يبقى رقمٌ يُقرأ
       * «على الرفّ» وهو خارج المنشأة.
       */
      await this.inventory.releaseInvoiceLineNumbers(tx, tenantId, {
        docType: invoice.kind === 'sale_return' ? 'sales_return' : 'sales_invoice',
        docId: id,
        direction: invoice.kind === 'sale_return' ? 'in' : 'out',
        returned: invoice.kind === 'sale_return',
      });

      await tx
        .update(salesInvoices)
        .set({
          status: 'voided',
          voidedAt: new Date(),
          updatedAt: new Date(),
          zatcaStatus: `voided:${reason}`,
        })
        .where(
          and(
            eq(salesInvoices.tenantId, tenantId),
            eq(salesInvoices.id, id),
            eq(salesInvoices.status, 'posted'),
          ),
        );
    });
    const voided = await this.get(tenantId, id);
    void this.webhooks.emit('invoice.voided', tenantId, {
      invoiceId: voided.id,
      number: voided.number,
      reason,
      total: voided.total,
      currency: voided.currency,
      partyId: voided.partyId,
    });
    return voided;
  }

  async addPayment(tenantId: string, invoiceId: string, input: PaymentInput) {
    const invoice = await this.get(tenantId, invoiceId);
    if (invoice.status !== 'posted')
      throw new DomainError('SALES_INVOICE_NOT_POSTED', 'Payments require a posted invoice', 409);
    const paymentValue = money(input.amount);
    if (!paymentValue.isFinite() || paymentValue.lte(0))
      throw new DomainError('PAYMENT_AMOUNT_INVALID', 'Payment amount must be positive', 422);
    if (
      input.method !== 'credit' &&
      ['cash', 'card', 'bank', 'split'].includes(input.method) &&
      input.method === 'cash' &&
      !input.cashLocationId
    )
      throw new DomainError('CASH_LOCATION_REQUIRED', 'Cash payments require a cash location', 422);
    // يُقال صراحةً: هل كتب هذا النداء دفعةً جديدة أم أعاد صفاً موجوداً؟ فالإعلان عن
    // `invoice.paid` عند إعادة الإرسال بنفس مفتاح الالتزام يُضاعف أثر الحدث عند المستلم.
    let recorded = false;
    let paymentId = '';
    let paymentMethod: string = input.method;
    let paymentAmount: string = input.amount;
    /** ما كُتب فعلاً تحت القفل — لا ما كانت تقوله النسخة المقروءة قبل المعاملة. */
    let paidTotalAfter = money(invoice.paidTotal).toFixed(4);
    let invoiceTotal = money(invoice.total).toFixed(4);
    const result = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.tenantId, tenantId),
            eq(invoicePayments.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing) return existing;
      /**
       * 🔒 المال يُقرأ تحت القفل — `invoice` نسخة قُرئت قبل المعاملة، فدفعتان متزامنتان
       * كانتا تجمعان على الرصيد نفسه وتعبران السقف معاً. القفل على صف الفاتورة يجعل
       * الثانية تنتظر، ثم تقرأ `paid_total` المُودَع فتحسب فوقه.
       */
      const [locked] = await tx
        .select({
          status: salesInvoices.status,
          paidTotal: salesInvoices.paidTotal,
          total: salesInvoices.total,
        })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)))
        .for('update');
      if (!locked || locked.status !== 'posted')
        throw new DomainError('SALES_INVOICE_NOT_POSTED', 'Payments require a posted invoice', 409);
      const paidValue = money(locked.paidTotal).plus(paymentValue);
      if (paidValue.gt(money(locked.total).plus('0.0001')))
        throw new DomainError('PAYMENT_EXCEEDS_DUE', 'Payment exceeds invoice balance', 422);
      paidTotalAfter = paidValue.toFixed(4);
      invoiceTotal = money(locked.total).toFixed(4);
      const [payment] = await tx
        .insert(invoicePayments)
        .values({
          id: newId(),
          tenantId,
          invoiceId,
          method: input.method,
          amount: input.amount,
          cashLocationId: input.cashLocationId,
          reference: input.reference,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      await tx
        .update(salesInvoices)
        .set({
          paidTotal: paidValue.toFixed(4),
          paymentStatus: paidValue.gte(money(invoice.total)) ? 'paid' : 'partial',
          updatedAt: new Date(),
        })
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)));
      recorded = true;
      paymentId = payment?.id ?? '';
      paymentMethod = payment?.method ?? input.method;
      paymentAmount = payment?.amount ?? input.amount;
      return payment;
    });
    // `invoice.paid` تعني «سُدِّدت» لا «وصلت دفعة»: تُعلَن عند تمام السداد وحده. والدفعات
    // الجزئية مقروءةٌ من حالة الفاتورة (`partial`) — وحدثٌ يتكرّر مع كل دفعة يجعل المستلم
    // يعيد بناء حالته مراراً على معلومة ناقصة.
    if (recorded && money(paidTotalAfter).gte(money(invoiceTotal))) {
      void this.webhooks.emit('invoice.paid', tenantId, {
        invoiceId,
        paymentId,
        method: paymentMethod,
        amount: paymentAmount,
        // ما كُتب تحت القفل — لا مجموع نسخةٍ قُرئت قبل المعاملة.
        paidTotal: paidTotalAfter,
        total: invoiceTotal,
        currency: invoice.currency,
        partyId: invoice.partyId,
      });
    }
    return result;
  }

  async returnFrom(tenantId: string, sourceId: string, input: Omit<SalesInvoiceInput, 'kind'>) {
    const source = await this.get(tenantId, sourceId);
    if (source.status !== 'posted')
      throw new DomainError('SALES_RETURN_SOURCE_INVALID', 'Returns require a posted source invoice', 409);
    if (source.kind === 'sale_return')
      throw new DomainError('SALES_RETURN_SOURCE_INVALID', 'A return cannot reference another return', 422);

    const sourceQuantities = new Map<string, Decimal>();
    const requested = new Map<string, Decimal>();
    for (const line of input.lines) {
      if (!line.itemId)
        throw new DomainError('SALES_RETURN_ITEM_REQUIRED', 'Return lines must reference an item', 422);
      const quantity = money(line.quantity);
      if (!quantity.isFinite() || quantity.lte(0))
        throw new DomainError('SALES_RETURN_QUANTITY_INVALID', 'Return quantities must be positive', 422);
      sourceQuantities.set(line.itemId, sourceQuantities.get(line.itemId) ?? new Decimal(0));
      requested.set(line.itemId, (requested.get(line.itemId) ?? new Decimal(0)).plus(quantity));
    }
    for (const line of source.lines)
      if (line.itemId)
        sourceQuantities.set(
          line.itemId,
          (sourceQuantities.get(line.itemId) ?? new Decimal(0)).plus(line.quantity),
        );

    const returned = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const returnInvoices = await tx
        .select({ id: salesInvoices.id })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, tenantId),
            eq(salesInvoices.referenceInvoiceId, sourceId),
            eq(salesInvoices.kind, 'sale_return'),
          ),
        );
      const totals = new Map<string, Decimal>();
      for (const invoice of returnInvoices) {
        const lines = await tx
          .select()
          .from(salesInvoiceLines)
          .where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, invoice.id)));
        for (const line of lines)
          if (line.itemId)
            totals.set(line.itemId, (totals.get(line.itemId) ?? new Decimal(0)).plus(line.quantity));
      }
      return totals;
    });

    for (const [itemId, quantity] of requested) {
      const available = (sourceQuantities.get(itemId) ?? new Decimal(0)).minus(
        returned.get(itemId) ?? new Decimal(0),
      );
      if (quantity.gt(available))
        throw new DomainError(
          'SALES_RETURN_QUANTITY_EXCEEDED',
          'Return quantity exceeds the remaining invoice quantity',
          422,
        );
    }
    return this.create(tenantId, {
      ...input,
      kind: 'sale_return',
      partyId: input.partyId ?? source.partyId ?? undefined,
      referenceInvoiceId: sourceId,
    } as SalesInvoiceInput & { referenceInvoiceId: string });
  }

  async evaluateOffer(
    tenantId: string,
    offerId: string,
    input: { itemId: string; quantity: string; value: string },
  ) {
    const [offer] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(offers)
        .where(and(eq(offers.tenantId, tenantId), eq(offers.id, offerId))),
    );
    if (!offer) throw new DomainError('SALES_OFFER_NOT_FOUND', 'Offer was not found', 404);
    const now = Date.now();
    if (offer.status !== 'active' || now < offer.validFrom.getTime() || now > offer.validTo.getTime())
      return { eligible: false, discount: '0', reason: 'OFFER_NOT_VALID' };
    const target = money(offer.targetValue);
    const eligible =
      offer.targetType === 'value' ? money(input.value).gte(target) : money(input.quantity).gte(target);
    if (!eligible) return { eligible: false, discount: '0', reason: 'TARGET_NOT_MET' };
    const discount =
      offer.discountType === 'percent'
        ? money(input.value).mul(offer.discountValue).div(100)
        : Decimal.min(money(offer.discountValue), money(input.value));
    return { eligible: true, discount: discount.toFixed(4), offerId };
  }

  /**
   * Posting allocates the note number from the shared sequence service, the same way an
   * invoice does. It used to mint `AN-<epoch>-<id fragment>`, which is neither sequential
   * nor auditable — a tax authority expects an unbroken series per document type.
   */
  async postAdjustmentNote(tenantId: string, id: string) {
    const [note] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(salesAdjustmentNotes)
        .where(and(eq(salesAdjustmentNotes.tenantId, tenantId), eq(salesAdjustmentNotes.id, id))),
    );
    if (!note) throw new DomainError('SALES_NOTE_NOT_FOUND', 'Adjustment note was not found', 404);
    if (note.status !== 'draft')
      throw new DomainError('SALES_NOTE_INVALID_STATUS', 'Only draft adjustment notes can be posted', 409);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next(
        { tenantId, branchId: note.branchId, docType: `sales_note_${note.kind}` },
        tx,
        { prefix: note.kind === 'credit' ? 'SCN-' : 'SDN-', padding: 6 },
      );
      const [posted] = await tx
        .update(salesAdjustmentNotes)
        .set({
          status: 'posted',
          number: allocated.display,
          postedAt: new Date(),
          updatedAt: new Date(),
          updatedBy: tryGetAuthContext()?.userId,
        })
        .where(
          and(
            eq(salesAdjustmentNotes.tenantId, tenantId),
            eq(salesAdjustmentNotes.id, id),
            eq(salesAdjustmentNotes.status, 'draft'),
          ),
        )
        .returning();
      if (!posted)
        throw new DomainError('SALES_NOTE_INVALID_STATUS', 'Only draft adjustment notes can be posted', 409);
      return posted;
    });
  }

  async printData(tenantId: string, id: string) {
    return this.get(tenantId, id);
  }

  /**
   * Quotations (عرض سعر) reuse the invoice tables with `kind = 'quotation'`. They are
   * numbered on creation — a customer needs a reference before anything is agreed — but
   * they never touch stock or the ledger; the conversion below does that.
   */
  async createQuotation(tenantId: string, input: SalesInvoiceInput & { validUntil?: string }) {
    const quotation = await this.create(tenantId, { ...input, kind: 'quotation' });
    const [numbered] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next(
        { tenantId, branchId: quotation.branchId, docType: 'quotation' },
        tx,
        { prefix: 'QT-', padding: 6 },
      );
      return tx
        .update(salesInvoices)
        .set({ number: allocated.display })
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, quotation.id)))
        .returning();
    });
    return { ...quotation, number: numbered?.number ?? quotation.number };
  }

  async listQuotations(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.kind, 'quotation')))
        .orderBy(desc(salesInvoices.createdAt))
        .limit(200),
    );
  }

  /**
   * Turns a quotation into a draft sales invoice, copying the lines as they were quoted.
   * The quotation is stamped `converted` and keeps a pointer to what it became, so the
   * same quote cannot be billed twice.
   */
  async convertQuotation(tenantId: string, id: string, input: { warehouseId?: string } = {}) {
    const quotation = await this.get(tenantId, id);
    if (quotation.kind !== 'quotation')
      throw new DomainError('SALES_QUOTATION_EXPECTED', 'This document is not a quotation', 422);
    if (quotation.status === 'converted')
      throw new DomainError(
        'SALES_QUOTATION_ALREADY_CONVERTED',
        'This quotation was already converted into an invoice',
        409,
      );
    if (quotation.status !== 'draft')
      throw new DomainError('SALES_QUOTATION_INVALID_STATUS', 'Only an open quotation can be converted', 409);
    if (quotation.validUntil && quotation.validUntil < new Date().toISOString().slice(0, 10)) {
      throw new DomainError('SALES_QUOTATION_EXPIRED', 'This quotation expired; issue a new one', 422);
    }

    const invoice = await this.create(tenantId, {
      branchId: quotation.branchId,
      warehouseId: input.warehouseId ?? quotation.warehouseId ?? undefined,
      partyId: quotation.partyId ?? undefined,
      salesmanId: quotation.salesmanId ?? undefined,
      cashCustomerName: quotation.cashCustomerName ?? undefined,
      cashCustomerMobile: quotation.cashCustomerMobile ?? undefined,
      currency: quotation.currency,
      priceIncludesVat: quotation.priceIncludesVat,
      referenceInvoiceId: quotation.id,
      kind: 'sale',
      lines: quotation.lines.map((line) => ({
        itemId: line.itemId ?? undefined,
        description: line.description ?? undefined,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountRate: line.discountRate,
        taxRate: line.taxRate,
        taxGroupId: line.taxGroupId ?? undefined,
      })),
    });

    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(salesInvoices)
        .set({
          status: 'converted',
          convertedInvoiceId: invoice.id,
          updatedAt: new Date(),
          updatedBy: tryGetAuthContext()?.userId,
        })
        .where(
          and(
            eq(salesInvoices.tenantId, tenantId),
            eq(salesInvoices.id, id),
            eq(salesInvoices.status, 'draft'),
          ),
        ),
    );

    return invoice;
  }

  async createAdjustmentNote(
    tenantId: string,
    invoiceId: string,
    input: { branchId: string; kind: string; reason: string; amount: string },
  ) {
    const invoice = await this.get(tenantId, invoiceId);
    if (invoice.status !== 'posted')
      throw new DomainError('SALES_INVOICE_NOT_POSTED', 'Notes require a posted invoice', 409);
    const [note] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(salesAdjustmentNotes)
        .values({
          id: newId(),
          tenantId,
          invoiceId,
          branchId: input.branchId,
          kind: input.kind,
          reason: input.reason,
          amount: input.amount,
        })
        .returning(),
    );
    return note;
  }

  /** Notes issued against posted invoices, newest first — the source of the notes report. */
  async listAdjustmentNotes(tenantId: string, kind?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: salesAdjustmentNotes.id,
          number: salesAdjustmentNotes.number,
          kind: salesAdjustmentNotes.kind,
          status: salesAdjustmentNotes.status,
          reason: salesAdjustmentNotes.reason,
          amount: salesAdjustmentNotes.amount,
          postedAt: salesAdjustmentNotes.postedAt,
          createdAt: salesAdjustmentNotes.createdAt,
          invoiceId: salesAdjustmentNotes.invoiceId,
          invoiceNumber: salesInvoices.number,
          partyId: salesInvoices.partyId,
          invoiceTotal: salesInvoices.total,
        })
        .from(salesAdjustmentNotes)
        .leftJoin(salesInvoices, eq(salesInvoices.id, salesAdjustmentNotes.invoiceId))
        .where(
          and(
            eq(salesAdjustmentNotes.tenantId, tenantId),
            kind ? eq(salesAdjustmentNotes.kind, kind) : undefined,
          ),
        )
        .orderBy(desc(salesAdjustmentNotes.createdAt))
        .limit(200),
    );
  }

  async listOffers(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(offers).where(eq(offers.tenantId, tenantId)).orderBy(desc(offers.validFrom)),
    );
  }
  /** Validity arrives as ISO strings over HTTP; drizzle timestamps need real `Date`s. */
  async createOffer(
    tenantId: string,
    input: Omit<typeof offers.$inferInsert, 'id' | 'tenantId' | 'validFrom' | 'validTo'> & {
      validFrom: string | Date;
      validTo: string | Date;
    },
  ) {
    const validFrom = input.validFrom instanceof Date ? input.validFrom : new Date(input.validFrom);
    const validTo = input.validTo instanceof Date ? input.validTo : new Date(input.validTo);
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime()))
      throw new DomainError('SALES_OFFER_INVALID_PERIOD', 'Offer validity dates are invalid', 422);
    if (validTo < validFrom)
      throw new DomainError('SALES_OFFER_INVALID_PERIOD', 'Offer end date precedes its start date', 422);
    const [offer] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(offers)
        .values({
          ...input,
          validFrom,
          validTo,
          id: newId(),
          tenantId,
          createdBy: tryGetAuthContext()?.userId,
        })
        .returning(),
    );
    return offer;
  }
  /**
   * 👤 عميل نقدي — `Form_WPF/frmCashCustomer.xaml.cs` (`SearchCustomers`).
   *
   * The desktop does **not** keep a table of cash customers: it searches the invoices
   * themselves —
   * `SELECT CashCustomerName, CashCustomerMobile FROM inv WHERE CashCustomerMobile = @Mobile`
   * or `… WHERE CashCustomerName LIKE '%' + @Name + '%'`, both with
   * `CashCustomerName <> ''`. A walk-in is a name and a mobile written **on the sale**,
   * which is why a till can produce one without opening the customer ledger, and why
   * "find the customer" means "find a name the shop has already served".
   *
   * The cloud keeps that source of truth (`sales_invoices`) and groups it so a name is
   * an answer, not a row per visit. One intentional difference: the desktop's grid
   * starts empty and fills only on a keystroke, while a list screen has to show
   * something, so with no search term we return the most recently served names.
   */
  async cashCustomers(tenantId: string, filters: { name?: string; mobile?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          name: salesInvoices.cashCustomerName,
          mobile: salesInvoices.cashCustomerMobile,
          /** كم فاتورة بهذا الاسم — `count(*)` over the group. */
          invoices: sql<number>`count(*)::int`,
          lastAt: sql<Date>`max(${salesInvoices.createdAt})`,
        })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, tenantId),
            isNotNull(salesInvoices.cashCustomerName),
            sql`${salesInvoices.cashCustomerName} <> ''`,
            filters.mobile ? eq(salesInvoices.cashCustomerMobile, filters.mobile) : undefined,
            filters.name ? ilike(salesInvoices.cashCustomerName, `%${filters.name}%`) : undefined,
          ),
        )
        .groupBy(salesInvoices.cashCustomerName, salesInvoices.cashCustomerMobile)
        .orderBy(desc(sql`max(${salesInvoices.createdAt})`))
        .limit(100),
    );
  }

  /**
   * 🧑‍💼 بطاقة المندوب — `Form_WPF/frmSalesMen.xaml` («شاشة المندوبين»).
   *
   * `btnSave_Click` L155 writes one row of
   * `salesmen(name, comm, tel, mobile, email, notes, IS_Deleted, Profit_Comm,
   * Colle_Comm)`, and `LoadDG` L63 lists `WHERE name LIKE … AND IS_Deleted=0`.
   * `btnDelete_Click` L215 refuses nothing with «اختر مندوباً ليتم حذفه.».
   */
  async listSalesmen(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(salesmen).where(eq(salesmen.tenantId, tenantId)).orderBy(salesmen.name),
    );
  }

  /**
   * 🚐 بطاقة المندوب الموسّعة — the same `salesmen` card, read with the three links
   * distribution needs: the employee card behind it, the login account (membership/user)
   * that employee owns, and the van warehouse that holds his custody.
   *
   * No second salesman table and no second screen: `POST/PATCH /sales/salesmen` writes the
   * row, this reads it joined, and the van workspace filters it to one rep.
   */
  async listSalesmenWithCustody(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT s.id::text, s.name, s.active, s.employee_ref AS "employeeRef",
               s.commission_rate::text AS "commissionRate",
               s.collection_commission_rate::text AS "collectionCommissionRate",
               s.profit_commission_rate::text AS "profitCommissionRate",
               s.employee_id::text AS "employeeId", s.tel, s.mobile, s.email, s.notes,
               s.warehouse_id::text AS "warehouseId", s.vehicle_plate AS "vehiclePlate",
               e.employee_no AS "employeeNo", e.name AS "employeeName", e.status AS "employeeStatus",
               e.membership_id::text AS "membershipId",
               m.status AS "membershipStatus", m.display_name AS "membershipDisplayName",
               u.email AS "userEmail", u.status AS "userStatus",
               w.name AS "warehouseName", w.code AS "warehouseCode",
               w.branch_id::text AS "warehouseBranchId",
               COALESCE(rc.role_count, 0)::int AS "roleCount",
               COALESCE(rp.permissions, ARRAY[]::text[]) AS "permissions"
        FROM salesmen s
        LEFT JOIN employees e ON e.id = s.employee_id AND e.deleted_at IS NULL
        LEFT JOIN memberships m ON m.id = e.membership_id AND m.deleted_at IS NULL
        LEFT JOIN users u ON u.id = m.user_id
        LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS role_count
          FROM membership_roles mr WHERE mr.membership_id = m.id
        ) rc ON true
        LEFT JOIN LATERAL (
          SELECT array_agg(DISTINCT rpx.permission_code) AS permissions
          FROM membership_roles mrx
          JOIN role_permissions rpx ON rpx.role_id = mrx.role_id
          WHERE mrx.membership_id = m.id
        ) rp ON true
        WHERE s.tenant_id = ${tenantId}::uuid
        ORDER BY s.active DESC, s.name ASC
      `);
      return (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    });
  }

  /**
   * نسبة مئوية — the three boxes are parsed by `btnSave_Click` L174 with
   * `double.TryParse(txtComm.Text, out double c) ? c : 0`, so a box that holds no
   * number is silently a zero. The cloud refuses instead: a commission of 250% pays
   * the مندوب more than the sale is worth, and «0» was never typed by anybody.
   */
  private rateOrThrow(value: string | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    let parsed: Decimal;
    try {
      parsed = new Decimal(value);
    } catch {
      throw new DomainError('SALESMAN_RATE_INVALID', 'نسبة العمولة يجب أن تكون رقماً', 422, {
        field,
      });
    }
    if (!parsed.isFinite() || parsed.lt(0) || parsed.gt(100))
      throw new DomainError('SALESMAN_RATE_RANGE', 'نسبة العمولة يجب أن تكون بين 0 و100', 422, {
        field,
      });
    return parsed.toFixed(4);
  }

  /**
   * الموظف — the card may point at one, and only at one that exists here, and only at
   * one no other card already holds: the link is what joins his فواتير to his سندات,
   * and two cards claiming the same employee would split a مندوب in half.
   */
  private async assertEmployee(tenantId: string, employeeId: string | null | undefined, selfId?: string) {
    if (!employeeId) return;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, tenantId),
            eq(employees.id, employeeId),
            isNull(employees.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row)
      throw new DomainError('SALESMAN_EMPLOYEE_NOT_FOUND', 'الموظف غير موجود', 422, {
        field: 'employeeId',
      });
    const [taken] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: salesmen.id })
        .from(salesmen)
        .where(
          and(
            eq(salesmen.tenantId, tenantId),
            eq(salesmen.employeeId, employeeId),
            selfId ? sql`${salesmen.id} <> ${selfId}` : undefined,
          ),
        )
        .limit(1),
    );
    if (taken)
      throw new DomainError('SALESMAN_EMPLOYEE_TAKEN', 'هذا الموظف مرتبط بمندوب آخر', 409, {
        field: 'employeeId',
      });
  }

  /** The index is the authority — under concurrency the pre-check can pass and the write still lose. */
  private rethrowEmployeeTaken(error: unknown): void {
    if (isUniqueViolation(error, 'salesmen_tenant_employee_key'))
      throw new DomainError('SALESMAN_EMPLOYEE_TAKEN', 'هذا الموظف مرتبط بمندوب آخر', 409, {
        field: 'employeeId',
      });
    throw error;
  }

  async createSalesman(tenantId: string, input: SalesmanInput & { name: string }) {
    await this.assertEmployee(tenantId, input.employeeId);
    const vanWarehouseId = await this.assertWarehouse(tenantId, input.warehouseId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(salesmen)
        .values({
          id: newId(),
          tenantId,
          name: input.name,
          employeeRef: input.employeeRef,
          active: input.active ?? true,
          commissionRate: this.rateOrThrow(input.commissionRate, 'commissionRate') ?? '0',
          collectionCommissionRate:
            this.rateOrThrow(input.collectionCommissionRate, 'collectionCommissionRate') ?? '0',
          profitCommissionRate:
            this.rateOrThrow(input.profitCommissionRate, 'profitCommissionRate') ?? '0',
          employeeId: input.employeeId ?? null,
          warehouseId: vanWarehouseId,
          vehiclePlate: input.vehiclePlate ?? null,
          tel: input.tel ?? null,
          mobile: input.mobile ?? null,
          email: input.email ?? null,
          notes: input.notes ?? null,
        })
        .returning(),
    ).catch((error: unknown) => {
      this.rethrowEmployeeTaken(error);
      throw error;
    });
    return row;
  }

  /**
   * 🚐 مستودع المندوب — must be an active warehouse of this tenant, because it is the
   * destination of a real stock transfer and the balance his workspace reads. A warehouse
   * of another tenant would hand one rep another company's custody.
   */
  private async assertWarehouse(
    tenantId: string,
    warehouseId: string | null | undefined,
  ): Promise<string | null> {
    if (!warehouseId) return null;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, tenantId),
            eq(warehouses.id, warehouseId),
            eq(warehouses.isActive, true),
            isNull(warehouses.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row)
      throw new DomainError('SALESMAN_WAREHOUSE_INVALID', 'مستودع المندوب غير موجود أو غير مفعّل', 422, {
        field: 'warehouseId',
      });
    return row.id;
  }

  async updateSalesman(tenantId: string, id: string, input: SalesmanInput) {
    await this.assertEmployee(tenantId, input.employeeId, id);
    const updatedWarehouseId =
      input.warehouseId === undefined
        ? undefined
        : await this.assertWarehouse(tenantId, input.warehouseId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(salesmen)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.employeeRef === undefined ? {} : { employeeRef: input.employeeRef }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.commissionRate === undefined
            ? {}
            : { commissionRate: this.rateOrThrow(input.commissionRate, 'commissionRate') }),
          ...(input.collectionCommissionRate === undefined
            ? {}
            : {
                collectionCommissionRate: this.rateOrThrow(
                  input.collectionCommissionRate,
                  'collectionCommissionRate',
                ),
              }),
          ...(input.profitCommissionRate === undefined
            ? {}
            : {
                profitCommissionRate: this.rateOrThrow(
                  input.profitCommissionRate,
                  'profitCommissionRate',
                ),
              }),
          ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
          ...(input.warehouseId === undefined ? {} : { warehouseId: updatedWarehouseId }),
          ...(input.vehiclePlate === undefined ? {} : { vehiclePlate: input.vehiclePlate }),
          ...(input.tel === undefined ? {} : { tel: input.tel }),
          ...(input.mobile === undefined ? {} : { mobile: input.mobile }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          updatedAt: new Date(),
        })
        .where(and(eq(salesmen.tenantId, tenantId), eq(salesmen.id, id)))
        .returning(),
    ).catch((error: unknown) => {
      this.rethrowEmployeeTaken(error);
      throw error;
    });
    if (!row) throw new DomainError('NOT_FOUND', 'Salesman was not found', 404);
    return row;
  }
  /**
   * A salesman who is already named on invoices is deactivated rather than deleted, so
   * commission and performance reports for closed periods keep their subject.
   */
  async deleteSalesman(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const used = await tx.execute(
        sql`SELECT EXISTS (SELECT 1 FROM sales_invoices WHERE tenant_id = ${tenantId} AND salesman_id = ${id}) AS used`,
      );
      if ((used.rows[0] as { used: boolean }).used) {
        const [row] = await tx
          .update(salesmen)
          .set({ active: false, updatedAt: new Date() })
          .where(and(eq(salesmen.tenantId, tenantId), eq(salesmen.id, id)))
          .returning();
        if (!row) throw new DomainError('NOT_FOUND', 'Salesman was not found', 404);
        return { id, archived: true, deleted: false };
      }
      const result = await tx
        .delete(salesmen)
        .where(and(eq(salesmen.tenantId, tenantId), eq(salesmen.id, id)));
      if (!result.rowCount) throw new DomainError('NOT_FOUND', 'Salesman was not found', 404);
      return { id, archived: false, deleted: true };
    });
  }

  /**
   * 📋 طباعة فواتير مندوب وعمولاتهم — `Form_WPF/frmInvBySalesMen.xaml`
   * («مبيعات مندوب خلال فترة»), opened by `frmSalesMen.xaml.cs` L272 `Button1_Click`.
   *
   * The window reads three ledgers and prints one row per document:
   *
   *   • `ShowInvoiceResults` L196 — `Inv` with `salesman > 0`, `IS_Deleted=0`,
   *     `inv_type IN (2,3)` and `proc_type IN (1,2)`, narrowed by the مندوب, by the
   *     branch (`MainClass.BranchNo`) and by the two dates unless «كل الفترة» is on.
   *     `ProcessInvoiceRow` L254 sums `val1 × exchange_price` per invoice, takes VAT
   *     out when prices include it, then `minus` and the lines' discounts (L307) to
   *     reach `netForComm` — which is what the cloud already stores in `subtotal`
   *     (`calculateInvoiceTotals` nets VAT and both discounts out first).
   *   • `LoadCreditNotes` L351 — `Notes WHERE Doc_Type=2 AND Inv_No=…`: one
   *     «إشعار مدين» row per debit note hanging off a **sale** invoice, and never off
   *     a مرتجع.
   *   • `LoadReceiptsByType` L411 — «سند قبض عميل» (`ReceiptType=5`) and «سند قبض»
   *     (`ReceiptType=7`), always inside the two dates.
   *
   * and three commissions a row (`ProcessInvoiceRow` L330–L341):
   *
   *   عمولة المبيعات  = comm        % × netForComm
   *   عمولة التحصيل   = Colle_Comm  % × netForComm  — only when `pay_type` is set
   *   عمولة الربح     = Profit_Comm % × (netForComm − AvrgCost), and only when that is +
   *
   * `RecalculateSummary` L482 adds `Value` once per row and flips each commission by
   * `isPlus`. The one place the cloud does not follow it: `sumVal += row.Value` ignores
   * `isPlus`, so a مرتجع *raises* the desktop's «💰 إجمالي القيمة». The total here is
   * signed, like the «💰 الإجمالي» of «حركات الموظف» (Phase 08 part five) — a report
   * that grows when the goods come back would pay commission on a refund.
   */
  async salesmanCommissions(tenantId: string, query: SalesmanCommissionQuery = {}) {
    // «🌐 الكل» and «كل الفترة» are both checked in the XAML (L262/L287), and the two
    // date pickers open on today (`FrmInvBySalesMen_Loaded` L58).
    /**
     * «🌐 الكل» is checked in the XAML, but a caller who sends a مندوب without saying
     * «الكل» means that مندوب — `frmRptSalary` defaults «كل الفترة» the same way when no
     * month is sent. Sending both is still the screen's job.
     */
    const allSalesmen = query.allSalesmen ?? !query.salesmanId;
    const allPeriod = query.allPeriod ?? true;
    const today = new Date().toISOString().slice(0, 10);
    const from = query.from ?? today;
    const to = query.to ?? today;

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const cards = await tx
        .select()
        .from(salesmen)
        .where(eq(salesmen.tenantId, tenantId))
        .orderBy(salesmen.name);
      /**
       * With «🌐 الكل» off and nothing picked the desktop filters nothing at all
       * (`ShowInvoiceResults` L187), so every active card stays in scope.
       */
      const scope = cards.filter(
        (card) =>
          card.active !== false &&
          (allSalesmen || !query.salesmanId || card.id === query.salesmanId),
      );
      // A document may name either side of the card: a فاتورة writes the مندوب's id, a
      // سند قبض writes the employee's (`vouchers.salesman_id`, migration 0025). The
      // desktop joins both to one `salesmen` row; the cloud joins through the link.
      const byCardId = new Map(scope.map((card) => [card.id, card]));
      const byEmployeeId = new Map(
        scope.filter((card) => card.employeeId).map((card) => [card.employeeId as string, card]),
      );
      const namedBy = [...byCardId.keys(), ...byEmployeeId.keys()];
      const rows: SalesmanCommissionRow[] = [];
      const push = (row: Omit<SalesmanCommissionRow, 'seq'>) =>
        rows.push({ seq: rows.length + 1, ...row });
      /** `Math.Round(x, 2)` in `ProcessInvoiceRow` L330 — two decimals, half up. */
      const pct = (percent: string, base: Decimal) =>
        base.times(new Decimal(percent)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      if (namedBy.length > 0) {
        const invoices = await tx
          .select({
            id: salesInvoices.id,
            number: salesInvoices.number,
            kind: salesInvoices.kind,
            date: sql<string>`${salesInvoices.postedAt}::date`,
            subtotal: salesInvoices.subtotal,
            /**
             * `AvrgCost = SUM(val × AvrgCost)` L257 — the cost of what left the
             * warehouse. It lives on the lines (`recordAutoStock` writes it at
             * posting), so the report sums them rather than trusting a header total.
             */
            costTotal: sql<string>`COALESCE((SELECT SUM(l.cost_total) FROM sales_invoice_lines l WHERE l.invoice_id = ${salesInvoices.id}), 0)`,
            paidTotal: salesInvoices.paidTotal,
            salesmanId: salesInvoices.salesmanId,
            branchName: branches.nameAr,
            refNumber: sql<string | null>`(SELECT ref.number FROM sales_invoices ref WHERE ref.id = ${salesInvoices.referenceInvoiceId})`,
            isPos: sql<boolean>`(${salesInvoices.orderType} IS NOT NULL OR ${salesInvoices.shiftId} IS NOT NULL)`,
          })
          .from(salesInvoices)
          .leftJoin(branches, eq(branches.id, salesInvoices.branchId))
          .where(
            and(
              eq(salesInvoices.tenantId, tenantId),
              // المرحَّل وحده — `IS_Deleted=0` plus the cloud's own «مُلغى».
              eq(salesInvoices.status, 'posted'),
              isNull(salesInvoices.voidedAt),
              // `proc_type IN (1,2)` — a فاتورة and its مرتجع, never a مسوَّدة.
              inArray(salesInvoices.kind, ['sale', 'sale_return']),
              inArray(salesInvoices.salesmanId, namedBy),
              allPeriod ? undefined : gte(sql`${salesInvoices.postedAt}::date`, from),
              allPeriod ? undefined : lte(sql`${salesInvoices.postedAt}::date`, to),
              query.branchId ? eq(salesInvoices.branchId, query.branchId) : undefined,
            ),
          )
          .orderBy(asc(sql`${salesInvoices.postedAt}::date`), asc(salesInvoices.number));

        const saleIds = invoices.filter((row) => row.kind === 'sale').map((row) => row.id);
        const notes = saleIds.length
          ? await tx
              .select({
                id: salesAdjustmentNotes.id,
                number: salesAdjustmentNotes.number,
                invoiceId: salesAdjustmentNotes.invoiceId,
                amount: salesAdjustmentNotes.amount,
                date: sql<string>`${salesAdjustmentNotes.postedAt}::date`,
              })
              .from(salesAdjustmentNotes)
              .where(
                and(
                  eq(salesAdjustmentNotes.tenantId, tenantId),
                  // `Doc_Type=2` — «إشعار مدين», the note that *raises* what a customer owes.
                  eq(salesAdjustmentNotes.kind, 'debit'),
                  // المسوَّد لا يُحصى — a note that was never posted is not a movement yet.
                  eq(salesAdjustmentNotes.status, 'posted'),
                  inArray(salesAdjustmentNotes.invoiceId, saleIds),
                ),
              )
              .orderBy(asc(salesAdjustmentNotes.postedAt), asc(salesAdjustmentNotes.number))
          : [];
        const notesByInvoice = new Map<string, (typeof notes)[number][]>();
        for (const note of notes) {
          const key = String(note.invoiceId);
          notesByInvoice.set(key, [...(notesByInvoice.get(key) ?? []), note]);
        }

        for (const invoice of invoices) {
          const card =
            (invoice.salesmanId ? byCardId.get(invoice.salesmanId) : undefined) ??
            (invoice.salesmanId ? byEmployeeId.get(invoice.salesmanId) : undefined);
          // `if (salTable.Rows.Count == 0) return;` L302 — a document whose مندوب has no
          // card is not a commission row, exactly as the desktop drops it.
          if (!card) continue;
          const value = new Decimal(invoice.subtotal ?? '0');
          const cogs = new Decimal(invoice.costTotal ?? '0');
          const profitBase = value.minus(cogs).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          const isPlus: 1 | -1 = invoice.kind === 'sale' ? 1 : -1;
          /**
           * «عمولة التحصيل فقط إذا كان نوع الدفع موجودًا» L331 — the desktop reads
           * `Inv.pay_type`; the cloud's settled half of an invoice is its `paid_total`
           * (a cash/card/bank posting fills it at once, and `addPayment` adds to it).
           */
          const settled = new Decimal(invoice.paidTotal ?? '0').gt(0);
          push({
            movementType: invoiceLabel(invoice.kind, invoice.isPos),
            date: invoice.date,
            documentId: invoice.id,
            number: invoice.number,
            refNumber: invoice.refNumber ?? null,
            salesmanId: card.id,
            salesmanName: card.name,
            branchName: invoice.branchName ?? null,
            value: value.toFixed(4),
            salesCommission: pct(card.commissionRate, value).toFixed(4),
            collectionCommission: settled
              ? pct(card.collectionCommissionRate, value).toFixed(4)
              : '0.0000',
            profitCommission: profitBase.gt(0)
              ? pct(card.profitCommissionRate, profitBase).toFixed(4)
              : '0.0000',
            isPlus,
          });
          // «إشعار مدين» — the commission the note takes back, `IsPlus = -1` (L390).
          for (const note of notesByInvoice.get(invoice.id) ?? []) {
            const noteValue = new Decimal(note.amount ?? '0');
            push({
              movementType: 'إشعار مدين',
              date: note.date,
              documentId: note.id,
              number: note.number,
              refNumber: invoice.number,
              salesmanId: card.id,
              salesmanName: card.name,
              branchName: invoice.branchName ?? null,
              value: noteValue.toFixed(4),
              salesCommission: pct(card.commissionRate, noteValue).toFixed(4),
              collectionCommission: pct(card.collectionCommissionRate, noteValue).toFixed(4),
              profitCommission: '0.0000',
              isPlus: -1,
            });
          }
        }

        const employeeIds = [...byEmployeeId.keys()];
        const receipts = employeeIds.length
          ? await tx
              .select({
                id: vouchers.id,
                number: vouchers.number,
                date: vouchers.date,
                amount: vouchers.amount,
                netAmount: vouchers.netAmount,
                subtype: vouchers.subtype,
                salesmanId: vouchers.salesmanId,
                branchName: branches.nameAr,
              })
              .from(vouchers)
              .leftJoin(branches, eq(branches.id, vouchers.branchId))
              .where(
                and(
                  eq(vouchers.tenantId, tenantId),
                  eq(vouchers.kind, 'receipt'),
                  eq(vouchers.status, 'posted'),
                  isNull(vouchers.voidedAt),
                  // `ReceiptType` 5 «سند قبض عميل» and 7 «سندات قبض».
                  inArray(vouchers.subtype, ['customer', 'account', 'other']),
                  inArray(vouchers.salesmanId, employeeIds),
                  /**
                   * `LoadReceiptsByType` L426 — the receipts are inside the two dates
                   * **always**; «كل الفترة» lifts the filter from the invoices only.
                   * Ported as it stands, and the screen says so.
                   */
                  gte(vouchers.date, from),
                  lte(vouchers.date, to),
                ),
              )
              .orderBy(asc(vouchers.date), asc(vouchers.number))
          : [];

        for (const receipt of receipts) {
          const card = receipt.salesmanId ? byEmployeeId.get(receipt.salesmanId) : undefined;
          if (!card) continue;
          const received = new Decimal(receipt.amount ?? '0');
          const net = new Decimal(receipt.netAmount ?? '0');
          /**
           * `baseVal = NetVal × 100 / 115` L452 — the desktop pulls a hardcoded 15% VAT
           * out of the receipt. The cloud's سند carries its VAT as a field
           * (`net_amount` = amount − vat), which is the same number without the guess.
           */
          const base = net.gt(0) ? net : received;
          push({
            movementType: receipt.subtype === 'customer' ? 'سند قبض عميل' : 'سند قبض',
            date: receipt.date,
            documentId: receipt.id,
            number: receipt.number,
            refNumber: null,
            salesmanId: card.id,
            salesmanName: card.name,
            branchName: receipt.branchName ?? null,
            value: base.toFixed(4),
            salesCommission: '0.0000',
            // L453 — the collection commission is on what was actually received.
            collectionCommission: pct(card.collectionCommissionRate, received).toFixed(4),
            profitCommission: '0.0000',
            isPlus: 1,
          });
        }
      }

      const totals = rows.reduce(
        (running, row) => ({
          value: running.value.plus(new Decimal(row.value).times(row.isPlus)),
          sales: running.sales.plus(new Decimal(row.salesCommission).times(row.isPlus)),
          collection: running.collection.plus(
            new Decimal(row.collectionCommission).times(row.isPlus),
          ),
          profit: running.profit.plus(new Decimal(row.profitCommission).times(row.isPlus)),
        }),
        {
          value: new Decimal(0),
          sales: new Decimal(0),
          collection: new Decimal(0),
          profit: new Decimal(0),
        },
      );
      const countOf = (label: string) => rows.filter((row) => row.movementType === label).length;

      return {
        data: {
          salesmanId: !allSalesmen && query.salesmanId ? query.salesmanId : null,
          salesmanName:
            (!allSalesmen && query.salesmanId ? byCardId.get(query.salesmanId)?.name : null) ??
            null,
          allSalesmen,
          allPeriod,
          from,
          to,
          branchId: query.branchId ?? null,
          summary: {
            /** 💰 إجمالي القيمة — signed: sales less returns and notes (see the note above). */
            totalValue: totals.value.toFixed(4),
            /** 📈 ع. المبيعات */
            salesCommission: totals.sales.toFixed(4),
            /** 💳 ع. التحصيل */
            collectionCommission: totals.collection.toFixed(4),
            /** 📊 ع. الربح */
            profitCommission: totals.profit.toFixed(4),
            invoices: rows.filter((row) => row.movementType.startsWith('فاتورة')).length,
            notes: countOf('إشعار مدين'),
            receipts: rows.filter((row) => row.movementType.startsWith('سند')).length,
            rows: rows.length,
          },
          rows,
        },
      };
    });
  }
}

/**
 * 📌 نوع الحركة — `ProcessInvoiceRow` L322: `inv_type` 2 is a مبيعات document and 3 is
 * نقطة بيع; `proc_type` 1 is the فاتورة and 2 its مرتجع. The four labels are verbatim.
 */
function invoiceLabel(kind: string, isPos: boolean): string {
  if (kind === 'sale_return') return isPos ? 'فاتورة مرتجع نقطة بيع' : 'فاتورة مرتجع بيع';
  return isPos ? 'فاتورة نقطة بيع' : 'فاتورة بيع';
}

export const salesService = { calculateInvoiceTotals };
