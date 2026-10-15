import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { rows, first, str, dec, iso } from '../van-sales/van-sales-shared.service.js';
import { VanSalesCustodyService } from '../van-sales/van-sales-custody.service.js';
import { VanSalesSharedService } from '../van-sales/van-sales-shared.service.js';
import type { AuthorisedRep } from '../field-sync/field-sync-rep-guard.service.js';

/**
 * 🚐 مساحة عمل المندوب (M4) — thin orchestration over what already exists.
 *
 * Three read/submit surfaces the rep app needs beyond raw sync, each derived from the
 * caller's own membership (D-004) and each reading the SAME tables the van-screens read:
 *
 *   * **اليوم** (`day`) — one business day of the rep's documents and collections, with
 *     per-customer visit aggregation. Reads `van_sales_documents` / `van_stock_movements`;
 *     writes nothing.
 *   * **العهدة** (`custody`) — the official van warehouse balances plus his open load
 *     orders with expected vs. actual remaining. Reads `stock_balances` / `van_load_orders`.
 *   * **الإغلاق** (`closing`) — the rep's own shift-closing submission, wrapped around
 *     the existing custody saga after an explicit ownership check (the back-office route
 *     allows accountants to close on a rep's behalf; this one never does).
 */
@Injectable()
export class RepWorkspaceService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly shared: VanSalesSharedService,
    private readonly custody: VanSalesCustodyService,
  ) {}

  /** 📅 يوم المندوب — documents + collections + visit aggregation for one business day. */
  async day(tenantId: string, rep: AuthorisedRep, dateParam?: string) {
    const dateText = (dateParam ?? '').trim() || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || Number.isNaN(Date.parse(dateText))) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'تاريخ غير صالح (YYYY-MM-DD)', 422, {
        field: 'date',
      });
    }

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const documents = rows(
        await tx.execute(sql`
          SELECT d.id::text, d.number, d.document_kind, d.invoice_mode, d.payment_method,
                 d.party_id::text,
                 COALESCE(p.name, d.customer_name, 'عميل نقدي') AS customer_name,
                 d.item_id::text, COALESCE(i.name_ar, 'صنف') AS item_name,
                 d.sold_qty::text, d.bonus_qty::text, d.unit_price::text,
                 d.subtotal::text, d.tax_total::text, d.total::text, d.paid_amount::text,
                 d.sales_invoice_id::text, si.number AS invoice_number, si.status AS invoice_status
          FROM van_sales_documents d
          LEFT JOIN parties p ON p.id = d.party_id
          LEFT JOIN items i ON i.id = d.item_id
          LEFT JOIN sales_invoices si ON si.id = d.sales_invoice_id
          WHERE d.tenant_id = ${tenantId}::uuid
            AND d.deleted_at IS NULL
            AND d.salesman_id = ${rep.salesmanId}::uuid
            AND d.doc_date = ${dateText}::date
          ORDER BY d.created_at ASC
        `),
      );

      const collections = rows(
        await tx.execute(sql`
          SELECT m.id::text, m.created_at, m.amount::text, m.reason, m.voucher_id::text,
                 v.number AS voucher_number, v.status AS voucher_status
          FROM van_stock_movements m
          LEFT JOIN vouchers v ON v.id = m.voucher_id
          WHERE m.tenant_id = ${tenantId}::uuid
            AND m.movement_type = 'collection_receipt'
            AND m.salesman_id = ${rep.salesmanId}::uuid
            AND m.created_at::date = ${dateText}::date
          ORDER BY m.created_at ASC
        `),
      );

      const toDecimal = (value: unknown) => dec(value);

      const sales = documents.filter((row) => str(row.document_kind) !== 'return');
      const returns = documents.filter((row) => str(row.document_kind) === 'return');

      const totals = documents.reduce<{
        revenue: Decimal;
        collected: Decimal;
        outstanding: Decimal;
        cashSales: Decimal;
        creditSales: Decimal;
      }>(
        (acc, doc) => {
          const docTotal = toDecimal(doc.total);
          const paid = toDecimal(doc.paid_amount);
          const isReturn = str(doc.document_kind) === 'return';
          acc.revenue = acc.revenue.plus(isReturn ? docTotal.neg() : docTotal);
          acc.collected = acc.collected.plus(paid);
          acc.outstanding = acc.outstanding.plus(Decimal.max(0, docTotal.minus(paid)));
          if (str(doc.payment_method) === 'cash') acc.cashSales = acc.cashSales.plus(docTotal);
          else acc.creditSales = acc.creditSales.plus(docTotal);
          return acc;
        },
        {
          revenue: new Decimal(0),
          collected: new Decimal(0),
          outstanding: new Decimal(0),
          cashSales: new Decimal(0),
          creditSales: new Decimal(0),
        },
      );
      const collectionsTotal = collections.reduce(
        (sum, row) => sum.plus(toDecimal(row.amount)),
        new Decimal(0),
      );

      /** 🧭 الزيارات — the same day seen per customer: what he bought, returned and paid. */
      const visits = new Map<
        string,
        { customerName: string; partyId: string | null; documents: number; returns: number; revenue: Decimal; collected: Decimal }
      >();
      for (const doc of documents) {
        const key = str(doc.party_id) || `cash:${str(doc.customer_name)}`;
        const entry =
          visits.get(key) ??
          {
            customerName: str(doc.customer_name),
            partyId: doc.party_id ? str(doc.party_id) : null,
            documents: 0,
            returns: 0,
            revenue: new Decimal(0),
            collected: new Decimal(0),
          };
        const docTotal = toDecimal(doc.total);
        const isReturn = str(doc.document_kind) === 'return';
        if (isReturn) entry.returns += 1;
        else entry.documents += 1;
        entry.revenue = entry.revenue.plus(isReturn ? docTotal.neg() : docTotal);
        entry.collected = entry.collected.plus(toDecimal(doc.paid_amount));
        visits.set(key, entry);
      }

      return {
        data: {
          date: dateText,
          salesmanId: rep.salesmanId,
          salesmanName: rep.salesmanName,
          documents: documents.map(mapDayDocument),
          collections: collections.map((row) => ({
            id: str(row.id),
            collectedAt: iso(row.created_at),
            amount: dec(row.amount).toFixed(2),
            reason: str(row.reason),
            voucherId: row.voucher_id ? str(row.voucher_id) : null,
            voucherNumber: row.voucher_number ? str(row.voucher_number) : null,
            voucherStatus: row.voucher_status ? str(row.voucher_status) : null,
          })),
          totals: {
            documents: sales.length,
            returns: returns.length,
            revenue: totals.revenue.toFixed(2),
            cashSales: totals.cashSales.toFixed(2),
            creditSales: totals.creditSales.toFixed(2),
            collectedOnDocuments: totals.collected.toFixed(2),
            collections: collectionsTotal.toFixed(2),
            outstanding: totals.outstanding.toFixed(2),
          },
          visits: [...visits.values()]
            .map((entry) => ({
              customerName: entry.customerName,
              partyId: entry.partyId,
              documents: entry.documents,
              returns: entry.returns,
              revenue: entry.revenue.toFixed(2),
              collected: entry.collected.toFixed(2),
            }))
            .sort((a, b) => dec(b.revenue).cmp(dec(a.revenue))),
        },
      };
    });
  }

  /** 🧮 ملخص العهدة — official van balances + open load orders (expected vs. actual). */
  async custodySummary(tenantId: string, rep: AuthorisedRep) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const balances = await this.shared.officialStockBalancesInTx(tx, tenantId, {
        warehouseIds: [rep.warehouseId],
      });

      const openOrders = rows(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.load_date::text, l.status, l.item_id::text,
                 COALESCE(i.name_ar, 'صنف') AS item_name, l.production_batch_no,
                 l.loaded_qty::text, l.received_qty::text, l.sold_qty::text, l.bonus_qty::text,
                 l.returned_qty::text, l.damaged_qty::text, l.shortage_qty::text,
                 l.expected_cash::text, l.collected_cash::text, l.actual_remaining_qty::text,
                 l.stock_settlement_status
          FROM van_load_orders l
          LEFT JOIN items i ON i.id = l.item_id
          WHERE l.tenant_id = ${tenantId}::uuid
            AND l.deleted_at IS NULL
            AND l.salesman_id = ${rep.salesmanId}::uuid
            AND l.status NOT IN ('settled', 'canceled', 'rejected')
          ORDER BY l.created_at DESC
        `),
      ).map((row) => {
        const received = dec(row.received_qty).gt(0) ? dec(row.received_qty) : dec(row.loaded_qty);
        return {
          id: str(row.id),
          number: str(row.number),
          loadDate: str(row.load_date),
          status: str(row.status),
          itemId: row.item_id ? str(row.item_id) : null,
          itemName: str(row.item_name),
          productionBatchNo: str(row.production_batch_no),
          loadedQty: dec(row.loaded_qty).toFixed(4),
          receivedQty: dec(row.received_qty).toFixed(4),
          soldQty: dec(row.sold_qty).toFixed(4),
          bonusQty: dec(row.bonus_qty).toFixed(4),
          returnedQty: dec(row.returned_qty).toFixed(4),
          damagedQty: dec(row.damaged_qty).toFixed(4),
          shortageQty: dec(row.shortage_qty).toFixed(4),
          expectedCash: dec(row.expected_cash).toFixed(2),
          collectedCash: dec(row.collected_cash).toFixed(2),
          outstandingCash: Decimal.max(0, dec(row.expected_cash).minus(dec(row.collected_cash))).toFixed(2),
          expectedRemainingQty: Decimal.max(
            0,
            received
              .minus(dec(row.sold_qty))
              .minus(dec(row.bonus_qty))
              .minus(dec(row.returned_qty))
              .minus(dec(row.damaged_qty)),
          ).toFixed(4),
          actualRemainingQty: dec(row.actual_remaining_qty).toFixed(4),
          stockSettlementStatus: str(row.stock_settlement_status || 'not_required'),
        };
      });

      return {
        data: {
          salesmanId: rep.salesmanId,
          salesmanName: rep.salesmanName,
          warehouseId: rep.warehouseId,
          vehiclePlate: rep.vehiclePlate,
          balances,
          custodyKg: balances.reduce((sum, row) => sum.plus(dec(row.quantity)), new Decimal(0)).toFixed(4),
          custodyValue: balances.reduce((sum, row) => sum.plus(dec(row.value)), new Decimal(0)).toFixed(4),
          openLoadOrders: openOrders,
        },
      };
    });
  }

  /**
   * 📥 تقديم الإغلاق — the rep's own closing submission. The back-office route
   * (`POST /van-sales/load-orders/:id/submit-closing`) exists for the accountant; this one
   * is the rep path and refuses any load order that is not his own with 403, so "hiding
   * the button" is never the only thing standing between two custodies.
   */
  async submitClosing(
    tenantId: string,
    userId: string,
    rep: AuthorisedRep,
    body: {
      loadOrderId?: string;
      returnedQty?: string;
      damagedQty?: string;
      damageReason?: string;
      collectedCash?: string;
      actualRemainingQty?: string;
      closingNotes?: string;
    },
  ) {
    const loadOrderId = str(body?.loadOrderId).trim();
    if (!loadOrderId) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'حدد أمر التحميل المراد إغلاقه', 422, {
        field: 'loadOrderId',
      });
    }

    const order = await withTenantTx(this.database.db, tenantId, async (tx) =>
      first(
        await tx.execute(sql`
          SELECT salesman_id::text, status FROM van_load_orders
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      ),
    );
    if (!order) throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
    if (str(order.salesman_id) !== rep.salesmanId) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'لا يجوز تقديم إغلاق لعهدة مندوب آخر',
        403,
        { field: 'loadOrderId' },
      );
    }

    const closingBody = { ...body };
    delete closingBody.loadOrderId;
    return { data: await this.custody.submitClosing(tenantId, userId, loadOrderId, closingBody) };
  }
}

/** `Decimal` is re-imported at the top; this stub keeps the module single-purpose. */
function mapDayDocument(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    number: str(row.number),
    documentKind: str(row.document_kind),
    invoiceMode: str(row.invoice_mode),
    paymentMethod: str(row.payment_method),
    partyId: row.party_id ? str(row.party_id) : null,
    customerName: str(row.customer_name),
    itemId: row.item_id ? str(row.item_id) : null,
    itemName: str(row.item_name),
    soldQty: dec(row.sold_qty).toFixed(4),
    bonusQty: dec(row.bonus_qty).toFixed(4),
    unitPrice: dec(row.unit_price).toFixed(4),
    subtotal: dec(row.subtotal).toFixed(2),
    taxTotal: dec(row.tax_total).toFixed(2),
    total: dec(row.total).toFixed(2),
    paidAmount: dec(row.paid_amount).toFixed(2),
    salesInvoiceId: row.sales_invoice_id ? str(row.sales_invoice_id) : null,
    invoiceNumber: row.invoice_number ? str(row.invoice_number) : null,
    invoiceStatus: row.invoice_status ? str(row.invoice_status) : null,
  };
}
