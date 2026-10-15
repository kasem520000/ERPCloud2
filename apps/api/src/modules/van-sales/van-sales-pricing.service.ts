/**
 * Customer price writes and the shortage-unit-price resolution used by closing/settlement.
 *
 * M1 decomposition (see ./README.md): extracted verbatim from the former van-sales.service.ts —
 * pure code movement, no behavior change.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import { first, str, dec, type VanSalesTenantPolicy } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';

@Injectable()
export class VanSalesPricingService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly shared: VanSalesSharedService,
    private readonly reporting: VanSalesReportingService
  ) {}

  async upsertCustomerPrice(
    tenantId: string,
    body: {
      partyId?: string;
      itemId?: string | null;
      priceTierLabel?: string;
      unitPrice?: string;
      maxBonusPct?: string;
      maxBonusKgPerInvoice?: string;
      preferredInvoiceMode?: 'zatca_tax' | 'internal_delivery';
      creditLimit?: string;
      paymentTermsDays?: number;
      lockPrice?: boolean;
      maxDiscountPct?: string;
      effectiveFrom?: string;
      effectiveTo?: string | null;
      changeReason?: string;
      notes?: string;
    },
    userId?: string,
  ) {
    const partyId = str(body.partyId).trim();
    if (!partyId) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'اختر العميل لتحديد سعره المخصص',
        422,
        { field: 'partyId' },
      );
    }
    const unitPrice = dec(body.unitPrice);
    if (unitPrice.lte(0)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'سعر الكيلو للعميل يجب أن يكون أكبر من صفر',
        422,
        { field: 'unitPrice' },
      );
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.shared.loadTenantPolicyInTx(tx, tenantId);
      const partyRow = first(
        await tx.execute(sql`
          SELECT credit_limit::text FROM parties
          WHERE id = ${partyId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          LIMIT 1
        `),
      );

      const maxBonusPct = dec(body.maxBonusPct ?? policy.defaultMaxBonusPct ?? '5');
      const maxBonusKg = dec(body.maxBonusKgPerInvoice ?? policy.defaultMaxBonusQty ?? '2');
      const creditLimit = dec(
        body.creditLimit ?? partyRow?.credit_limit ?? policy.defaultCreditLimit ?? '5000',
      );
      const paymentTermsDays = Number(body.paymentTermsDays ?? 15);
      const lockPrice = body.lockPrice !== false;
      const maxDiscountPct = dec(body.maxDiscountPct ?? '0');
      const mode =
        body.preferredInvoiceMode === 'internal_delivery' ? 'internal_delivery' : 'zatca_tax';
      const label =
        String(body.priceTierLabel ?? '').trim() || `شريحة ${unitPrice.toFixed(2)} ريال/كجم`;
      const itemId = body.itemId ? String(body.itemId).trim() || null : null;
      const effectiveFrom = body.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10);
      const effectiveTo = body.effectiveTo?.trim() || null;
      const changeReason = body.changeReason?.trim() || body.notes?.trim() || null;

      const existing = first(
        await tx.execute(sql`
          SELECT id::text, unit_price::text FROM van_sales_customer_prices
          WHERE tenant_id = ${tenantId}::uuid
            AND party_id = ${partyId}::uuid
            AND ((${itemId}::uuid IS NULL AND item_id IS NULL) OR item_id = ${itemId}::uuid)
            AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE
        `),
      );

      let customerPriceId: string;
      let previousUnitPrice: string | null = null;

      if (existing) {
        customerPriceId = str(existing.id);
        previousUnitPrice = existing.unit_price ? dec(existing.unit_price).toFixed(4) : null;
        await tx.execute(sql`
          UPDATE van_sales_customer_prices
          SET price_tier_label = ${label},
              unit_price = ${unitPrice.toFixed(4)}::numeric,
              max_bonus_pct = ${maxBonusPct.toFixed(2)}::numeric,
              max_bonus_kg_per_invoice = ${maxBonusKg.toFixed(4)}::numeric,
              preferred_invoice_mode = ${mode},
              credit_limit = ${creditLimit.toFixed(4)}::numeric,
              payment_terms_days = ${paymentTermsDays},
              lock_price = ${lockPrice},
              max_discount_pct = ${maxDiscountPct.toFixed(2)}::numeric,
              effective_from = ${effectiveFrom}::date,
              effective_to = ${effectiveTo}::date,
              updated_by = ${userId ?? null}::uuid,
              change_reason = ${changeReason},
              notes = ${body.notes?.trim() || null},
              updated_at = now()
          WHERE id = ${customerPriceId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      } else {
        customerPriceId = newId();
        await tx.execute(sql`
          INSERT INTO van_sales_customer_prices (
            id, tenant_id, party_id, item_id, price_tier_label, unit_price,
            max_bonus_pct, max_bonus_kg_per_invoice, preferred_invoice_mode,
            credit_limit, payment_terms_days, lock_price, max_discount_pct,
            effective_from, effective_to, updated_by, change_reason, notes
          ) VALUES (
            ${customerPriceId}::uuid, ${tenantId}::uuid, ${partyId}::uuid, ${itemId}::uuid,
            ${label}, ${unitPrice.toFixed(4)}::numeric,
            ${maxBonusPct.toFixed(2)}::numeric, ${maxBonusKg.toFixed(4)}::numeric,
            ${mode}, ${creditLimit.toFixed(4)}::numeric, ${paymentTermsDays},
            ${lockPrice}, ${maxDiscountPct.toFixed(2)}::numeric,
            ${effectiveFrom}::date, ${effectiveTo}::date, ${userId ?? null}::uuid,
            ${changeReason}, ${body.notes?.trim() || null}
          )
        `);
      }

      await tx.execute(sql`
        INSERT INTO van_sales_customer_price_history (
          id, tenant_id, customer_price_id, party_id, item_id,
          previous_unit_price, new_unit_price,
          max_bonus_pct, max_bonus_kg_per_invoice, max_discount_pct, lock_price,
          effective_from, effective_to, change_reason, changed_by
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, ${customerPriceId}::uuid, ${partyId}::uuid, ${itemId}::uuid,
          ${previousUnitPrice}::numeric, ${unitPrice.toFixed(4)}::numeric,
          ${maxBonusPct.toFixed(2)}::numeric, ${maxBonusKg.toFixed(4)}::numeric,
          ${maxDiscountPct.toFixed(2)}::numeric, ${lockPrice},
          ${effectiveFrom}::date, ${effectiveTo}::date, ${changeReason}, ${userId ?? null}::uuid
        )
      `);
    });
    return this.reporting.dashboard(tenantId);
  }

  /**
   * Pillar 1 & 2 (Phase 2 & 3): Issue goods from Factory Warehouse to Sales Rep Custody (`أمر تحميل وصرف عهدة لمندوب`),
   * using atomic `SequencesService.next` and linking to official `stock_transfers` / `InventoryService.recordInTx`.
   */

  async resolveShortageUnitPriceInTx(
    tx: DrizzleTx,
    tenantId: string,
    loadOrder: Record<string, unknown>,
    policy: VanSalesTenantPolicy,
  ): Promise<Decimal> {
    if (policy.shortageUnitPrice && dec(policy.shortageUnitPrice).gt(0)) {
      return dec(policy.shortageUnitPrice);
    }
    if (policy.shortageValuationBasis === 'unit_cost' && dec(loadOrder.unit_cost).gt(0)) {
      return dec(loadOrder.unit_cost);
    }
    const avgDocRow = first(
      await tx.execute(sql`
        SELECT AVG(unit_price)::text AS avg_price
        FROM van_sales_documents
        WHERE tenant_id = ${tenantId}::uuid
          AND load_order_id = ${str(loadOrder.id)}::uuid
          AND deleted_at IS NULL
          AND unit_price > 0
      `),
    );
    if (avgDocRow?.avg_price && dec(avgDocRow.avg_price).gt(0)) {
      return dec(avgDocRow.avg_price);
    }
    if (loadOrder.item_id) {
      const itemRow = first(
        await tx.execute(sql`
          SELECT sale_price::text, purchase_price::text AS cost_price FROM items
          WHERE id = ${str(loadOrder.item_id)}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (itemRow?.sale_price && dec(itemRow.sale_price).gt(0)) {
        return dec(itemRow.sale_price);
      }
      if (itemRow?.cost_price && dec(itemRow.cost_price).gt(0)) {
        return dec(itemRow.cost_price);
      }
    }
    const loadedQty = dec(loadOrder.loaded_qty);
    const loadedVal = dec(loadOrder.loaded_total_value);
    if (loadedQty.gt(0) && loadedVal.gt(0)) {
      return loadedVal.div(loadedQty);
    }
    return dec(loadOrder.unit_cost);
  }

  /**
   * Pillar 2 (Stage 1 — Phase 3 & 4): Sales Rep submits End-of-Day Shift Closing (`تقديم إغلاق الوردية للمحاسب`).
   */
}
