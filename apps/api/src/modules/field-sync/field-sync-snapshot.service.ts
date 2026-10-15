import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { rows, first, str } from '../van-sales/van-sales-shared.service.js';

import type { AuthorisedRep } from './field-sync-rep-guard.service.js';

/**
 * 📸 لقطة المندوب ودلتاها — the offline master data the rep app carries in IndexedDB.
 *
 * Design rules:
 * - **Rep-scoped by construction (D-004)**: stock is read for the rep's own van warehouse
 *   only, load orders and credit documents for his own salesman card — the caller's
 *   membership decides, a request parameter never does.
 * - **The watermark is the database clock**: `now()` read in the same transaction that
 *   reads the rows. The client stores it verbatim and sends it back as `since`; delta
 *   comparisons (`GREATEST(created_at, updated_at) > since`) therefore never depend on a
 *   device clock.
 * - **Honest deltas**: every collection that tracks `updated_at` returns changed rows and
 *   soft-deleted ids separately. Collections without change tracking (`item_units`,
 *   `item_barcodes`) and live operational state (stock, open load orders, open credit
 *   documents) are re-read in full — they are small and current-value is what the app
 *   needs; pretending they had a delta would be the dishonest option.
 * - Customer price rows carry their effective window (`effectiveFrom`/`effectiveTo`); a
 *   window that closes needs no server signal because the row itself says when it stops
 *   applying — the app filters locally.
 */
