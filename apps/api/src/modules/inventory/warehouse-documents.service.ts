import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  goodsRequestLines,
  goodsRequests,
  salesInvoiceLines,
  salesInvoices,
  stockDeliveries,
  stockDeliveryLines,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { SequencesService } from '../platform-services/index.js';

import { InventoryService } from './inventory.service.js';

export type GoodsRequestLineInput = { itemId: string; qty: string; note?: string };
export type GoodsRequestInput = {
  branchId: string;
  toWarehouseId: string;
  fromWarehouseId?: string;
  neededBy?: string;
  notes?: string;
  lines: GoodsRequestLineInput[];
};
export type GoodsRequestApproval = { fromWarehouseId?: string; lines?: Array<{ lineNo: number; approvedQty: string }> };

export type StockDeliveryLineInput = { itemId: string; qty: string; note?: string };
export type StockDeliveryInput = {
  invoiceId: string;
  warehouseId?: string;
  branchId?: string;
  deliveredOn?: string;
  recipientName?: string;
  driverName?: string;
  notes?: string;
  /** Omitted = deliver everything still outstanding on the invoice. */
  lines?: StockDeliveryLineInput[];
};

/** Statuses that still hold quantity against an invoice; `cancelled` releases it. */
const OPEN_DELIVERY_STATUSES = ['draft', 'delivered'];

/**
 * The two warehouse documents that bracket a transfer.
 *
 * **طلب بضاعة** — a requisition is a *request for* stock, never a movement of it. It is
 * approved (possibly for less than was asked for) and then fulfilled by creating a draft
 * `stock_transfer`, which is the document that actually touches `inventory_transactions`.
 * Keeping the request out of the ledger is what lets a branch ask for goods that are not
 * available yet without corrupting stock valuation.
 *
 * **توصيل مخزني** — a delivery is the handover record for a posted sales invoice. Posting
 * the invoice is what relieves the warehouse in this system, so recording a delivery
 * writes no inventory line at all; issuing stock twice for one sale would double-count
 * every delivered unit and drive the average cost down. What the document adds is the
 * physical half of the sale: who received the goods, on what date, and how much of the
 * invoice the customer is still owed.
 */
