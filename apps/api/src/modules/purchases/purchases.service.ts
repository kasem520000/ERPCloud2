/* eslint-disable no-restricted-syntax */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { allocateLandedCost, calculateInvoiceTotals, DomainError, errorCodes, newId } from '@erp/contracts';
import {
  accounts,
  inventoryTransactions,
  items,
  journalEntries,
  parties,
  paymentAllocations,
  purchaseAdjustmentNotes,
  purchaseInvoiceCosts,
  purchaseInvoiceLines,
  purchaseInvoices,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { getRequestContext } from '../../request-context/request-context.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { AccountingService, type JournalLineInput } from '../accounting/accounting.service.js';
import { splitByCostCenter } from '../../common/cost-center-split.js';
import { InventoryService, type InventoryLine } from '../inventory/inventory.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';
import { SequencesService } from '../platform-services/index.js';
import { ApprovalService } from '../approvals/approvals.service.js';

/**
 * سطر فاتورة الشراء — و`serialNos` و`batchNo` وتاريخاه (R8) هي أرقام العبوة كما يقرؤها
 * المُدخِل، وهي في الديسكتوب على السطر نفسه (`Class/InvoiceOper.cs` L1635). تُحفظ في
 * المسودّة، ويُحسم معناها عند الترحيل: الإدخال **يُنشئ** الأرقام التسلسلية ويبحث عن
 * الدفعة أو يُنشئها، والمرتجع يأخذ الرقم خارج الرفّ.
 */
export type PurchaseLineInput = {
  itemId: string;
  description?: string;
  quantity: string;
  unitPrice: string;
  discountRate?: string;
  discountAmount?: string;
  taxRate?: string;
  taxGroupId?: string;
  serialNos?: string[];
  batchNo?: string;
  productionDate?: string;
  expiryDate?: string;
  lotId?: string;
  /** R9 — 📊 مركز تكلفة السطر (`Inv_Sub.ItemCostCenter`); يسبق مركز الرأس عند وسم القيد. */
  costCenterId?: string;
};
export type PurchaseInvoiceInput = {
  branchId: string;
  warehouseId?: string;
  partyId: string;
  costCenterId?: string;
  referenceInvoiceId?: string;
  kind?: 'purchase' | 'purchase_return';
  supplierReferenceNo?: string;
  supplierReferenceDate?: string;
  currency?: string;
  priceIncludesVat?: boolean;
  invoiceDiscount?: string;
  extraTax?: string;
  withholding?: string;
  landedCostAlloc?: 'qty' | 'value';
  /** OCR may create an incomplete header draft before the reviewer maps item lines. */
  headerTotals?: { subtotal: string; tax: string; total: string };
  lines: PurchaseLineInput[];
};
export type PurchaseCostInput = { costName: string; amount: string; allocationTarget?: 'inventory' | 'expense'; costCenterId?: string; accountId?: string };
export type PurchasePostingInput = { fiscalPeriodId?: string; journalLines?: JournalLineInput[]; settlement?: 'credit' | 'cash' | 'bank'; settlementAccountId?: string; settlementCashLocationId?: string };
export type PurchasePaymentInput = { amount: string; idempotencyKey?: string; voucherId?: string; reference?: string };

const money = (value: string) => new Decimal(value);

/**
 * 🔢 الأرقام التسلسلية كما كتبها المُدخِل: مقصوصة، بلا فراغات ولا تكرار — فالرقم الواحد
 * مرّتين على سطرٍ يعني قطعةً واحدة، ولا معنى له في مستندٍ يحرّك قطعتين (R8).
 */
function cleanSerialNos(values?: string[]): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}
const landedCostMethod = (value: string | null | undefined): 'qty' | 'value' => value === 'qty' ? 'qty' : 'value';