@Injectable()
export class FieldSyncSnapshotService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /** اللقطة الكاملة — everything the device needs to work a full day offline. */
  async snapshot(tenantId: string, rep: AuthorisedRep) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const watermark = str(first(await tx.execute(sql`SELECT now()::text AS now`))?.now);

      const customers = rows(
        await tx.execute(sql`
          SELECT p.id::text, p.code, p.name, p.phone, p.email, p.tax_no, p.branch_id::text,
                 p.credit_limit::text, p.is_owner
          FROM parties p
          WHERE p.tenant_id = ${tenantId}::uuid
            AND p.kind IN ('customer', 'both')
            AND p.deleted_at IS NULL
          ORDER BY p.name ASC
          LIMIT 10000
        `),
      ).map(mapCustomer);

      const customerPrices = rows(
        await tx.execute(sql`
          SELECT party_id::text, item_id::text, price_tier_label, unit_price::text,
                 max_bonus_pct::text, max_bonus_qty::text, max_bonus_kg_per_invoice::text,
                 expected_daily_qty::text, preferred_invoice_mode, credit_limit::text,
                 payment_terms_days::text, lock_price, max_discount_pct::text,
                 effective_from::text, effective_to::text
          FROM van_sales_customer_prices
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
            AND effective_from <= CURRENT_DATE
            AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
          ORDER BY party_id ASC
        `),
      ).map(mapCustomerPrice);

      const items = rows(
        await tx.execute(sql`
          SELECT id::text, sku, barcode, name_ar, name_en, category_id::text,
                 base_unit_id::text, kind, sale_price::text, purchase_price::text,
                 tax_group_id::text, track_lot, weighted_scale, show_in_pos
          FROM items
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          ORDER BY name_ar ASC
          LIMIT 10000
        `),
      ).map(mapItem);

      const units = rows(
        await tx.execute(sql`
          SELECT id::text, code, name_ar, name_en
          FROM units_of_measure
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      ).map((row) => ({
        id: str(row.id),
        code: str(row.code),
        nameAr: str(row.name_ar),
        nameEn: str(row.name_en),
      }));

      const taxes = rows(
        await tx.execute(sql`
          SELECT id::text, name_ar, name_en, rate::text, is_inclusive_default
          FROM tax_groups
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      ).map((row) => ({
        id: str(row.id),
        nameAr: str(row.name_ar),
        nameEn: str(row.name_en),
        rate: str(row.rate),
        isInclusiveDefault: row.is_inclusive_default === true,
      }));

      const itemUnits = rows(
        await tx.execute(sql`
          SELECT iu.item_id::text, iu.unit_id::text, iu.ratio::text, iu.barcode,
                 iu.sale_price::text, iu.is_default_sale
          FROM item_units iu
          JOIN items i ON i.id = iu.item_id
          WHERE i.tenant_id = ${tenantId}::uuid AND i.deleted_at IS NULL
        `),
      ).map((row) => ({
        itemId: str(row.item_id),
        unitId: str(row.unit_id),
        ratio: str(row.ratio),
        barcode: row.barcode ? str(row.barcode) : null,
        salePrice: row.sale_price ? str(row.sale_price) : null,
        isDefaultSale: row.is_default_sale === true,
      }));

      const barcodes = rows(
        await tx.execute(sql`
          SELECT b.barcode, b.item_id::text, b.unit_id::text
          FROM item_barcodes b
          JOIN items i ON i.id = b.item_id
          WHERE b.tenant_id = ${tenantId}::uuid AND i.deleted_at IS NULL
        `),
      ).map((row) => ({
        barcode: str(row.barcode),
        itemId: str(row.item_id),
        unitId: row.unit_id ? str(row.unit_id) : null,
      }));

      /** 🔒 العهدة — the official ledger rows of the rep's van warehouse, nothing else. */
      const stock = rows(
        await tx.execute(sql`
          SELECT b.item_id::text, b.warehouse_id::text, b.quantity::text, b.value::text,
                 b.average_cost::text
          FROM stock_balances b
          WHERE b.tenant_id = ${tenantId}::uuid
            AND b.warehouse_id = ${rep.warehouseId}::uuid
          ORDER BY b.item_id ASC
        `),
      ).map((row) => ({
        itemId: str(row.item_id),
        warehouseId: str(row.warehouse_id),
        quantity: str(row.quantity),
        value: str(row.value),
        averageCost: str(row.average_cost),
      }));

      const priceLists = rows(
        await tx.execute(sql`
          SELECT id::text, name, currency_code, is_default
          FROM price_lists
          WHERE tenant_id = ${tenantId}::uuid AND is_active = true AND deleted_at IS NULL
        `),
      ).map((row) => ({
        id: str(row.id),
        name: str(row.name),
        currencyCode: str(row.currency_code),
        isDefault: row.is_default === true,
      }));

      const priceListItems = priceLists.length
        ? rows(
            await tx.execute(sql`
              SELECT pli.id::text, pli.price_list_id::text, pli.item_id::text,
                     pli.unit_id::text, pli.unit_price::text, pli.min_qty::text
              FROM price_list_items pli
              WHERE pli.tenant_id = ${tenantId}::uuid
                AND pli.price_list_id IN (${sql.join(
                  priceLists.map((row) => sql`${row.id}::uuid`),
                  sql`, `,
                )})
            `),
          ).map((row) => ({
            id: str(row.id),
            priceListId: str(row.price_list_id),
            itemId: row.item_id ? str(row.item_id) : null,
            unitId: row.unit_id ? str(row.unit_id) : null,
            unitPrice: str(row.unit_price),
            minQty: str(row.min_qty),
          }))
        : [];

      const paymentMethods = rows(
        await tx.execute(sql`
          SELECT id::text, code, name_ar, kind, due_days::text, cash_location_id::text, is_default
          FROM payment_methods
          WHERE tenant_id = ${tenantId}::uuid AND is_active = true AND deleted_at IS NULL
          ORDER BY is_default DESC, code ASC
        `),
      ).map((row) => ({
        id: str(row.id),
        code: str(row.code),
        nameAr: str(row.name_ar),
        kind: str(row.kind),
        dueDays: str(row.due_days),
        cashLocationId: row.cash_location_id ? str(row.cash_location_id) : null,
        isDefault: row.is_default === true,
      }));

      const openLoadOrders = await this.openLoadOrdersInTx(tx, tenantId, rep.salesmanId);
      const openCreditDocuments = await this.openCreditDocumentsInTx(
        tx,
        tenantId,
        rep.salesmanId,
      );

      return {
        data: {
          schemaVersion: 1,
          generatedAt: watermark,
          watermark,
          expiresInSeconds: 24 * 60 * 60,
          rep: {
            salesmanId: rep.salesmanId,
            salesmanName: rep.salesmanName,
            warehouseId: rep.warehouseId,
            vehiclePlate: rep.vehiclePlate,
          },
          customers,
          customerPrices,
          items,
          units,
          taxes,
          itemUnits,
          barcodes,
          stock,
          priceLists,
          priceListItems,
          paymentMethods,
          openLoadOrders,
          openCreditDocuments,
        },
      };
    });
  }

  /**
   * 🕰️ الدلتا — what changed since the client's stored watermark.
   *
   * `changed` collections mirror the snapshot shape row-for-row; `deleted` carries the
   * soft-deleted ids per collection; `full` re-reads the collections that have no change
   * tracking or that represent live operational state. The new watermark closes the
   * window: rows written after it will appear in the next delta.
   */
  async delta(tenantId: string, rep: AuthorisedRep, sinceParam: string | undefined) {
    const sinceText = (sinceParam ?? '').trim();
    if (!sinceText || Number.isNaN(Date.parse(sinceText))) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'مرر العلامة المائية (`since`) كما استلمتها من اللقطة أو الدلتا السابقة',
        422,
        { field: 'since' },
      );
    }

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const watermark = str(first(await tx.execute(sql`SELECT now()::text AS now`))?.now);
      const since = sql`${sinceText}::timestamptz`;
      /** العمود الذي يُقاس عليه التغيير — القراءة والتعديل، أهما حدث فالصف تغيّر. */
      const changedExpr = sql`GREATEST(created_at, COALESCE(updated_at, created_at)) > ${since}`;

      const customers = rows(
        await tx.execute(sql`
          SELECT p.id::text, p.code, p.name, p.phone, p.email, p.tax_no, p.branch_id::text,
                 p.credit_limit::text, p.is_owner
          FROM parties p
          WHERE p.tenant_id = ${tenantId}::uuid
            AND p.kind IN ('customer', 'both')
            AND p.deleted_at IS NULL AND ${changedExpr}
          ORDER BY p.name ASC
        `),
      ).map(mapCustomer);

      const customerPrices = rows(
        await tx.execute(sql`
          SELECT party_id::text, item_id::text, price_tier_label, unit_price::text,
                 max_bonus_pct::text, max_bonus_qty::text, max_bonus_kg_per_invoice::text,
                 expected_daily_qty::text, preferred_invoice_mode, credit_limit::text,
                 payment_terms_days::text, lock_price, max_discount_pct::text,
                 effective_from::text, effective_to::text
          FROM van_sales_customer_prices
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL AND ${changedExpr}
          ORDER BY party_id ASC
        `),
      ).map(mapCustomerPrice);

      const items = rows(
        await tx.execute(sql`
          SELECT id::text, sku, barcode, name_ar, name_en, category_id::text,
                 base_unit_id::text, kind, sale_price::text, purchase_price::text,
                 tax_group_id::text, track_lot, weighted_scale, show_in_pos
          FROM items
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND ${changedExpr}
          ORDER BY name_ar ASC
        `),
      ).map(mapItem);

      const units = rows(
        await tx.execute(sql`
          SELECT id::text, code, name_ar, name_en
          FROM units_of_measure
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND ${changedExpr}
        `),
      ).map((row) => ({
        id: str(row.id),
        code: str(row.code),
        nameAr: str(row.name_ar),
        nameEn: str(row.name_en),
      }));

      const taxes = rows(
        await tx.execute(sql`
          SELECT id::text, name_ar, name_en, rate::text, is_inclusive_default
          FROM tax_groups
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND ${changedExpr}
        `),
      ).map((row) => ({
        id: str(row.id),
        nameAr: str(row.name_ar),
        nameEn: str(row.name_en),
        rate: str(row.rate),
        isInclusiveDefault: row.is_inclusive_default === true,
      }));

      const priceLists = rows(
        await tx.execute(sql`
          SELECT id::text, name, currency_code, is_default
          FROM price_lists
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND ${changedExpr}
        `),
      ).map((row) => ({
        id: str(row.id),
        name: str(row.name),
        currencyCode: str(row.currency_code),
        isDefault: row.is_default === true,
      }));

      const priceListItems = priceLists.length
        ? rows(
            await tx.execute(sql`
              SELECT pli.id::text, pli.price_list_id::text, pli.item_id::text,
                     pli.unit_id::text, pli.unit_price::text, pli.min_qty::text
              FROM price_list_items pli
              WHERE pli.tenant_id = ${tenantId}::uuid
                AND pli.price_list_id IN (${sql.join(
                  priceLists.map((row) => sql`${row.id}::uuid`),
                  sql`, `,
                )})
                AND ${changedExpr}
            `),
          ).map((row) => ({
            id: str(row.id),
            priceListId: str(row.price_list_id),
            itemId: row.item_id ? str(row.item_id) : null,
            unitId: row.unit_id ? str(row.unit_id) : null,
            unitPrice: str(row.unit_price),
            minQty: str(row.min_qty),
          }))
        : [];

      const paymentMethods = rows(
        await tx.execute(sql`
          SELECT id::text, code, name_ar, kind, due_days::text, cash_location_id::text, is_default
          FROM payment_methods
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND ${changedExpr}
          ORDER BY is_default DESC, code ASC
        `),
      ).map((row) => ({
        id: str(row.id),
        code: str(row.code),
        nameAr: str(row.name_ar),
        kind: str(row.kind),
        dueDays: str(row.due_days),
        cashLocationId: row.cash_location_id ? str(row.cash_location_id) : null,
        isDefault: row.is_default === true,
      }));

      const deletedIds = async (table: string) =>
        rows(
          await tx.execute(sql`
            SELECT id::text FROM ${sql.raw(table)}
            WHERE tenant_id = ${tenantId}::uuid AND deleted_at > ${since}
          `),
        ).map((row) => str(row.id));

      const [
        deletedCustomers,
        deletedCustomerPrices,
        deletedItems,
        deletedUnits,
        deletedTaxes,
        deletedPriceLists,
        deletedPaymentMethods,
      ] = await Promise.all([
        deletedIds('parties'),
        /** أسعار العملاء بلا مفتاح واحد للعميل — الحذف يُبلَّغ بزوج (عميل، صنف). */
        (async () =>
          rows(
            await tx.execute(sql`
              SELECT party_id::text, item_id::text FROM van_sales_customer_prices
              WHERE tenant_id = ${tenantId}::uuid AND deleted_at > ${since}
            `),
          ).map((row) => ({ partyId: str(row.party_id), itemId: str(row.item_id) })))(),
        deletedIds('items'),
        deletedIds('units_of_measure'),
        deletedIds('tax_groups'),
        deletedIds('price_lists'),
        deletedIds('payment_methods'),
      ]);

      const itemUnits = rows(
        await tx.execute(sql`
          SELECT iu.item_id::text, iu.unit_id::text, iu.ratio::text, iu.barcode,
                 iu.sale_price::text, iu.is_default_sale
          FROM item_units iu
          JOIN items i ON i.id = iu.item_id
          WHERE i.tenant_id = ${tenantId}::uuid AND i.deleted_at IS NULL
        `),
      ).map((row) => ({
        itemId: str(row.item_id),
        unitId: str(row.unit_id),
        ratio: str(row.ratio),
        barcode: row.barcode ? str(row.barcode) : null,
        salePrice: row.sale_price ? str(row.sale_price) : null,
        isDefaultSale: row.is_default_sale === true,
      }));

      const stock = rows(
        await tx.execute(sql`
          SELECT b.item_id::text, b.warehouse_id::text, b.quantity::text, b.value::text,
                 b.average_cost::text
          FROM stock_balances b
          WHERE b.tenant_id = ${tenantId}::uuid
            AND b.warehouse_id = ${rep.warehouseId}::uuid
          ORDER BY b.item_id ASC
        `),
      ).map((row) => ({
        itemId: str(row.item_id),
        warehouseId: str(row.warehouse_id),
        quantity: str(row.quantity),
        value: str(row.value),
        averageCost: str(row.average_cost),
      }));

      const openLoadOrders = await this.openLoadOrdersInTx(tx, tenantId, rep.salesmanId);
      const openCreditDocuments = await this.openCreditDocumentsInTx(
        tx,
        tenantId,
        rep.salesmanId,
      );

      return {
        data: {
          since: sinceText,
          watermark,
          changed: {
            customers,
            customerPrices,
            items,
            units,
            taxes,
            priceLists,
            priceListItems,
            paymentMethods,
          },
          deleted: {
            customers: deletedCustomers,
            customerPrices: deletedCustomerPrices,
            items: deletedItems,
            units: deletedUnits,
            taxes: deletedTaxes,
            priceLists: deletedPriceLists,
            paymentMethods: deletedPaymentMethods,
          },
          full: {
            itemUnits,
            barcodes: rows(
              await tx.execute(sql`
                SELECT b.barcode, b.item_id::text, b.unit_id::text
                FROM item_barcodes b
                JOIN items i ON i.id = b.item_id
                WHERE b.tenant_id = ${tenantId}::uuid AND i.deleted_at IS NULL
              `),
            ).map((row) => ({
              barcode: str(row.barcode),
              itemId: str(row.item_id),
              unitId: row.unit_id ? str(row.unit_id) : null,
            })),
            stock,
            openLoadOrders,
            openCreditDocuments,
          },
        },
      };
    });
  }

  /** أوامر التحميل المفتوحة — custody the rep may still sell from or must still close. */
  private async openLoadOrdersInTx(tx: FieldSyncTx, tenantId: string, salesmanId: string) {
    return rows(
      await tx.execute(sql`
        SELECT l.id::text, l.number, l.load_date::text, l.status, l.item_id::text,
               l.warehouse_id::text, l.van_warehouse_id::text, l.production_batch_no,
               l.loaded_qty::text, l.received_qty::text, l.sold_qty::text, l.bonus_qty::text,
               l.returned_qty::text, l.damaged_qty::text, l.expected_cash::text,
               l.collected_cash::text, l.stock_transfer_id::text
        FROM van_load_orders l
        WHERE l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          AND l.salesman_id = ${salesmanId}::uuid
          AND l.status NOT IN ('settled', 'canceled', 'rejected')
        ORDER BY l.created_at DESC
      `),
    ).map((row) => ({
      id: str(row.id),
      number: str(row.number),
      loadDate: str(row.load_date),
      status: str(row.status),
      itemId: row.item_id ? str(row.item_id) : null,
      warehouseId: row.warehouse_id ? str(row.warehouse_id) : null,
      vanWarehouseId: row.van_warehouse_id ? str(row.van_warehouse_id) : null,
      productionBatchNo: str(row.production_batch_no),
      loadedQty: str(row.loaded_qty),
      receivedQty: str(row.received_qty),
      soldQty: str(row.sold_qty),
      bonusQty: str(row.bonus_qty),
      returnedQty: str(row.returned_qty),
      damagedQty: str(row.damaged_qty),
      expectedCash: str(row.expected_cash),
      collectedCash: str(row.collected_cash),
      stockTransferId: row.stock_transfer_id ? str(row.stock_transfer_id) : null,
    }));
  }

  /** فواتير الآجل غير المسددة — the collection targets the rep may receipt offline. */
  private async openCreditDocumentsInTx(
    tx: FieldSyncTx,
    tenantId: string,
    salesmanId: string,
  ) {
    return rows(
      await tx.execute(sql`
        SELECT d.id::text, d.number, d.doc_date::text, d.party_id::text,
               COALESCE(p.name, d.customer_name, 'عميل نقدي') AS customer_name,
               d.item_id::text, d.sold_qty::text, d.unit_price::text,
               d.total::text, d.paid_amount::text,
               (d.total - d.paid_amount)::text AS outstanding,
               d.sales_invoice_id::text, d.load_order_id::text
        FROM van_sales_documents d
        LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.tenant_id = ${tenantId}::uuid AND d.deleted_at IS NULL
          AND d.salesman_id = ${salesmanId}::uuid
          AND d.document_kind = 'sale'
          AND d.total > d.paid_amount
        ORDER BY d.doc_date DESC, d.created_at DESC
        LIMIT 500
      `),
    ).map((row) => ({
      id: str(row.id),
      number: str(row.number),
      docDate: str(row.doc_date),
      partyId: row.party_id ? str(row.party_id) : null,
      customerName: str(row.customer_name),
      itemId: row.item_id ? str(row.item_id) : null,
      soldQty: str(row.sold_qty),
      unitPrice: str(row.unit_price),
      total: str(row.total),
      paidAmount: str(row.paid_amount),
      outstanding: str(row.outstanding),
      salesInvoiceId: row.sales_invoice_id ? str(row.sales_invoice_id) : null,
      loadOrderId: row.load_order_id ? str(row.load_order_id) : null,
    }));
  }
}