@Injectable()
export class WarehouseDocumentsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
    private readonly inventory: InventoryService,
  ) {}

  // ---------------------------------------------------------------- goods requests

  async listRequests(tenantId: string, status?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(goodsRequests)
        .where(and(eq(goodsRequests.tenantId, tenantId), status ? eq(goodsRequests.status, status) : undefined))
        .orderBy(desc(goodsRequests.createdAt))
        .limit(200);
      if (rows.length === 0) return [];
      const lines = await tx
        .select()
        .from(goodsRequestLines)
        .where(and(eq(goodsRequestLines.tenantId, tenantId), inArray(goodsRequestLines.requestId, rows.map((row) => row.id))));
      return rows.map((row) => ({ ...row, lines: lines.filter((line) => line.requestId === row.id).sort((a, b) => a.lineNo - b.lineNo) }));
    });
  }

  async getRequest(tenantId: string, id: string) {
    const found = await withTenantTx(this.database.db, tenantId, (tx) => this.loadRequest(tx, tenantId, id));
    return found;
  }

  async createRequest(tenantId: string, input: GoodsRequestInput) {
    const lines = input.lines ?? [];
    if (!lines.length) throw new DomainError('GOODS_REQUEST_LINES_REQUIRED', 'A goods request needs at least one line', 422);
    if (!input.branchId || !input.toWarehouseId) throw new DomainError('GOODS_REQUEST_TARGET_REQUIRED', 'Branch and requesting warehouse are required', 422);
    if (input.fromWarehouseId && input.fromWarehouseId === input.toWarehouseId) {
      throw new DomainError('GOODS_REQUEST_SAME_WAREHOUSE', 'The supplying and requesting warehouses must differ', 422);
    }
    for (const line of lines) {
      const quantity = new Decimal(line.qty || '0');
      if (!quantity.isFinite() || quantity.lte(0)) throw new DomainError('GOODS_REQUEST_QTY_INVALID', 'Every requested quantity must be greater than zero', 422);
    }

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next({ tenantId, branchId: input.branchId, docType: 'goods_request' }, tx, { prefix: 'GR-', padding: 6 });
      await tx.insert(goodsRequests).values({
        id,
        tenantId,
        branchId: input.branchId,
        toWarehouseId: input.toWarehouseId,
        fromWarehouseId: input.fromWarehouseId,
        number: allocated.display,
        status: 'draft',
        requestedAt: today(),
        neededBy: input.neededBy,
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      });
      await tx.insert(goodsRequestLines).values(lines.map((line, index) => ({
        requestId: id,
        lineNo: index + 1,
        tenantId,
        itemId: line.itemId,
        qty: new Decimal(line.qty).toFixed(4),
        note: line.note,
      })));
      return this.loadRequest(tx, tenantId, id);
    });
  }

  async submitRequest(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const request = await this.loadRequest(tx, tenantId, id);
      if (request.status !== 'draft') throw new DomainError('GOODS_REQUEST_INVALID_STATUS', 'Only a draft request can be submitted', 409);
      await tx.update(goodsRequests)
        .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(goodsRequests.tenantId, tenantId), eq(goodsRequests.id, id)));
      return this.loadRequest(tx, tenantId, id);
    });
  }

  /**
   * Approval may cut quantities down — a store that has 30 of the 50 asked for approves
   * 30 rather than forcing the branch to re-key the request.
   */
  async approveRequest(tenantId: string, id: string, input: GoodsRequestApproval = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const request = await this.loadRequest(tx, tenantId, id);
      if (request.status !== 'submitted') throw new DomainError('GOODS_REQUEST_INVALID_STATUS', 'Only a submitted request can be approved', 409);

      const byLineNo = new Map(request.lines.map((line) => [line.lineNo, line]));
      const decisions = input.lines ?? request.lines.map((line) => ({ lineNo: line.lineNo, approvedQty: line.qty }));
      let approvedTotal = new Decimal(0);
      for (const decision of decisions) {
        const line = byLineNo.get(decision.lineNo);
        if (!line) throw new DomainError('GOODS_REQUEST_LINE_NOT_FOUND', `Request has no line ${decision.lineNo}`, 404);
        const approved = new Decimal(decision.approvedQty || '0');
        if (!approved.isFinite() || approved.lt(0) || approved.gt(new Decimal(line.qty))) {
          throw new DomainError('GOODS_REQUEST_APPROVED_QTY_INVALID', 'Approved quantity must be between zero and the requested quantity', 422);
        }
        approvedTotal = approvedTotal.plus(approved);
      }
      if (approvedTotal.lte(0)) throw new DomainError('GOODS_REQUEST_APPROVED_EMPTY', 'Approving zero of everything is a rejection, not an approval', 422);

      const fromWarehouseId = input.fromWarehouseId ?? request.fromWarehouseId;
      if (!fromWarehouseId) throw new DomainError('GOODS_REQUEST_SOURCE_REQUIRED', 'A supplying warehouse is required to approve the request', 422);
      if (fromWarehouseId === request.toWarehouseId) throw new DomainError('GOODS_REQUEST_SAME_WAREHOUSE', 'The supplying and requesting warehouses must differ', 422);

      for (const decision of decisions) {
        await tx.update(goodsRequestLines)
          .set({ approvedQty: new Decimal(decision.approvedQty).toFixed(4) })
          .where(and(eq(goodsRequestLines.tenantId, tenantId), eq(goodsRequestLines.requestId, id), eq(goodsRequestLines.lineNo, decision.lineNo)));
      }
      await tx.update(goodsRequests)
        .set({ status: 'approved', fromWarehouseId, decidedAt: new Date(), decidedBy: tryGetAuthContext()?.userId, rejectionReason: null, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(goodsRequests.tenantId, tenantId), eq(goodsRequests.id, id)));
      return this.loadRequest(tx, tenantId, id);
    });
  }

  async rejectRequest(tenantId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new DomainError('GOODS_REQUEST_REASON_REQUIRED', 'A rejection must carry a reason', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const request = await this.loadRequest(tx, tenantId, id);
      if (request.status !== 'submitted') throw new DomainError('GOODS_REQUEST_INVALID_STATUS', 'Only a submitted request can be rejected', 409);
      await tx.update(goodsRequests)
        .set({ status: 'rejected', rejectionReason: reason.trim(), decidedAt: new Date(), decidedBy: tryGetAuthContext()?.userId, updatedAt: new Date() })
        .where(and(eq(goodsRequests.tenantId, tenantId), eq(goodsRequests.id, id)));
      return this.loadRequest(tx, tenantId, id);
    });
  }

  async cancelRequest(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const request = await this.loadRequest(tx, tenantId, id);
      if (!['draft', 'submitted', 'approved'].includes(request.status)) {
        throw new DomainError('GOODS_REQUEST_INVALID_STATUS', 'A fulfilled or already closed request cannot be cancelled', 409);
      }
      await tx.update(goodsRequests)
        .set({ status: 'cancelled', updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(goodsRequests.tenantId, tenantId), eq(goodsRequests.id, id)));
      return this.loadRequest(tx, tenantId, id);
    });
  }

  /**
   * Fulfilment hands the approved quantities to a **draft** transfer. It is deliberately
   * not sent: the store still has to pick the goods, and sending is what moves stock.
   */
  async fulfilRequest(tenantId: string, id: string, input: { fromWarehouseId?: string } = {}) {
    const request = await this.getRequest(tenantId, id);
    if (request.status !== 'approved') throw new DomainError('GOODS_REQUEST_INVALID_STATUS', 'Only an approved request can be fulfilled', 409);
    const fromWarehouseId = input.fromWarehouseId ?? request.fromWarehouseId;
    if (!fromWarehouseId) throw new DomainError('GOODS_REQUEST_SOURCE_REQUIRED', 'A supplying warehouse is required to fulfil the request', 422);
    if (fromWarehouseId === request.toWarehouseId) throw new DomainError('GOODS_REQUEST_SAME_WAREHOUSE', 'The supplying and requesting warehouses must differ', 422);

    const lines = request.lines
      .map((line) => ({ itemId: line.itemId, qty: new Decimal(line.approvedQty ?? line.qty) }))
      .filter((line) => line.qty.gt(0))
      .map((line) => ({ itemId: line.itemId, qty: line.qty.toFixed(4) }));
    if (!lines.length) throw new DomainError('GOODS_REQUEST_APPROVED_EMPTY', 'No approved quantity is left to fulfil', 422);

    const transferId = newId();
    await this.inventory.createTransfer(tenantId, { id: transferId, fromWarehouseId, toWarehouseId: request.toWarehouseId, lines });
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.update(goodsRequests)
        .set({ status: 'fulfilled', transferId, fromWarehouseId, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(goodsRequests.tenantId, tenantId), eq(goodsRequests.id, id)));
      return this.loadRequest(tx, tenantId, id);
    });
  }

  private async loadRequest(tx: DrizzleTx, tenantId: string, id: string) {
    const [request] = await tx.select().from(goodsRequests).where(and(eq(goodsRequests.tenantId, tenantId), eq(goodsRequests.id, id)));
    if (!request) throw new DomainError('GOODS_REQUEST_NOT_FOUND', 'Goods request was not found', 404);
    const lines = await tx.select().from(goodsRequestLines).where(and(eq(goodsRequestLines.tenantId, tenantId), eq(goodsRequestLines.requestId, id)));
    return { ...request, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
  }

  // ------------------------------------------------------------------- deliveries

  async listDeliveries(tenantId: string, filters: { status?: string; invoiceId?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(stockDeliveries)
        .where(and(
          eq(stockDeliveries.tenantId, tenantId),
          filters.status ? eq(stockDeliveries.status, filters.status) : undefined,
          filters.invoiceId ? eq(stockDeliveries.invoiceId, filters.invoiceId) : undefined,
        ))
        .orderBy(desc(stockDeliveries.createdAt))
        .limit(200);
      if (rows.length === 0) return [];
      const lines = await tx
        .select()
        .from(stockDeliveryLines)
        .where(and(eq(stockDeliveryLines.tenantId, tenantId), inArray(stockDeliveryLines.deliveryId, rows.map((row) => row.id))));
      const invoices = await tx
        .select({ id: salesInvoices.id, number: salesInvoices.number })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, tenantId), inArray(salesInvoices.id, rows.map((row) => row.invoiceId))));
      const numberOf = new Map(invoices.map((invoice) => [invoice.id, invoice.number]));
      return rows.map((row) => ({
        ...row,
        invoiceNumber: numberOf.get(row.invoiceId) ?? null,
        lines: lines.filter((line) => line.deliveryId === row.id).sort((a, b) => a.lineNo - b.lineNo),
      }));
    });
  }

  /**
   * Posted sales invoices that still owe the customer goods. This is what the screen
   * lists first: you deliver *against an invoice*, so picking one has to come before
   * keying quantities.
   */
  async outstandingInvoices(tenantId: string, invoiceId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const invoices = await tx
        .select()
        .from(salesInvoices)
        .where(and(
          eq(salesInvoices.tenantId, tenantId),
          eq(salesInvoices.kind, 'sale'),
          eq(salesInvoices.status, 'posted'),
          invoiceId ? eq(salesInvoices.id, invoiceId) : undefined,
        ))
        .orderBy(desc(salesInvoices.createdAt))
        .limit(100);
      if (invoices.length === 0) return [];
      const ids = invoices.map((invoice) => invoice.id);
      const lines = await tx.select().from(salesInvoiceLines).where(and(eq(salesInvoiceLines.tenantId, tenantId), inArray(salesInvoiceLines.invoiceId, ids)));
      const delivered = await this.deliveredByItem(tx, tenantId, ids);

      return invoices
        .map((invoice) => {
          const invoiceLines = lines
            .filter((line) => line.invoiceId === invoice.id && line.itemId)
            .map((line) => {
              const itemId = line.itemId as string;
              const invoicedQty = new Decimal(line.quantity);
              const deliveredQty = delivered.get(`${invoice.id}:${itemId}`) ?? new Decimal(0);
              return {
                itemId,
                description: line.description,
                invoicedQty: invoicedQty.toFixed(4),
                deliveredQty: deliveredQty.toFixed(4),
                remainingQty: Decimal.max(invoicedQty.minus(deliveredQty), 0).toFixed(4),
              };
            })
            .filter((line) => new Decimal(line.remainingQty).gt(0));
          return {
            id: invoice.id,
            number: invoice.number,
            branchId: invoice.branchId,
            warehouseId: invoice.warehouseId,
            partyId: invoice.partyId,
            cashCustomerName: invoice.cashCustomerName,
            total: invoice.total,
            postedAt: invoice.postedAt,
            lines: invoiceLines,
          };
        })
        .filter((invoice) => invoice.lines.length > 0);
    });
  }

  async createDelivery(tenantId: string, input: StockDeliveryInput) {
    if (!input.invoiceId) throw new DomainError('DELIVERY_INVOICE_REQUIRED', 'A delivery must reference a sales invoice', 422);

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, input.invoiceId)));
      if (!invoice) throw new DomainError('SALES_INVOICE_NOT_FOUND', 'Sales invoice was not found', 404);
      if (invoice.kind !== 'sale') throw new DomainError('DELIVERY_INVOICE_KIND_INVALID', 'Only a sales invoice can be delivered', 422);
      if (invoice.status !== 'posted') throw new DomainError('DELIVERY_INVOICE_NOT_POSTED', 'Stock leaves the warehouse when the invoice is posted, so only a posted invoice can be delivered', 422);

      const warehouseId = input.warehouseId ?? invoice.warehouseId;
      if (!warehouseId) throw new DomainError('DELIVERY_WAREHOUSE_REQUIRED', 'A warehouse is required for the delivery', 422);

      const invoiceLines = await tx.select().from(salesInvoiceLines).where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, invoice.id)));
      const invoiced = new Map<string, Decimal>();
      for (const line of invoiceLines) {
        if (!line.itemId) continue;
        invoiced.set(line.itemId, (invoiced.get(line.itemId) ?? new Decimal(0)).plus(new Decimal(line.quantity)));
      }
      const delivered = await this.deliveredByItem(tx, tenantId, [invoice.id]);
      const remaining = new Map<string, Decimal>();
      for (const [itemId, quantity] of invoiced) {
        remaining.set(itemId, quantity.minus(delivered.get(`${invoice.id}:${itemId}`) ?? new Decimal(0)));
      }

      const requested: StockDeliveryLineInput[] = input.lines?.length
        ? input.lines
        : [...remaining.entries()].filter(([, quantity]) => quantity.gt(0)).map(([itemId, quantity]) => ({ itemId, qty: quantity.toFixed(4) }));
      if (!requested.length) throw new DomainError('DELIVERY_NOTHING_OUTSTANDING', 'This invoice has already been delivered in full', 422);

      const values: Array<{ deliveryId: string; lineNo: number; tenantId: string; itemId: string; qty: string; note?: string }> = [];
      requested.forEach((line, index) => {
        const quantity = new Decimal(line.qty || '0');
        if (!quantity.isFinite() || quantity.lte(0)) throw new DomainError('DELIVERY_QTY_INVALID', 'Every delivered quantity must be greater than zero', 422);
        const left = remaining.get(line.itemId);
        if (left === undefined) throw new DomainError('DELIVERY_ITEM_NOT_ON_INVOICE', 'A delivered item is not on the invoice', 422);
        if (quantity.gt(left)) throw new DomainError('DELIVERY_QTY_EXCEEDS_INVOICE', 'Delivered quantity exceeds what the invoice still owes', 422);
        remaining.set(line.itemId, left.minus(quantity));
        values.push({ deliveryId: id, lineNo: index + 1, tenantId, itemId: line.itemId, qty: quantity.toFixed(4), note: line.note });
      });

      const allocated = await this.sequences.next({ tenantId, branchId: invoice.branchId, docType: 'stock_delivery' }, tx, { prefix: 'DLV-', padding: 6 });
      await tx.insert(stockDeliveries).values({
        id,
        tenantId,
        branchId: input.branchId ?? invoice.branchId,
        warehouseId,
        invoiceId: invoice.id,
        partyId: invoice.partyId,
        number: allocated.display,
        status: 'draft',
        deliveredOn: input.deliveredOn ?? today(),
        recipientName: input.recipientName ?? invoice.cashCustomerName,
        driverName: input.driverName,
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      });
      await tx.insert(stockDeliveryLines).values(values);
      return this.loadDelivery(tx, tenantId, id);
    });
  }

  async confirmDelivery(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const delivery = await this.loadDelivery(tx, tenantId, id);
      if (delivery.status !== 'draft') throw new DomainError('DELIVERY_INVALID_STATUS', 'Only a draft delivery can be handed over', 409);
      await tx.update(stockDeliveries)
        .set({ status: 'delivered', deliveredAt: new Date(), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(stockDeliveries.tenantId, tenantId), eq(stockDeliveries.id, id)));
      return this.loadDelivery(tx, tenantId, id);
    });
  }

  async cancelDelivery(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const delivery = await this.loadDelivery(tx, tenantId, id);
      if (delivery.status === 'cancelled') throw new DomainError('DELIVERY_INVALID_STATUS', 'This delivery is already cancelled', 409);
      await tx.update(stockDeliveries)
        .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(stockDeliveries.tenantId, tenantId), eq(stockDeliveries.id, id)));
      return this.loadDelivery(tx, tenantId, id);
    });
  }

  private async loadDelivery(tx: DrizzleTx, tenantId: string, id: string) {
    const [delivery] = await tx.select().from(stockDeliveries).where(and(eq(stockDeliveries.tenantId, tenantId), eq(stockDeliveries.id, id)));
    if (!delivery) throw new DomainError('DELIVERY_NOT_FOUND', 'Delivery was not found', 404);
    const lines = await tx.select().from(stockDeliveryLines).where(and(eq(stockDeliveryLines.tenantId, tenantId), eq(stockDeliveryLines.deliveryId, id)));
    return { ...delivery, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
  }

  /**
   * Quantity already committed per `invoiceId:itemId`. A **draft** delivery counts: the
   * picker has set the goods aside, and letting a second draft claim the same units is
   * how a warehouse ends up promising the same box twice.
   */
  private async deliveredByItem(tx: DrizzleTx, tenantId: string, invoiceIds: string[]) {
    const totals = new Map<string, Decimal>();
    if (!invoiceIds.length) return totals;
    const rows = await tx
      .select({ invoiceId: stockDeliveries.invoiceId, itemId: stockDeliveryLines.itemId, qty: sql<string>`sum(${stockDeliveryLines.qty})` })
      .from(stockDeliveryLines)
      .innerJoin(stockDeliveries, eq(stockDeliveries.id, stockDeliveryLines.deliveryId))
      .where(and(
        eq(stockDeliveryLines.tenantId, tenantId),
        inArray(stockDeliveries.invoiceId, invoiceIds),
        inArray(stockDeliveries.status, OPEN_DELIVERY_STATUSES),
      ))
      .groupBy(stockDeliveries.invoiceId, stockDeliveryLines.itemId);
    for (const row of rows) totals.set(`${row.invoiceId}:${row.itemId}`, new Decimal(row.qty ?? '0'));
    return totals;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