@Injectable()
export class PurchasesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly customFields: CustomFieldsService,
    private readonly inventory: InventoryService,
    private readonly accounting: AccountingService,
    private readonly sequences: SequencesService,
    private readonly profiles: PostingProfilesService,
    private readonly approvals: ApprovalService,
  ) {}

  async list(tenantId: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(purchaseInvoices).where(eq(purchaseInvoices.tenantId, tenantId)).orderBy(desc(purchaseInvoices.createdAt)).limit(100));
    return this.customFields.decorate(tenantId, 'invoice', rows);
  }

  async get(tenantId: string, id: string) {
    const [invoice] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, id))));
    if (!invoice) throw new DomainError('PURCHASE_INVOICE_NOT_FOUND', 'Purchase invoice was not found', 404);
    const lines = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(purchaseInvoiceLines).where(and(eq(purchaseInvoiceLines.tenantId, tenantId), eq(purchaseInvoiceLines.invoiceId, id))));
    const costs = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(purchaseInvoiceCosts).where(and(eq(purchaseInvoiceCosts.tenantId, tenantId), eq(purchaseInvoiceCosts.invoiceId, id))));
    /**
     * R3 — كان `paidTotal`/`paymentStatus` وحدهما يُظهران الدفعة: صفُّ التخصيص مكتوبٌ
     * في `payment_allocations` ولا يُقرأ. الآن تُعاد كما تعيدها فاتورة البيع، فتستطيع
     * الشاشة أن تعرض الدفعات (وأولها الدفعة النقدية التي كتبها الترحيل نفسه).
     */
    const payments = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.invoiceId, id)))
        .orderBy(paymentAllocations.allocatedAt),
    );
    const source = { ...invoice, lines, costs, payments };
    const [decorated] = await this.customFields.decorate(tenantId, 'invoice', [source]);
    return decorated ?? source;
  }

  async create(tenantId: string, input: PurchaseInvoiceInput) {
    if (!input.lines.length && !input.headerTotals) {
      throw new DomainError('PURCHASE_LINES_REQUIRED', 'At least one purchase line is required unless a header draft is explicitly requested', 422);
    }
    const id = newId();
    const totals = input.lines.length
      ? calculateInvoiceTotals({
          lines: input.lines,
          priceIncludesVat: input.priceIncludesVat,
          invoiceDiscount: input.invoiceDiscount,
          extraTax: input.extraTax,
          withholding: input.withholding,
        })
      : {
          lines: [],
          subtotal: input.headerTotals?.subtotal ?? '0',
          discount: input.invoiceDiscount ?? '0',
          taxable: input.headerTotals?.subtotal ?? '0',
          tax: input.headerTotals?.tax ?? '0',
          extraTax: input.extraTax ?? '0',
          withholding: input.withholding ?? '0',
          total: input.headerTotals?.total ?? '0',
        };
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      // R9 — كل مركزٍ مُسمّى (رأساً أو على سطر) يُفحَص قبل أي كتابة: مركزُ مستأجرٍ آخر
      // ليس مركزاً عندنا. وهذا مسار الإنشاء الوحيد لكل فواتير الشراء ومردوداتها.
      await this.accounting.assertCostCentersInTx(tx, tenantId, [
        input.costCenterId,
        ...input.lines.map((line) => line.costCenterId),
      ]);
      let resolvedPartyId = input.partyId?.trim() || '';
      if (!resolvedPartyId) {
        const [existingDefault] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.tenantId, tenantId),
              isNull(parties.deletedAt),
              sql`(${parties.code} = 'SUPP-GEN' OR ${parties.name} = 'مورد عام')`,
            ),
          )
          .limit(1);
        if (existingDefault) {
          resolvedPartyId = existingDefault.id;
        } else {
          resolvedPartyId = newId();
          await tx
            .insert(parties)
            .values({
              id: resolvedPartyId,
              tenantId,
              code: 'SUPP-GEN',
              kind: 'supplier',
              name: 'مورد عام',
              legalName: 'مورد عام',
              creditLimit: '0',
            })
            .onConflictDoNothing();
        }
      }
      const [supplier] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, resolvedPartyId)));
      if (!supplier || !['supplier', 'both'].includes(supplier.kind)) throw new DomainError('PURCHASE_SUPPLIER_REQUIRED', 'Purchase invoices require a supplier party', 422);
      await tx.insert(purchaseInvoices).values({ id, tenantId, createdBy: tryGetAuthContext()?.userId, branchId: input.branchId, warehouseId: input.warehouseId, partyId: resolvedPartyId, costCenterId: input.costCenterId ?? null, referenceInvoiceId: input.referenceInvoiceId, kind: input.kind ?? 'purchase', supplierReferenceNo: input.supplierReferenceNo, supplierReferenceDate: input.supplierReferenceDate, currency: input.currency ?? 'SAR', priceIncludesVat: input.priceIncludesVat ?? false, landedCostAlloc: input.landedCostAlloc ?? 'value', invoiceDiscount: totals.discount, extraTax: totals.extraTax, withholding: totals.withholding, subtotal: totals.subtotal, taxTotal: totals.tax, total: totals.total, status: 'draft' });
      if (input.lines.length > 0) {
        await tx.insert(purchaseInvoiceLines).values(
          input.lines.map((line, index) => {
            const calculated = totals.lines[index];
            if (!calculated) throw new DomainError('PURCHASE_TOTALS_INVALID', 'Purchase totals do not match invoice lines', 422);
            return {
              id: newId(),
              tenantId,
              invoiceId: id,
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
              costCenterId: line.costCenterId ?? null,
              batchNo: line.batchNo?.trim() || null,
              productionDate: line.productionDate?.trim() || null,
              expiryDate: line.expiryDate?.trim() || null,
            };
          }),
        );
      }
    });
    return this.get(tenantId, id);
  }

  /** Replace the lines of an existing OCR/header draft without creating a second invoice. */
  async replaceDraftLines(tenantId: string, id: string, lines: PurchaseLineInput[]) {
    if (!lines.length) throw new DomainError('PURCHASE_LINES_REQUIRED', 'At least one purchase line is required', 422);
    const invoice = await this.get(tenantId, id);
    if (invoice.status !== 'draft') throw new DomainError('PURCHASE_INVOICE_IMMUTABLE', 'Only draft purchase invoices can be changed', 409);
    const totals = calculateInvoiceTotals({ lines, priceIncludesVat: invoice.priceIncludesVat, invoiceDiscount: invoice.invoiceDiscount });

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.accounting.assertCostCentersInTx(tx, tenantId, lines.map((line) => line.costCenterId));
      const [supplier] = await tx
        .select({ id: parties.id, kind: parties.kind })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, invoice.partyId)))
        .limit(1);
      if (!supplier || !['supplier', 'both'].includes(supplier.kind)) {
        throw new DomainError('PURCHASE_SUPPLIER_REQUIRED', 'Purchase invoices require a supplier party', 422);
      }
      await tx.delete(purchaseInvoiceLines).where(and(eq(purchaseInvoiceLines.tenantId, tenantId), eq(purchaseInvoiceLines.invoiceId, id)));
      await tx.insert(purchaseInvoiceLines).values(
        lines.map((line, index) => {
          const calculated = totals.lines[index];
          if (!calculated) throw new DomainError('PURCHASE_TOTALS_INVALID', 'Purchase totals do not match invoice lines', 422);
          return {
            id: newId(),
            tenantId,
            invoiceId: id,
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
            costCenterId: line.costCenterId ?? null,
            batchNo: line.batchNo?.trim() || null,
            productionDate: line.productionDate?.trim() || null,
            expiryDate: line.expiryDate?.trim() || null,
          };
        }),
      );
      await tx
        .update(purchaseInvoices)
        .set({
          subtotal: totals.subtotal,
          taxTotal: totals.tax,
          total: totals.total,
          invoiceDiscount: totals.discount,
          updatedAt: new Date(),
          version: invoice.version + 1,
        })
        .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, id), eq(purchaseInvoices.status, 'draft')));
    });
    return this.get(tenantId, id);
  }

  async updateDraft(tenantId: string, id: string, input: Partial<PurchaseInvoiceInput>) {
    const invoice = await this.get(tenantId, id);
    if (invoice.status !== 'draft') throw new DomainError('PURCHASE_INVOICE_IMMUTABLE', 'Only draft purchase invoices can be changed', 409);
    if (input.lines) return this.replaceDraftLines(tenantId, id, input.lines);
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(purchaseInvoices).set({ warehouseId: input.warehouseId, supplierReferenceNo: input.supplierReferenceNo, supplierReferenceDate: input.supplierReferenceDate, landedCostAlloc: input.landedCostAlloc, costCenterId: input.costCenterId, updatedAt: new Date() }).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, id))));
    return this.get(tenantId, id);
  }

  async addCost(tenantId: string, invoiceId: string, input: PurchaseCostInput) {
    const invoice = await this.get(tenantId, invoiceId);
    if (invoice.status !== 'draft') throw new DomainError('PURCHASE_COST_IMMUTABLE', 'Costs can be edited only while invoice is draft', 409);
    const amount = money(input.amount);
    if (!amount.isFinite() || amount.lt(0)) throw new DomainError('PURCHASE_COST_INVALID', 'Cost amount must be non-negative', 422);
    const [cost] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(purchaseInvoiceCosts).values({ id: newId(), tenantId, invoiceId, costName: input.costName, amount: input.amount, allocationTarget: input.allocationTarget ?? 'inventory', costCenterId: input.costCenterId, accountId: input.accountId }).returning());
    return cost;
  }

  async deleteCost(tenantId: string, invoiceId: string, costId: string) {
    const invoice = await this.get(tenantId, invoiceId);
    if (invoice.status !== 'draft') throw new DomainError('PURCHASE_COST_IMMUTABLE', 'Costs can be edited only while invoice is draft', 409);
    await withTenantTx(this.database.db, tenantId, (tx) => tx.delete(purchaseInvoiceCosts).where(and(eq(purchaseInvoiceCosts.tenantId, tenantId), eq(purchaseInvoiceCosts.invoiceId, invoiceId), eq(purchaseInvoiceCosts.id, costId))));
    return { id: costId, deleted: true };
  }

  previewLandedCost(input: { lines: Array<{ lineId?: string; itemId?: string; quantity: string; net: string; unitCost?: string }>; costs: Array<{ amount: string }>; method: 'qty' | 'value' }) {
    return allocateLandedCost(input);
  }

  async previewInvoiceLandedCost(tenantId: string, invoiceId: string) {
    const invoice = await this.get(tenantId, invoiceId);
    return this.previewLandedCost({ method: landedCostMethod(invoice.landedCostAlloc), lines: invoice.lines.map((line) => ({ lineId: line.id, itemId: line.itemId, quantity: line.quantity, net: line.net })), costs: invoice.costs.filter((cost) => cost.allocationTarget === 'inventory').map((cost) => ({ amount: cost.amount })) });
  }

  async post(tenantId: string, id: string, posting: PurchasePostingInput = {}) {
    const invoice = await this.get(tenantId, id);
    if (invoice.status === 'posted') return invoice;
    if (invoice.status !== 'draft') throw new DomainError('PURCHASE_INVOICE_INVALID_STATUS', 'Only draft purchases can be posted', 409);
    await this.approvals.ensureApprovalRequired(tenantId, 'purchase_invoice', id, {
      amount: invoice.total,
      branchId: invoice.branchId,
      costCenterId: invoice.costCenterId,
      posting: posting as unknown as Record<string, unknown>,
    });
    return this.postWithoutApproval(tenantId, id, posting);
  }

  /** Called only by the approval completion event; it cannot open a second chain. */
  async postApproved(tenantId: string, id: string, posting: PurchasePostingInput = {}) {
    return this.postWithoutApproval(tenantId, id, posting);
  }

  private async postWithoutApproval(tenantId: string, id: string, posting: PurchasePostingInput = {}) {
    const invoice = await this.get(tenantId, id);
    if (invoice.status === 'posted') return invoice;
    if (invoice.status !== 'draft') throw new DomainError('PURCHASE_INVOICE_INVALID_STATUS', 'Only draft purchases can be posted', 409);
    if (posting.journalLines?.length && !posting.fiscalPeriodId) throw new DomainError('PURCHASE_FISCAL_PERIOD_REQUIRED', 'A fiscal period is required for accounting posting', 422);
    // Desktop gates, enforced at posting (drafts may stay incomplete). Service-only
    // purchases carry no stock, so the warehouse gate applies only when stocked
    // lines are present; callers that hand us no lines stay on the conservative
    // path and must pass one.
    const candidateIds = ((invoice.lines ?? []) as Array<{ itemId?: string | null; quantity?: string }>)
      .filter((line) => line.itemId && money(line.quantity ?? '0').gt(0))
      .map((line) => line.itemId!);
    let movesStock = invoice.lines === undefined || candidateIds.length > 0;
    if (movesStock && invoice.lines !== undefined && candidateIds.length > 0 && !invoice.warehouseId) {
      const kinds = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.select({ kind: items.kind }).from(items).where(and(eq(items.tenantId, tenantId), inArray(items.id, candidateIds))),
      );
      movesStock = kinds.some((row) => row.kind === 'stock');
    }
    if (movesStock && !invoice.warehouseId) {
      throw new DomainError('PURCHASE_WAREHOUSE_REQUIRED', 'A warehouse is required to post a stock-moving purchase', 422);
    }
    if (invoice.kind === 'purchase' && money(invoice.total).lt(0)) {
      throw new DomainError('PURCHASE_TOTAL_INVALID', 'A purchase total cannot be negative', 422);
    }
    // R3 — الوجه الآخر لحرس الإلغاء: مردودُ مشترياتٍ فاتورتُه **ملغاة**. بلا هذا الفحص
    // تكفي مسودّةٌ أُنشئت قبل الإلغاء ثم رُحّلت بعده ليُعاد المرجع المعلّق نفسه الذي منعه
    // الإلغاء. والفحص قبل أي كتابة: لا قيدٌ ولا مخزون لمردودٍ مصدرُه ملغى.
    if (invoice.kind === 'purchase_return' && invoice.referenceInvoiceId) {
      const [source] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select({ status: purchaseInvoices.status })
          .from(purchaseInvoices)
          .where(
            and(
              eq(purchaseInvoices.tenantId, tenantId),
              eq(purchaseInvoices.id, invoice.referenceInvoiceId as string),
            ),
          ),
      );
      if (source?.status === 'voided') {
        throw new DomainError(
          errorCodes.PURCHASE_REFERENCE_VOIDED,
          'The referenced purchase invoice is voided',
          409,
          { referenceInvoiceId: invoice.referenceInvoiceId },
        );
      }
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [locked] = await tx.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, id), eq(purchaseInvoices.status, 'draft')));
      if (!locked) throw new DomainError('PURCHASE_INVOICE_INVALID_STATUS', 'Only draft purchases can be posted', 409);
      const lines = await tx.select().from(purchaseInvoiceLines).where(and(eq(purchaseInvoiceLines.tenantId, tenantId), eq(purchaseInvoiceLines.invoiceId, id)));
      const costs = await tx.select().from(purchaseInvoiceCosts).where(and(eq(purchaseInvoiceCosts.tenantId, tenantId), eq(purchaseInvoiceCosts.invoiceId, id)));
      const allocation = allocateLandedCost({ method: landedCostMethod(locked.landedCostAlloc), lines: lines.map((line) => ({ lineId: line.id, itemId: line.itemId, quantity: line.quantity, net: line.net })), costs: costs.filter((cost) => cost.allocationTarget === 'inventory').map((cost) => ({ amount: cost.amount })) });
      const byLine = new Map(allocation.lines.map((line) => [line.lineId, line]));
      const docType = locked.kind === 'purchase_return' ? 'purchase_return' : 'purchase_invoice';
      const isReturn = locked.kind === 'purchase_return';
      // Services never touch the stock ledger — only `stock`-kind lines move.
      const itemRows = await tx
        .select({ id: items.id, kind: items.kind })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), inArray(items.id, lines.map((line) => line.itemId))));
      const stockable = new Set(itemRows.filter((row) => row.kind === 'stock').map((row) => row.id));
      const stocked = lines.filter((line) => stockable.has(line.itemId) && money(line.quantity).gt(0));
      if (stocked.length && !locked.warehouseId) throw new DomainError('PURCHASE_WAREHOUSE_REQUIRED', 'Posting purchases requires a warehouse', 422);
      const inventoryLines: InventoryLine[] = stocked.map((line) => { const allocated = byLine.get(line.id); return { itemId: line.itemId, warehouseId: locked.warehouseId ?? '', qty: line.quantity, unitCost: allocated?.effectiveUnitCost ?? line.unitPrice, direction: isReturn ? 'out' : 'in', docType, docId: id, lineId: line.id, costing: isReturn ? 'outAtAvg' : 'inWithCost' }; });
      if (inventoryLines.length) await this.inventory.recordInTx(tx, tenantId, inventoryLines);
      /**
       * R8 — الأرقام التسلسلية والدفعات على سطور الفاتورة بعد حركة المخزون: الإدخال
       * يُنشئ الأرقام ويبحث عن الدفعة أو يُنشئها، والمرتجع يُخرج الرقم من الرفّ.
       */
      if (stocked.length && locked.warehouseId) {
        const resolved = await this.inventory.resolveInvoiceLineNumbers(tx, tenantId, {
          docType,
          docId: id,
          warehouseId: locked.warehouseId,
          direction: isReturn ? 'out' : 'in',
          mode: isReturn ? 'issue' : 'receipt',
          lines: stocked.map((line) => ({
            lineNo: line.lineNo,
            itemId: line.itemId,
            qty: line.quantity,
            lotId: line.lotId,
            batchNo: line.batchNo,
            productionDate: line.productionDate,
            expiryDate: line.expiryDate,
            serialNos: line.serialNos ?? [],
          })),
        });
        for (const [index, line] of stocked.entries()) {
          const numbers = resolved.get(index);
          if (!numbers) continue;
          await tx
            .update(purchaseInvoiceLines)
            .set({
              lotId: numbers.lotId,
              batchNo: numbers.batchNo,
              productionDate: numbers.productionDate,
              expiryDate: numbers.expiryDate,
            })
            .where(and(eq(purchaseInvoiceLines.tenantId, tenantId), eq(purchaseInvoiceLines.id, line.id)));
        }
      }
      for (const line of lines) {
        const allocated = byLine.get(line.id);
        await tx.update(purchaseInvoiceLines).set({ allocatedCost: allocated?.allocatedCost ?? '0', landedTotal: allocated?.landedTotal ?? line.net, unitCostAtPost: allocated?.effectiveUnitCost ?? line.unitPrice, updatedAt: new Date() }).where(and(eq(purchaseInvoiceLines.tenantId, tenantId), eq(purchaseInvoiceLines.id, line.id)));
      }
      const today = new Date().toISOString().slice(0, 10);
      const numbered = await this.sequences.next({ tenantId, branchId: locked.branchId, docType }, tx, { prefix: isReturn ? 'PR-' : 'PI-', padding: 6 });
      const additionalCostTotal = costs.reduce((sum, cost) => sum.plus(cost.amount), new Decimal(0)).toFixed(4);
      const postedTotal = money(locked.total).plus(additionalCostTotal).toFixed(4);
      let journalEntryId: string | null = null;
      if (posting.journalLines?.length) {
        const journal = await this.accounting.postJournalInTx(tx, tenantId, { branchId: locked.branchId, fiscalPeriodId: posting.fiscalPeriodId!, date: today, description: `Purchase invoice ${id}`, lines: posting.journalLines, sourceType: docType, sourceId: id });
        journalEntryId = journal?.id ?? null;
      } else if (money(postedTotal).abs().gt(0)) {
        const profile = await this.profiles.resolvePostProfileInTx(tx, tenantId, locked.branchId, docType);
        const fiscalPeriodId = posting.fiscalPeriodId ?? (await this.accounting.openPeriodForDateInTx(tx, tenantId, today));
        const mapping = profile.mapping as unknown as Record<string, string | null | undefined>;
        // Returns relieve at the current average: the journal credits exactly what
        // the ledger relieved, and any price-vs-average drift lands in COGS.
        let relievedValue = new Decimal(0);
        if (isReturn && inventoryLines.length) {
          const txns = await tx
            .select({ totalCost: inventoryTransactions.totalCost })
            .from(inventoryTransactions)
            .where(and(eq(inventoryTransactions.tenantId, tenantId), eq(inventoryTransactions.docId, id)));
          relievedValue = txns.reduce((sum, row) => sum.plus(row.totalCost), new Decimal(0));
        }
        await this.assertPostingAccounts(tx, tenantId, costs, posting.settlement ?? 'credit', posting.settlementAccountId);
        const journalLines = this.buildAutoJournal(
          { kind: locked.kind, invoiceDiscount: locked.invoiceDiscount, taxTotal: locked.taxTotal, extraTax: locked.extraTax, withholding: locked.withholding, total: postedTotal, partyId: locked.partyId, costCenterId: locked.costCenterId },
          lines.map((line) => ({ id: line.id, itemId: line.itemId, quantity: line.quantity, unitPrice: line.unitPrice, net: line.net, landedTotal: byLine.get(line.id)?.landedTotal ?? line.net, stocked: stockable.has(line.itemId), costCenterId: line.costCenterId })),
          costs.map((cost) => ({ name: cost.costName, amount: cost.amount, allocationTarget: cost.allocationTarget, accountId: cost.accountId, costCenterId: cost.costCenterId })),
          mapping,
          relievedValue,
          posting.settlement ?? 'credit',
          posting.settlementAccountId,
        );
        const journal = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId: locked.branchId,
          fiscalPeriodId,
          date: today,
          description: isReturn ? `Purchase return ${numbered.display}` : `Purchase invoice ${numbered.display}`,
          lines: journalLines,
          sourceType: docType,
          sourceId: id,
          idempotencyKey: `purchase-post:${id}`,
        });
        journalEntryId = journal?.id ?? null;
      }
      // Immediate settlement (cash/bank) is recorded as the invoice's first payment
      // in the same transaction, so a cash purchase lands fully paid — never with
      // just a flipped flag. Returns never fabricate a payment row.
      const settled = !posting.journalLines?.length && !isReturn && posting.settlement !== undefined && posting.settlement !== 'credit' && money(postedTotal).gt(0);
      if (settled) {
        await tx.insert(paymentAllocations).values({ id: newId(), tenantId, partyId: locked.partyId, invoiceKind: locked.kind, invoiceId: id, amount: postedTotal });
      }
      await tx.update(purchaseInvoices).set({ status: 'posted', number: numbered.display, additionalCostTotal, total: postedTotal, paidTotal: settled ? postedTotal : locked.paidTotal, paymentStatus: money(postedTotal).isZero() || settled ? 'paid' : 'unpaid', journalEntryId, postedAt: new Date() }).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, id), eq(purchaseInvoices.status, 'draft')));
    });
    return this.get(tenantId, id);
  }

  /**
   * Tenant-ownership guard for every account the auto journal touches that does not
   * come from the posting profile: the settlement till/bank and each expense-cost
   * account. A missing expense account is a named error, not a silent misposting.
   */
  private async assertPostingAccounts(
    tx: DrizzleTx,
    tenantId: string,
    costs: Array<{ costName: string; amount: string; allocationTarget: string | null; accountId: string | null }>,
    settlement: 'credit' | 'cash' | 'bank',
    settlementAccountId?: string,
  ): Promise<void> {
    const ids = new Set<string>();
    for (const cost of costs) {
      if (cost.allocationTarget !== 'expense' || money(cost.amount).abs().lte(0)) continue;
      if (!cost.accountId) throw new DomainError('PURCHASE_COST_ACCOUNT_REQUIRED', `Cost "${cost.costName}" needs an expense account before posting`, 422, { field: 'accountId' });
      ids.add(cost.accountId);
    }
    if (settlement !== 'credit' && settlementAccountId) ids.add(settlementAccountId);
    if (!ids.size) return;
    const rows = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, [...ids])));
    const found = new Set(rows.map((row) => row.id));
    for (const accountId of ids) {
      if (!found.has(accountId)) {
        const field = accountId === settlementAccountId ? 'settlementAccountId' : 'accountId';
        throw new DomainError('PURCHASE_POSTING_ACCOUNT_INVALID', 'A posting account does not belong to this tenant', 422, { field });
      }
    }
  }

  /**
   * The desktop `BindToEntry` purchase mirror (supplier Cr / purchases Dr /
   * discount-received Cr / VAT-input Dr / cash legs), adapted to the cloud's
   * perpetual inventory: stocked value debits the inventory account at landed
   * cost (gross method — the earned discount keeps its contra leg), services
   * debit the purchases account, expense costs hit their own accounts, and
   * returns relieve at average with the price-vs-average drift in COGS.
   */
  private buildAutoJournal(
    locked: { kind: string; invoiceDiscount: string | null; taxTotal: string; extraTax: string | null; withholding: string | null; total: string; partyId: string | null; costCenterId?: string | null },
    lines: Array<{ id: string; itemId: string; quantity: string; unitPrice: string; net: string; landedTotal: string; stocked: boolean; costCenterId?: string | null }>,
    costs: Array<{ name: string; amount: string; allocationTarget: string | null; accountId: string | null; costCenterId: string | null }>,
    mapping: Record<string, string | null | undefined>,
    relievedValue: Decimal,
    settlement: 'credit' | 'cash' | 'bank',
    settlementAccountId?: string,
  ): JournalLineInput[] {
    const need = (key: string): string => {
      const accountId = mapping[key];
      if (!accountId) throw new DomainError('PURCHASE_PROFILE_KEY_MISSING', `Posting profile has no ${key}`, 422, { field: key });
      return accountId;
    };
    if (money(locked.withholding ?? '0').abs().gt(0)) {
      throw new DomainError('PURCHASE_WITHHOLDING_MANUAL_POSTING', 'Purchases with withholding need explicit journal lines', 422);
    }
    const settlementAccount =
      settlement === 'credit'
        ? need('payableAccountId')
        : (settlementAccountId ?? (() => { throw new DomainError('PURCHASE_SETTLEMENT_ACCOUNT_REQUIRED', 'A cash or bank account is required for immediate settlement', 422, { field: 'settlementAccountId' }); })());
    const settlementParty = settlement === 'credit' ? locked.partyId : null;
    const journal: JournalLineInput[] = [];
    const leg = (accountId: string, debit: Decimal, credit: Decimal, extra?: { partyId?: string | null; costCenterId?: string | null; description?: string }): void => {
      if (debit.abs().lte(0) && credit.abs().lte(0)) return;
      journal.push({ accountId, debit: debit.toFixed(4), credit: credit.toFixed(4), partyId: (extra?.partyId ?? locked.partyId) ?? undefined, costCenterId: extra?.costCenterId ?? undefined, description: extra?.description });
    };

    // Stored line nets already carry the header-discount share (pro-rata by gross,
    // the desktop rule). The gross method restores it so the earned discount keeps
    // its contra leg; the stocked/non-stock split follows the same gross weights.
    const discount = money(locked.invoiceDiscount ?? '0');
    const grossOf = (line: { quantity: string; unitPrice: string }): Decimal => money(line.quantity).mul(line.unitPrice);
    const totalGross = lines.reduce((sum, line) => sum.plus(grossOf(line)), new Decimal(0));
    const stockedGross = lines.filter((line) => line.stocked).reduce((sum, line) => sum.plus(grossOf(line)), new Decimal(0));
    const stockedDiscount = totalGross.gt(0) ? discount.mul(stockedGross).div(totalGross).toDecimalPlaces(4) : new Decimal(0);
    const nonstockDiscount = discount.minus(stockedDiscount);
    const stockedNet = lines.filter((line) => line.stocked).reduce((sum, line) => sum.plus(line.net), new Decimal(0));
    const stockedLanded = lines.filter((line) => line.stocked).reduce((sum, line) => sum.plus(line.landedTotal), new Decimal(0));
    const nonstockNet = lines.filter((line) => !line.stocked).reduce((sum, line) => sum.plus(line.net), new Decimal(0));
    const tax = money(locked.taxTotal);
    const extra = money(locked.extraTax ?? '0');
    const total = money(locked.total);
    const expenseCosts = costs.filter((cost) => cost.allocationTarget === 'expense' && money(cost.amount).abs().gt(0));
    const isReturn = locked.kind === 'purchase_return';

    /**
     * R9 — 📊 مركز التكلفة: كل سطرٍ يأخذ مركزه، ومن لم يذكر مركزاً يأخذ مركز الرأس
     * (`frmInvPurch.xaml` L467). والرجل المجمَّعة تُقسم على المراكز سطراً لكل مركز؛ وبلا
     * مراكز تبقى رجلٌ واحدة غير موسومة كما كانت — فلا يتغيّر قيدُ مشترياتٍ بلا مراكز.
     */
    const centerOf = (line: { costCenterId?: string | null }): string | null =>
      line.costCenterId ?? locked.costCenterId ?? null;
    const legByCenter = (
      accountId: string,
      legTotal: Decimal,
      rows: Array<{ amount: Decimal; costCenterId: string | null }>,
      partyId: string | null,
    ): void => {
      const shares = splitByCostCenter(
        legTotal,
        rows.map((row) => ({ costCenterId: row.costCenterId, weight: row.amount })),
      );
      if (!shares.length) {
        leg(accountId, legTotal, new Decimal(0), { partyId });
        return;
      }
      for (const share of shares) leg(accountId, share.amount, new Decimal(0), { partyId, costCenterId: share.costCenterId });
    };
    const creditByCenter = (
      accountId: string,
      legTotal: Decimal,
      rows: Array<{ amount: Decimal; costCenterId: string | null }>,
      partyId: string | null,
    ): void => {
      const shares = splitByCostCenter(
        legTotal,
        rows.map((row) => ({ costCenterId: row.costCenterId, weight: row.amount })),
      );
      if (!shares.length) {
        leg(accountId, new Decimal(0), legTotal, { partyId });
        return;
      }
      for (const share of shares) leg(accountId, new Decimal(0), share.amount, { partyId, costCenterId: share.costCenterId });
    };
    /** أوزان البنود المخزنية: قيمتها المحمَّلة + نصيبها من خصم الفاتورة. */
    const stockedRows = lines
      .filter((line) => line.stocked && money(line.landedTotal).abs().gt(0))
      .map((line) => ({
        amount: money(line.landedTotal).abs().plus(stockedGross.gt(0) ? stockedDiscount.mul(grossOf(line)).div(stockedGross) : new Decimal(0)),
        costCenterId: centerOf(line),
      }));
    const nonstockRows = lines
      .filter((line) => !line.stocked && money(line.net).abs().gt(0))
      .map((line) => ({ amount: money(line.net).abs(), costCenterId: centerOf(line) }));

    if (!isReturn) {
      legByCenter(need('inventoryAccountId'), stockedLanded.plus(stockedDiscount), stockedRows, locked.partyId);
      // الرجل غير المخزنية تتبع وزن بواقي البنود بلا خصمٍ محمَّل عليه (الخصم غير المخزني
      // يُبنى على `nonstockNet` نفسه).
      legByCenter(need('purchasesAccountId'), nonstockNet.plus(nonstockDiscount), nonstockRows, locked.partyId);
      if (tax.abs().gt(0)) leg(need('vatInputAccountId'), tax, new Decimal(0));
      if (extra.abs().gt(0)) leg(need('exciseTaxAccountId'), extra, new Decimal(0));
      for (const cost of expenseCosts) leg(cost.accountId!, money(cost.amount), new Decimal(0), { costCenterId: cost.costCenterId, description: cost.name });
      if (discount.gt(0)) leg(need('discountReceivedAccountId'), new Decimal(0), discount);
      leg(settlementAccount, new Decimal(0), total, { partyId: settlementParty });
    } else {
      // Stocked goods go straight against inventory at the relieved (average)
      // value — no contra leg; only services use the purchase-return account.
      // The price-vs-average drift is a COGS gain/loss, skipped when zero.
      leg(settlementAccount, total, new Decimal(0), { partyId: settlementParty });
      creditByCenter(need('inventoryAccountId'), relievedValue, stockedRows, locked.partyId);
      creditByCenter(need('purchaseReturnAccountId'), nonstockNet.plus(nonstockDiscount), nonstockRows, locked.partyId);
      if (nonstockDiscount.gt(0)) leg(need('discountReceivedAccountId'), nonstockDiscount, new Decimal(0));
      if (tax.abs().gt(0)) leg(need('vatInputAccountId'), new Decimal(0), tax);
      if (extra.abs().gt(0)) leg(need('exciseTaxAccountId'), new Decimal(0), extra);
      for (const cost of expenseCosts) leg(cost.accountId!, new Decimal(0), money(cost.amount), { costCenterId: cost.costCenterId, description: cost.name });
      const drift = stockedNet.plus(stockedLanded.minus(stockedNet)).minus(relievedValue);
      if (drift.gt(0) || drift.lt(0)) {
        const gain = drift.gt(0);
        leg(need('cogsAccountId'), gain ? new Decimal(0) : drift.abs(), gain ? drift.abs() : new Decimal(0), { partyId: null, description: 'فرق متوسط التكلفة — مردود مشتريات' });
      }
    }
    return journal;
  }

  async void(tenantId: string, id: string, reason: string) {
    if (!reason.trim()) throw new DomainError('PURCHASE_VOID_REASON_REQUIRED', 'A void reason is required', 422);
    const invoice = await this.get(tenantId, id);
    if (invoice.status !== 'posted') throw new DomainError('PURCHASE_INVOICE_INVALID_STATUS', 'Only posted purchases can be voided', 409);
    if (money(invoice.paidTotal).abs().gt(0)) {
      throw new DomainError('PURCHASE_VOID_HAS_PAYMENTS', 'Unallocate the payments before voiding', 409);
    }
    // R3 — لا إلغاء لفاتورةٍ عليها مردودٌ مُرحَّل: الإلغاء يعكس قيد المشتريات ويعكس كل
    // حركة مخزون، والمردود يبقى مُرحَّلاً بقيده ومخزونه ⇒ مرجعٌ معلّق إلى فاتورةٍ ملغاة.
    // والقاعدة هي قاعدة البيع نفسها: الشرط على المُرحَّل وحده — مردودٌ **مسودّة** أثرُه
    // صفر فلا يحجب، ويصُدّه `PURCHASE_REFERENCE_VOIDED` لو رُحِّل بعد الإلغاء.
    const derived = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: purchaseInvoices.id, number: purchaseInvoices.number, kind: purchaseInvoices.kind })
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.referenceInvoiceId, id),
            eq(purchaseInvoices.status, 'posted'),
          ),
        ),
    );
    if (derived.length) {
      throw new DomainError(
        errorCodes.PURCHASE_VOID_HAS_RETURNS,
        'Void the returns that reference this purchase first',
        409,
        {
          references: derived.map((row) => ({ id: row.id, number: row.number, kind: row.kind })),
          count: derived.length,
        },
      );
    }
    // The old cloud void only flipped the flag and left the journal and the stock
    // behind. Like the sales side, voiding now reverses all three legs — journal,
    // stock and status — in one transaction.
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      const docType = invoice.kind === 'purchase_return' ? 'purchase_return' : 'purchase_invoice';
      const [entry] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.sourceType, docType), eq(journalEntries.sourceId, id)));
      if (entry) {
        /**
         * 🔁 العكس الرسمي الموحَّد — كما في مسار البيع تماماً (والعيب كان واحداً في
         * المسارين): المرآة وحدها والأصل يبقى `posted`، لأن إبطال الأصل مع ترحيل المرآة
         * يُنحرف ميزان المراجعة ورصيد الحساب بمقدار الفاتورة الملغاة. الأبعاد كلها
         * (الطرف، مركز التكلفة، المندوب، الفرع، العملة) تنقلها الآلية الموحَّدة.
         */
        await this.accounting.reverseJournalInTx(tx, tenantId, entry.id, {
          reason: `إبطال ${invoice.kind === 'purchase_return' ? 'مرتجع الشراء' : 'فاتورة الشراء'} ${invoice.number ?? id}: ${reason}`,
          date: today,
          branchId: invoice.branchId,
          sourceType: docType,
          sourceId: id,
          actorId: getRequestContext().tenant?.userId ?? null,
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
        docType: 'purchase_void',
        docId: id,
        lineId: movement.lineId ?? undefined,
        serialId: movement.serialId ?? undefined,
        costing: movement.direction === 'out' ? 'returnAtOriginalCost' : 'outAtOriginalCost',
      }));
      if (mirrors.length) await this.inventory.recordInTx(tx, tenantId, mirrors);

      /**
       * R8 — الإلغاء يعكس الأرقام: أرقام إدخالٍ سُجِّلت تُسحب (ما دامت مكانها)، وأرقام
       * مرتجعٍ خرجت تعود إلى الرفّ. والروابط تُحذف في الحالتين فلا يبقى تتبّعٌ معلّق إلى
       * مستند ملغى.
       */
      await this.inventory.releaseInvoiceLineNumbers(tx, tenantId, {
        docType,
        docId: id,
        direction: invoice.kind === 'purchase_return' ? 'out' : 'in',
      });

      await tx
        .update(purchaseInvoices)
        .set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, id), eq(purchaseInvoices.status, 'posted')));
    });
    return this.get(tenantId, id);
  }

  async addPayment(tenantId: string, invoiceId: string, input: PurchasePaymentInput) {
    const invoice = await this.get(tenantId, invoiceId);
    if (invoice.status !== 'posted') throw new DomainError('PURCHASE_INVOICE_NOT_POSTED', 'Payments require a posted purchase invoice', 409);
    const amount = money(input.amount);
    if (!amount.isFinite() || amount.lte(0)) throw new DomainError('PAYMENT_AMOUNT_INVALID', 'Payment amount must be positive', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const paidTotal = money(invoice.paidTotal).plus(amount);
      if (paidTotal.gt(money(invoice.total).plus('0.0001'))) throw new DomainError('PAYMENT_EXCEEDS_DUE', 'Payment exceeds purchase invoice balance', 422);
      const [allocation] = await tx.insert(paymentAllocations).values({ id: newId(), tenantId, partyId: invoice.partyId, voucherId: input.voucherId, invoiceKind: invoice.kind, invoiceId, amount: input.amount }).returning();
      await tx.update(purchaseInvoices).set({ paidTotal: paidTotal.toFixed(4), paymentStatus: paidTotal.gte(money(invoice.total)) ? 'paid' : 'partial', updatedAt: new Date() }).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, invoiceId)));
      return allocation;
    });
  }

  /** Supplier notes are raised against a posted invoice only — the mirror of the sales side. */
  async createAdjustmentNote(tenantId: string, invoiceId: string, input: { branchId: string; kind: string; reason: string; amount: string }) {
    const invoice = await this.get(tenantId, invoiceId);
    if (invoice.status !== 'posted') throw new DomainError('PURCHASE_INVOICE_NOT_POSTED', 'Notes require a posted purchase invoice', 409);
    if (input.kind !== 'credit' && input.kind !== 'debit') throw new DomainError('PURCHASE_NOTE_KIND_INVALID', 'A note is either credit or debit', 422);
    const amount = money(input.amount);
    if (!amount.isFinite() || amount.lte(0)) throw new DomainError('PURCHASE_NOTE_AMOUNT_INVALID', 'Note amount must be positive', 422);
    const [note] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(purchaseAdjustmentNotes).values({ id: newId(), tenantId, invoiceId, branchId: input.branchId, kind: input.kind, reason: input.reason, amount: amount.toFixed(4), createdBy: tryGetAuthContext()?.userId }).returning());
    return note;
  }

  /** Notes raised on supplier invoices, newest first — the source of the notes report. */
  async listAdjustmentNotes(tenantId: string, kind?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: purchaseAdjustmentNotes.id, number: purchaseAdjustmentNotes.number, kind: purchaseAdjustmentNotes.kind, status: purchaseAdjustmentNotes.status, reason: purchaseAdjustmentNotes.reason, amount: purchaseAdjustmentNotes.amount, postedAt: purchaseAdjustmentNotes.postedAt, createdAt: purchaseAdjustmentNotes.createdAt, invoiceId: purchaseAdjustmentNotes.invoiceId, invoiceNumber: purchaseInvoices.number, partyId: purchaseInvoices.partyId, invoiceTotal: purchaseInvoices.total })
        .from(purchaseAdjustmentNotes)
        .leftJoin(purchaseInvoices, eq(purchaseInvoices.id, purchaseAdjustmentNotes.invoiceId))
        .where(and(eq(purchaseAdjustmentNotes.tenantId, tenantId), kind ? eq(purchaseAdjustmentNotes.kind, kind) : undefined))
        .orderBy(desc(purchaseAdjustmentNotes.createdAt))
        .limit(200));
  }

  /** Posting allocates the note number through the shared sequence service. */
  async postAdjustmentNote(tenantId: string, id: string) {
    const [note] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(purchaseAdjustmentNotes).where(and(eq(purchaseAdjustmentNotes.tenantId, tenantId), eq(purchaseAdjustmentNotes.id, id))));
    if (!note) throw new DomainError('PURCHASE_NOTE_NOT_FOUND', 'Adjustment note was not found', 404);
    if (note.status !== 'draft') throw new DomainError('PURCHASE_NOTE_INVALID_STATUS', 'Only draft adjustment notes can be posted', 409);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next({ tenantId, branchId: note.branchId, docType: `purchase_note_${note.kind}` }, tx, { prefix: note.kind === 'credit' ? 'PCN-' : 'PDN-', padding: 6 });
      const [posted] = await tx
        .update(purchaseAdjustmentNotes)
        .set({ status: 'posted', number: allocated.display, postedAt: new Date(), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(purchaseAdjustmentNotes.tenantId, tenantId), eq(purchaseAdjustmentNotes.id, id), eq(purchaseAdjustmentNotes.status, 'draft')))
        .returning();
      if (!posted) throw new DomainError('PURCHASE_NOTE_INVALID_STATUS', 'Only draft adjustment notes can be posted', 409);
      return posted;
    });
  }
}