/** The transaction handle as this module uses it — drizzle's execute with SQL templates. */
type FieldSyncTx = DrizzleTx;

function mapCustomer(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    code: str(row.code),
    name: str(row.name),
    phone: row.phone ? str(row.phone) : null,
    email: row.email ? str(row.email) : null,
    taxNo: row.tax_no ? str(row.tax_no) : null,
    branchId: row.branch_id ? str(row.branch_id) : null,
    creditLimit: str(row.credit_limit),
    isOwner: row.is_owner === true,
  };
}

function mapCustomerPrice(row: Record<string, unknown>) {
  return {
    partyId: str(row.party_id),
    itemId: row.item_id ? str(row.item_id) : null,
    priceTierLabel: str(row.price_tier_label),
    unitPrice: str(row.unit_price),
    maxBonusPct: str(row.max_bonus_pct),
    maxBonusQty: str(row.max_bonus_qty),
    maxBonusKgPerInvoice: str(row.max_bonus_kg_per_invoice),
    expectedDailyQty: str(row.expected_daily_qty),
    preferredInvoiceMode: str(row.preferred_invoice_mode),
    creditLimit: str(row.credit_limit),
    paymentTermsDays: str(row.payment_terms_days),
    lockPrice: row.lock_price === true,
    maxDiscountPct: str(row.max_discount_pct),
    effectiveFrom: str(row.effective_from),
    effectiveTo: row.effective_to ? str(row.effective_to) : null,
  };
}

function mapItem(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    sku: str(row.sku),
    barcode: row.barcode ? str(row.barcode) : null,
    nameAr: str(row.name_ar),
    nameEn: row.name_en ? str(row.name_en) : null,
    categoryId: row.category_id ? str(row.category_id) : null,
    baseUnitId: str(row.base_unit_id),
    kind: str(row.kind),
    salePrice: row.sale_price ? str(row.sale_price) : null,
    purchasePrice: row.purchase_price ? str(row.purchase_price) : null,
    taxGroupId: row.tax_group_id ? str(row.tax_group_id) : null,
    trackLot: row.track_lot === true,
    weightedScale: row.weighted_scale === true,
    showInPos: row.show_in_pos === true,
  };
}
