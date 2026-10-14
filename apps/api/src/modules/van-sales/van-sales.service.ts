import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AccountingService } from '../accounting/accounting.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { ProductionOrdersService } from '../inventory/production-orders.service.js';
import { WmsBomService } from '../inventory/wms-bom.service.js';
import { PostingProfilesService } from '../organization/index.js';
import { MembershipsService } from '../platform/tenancy/memberships.service.js';
import { RolesService } from '../platform/tenancy/roles.service.js';
import { NotificationsService, SequencesService } from '../platform-services/index.js';
import { SalesService, type SalesLineInput } from '../sales/sales.service.js';
import { TreasuryService } from '../treasury/treasury.service.js';

function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

function first(result: unknown): Record<string, unknown> | undefined {
  return rows(result)[0];
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function dec(value: unknown): Decimal {
  try {
    return new Decimal(value === null || value === undefined || value === '' ? 0 : String(value));
  } catch {
    return new Decimal(0);
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function buildZatcaTlvBase64(params: {
  sellerName: string;
  vatNumber: string;
  timestampIso: string;
  invoiceTotal: string;
  vatTotal: string;
}): string {
  const fields: Array<[number, string]> = [
    [1, params.sellerName || 'مصنع ومخابز التوزيع'],
    [2, params.vatNumber || '300000000000003'],
    [3, params.timestampIso],
    [4, Number(params.invoiceTotal || 0).toFixed(2)],
    [5, Number(params.vatTotal || 0).toFixed(2)],
  ];
  const chunks: Buffer[] = [];
  for (const [tag, val] of fields) {
    const valBuf = Buffer.from(val, 'utf8');
    const len = Math.min(valBuf.length, 255);
    chunks.push(Buffer.from([tag, len]), valBuf.subarray(0, len));
  }
  return Buffer.concat(chunks).toString('base64');
}

export type VanSalesTenantPolicy = {
  allowInternalDeliveryWithoutTax?: boolean;
  preventSelfApproval?: boolean;
  shortageValuationBasis?: 'unconfigured' | 'unit_cost' | 'selling_price';
  shortageUnitPrice?: string;
  defaultMaxBonusPct?: string;
  defaultMaxBonusQty?: string;
  defaultCreditLimit?: string;
};

@Injectable()
export class VanSalesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
    private readonly notifications: NotificationsService,
    private readonly inventory: InventoryService,
    private readonly productionOrders: ProductionOrdersService,
    private readonly wmsBom: WmsBomService,
    private readonly sales: SalesService,
    private readonly treasury: TreasuryService,
    private readonly accounting: AccountingService,
    private readonly postingProfiles: PostingProfilesService,
    private readonly memberships: MembershipsService,
    private readonly roles: RolesService,
  ) {}

  private async loadTenantPolicyInTx(
    tx: DrizzleTx,
    tenantId: string,
  ): Promise<VanSalesTenantPolicy> {
    const row = first(
      await tx.execute(sql`
        SELECT value FROM tenant_settings
        WHERE tenant_id = ${tenantId}::uuid AND key = 'van_sales.policy'
        LIMIT 1
      `),
    );
    if (!row || !row.value || typeof row.value !== 'object') {
      return {};
    }
    return row.value as VanSalesTenantPolicy;
  }

  private async resolveDefaultBranchIdInTx(
    tx: DrizzleTx,
    tenantId: string,
    requestedBranchId?: string | null,
    warehouseId?: string | null,
  ): Promise<string | null> {
    if (requestedBranchId && requestedBranchId.trim()) {
      return requestedBranchId.trim();
    }
    if (warehouseId && warehouseId.trim()) {
      const whRow = first(
        await tx.execute(sql`
          SELECT branch_id::text FROM warehouses
          WHERE id = ${warehouseId.trim()}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (whRow?.branch_id) return str(whRow.branch_id);
    }
    const branchRow = first(
      await tx.execute(sql`
        SELECT id::text FROM branches
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        ORDER BY is_default DESC NULLS LAST, created_at ASC
        LIMIT 1
      `),
    );
    return branchRow?.id ? str(branchRow.id) : null;
  }

  /**
   * المستودع الرئيسي — the warehouse production lands in.
   *
   * The screen used to post a production batch with no warehouse at all, so the batch row
   * was written and **no official stock movement happened**: `stock_balances` never moved
   * and the item's card said the factory had produced nothing. A missing warehouse is now
   * resolved instead of skipped — explicitly requested → the tenant's default warehouse →
   * the branch's first active warehouse — and only a tenant with no warehouse at all is
   * refused, with the reason named.
   */
  private async resolveMainWarehouseIdInTx(
    tx: DrizzleTx,
    tenantId: string,
    requestedWarehouseId?: string | null,
    branchId?: string | null,
  ): Promise<string | null> {
    const requested = requestedWarehouseId?.trim();
    if (requested) {
      const row = first(
        await tx.execute(sql`
          SELECT id::text FROM warehouses
          WHERE id = ${requested}::uuid AND tenant_id = ${tenantId}::uuid
            AND is_active = true AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (!row) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'المستودع المحدد غير موجود أو غير مفعّل في هذه المنشأة',
          422,
          { field: 'warehouseId' },
        );
      }
      return str(row.id);
    }
    const scoped = branchId?.trim()
      ? first(
          await tx.execute(sql`
            SELECT id::text FROM warehouses
            WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId.trim()}::uuid
              AND is_active = true AND deleted_at IS NULL
            ORDER BY is_default DESC NULLS LAST, created_at ASC
            LIMIT 1
          `),
        )
      : undefined;
    if (scoped?.id) return str(scoped.id);
    const fallback = first(
      await tx.execute(sql`
        SELECT id::text FROM warehouses
        WHERE tenant_id = ${tenantId}::uuid AND is_active = true AND deleted_at IS NULL
        ORDER BY is_default DESC NULLS LAST, created_at ASC
        LIMIT 1
      `),
    );
    return fallback?.id ? str(fallback.id) : null;
  }

  /**
   * A capability probe, not a swallowed error.
   *
   * Posting a journal needs the branch's posting profile (`branch_posting_profiles`); a
   * tenant that has not mapped its accounts yet has none, and
   * `resolvePostProfileInTx` answers `ACCOUNT_PROFILE_MISSING` (422). Van sales must still
   * move **stock** for such a tenant — the goods really left the warehouse — so the
   * accounting leg is deferred and reported (`postingStatus: 'pending_posting_profile'`)
   * instead of blocking the operation or, worse, inventing accounts.
   *
   * Any other failure is rethrown: this never hides a real error.
   */
  private async resolvePostingProfileOrNullInTx(
    tx: DrizzleTx,
    tenantId: string,
    branchId: string | null,
    docType: string,
  ): Promise<Record<string, string> | null> {
    if (!branchId) return null;
    try {
      const profile = await this.postingProfiles.resolvePostProfileInTx(tx, tenantId, branchId, docType);
      const mapping = (profile.mapping ?? {}) as Record<string, unknown>;
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(mapping)) {
        if (typeof value === 'string' && value.trim()) resolved[key] = value;
      }
      return resolved;
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === errorCodes.ACCOUNT_PROFILE_MISSING ||
          error.code === 'INVENTORY_PROFILE_KEY_MISSING')
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * من العضوية إلى المندوب — `memberships` → `employees` → `salesmen`.
   *
   * A rep logs in with a real user account; his workspace is derived from that chain, so
   * he can only ever read the custody of the salesman card his own employee card owns.
   * `null` means "this membership is not a rep" — the caller then falls back to the
   * tenant-wide view (which its own permission already gates).
   */
  private async resolveSalesmanForMembershipInTx(
    tx: DrizzleTx,
    tenantId: string,
    membershipId: string | null | undefined,
  ): Promise<{
    salesmanId: string;
    salesmanName: string;
    employeeId: string | null;
    warehouseId: string | null;
    vehiclePlate: string | null;
    active: boolean;
  } | null> {
    if (!membershipId) return null;
    const row = first(
      await tx.execute(sql`
        SELECT s.id::text AS salesman_id, s.name AS salesman_name, s.active,
               s.employee_id::text, s.warehouse_id::text, s.vehicle_plate
        FROM salesmen s
        JOIN employees e ON e.id = s.employee_id
        WHERE s.tenant_id = ${tenantId}::uuid
          AND e.tenant_id = ${tenantId}::uuid
          AND e.membership_id = ${membershipId}::uuid
          AND e.deleted_at IS NULL
        ORDER BY s.active DESC, s.name ASC
        LIMIT 1
      `),
    );
    if (!row) return null;
    return {
      salesmanId: str(row.salesman_id),
      salesmanName: str(row.salesman_name),
      employeeId: row.employee_id ? str(row.employee_id) : null,
      warehouseId: row.warehouse_id ? str(row.warehouse_id) : null,
      vehiclePlate: row.vehicle_plate ? str(row.vehicle_plate) : null,
      active: row.active !== false,
    };
  }

  /**
   * الأرصدة الرسمية — `stock_balances`, the same ledger the item card, the stock report
   * and the accounting valuation read.
   *
   * The van screens used to compute a "main warehouse balance" by subtracting add-on
   * quantities from add-on quantities, which agreed with nothing else in the system. The
   * official balance is now read, not derived, and `warehouseFilter` narrows it to the
   * van warehouses when the caller is a rep.
   */
  private async officialStockBalancesInTx(
    tx: DrizzleTx,
    tenantId: string,
    options: { warehouseIds?: string[]; itemId?: string | null } = {},
  ) {
    const warehouseIds = (options.warehouseIds ?? []).filter(Boolean);
    /**
     * The filters are built as SQL fragments rather than bound arrays: an empty
     * `uuid[]` parameter renders as `()::uuid[]`, which PostgreSQL rejects, and a
     * "no filter" flag parameter cannot be combined with an array parameter safely.
     */
    const warehouseFilter = warehouseIds.length
      ? sql`AND b.warehouse_id IN (${sql.join(
          warehouseIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
    const itemFilter = options.itemId ? sql`AND b.item_id = ${options.itemId}::uuid` : sql``;
    const balances = rows(
      await tx.execute(sql`
        SELECT b.item_id::text, b.warehouse_id::text,
               b.quantity::text, b.value::text, b.average_cost::text,
               COALESCE(i.name_ar, i.sku, 'صنف') AS item_name, i.sku,
               COALESCE(w.name, 'مستودع') AS warehouse_name, w.code AS warehouse_code,
               w.branch_id::text
        FROM stock_balances b
        JOIN items i ON i.id = b.item_id
        JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.tenant_id = ${tenantId}::uuid
          ${warehouseFilter}
          ${itemFilter}
        ORDER BY w.name ASC, i.name_ar ASC
      `),
    );
    return balances.map((row) => ({
      itemId: str(row.item_id),
      itemName: str(row.item_name),
      sku: str(row.sku),
      warehouseId: str(row.warehouse_id),
      warehouseName: str(row.warehouse_name),
      warehouseCode: str(row.warehouse_code),
      branchId: row.branch_id ? str(row.branch_id) : null,
      quantity: dec(row.quantity).toFixed(4),
      value: dec(row.value).toFixed(4),
      averageCost: dec(row.average_cost).toFixed(4),
    }));
  }

  async dashboard(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.loadTenantPolicyInTx(tx, tenantId);

      const productionBatches = rows(
        await tx.execute(sql`
          SELECT b.id::text, b.batch_no, b.production_date::text, b.item_id::text,
                 b.warehouse_id::text, b.production_order_id::text, b.manufacturing_order_id::text,
                 b.lot_id::text, b.inventory_transaction_id::text,
                 COALESCE(i.name_ar, b.item_name, 'رقائق سمبوسة وفطائر طازجة') AS item_name,
                 b.produced_qty::text, b.scrap_qty::text, b.issued_qty::text, b.returned_good_qty::text,
                 b.damaged_qty::text, b.unit_cost::text, b.total_cost::text, b.cost_basis,
                 b.status, b.supervisor_name, b.notes, b.created_at
          FROM factory_production_batches b
          LEFT JOIN items i ON i.id = b.item_id
          WHERE b.tenant_id = ${tenantId}::uuid AND b.deleted_at IS NULL
          ORDER BY b.production_date DESC, b.created_at DESC
          LIMIT 50
        `),
      );

      const loadOrders = rows(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.load_date::text, l.production_batch_no,
                 l.vehicle_plate, l.status,
                 l.warehouse_id::text, l.van_warehouse_id::text,
                 l.stock_transfer_id::text, l.return_transfer_id::text,
                 l.damage_voucher_id::text, l.approval_request_id::text,
                 l.shortage_policy_status,
                 l.loaded_qty::text, l.loaded_total_value::text,
                 l.received_qty::text, l.discrepancy_qty::text, l.discrepancy_notes,
                 l.received_at, l.received_by::text, l.actual_remaining_qty::text,
                 l.stock_adjustment_id::text, l.remaining_action, l.stock_settlement_status,
                 l.stock_settlement_note, l.damage_journal_entry_id::text,
                 l.return_inventory_tx_id::text,
                 l.sold_qty::text, l.bonus_qty::text,
                 l.returned_qty::text, l.damaged_qty::text,
                 l.shortage_qty::text, l.shortage_value::text, l.unit_cost::text,
                 (SELECT sal.variance_value::text FROM stock_adjustment_lines sal
                   WHERE sal.adjustment_id = l.stock_adjustment_id
                   ORDER BY sal.line_no ASC LIMIT 1) AS count_document_variance_value,
                 (SELECT sal.expected_qty::text FROM stock_adjustment_lines sal
                   WHERE sal.adjustment_id = l.stock_adjustment_id
                   ORDER BY sal.line_no ASC LIMIT 1) AS count_document_expected_qty,
                 l.max_bonus_qty::text, l.max_bonus_pct::text,
                 l.expected_cash::text, l.collected_cash::text,
                 l.damage_reason, l.damage_inspected, l.salary_deduction_approved,
                 l.closing_notes, l.closing_submitted_at, l.approved_at, l.settled_at, l.notes,
                 l.salesman_id::text, COALESCE(s.name, 'مندوب توزيع') AS salesman_name,
                 l.item_id::text, COALESCE(i.name_ar, 'رقائق سمبوسة وفطائر') AS item_name,
                 COALESCE(u_app.full_name, u_app.email) AS approved_by_label
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          LEFT JOIN items i ON i.id = l.item_id
          LEFT JOIN users u_app ON u_app.id = l.approved_by
          WHERE l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          ORDER BY l.created_at DESC
          LIMIT 60
        `),
      );

      const customerPrices = rows(
        await tx.execute(sql`
          SELECT cp.id::text, cp.party_id::text, p.name AS party_name, p.code AS party_code, p.tax_no AS party_tax_no,
                 cp.item_id::text, COALESCE(i.name_ar, 'جميع أصناف المخبز') AS item_name,
                 cp.price_tier_label, cp.unit_price::text, cp.max_bonus_pct::text,
                 cp.max_bonus_kg_per_invoice::text, cp.preferred_invoice_mode,
                 cp.credit_limit::text, cp.payment_terms_days, cp.lock_price, cp.max_discount_pct::text,
                 cp.effective_from::text, cp.effective_to::text, cp.change_reason, cp.notes
          FROM van_sales_customer_prices cp
          JOIN parties p ON p.id = cp.party_id
          LEFT JOIN items i ON i.id = cp.item_id
          WHERE cp.tenant_id = ${tenantId}::uuid AND cp.deleted_at IS NULL
          ORDER BY p.name ASC
        `),
      );

      const customerPriceHistory = rows(
        await tx.execute(sql`
          SELECT h.id::text, h.customer_price_id::text, h.party_id::text, p.name AS party_name,
                 h.item_id::text, COALESCE(i.name_ar, 'جميع أصناف المخبز') AS item_name,
                 h.previous_unit_price::text, h.new_unit_price::text,
                 h.max_bonus_pct::text, h.max_bonus_kg_per_invoice::text,
                 h.max_discount_pct::text, h.lock_price,
                 h.effective_from::text, h.effective_to::text, h.change_reason,
                 COALESCE(u.full_name, u.email, 'النظام') AS changed_by_label,
                 h.created_at
          FROM van_sales_customer_price_history h
          JOIN parties p ON p.id = h.party_id
          LEFT JOIN items i ON i.id = h.item_id
          LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.tenant_id = ${tenantId}::uuid
          ORDER BY h.created_at DESC
          LIMIT 50
        `),
      );

      const documents = rows(
        await tx.execute(sql`
          SELECT d.id::text, d.number, d.doc_date::text, d.invoice_mode, d.tax_policy_status, d.payment_method,
                 d.production_batch_no, d.sold_qty::text, d.bonus_qty::text, d.bonus_reason,
                 d.unit_price::text, d.discount_amount::text, d.discount_reason,
                 d.subtotal::text, d.tax_rate::text,
                 d.tax_total::text, d.total::text, d.paid_amount::text,
                 d.unit_cost::text, d.net_profit::text,
                 d.customer_bonus_confirmed, d.customer_confirmation_code,
                 d.bonus_anomaly, d.anomaly_reason, d.notes, d.created_at,
                 d.zatca_qr_tlv, d.qr_payload,
                 d.load_order_id::text,
                 d.sales_invoice_id::text, d.receipt_voucher_id::text, d.stock_delivery_id::text,
                 d.document_kind, d.reference_document_id::text,
                 si.number AS invoice_number, si.status AS invoice_status,
                 si.paid_total::text AS invoice_paid_total,
                 d.salesman_id::text, COALESCE(s.name, 'مندوب') AS salesman_name,
                 d.party_id::text, COALESCE(p.name, d.customer_name, 'عميل توزيع') AS customer_name,
                 p.tax_no AS customer_tax_no,
                 d.item_id::text, COALESCE(i.name_ar, 'رقائق سمبوسة وفطائر') AS item_name
          FROM van_sales_documents d
          LEFT JOIN salesmen s ON s.id = d.salesman_id
          LEFT JOIN parties p ON p.id = d.party_id
          LEFT JOIN items i ON i.id = d.item_id
          LEFT JOIN sales_invoices si ON si.id = d.sales_invoice_id
          WHERE d.tenant_id = ${tenantId}::uuid AND d.deleted_at IS NULL
          ORDER BY d.created_at DESC
          LIMIT 120
        `),
      );

      const movements = rows(
        await tx.execute(sql`
          SELECT m.id::text, m.movement_type, m.batch_no, m.qty::text, m.unit_price::text, m.amount::text,
                 m.reason, m.created_at,
                 m.inventory_transaction_id::text, m.voucher_id::text,
                 COALESCE(s.name, '—') AS salesman_name,
                 COALESCE(p.name, '—') AS customer_name,
                 COALESCE(u_act.full_name, u_act.email, 'النظام') AS actor_label,
                 COALESCE(u_app.full_name, u_app.email) AS approved_by_label
          FROM van_stock_movements m
          LEFT JOIN salesmen s ON s.id = m.salesman_id
          LEFT JOIN parties p ON p.id = m.party_id
          LEFT JOIN users u_act ON u_act.id = m.actor_user_id
          LEFT JOIN users u_app ON u_app.id = m.approved_by_user_id
          WHERE m.tenant_id = ${tenantId}::uuid
          ORDER BY m.created_at DESC
          LIMIT 80
        `),
      );

      let totalProducedKg = new Decimal(0);
      let totalScrapKg = new Decimal(0);
      let totalProductionCostSar = new Decimal(0);
      for (const b of productionBatches) {
        totalProducedKg = totalProducedKg.plus(dec(b.produced_qty));
        totalScrapKg = totalScrapKg.plus(dec(b.scrap_qty));
        totalProductionCostSar = totalProductionCostSar.plus(dec(b.total_cost));
      }

      let totalLoadedKg = new Decimal(0);
      let totalSoldKg = new Decimal(0);
      let totalBonusKg = new Decimal(0);
      let totalReturnedKg = new Decimal(0);
      let totalDamagedKg = new Decimal(0);
      let totalShortageKg = new Decimal(0);
      let totalShortageSar = new Decimal(0);
      let totalZatcaSalesSar = new Decimal(0);
      let totalInternalSalesSar = new Decimal(0);
      let totalCollectedCashSar = new Decimal(0);
      let totalCreditReceivablesSar = new Decimal(0);
      let totalNetProfitSar = new Decimal(0);
      let anomalyCount = 0;
      let pendingClosingsCount = 0;
      let pendingReceiptsCount = 0;
      /** عهد اعتُمدت كمياتها ولم تُسوَّ مخزنياً بعد + فروق استلام بلا قرار. */
      let pendingStockSettlementsCount = 0;
      let pendingTransitDecisionsCount = 0;

      const repMap = new Map<
        string,
        {
          salesmanId: string;
          salesmanName: string;
          loadedKg: Decimal;
          soldKg: Decimal;
          bonusKg: Decimal;
          returnedKg: Decimal;
          damagedKg: Decimal;
          shortageKg: Decimal;
          shortageSar: Decimal;
          custodyRemainingKg: Decimal;
          revenueSar: Decimal;
          collectedSar: Decimal;
          creditDebtSar: Decimal;
          netProfitSar: Decimal;
          pendingClosings: number;
        }
      >();

      for (const l of loadOrders) {
        const loaded = dec(l.loaded_qty);
        const received = dec(l.received_qty);
        const sold = dec(l.sold_qty);
        const bonus = dec(l.bonus_qty);
        const returned = dec(l.returned_qty);
        const damaged = dec(l.damaged_qty);
        const shortage = dec(l.shortage_qty);
        const shortageVal = dec(l.shortage_value);
        const isSettled = str(l.status) === 'settled';
        const isPending = str(l.status) === 'pending_closing';
        const isAwaitingReceipt = str(l.status) === 'pending_receipt';
        if (isPending) pendingClosingsCount += 1;
        if (isAwaitingReceipt) pendingReceiptsCount += 1;
        if (str(l.status) === 'pending_stock_settlement') pendingStockSettlementsCount += 1;
        if (str(l.stock_settlement_status) === 'pending_transit_decision') {
          pendingTransitDecisionsCount += 1;
        }

        totalLoadedKg = totalLoadedKg.plus(loaded);
        totalSoldKg = totalSoldKg.plus(sold);
        totalBonusKg = totalBonusKg.plus(bonus);
        totalReturnedKg = totalReturnedKg.plus(returned);
        totalDamagedKg = totalDamagedKg.plus(damaged);
        totalShortageKg = totalShortageKg.plus(shortage);
        totalShortageSar = totalShortageSar.plus(shortageVal);

        const sid = str(l.salesman_id);
        const sname = str(l.salesman_name);
        const entry = repMap.get(sid) ?? {
          salesmanId: sid,
          salesmanName: sname,
          loadedKg: new Decimal(0),
          soldKg: new Decimal(0),
          bonusKg: new Decimal(0),
          returnedKg: new Decimal(0),
          damagedKg: new Decimal(0),
          shortageKg: new Decimal(0),
          shortageSar: new Decimal(0),
          custodyRemainingKg: new Decimal(0),
          revenueSar: new Decimal(0),
          collectedSar: new Decimal(0),
          creditDebtSar: new Decimal(0),
          netProfitSar: new Decimal(0),
          pendingClosings: 0,
        };
        entry.loadedKg = entry.loadedKg.plus(loaded);
        entry.soldKg = entry.soldKg.plus(sold);
        entry.bonusKg = entry.bonusKg.plus(bonus);
        entry.returnedKg = entry.returnedKg.plus(returned);
        entry.damagedKg = entry.damagedKg.plus(damaged);
        entry.shortageKg = entry.shortageKg.plus(shortage);
        entry.shortageSar = entry.shortageSar.plus(shortageVal);
        if (!isSettled && !isAwaitingReceipt) {
          /** العهدة المتبقية — على أساس ما استلمه المندوب فعلًا لا على أساس ما صُرف له. */
          const custodyBasis = received.gt(0) ? received : loaded;
          const rem = custodyBasis
            .minus(sold)
            .minus(bonus)
            .minus(returned)
            .minus(damaged)
            .minus(shortage);
          entry.custodyRemainingKg = entry.custodyRemainingKg.plus(Decimal.max(0, rem));
        }
        if (isPending) entry.pendingClosings += 1;
        repMap.set(sid, entry);
      }

      for (const d of documents) {
        const docTotal = dec(d.total);
        const docPaid = dec(d.paid_amount);
        const docDebt = Decimal.max(0, docTotal.minus(docPaid));
        const docProfit = dec(d.net_profit);

        if (str(d.invoice_mode) === 'zatca_tax') {
          totalZatcaSalesSar = totalZatcaSalesSar.plus(docTotal);
        } else {
          totalInternalSalesSar = totalInternalSalesSar.plus(docTotal);
        }
        totalCollectedCashSar = totalCollectedCashSar.plus(docPaid);
        totalCreditReceivablesSar = totalCreditReceivablesSar.plus(docDebt);
        totalNetProfitSar = totalNetProfitSar.plus(docProfit);
        if (d.bonus_anomaly === true) anomalyCount += 1;

        const sid = str(d.salesman_id);
        const entry = repMap.get(sid);
        if (entry) {
          entry.revenueSar = entry.revenueSar.plus(docTotal);
          entry.collectedSar = entry.collectedSar.plus(docPaid);
          entry.creditDebtSar = entry.creditDebtSar.plus(docDebt);
          entry.netProfitSar = entry.netProfitSar.plus(docProfit);
        }
      }

      /**
       * الأرصدة الرسمية — read from `stock_balances`, the ledger the item card, the stock
       * report and the inventory valuation all read.
       *
       * The screen used to show a "main warehouse balance" derived by subtracting add-on
       * quantities from add-on quantities: it could read 150 kg while the official balance
       * said 0, which is exactly the defect reported from the floor. The official number is
       * now the number on screen, and the derived one stays beside it (renamed) so a
       * disagreement between the two is visible instead of hidden.
       */
      const officialStock = await this.officialStockBalancesInTx(tx, tenantId);
      const mainWarehouseId = await this.resolveMainWarehouseIdInTx(tx, tenantId, null, null);
      /**
       * 🌾 المواد الخام ليست إنتاجاً — this headline and its derived twin count the **produced**
       * items only. A production batch must have a real source of materials (BOM أو مكوّنات), so
       * the main warehouse legitimately holds flour beside bread: summing every balance row would
       * report the flour as «إنتاج المستودع» and would keep `stockLedgerAgrees` permanently false
       * against a number derived from batches. Like for like, then — the official rows of the items
       * the batches actually produced. The materials stay visible in `officialStock` (the same rows
       * the stock screen reads) and in the inventory valuation; they are simply not production.
       */
      const producedItemIds = new Set(
        productionBatches.map((row) => (row.item_id ? str(row.item_id) : '')).filter(Boolean),
      );
      const officialMainWarehouseKg = officialStock
        .filter((row) => row.warehouseId === mainWarehouseId && producedItemIds.has(row.itemId))
        .reduce((sum, row) => sum.plus(dec(row.quantity)), new Decimal(0));
      const vanWarehouseIds = new Set(
        loadOrders
          .map((row) => (row.van_warehouse_id ? str(row.van_warehouse_id) : ''))
          .filter(Boolean),
      );
      const officialVanKg = officialStock
        .filter((row) => vanWarehouseIds.has(row.warehouseId))
        .reduce((sum, row) => sum.plus(dec(row.quantity)), new Decimal(0));

      /**
       * 🚚 بضاعة تحت التحويل — ما خرج من المستودع ولم يؤكّد المندوب استلامه بعد. ليست في
       * رصيد السيارة وليست في رصيد المستودع: قيمتها واقفة في حساب «بضاعة تحت التحويل»،
       * وإخفاؤها عن الشاشة هو ما يجعل المحاسب يظن أن الكمية ضاعت.
       */
      const inTransitRow = first(
        await tx.execute(sql`
          SELECT COALESCE(SUM(stl.qty - stl.received_qty - stl.closed_qty), 0)::text AS qty,
                 COALESCE(SUM((stl.qty - stl.received_qty - stl.closed_qty) * COALESCE(stl.unit_cost, 0)), 0)::text AS val,
                 COUNT(DISTINCT st.id)::int AS transfers
          FROM stock_transfers st
          JOIN stock_transfer_lines stl ON stl.transfer_id = st.id
          WHERE st.tenant_id = ${tenantId}::uuid
            AND st.status IN ('in_transit', 'partially_received')
        `),
      );
      const inTransitKg = dec(inTransitRow?.qty);
      const inTransitValueSar = dec(inTransitRow?.val);
      const inTransitTransfers = Number(inTransitRow?.transfers ?? 0);

      const derivedMainWarehouseBalanceKg = Decimal.max(
        0,
        totalProducedKg.minus(totalLoadedKg).plus(totalReturnedKg),
      );
      const remainingInVansKg = Decimal.max(
        0,
        totalLoadedKg
          .minus(totalSoldKg)
          .minus(totalBonusKg)
          .minus(totalReturnedKg)
          .minus(totalDamagedKg)
          .minus(totalShortageKg),
      );

      /**
       * جاهزية الترحيل — what the accountant still has to configure before each official
       * document can post. Named per operation so the message on screen is actionable
       * rather than a generic failure.
       */
      const readinessBranchId = await this.resolveDefaultBranchIdInTx(tx, tenantId, null, mainWarehouseId);
      const [salesProfile, transferProfile, voucherProfile] = await Promise.all([
        this.resolvePostingProfileOrNullInTx(tx, tenantId, readinessBranchId, 'sales_invoice'),
        this.resolvePostingProfileOrNullInTx(tx, tenantId, readinessBranchId, 'stock_transfer'),
        this.resolvePostingProfileOrNullInTx(tx, tenantId, readinessBranchId, 'receipt_voucher'),
      ]);

      return {
        policy: {
          allowInternalDeliveryWithoutTax: Boolean(policy.allowInternalDeliveryWithoutTax),
          preventSelfApproval: Boolean(policy.preventSelfApproval),
          shortageValuationBasis: policy.shortageValuationBasis ?? 'unconfigured',
        },
        /**
         * الأرصدة الرسمية لكل مستودع — the same rows the stock screen shows, so the factory
         * tab and the inventory tab can never disagree.
         */
        officialStock,
        mainWarehouseId,
        postingReadiness: {
          branchId: readinessBranchId,
          salesInvoice: Boolean(salesProfile),
          stockTransfer: Boolean(transferProfile),
          receiptVoucher: Boolean(voucherProfile),
          message: salesProfile && transferProfile
            ? null
            : 'ملف الترحيل المحاسبي للفرع غير مكتمل — من الإعدادات ← ملفات الترحيل، حدّد حسابات المبيعات والمخزون وبضاعة تحت التحويل حتى تُرحَّل المستندات الرسمية تلقائيًا',
        },
        summary: {
          totalProducedKg: totalProducedKg.toFixed(2),
          totalScrapKg: totalScrapKg.toFixed(2),
          /** الرصيد الرسمي في المستودع الرئيسي — من `stock_balances`. */
          mainWarehouseBalanceKg: officialMainWarehouseKg.toFixed(2),
          /** رصيد سيارات التوزيع الرسمي — من `stock_balances`. */
          vanWarehousesBalanceKg: officialVanKg.toFixed(2),
          /** الرصيد المشتق من سجلات الإضافة — يُعرض للمقارنة وكشف أي اختلاف. */
          derivedMainWarehouseBalanceKg: derivedMainWarehouseBalanceKg.toFixed(2),
          stockLedgerAgrees: officialMainWarehouseKg.eq(derivedMainWarehouseBalanceKg),
          /** 🚚 كمية وقيمة البضاعة التي ما زالت رسمياً على الطريق. */
          inTransitKg: inTransitKg.toFixed(2),
          inTransitValueSar: inTransitValueSar.toFixed(2),
          inTransitTransfersCount: inTransitTransfers,
          totalProductionCostSar: totalProductionCostSar.toFixed(2),
          totalLoadedKg: totalLoadedKg.toFixed(2),
          totalSoldKg: totalSoldKg.toFixed(2),
          totalBonusKg: totalBonusKg.toFixed(2),
          totalReturnedKg: totalReturnedKg.toFixed(2),
          totalDamagedKg: totalDamagedKg.toFixed(2),
          totalShortageKg: totalShortageKg.toFixed(2),
          totalShortageSar: totalShortageSar.toFixed(2),
          remainingInVansKg: remainingInVansKg.toFixed(2),
          totalZatcaSalesSar: totalZatcaSalesSar.toFixed(2),
          totalInternalSalesSar: totalInternalSalesSar.toFixed(2),
          totalRevenueSar: totalZatcaSalesSar.plus(totalInternalSalesSar).toFixed(2),
          totalCollectedCashSar: totalCollectedCashSar.toFixed(2),
          totalCreditReceivablesSar: totalCreditReceivablesSar.toFixed(2),
          totalNetProfitSar: totalNetProfitSar.toFixed(2),
          anomalyCount,
          pendingClosingsCount,
          pendingReceiptsCount,
          pendingStockSettlementsCount,
          pendingTransitDecisionsCount,
        },
        productionBatches: productionBatches.map((b) => {
          const produced = dec(b.produced_qty);
          const scrap = dec(b.scrap_qty);
          const issued = dec(b.issued_qty);
          const retGood = dec(b.returned_good_qty);
          const dmg = dec(b.damaged_qty);
          const avail = Decimal.max(0, produced.minus(issued).plus(retGood).minus(dmg));
          /**
           * 💵 أساس التكلفة كما **كُتب ساعة الإنشاء** (`cost_basis`، ترحيل 0127). الاستنتاج
           * القديم («هل ارتبطت الدفعة بأمر رسمي؟») كان صادقاً حين كان الربط اختيارياً، وصار
           * كذباً حين صار إلزامياً: دفعةٌ موادها صفرية القيمة يُسعّرها المحاسب أو بطاقة الصنف
           * ولو قرأناها من الربط لقيل إنها تكلفة فعلية من أمر تصنيع — ومعها أن الفاقد محمّل
           * على المنتج الجيد وهو ليس كذلك. ولدفعةٍ سابقة لهذا العمود (NULL) يبقى الاستنتاج
           * القديم لأنه كل ما يمكن قوله عنها بأمانة.
           */
          const basis: 'manufacturing_order' | 'manual_input_or_item_cost' =
            b.cost_basis === 'manual_input' || b.cost_basis === 'item_cost'
              ? 'manual_input_or_item_cost'
              : b.cost_basis === 'manufacturing_order'
                ? 'manufacturing_order'
                : b.manufacturing_order_id || b.production_order_id
                  ? 'manufacturing_order'
                  : 'manual_input_or_item_cost';
          return {
            id: str(b.id),
            batchNo: str(b.batch_no),
            productionDate: str(b.production_date),
            itemId: b.item_id ? str(b.item_id) : null,
            warehouseId: b.warehouse_id ? str(b.warehouse_id) : null,
            productionOrderId: b.production_order_id ? str(b.production_order_id) : null,
            manufacturingOrderId: b.manufacturing_order_id ? str(b.manufacturing_order_id) : null,
            lotId: b.lot_id ? str(b.lot_id) : null,
            inventoryTransactionId: b.inventory_transaction_id
              ? str(b.inventory_transaction_id)
              : null,
            itemName: str(b.item_name),
            producedQty: produced.toFixed(2),
            scrapQty: scrap.toFixed(2),
            issuedQty: issued.toFixed(2),
            returnedGoodQty: retGood.toFixed(2),
            damagedQty: dmg.toFixed(2),
            availableWarehouseQty: avail.toFixed(2),
            unitCost: dec(b.unit_cost).toFixed(2),
            totalCost: dec(b.total_cost).toFixed(2),
            /**
             * 💵 أساس التكلفة — هل الرقم تكلفة فعلية من أمر تصنيع رسمي، أم إدخال يدوي،
             * أم تكلفة بطاقة الصنف؟ المحاسب لا يقبل «تكلفة إنتاج» دون أن يعرف مصدرها.
             */
            costBasis: basis,
            /**
             * 🗑️ قيمة الفاقد، وهل حُمِّلت على تكلفة المنتج الجيد. محرك التصنيع الرسمي
             * يحمّل فاقد **المكوّنات** (`scrapPercent` على سطر BOM) ولا يحمّل فاقد المخبز
             * من المنتج التام، فحين لا يكون هناك أمر تصنيع رسمي تكون التكلفة المسجّلة
             * **غير شاملة للفاقد** — وتُعرض كذلك بدل أن تُقرأ تكلفةً فعلية مكتملة.
             */
            scrapValue: scrap.mul(dec(b.unit_cost)).toFixed(2),
            /**
             * 🗑️ هل حُمِّلت تكلفة فاقد **هذه الدفعة** على المنتج الجيد؟ لا — وربطُ الدفعة بأمر
             * رسمي لا يغيّر ذلك: الأمر يُنتج الكمية الصالحة وحدها (`outputQty = produced_qty`)
             * فلا تُصرف مواد للفاقد، و`scrapPercent` على سطر قائمة المواد يحمّل فاقد
             * **المكوّنات** داخل تكلفة الأمر وهو كمية أخرى غير فاقد المخبز المسجّل هنا.
             * وتحميل فاقد المخبز على المنتج قرار سياسة لم يُتخذ (التقرير §10) — والشاشة تقول
             * الحقيقة حتى يُتخذ بدل أن تقرأ «تكلفة فعلية مكتملة».
             */
            scrapCostLoaded: false,
            status: str(b.status),
            supervisorName: str(b.supervisor_name),
            notes: str(b.notes),
          };
        }),
        repPerformance: [...repMap.values()].map((r) => ({
          salesmanId: r.salesmanId,
          salesmanName: r.salesmanName,
          loadedKg: r.loadedKg.toFixed(2),
          soldKg: r.soldKg.toFixed(2),
          bonusKg: r.bonusKg.toFixed(2),
          returnedKg: r.returnedKg.toFixed(2),
          damagedKg: r.damagedKg.toFixed(2),
          shortageKg: r.shortageKg.toFixed(2),
          shortageSar: r.shortageSar.toFixed(2),
          custodyRemainingKg: r.custodyRemainingKg.toFixed(2),
          revenueSar: r.revenueSar.toFixed(2),
          collectedSar: r.collectedSar.toFixed(2),
          creditDebtSar: r.creditDebtSar.toFixed(2),
          netProfitSar: r.netProfitSar.toFixed(2),
          pendingClosings: r.pendingClosings,
        })),
        loadOrders: loadOrders.map((row) => {
          /**
           * هل مستند الجرد الرسمي **مُرحَّل**؟ المحرك يكتب `expected_qty` و`variance_value`
           * لحظة الترحيل لا لحظة الإنشاء (المسودة تحمل `0` في العمودين)، فالصفران يعنيان
           * «لم يُرحَّل بعد» — وتُحسب قيمة الفرق عندها من تكلفة الدفعة على أمر التحميل.
           */
          const countDocumentPosted =
            dec(row.count_document_expected_qty).gt(0) ||
            dec(row.count_document_variance_value).gt(0);
          const loaded = dec(row.loaded_qty);
          /**
           * أساس العهدة — what the rep confirmed he received. Before confirmation the
           * custody is zero even though the warehouse already sent the goods, because they
           * are officially still in transit.
           */
          const custodyBasis = dec(row.received_qty).gt(0) ? dec(row.received_qty) : loaded;
          const sold = dec(row.sold_qty);
          const bonus = dec(row.bonus_qty);
          const returned = dec(row.returned_qty);
          const damaged = dec(row.damaged_qty);
          const shortage = dec(row.shortage_qty);
          const isSettled = str(row.status) === 'settled';
          const remaining = isSettled
            ? new Decimal(0)
            : Decimal.max(
                0,
                custodyBasis.minus(sold).minus(bonus).minus(returned).minus(damaged).minus(shortage),
              );
          /**
           * 🧮 المتوقع مقابل الفعلي — what the documents say must still be in the van against
           * what the rep counted when he submitted the closing. The difference is the shortage
           * the accountant reviews; a negative difference is a surplus and is flagged as such.
           */
          const actualRemaining = dec(row.actual_remaining_qty);
          const expectedRemaining = custodyBasis.minus(sold).minus(bonus).minus(returned).minus(damaged);
          const countVariance = expectedRemaining.minus(actualRemaining);
          return {
            id: str(row.id),
            number: str(row.number),
            loadDate: str(row.load_date),
            productionBatchNo: str(row.production_batch_no),
            vehiclePlate: str(row.vehicle_plate),
            status: str(row.status),
            salesmanId: str(row.salesman_id),
            salesmanName: str(row.salesman_name),
            warehouseId: row.warehouse_id ? str(row.warehouse_id) : null,
            vanWarehouseId: row.van_warehouse_id ? str(row.van_warehouse_id) : null,
            stockTransferId: row.stock_transfer_id ? str(row.stock_transfer_id) : null,
            returnTransferId: row.return_transfer_id ? str(row.return_transfer_id) : null,
            damageVoucherId: row.damage_voucher_id ? str(row.damage_voucher_id) : null,
            approvalRequestId: row.approval_request_id ? str(row.approval_request_id) : null,
            shortagePolicyStatus: str(row.shortage_policy_status || 'pending_policy_approval'),
            itemId: row.item_id ? str(row.item_id) : null,
            itemName: str(row.item_name),
            loadedQty: loaded.toFixed(2),
            /** ما أكّد المندوب استلامه فعلًا — أساس العهدة بعد خطوة الاستلام. */
            receivedQty: dec(row.received_qty).toFixed(2),
            discrepancyQty: dec(row.discrepancy_qty).toFixed(2),
            discrepancyNotes: str(row.discrepancy_notes),
            receivedAt: row.received_at ? iso(row.received_at) : null,
            awaitingReceipt: str(row.status) === 'pending_receipt',
            soldQty: sold.toFixed(2),
            bonusQty: bonus.toFixed(2),
            returnedQty: returned.toFixed(2),
            damagedQty: damaged.toFixed(2),
            shortageQty: shortage.toFixed(2),
            shortageValue: dec(row.shortage_value).toFixed(2),
            remainingQty: remaining.toFixed(2),
            actualRemainingQty: actualRemaining.toFixed(2),
            expectedRemainingQty: expectedRemaining.toFixed(2),
            /** موجب = عجز عن الجرد، سالب = فائض يظهر للمحاسب للمراجعة. */
            countVarianceQty: countVariance.toFixed(2),
            /** 🧾 تسوية المخزون: مستند الجرد الرسمي، مصير المتبقي، وحالة التسوية. */
            stockAdjustmentId: row.stock_adjustment_id ? str(row.stock_adjustment_id) : null,
            remainingAction: row.remaining_action ? str(row.remaining_action) : null,
            remainingInventoryTxId: row.return_inventory_tx_id ? str(row.return_inventory_tx_id) : null,
            /**
             * 💵 قيمة فرق الجرد **على أساس التكلفة** — وهي قيمة التسوية المخزنية التي
             * يرحّلها مستند الجرد الرسمي، لا ديناً على المندوب. الرقم المرجعي بسعر البيع
             * (`shortageValue`) يبقى معروضاً بوصفه تقديراً للمراجعة فقط.
             */
            countVarianceCostValue: (countDocumentPosted
              ? dec(row.count_document_variance_value)
              : dec(row.unit_cost).mul(countVariance.abs())
            ).toFixed(2),
            countDocumentVarianceValue: countDocumentPosted
              ? dec(row.count_document_variance_value).toFixed(2)
              : null,
            countDocumentExpectedQty: countDocumentPosted
              ? dec(row.count_document_expected_qty).toFixed(2)
              : null,
            stockSettlementStatus: str(row.stock_settlement_status || 'not_required'),
            stockSettlementNote: str(row.stock_settlement_note),
            damageJournalEntryId: row.damage_journal_entry_id ? str(row.damage_journal_entry_id) : null,
            awaitingStockSettlement: str(row.status) === 'pending_stock_settlement',
            awaitingTransitDecision: str(row.stock_settlement_status) === 'pending_transit_decision',
            maxBonusQty: dec(row.max_bonus_qty).toFixed(2),
            maxBonusPct: dec(row.max_bonus_pct).toFixed(2),
            expectedCash: dec(row.expected_cash).toFixed(2),
            collectedCash: dec(row.collected_cash).toFixed(2),
            cashVariance: dec(row.collected_cash).minus(dec(row.expected_cash)).toFixed(2),
            damageReason: str(row.damage_reason),
            damageInspected: Boolean(row.damage_inspected),
            salaryDeductionApproved: Boolean(row.salary_deduction_approved),
            closingNotes: str(row.closing_notes),
            closingSubmittedAt: row.closing_submitted_at ? iso(row.closing_submitted_at) : null,
            approvedAt: row.approved_at ? iso(row.approved_at) : null,
            approvedByLabel: str(row.approved_by_label),
            notes: str(row.notes),
          };
        }),
        customerPrices: customerPrices.map((row) => ({
          id: str(row.id),
          partyId: str(row.party_id),
          partyName: str(row.party_name),
          partyCode: str(row.party_code),
          partyTaxNo: str(row.party_tax_no),
          itemId: row.item_id ? str(row.item_id) : null,
          itemName: str(row.item_name),
          priceTierLabel: str(row.price_tier_label),
          unitPrice: dec(row.unit_price).toFixed(2),
          maxBonusPct: dec(row.max_bonus_pct).toFixed(2),
          maxBonusKgPerInvoice: dec(row.max_bonus_kg_per_invoice).toFixed(2),
          preferredInvoiceMode: str(row.preferred_invoice_mode) as
            | 'zatca_tax'
            | 'internal_delivery',
          creditLimit: dec(row.credit_limit).toFixed(2),
          paymentTermsDays: Number(row.payment_terms_days ?? 15),
          lockPrice: row.lock_price !== false,
          maxDiscountPct: dec(row.max_discount_pct).toFixed(2),
          effectiveFrom: str(row.effective_from),
          effectiveTo: row.effective_to ? str(row.effective_to) : null,
          changeReason: str(row.change_reason),
          notes: str(row.notes),
        })),
        customerPriceHistory: customerPriceHistory.map((h) => ({
          id: str(h.id),
          customerPriceId: str(h.customer_price_id),
          partyId: str(h.party_id),
          partyName: str(h.party_name),
          itemId: h.item_id ? str(h.item_id) : null,
          itemName: str(h.item_name),
          previousUnitPrice: h.previous_unit_price ? dec(h.previous_unit_price).toFixed(2) : null,
          newUnitPrice: dec(h.new_unit_price).toFixed(2),
          maxBonusPct: dec(h.max_bonus_pct).toFixed(2),
          maxBonusKgPerInvoice: dec(h.max_bonus_kg_per_invoice).toFixed(2),
          maxDiscountPct: dec(h.max_discount_pct).toFixed(2),
          lockPrice: Boolean(h.lock_price),
          effectiveFrom: str(h.effective_from),
          effectiveTo: h.effective_to ? str(h.effective_to) : null,
          changeReason: str(h.change_reason),
          changedByLabel: str(h.changed_by_label),
          createdAt: iso(h.created_at),
        })),
        documents: documents.map((row) => ({
          id: str(row.id),
          number: str(row.number),
          docDate: str(row.doc_date),
          invoiceMode: str(row.invoice_mode) as 'zatca_tax' | 'internal_delivery',
          taxPolicyStatus: str(row.tax_policy_status || 'standard_vat'),
          paymentMethod: str(row.payment_method),
          documentKind: str(row.document_kind || 'sale'),
          referenceDocumentId: row.reference_document_id ? str(row.reference_document_id) : null,
          /** رقم وحالة الفاتورة الرسمية — ما يعرفه المحاسب وهيئة الزكاة. */
          invoiceNumber: row.invoice_number ? str(row.invoice_number) : null,
          invoiceStatus: row.invoice_status ? str(row.invoice_status) : null,
          productionBatchNo: str(row.production_batch_no),
          loadOrderId: row.load_order_id ? str(row.load_order_id) : null,
          salesInvoiceId: row.sales_invoice_id ? str(row.sales_invoice_id) : null,
          receiptVoucherId: row.receipt_voucher_id ? str(row.receipt_voucher_id) : null,
          stockDeliveryId: row.stock_delivery_id ? str(row.stock_delivery_id) : null,
          salesmanId: row.salesman_id ? str(row.salesman_id) : null,
          salesmanName: str(row.salesman_name),
          partyId: row.party_id ? str(row.party_id) : null,
          customerName: str(row.customer_name),
          customerTaxNo: str(row.customer_tax_no),
          itemId: row.item_id ? str(row.item_id) : null,
          itemName: str(row.item_name),
          soldQty: dec(row.sold_qty).toFixed(2),
          bonusQty: dec(row.bonus_qty).toFixed(2),
          bonusReason: str(row.bonus_reason),
          unitPrice: dec(row.unit_price).toFixed(2),
          discountAmount: dec(row.discount_amount).toFixed(2),
          discountReason: str(row.discount_reason),
          subtotal: dec(row.subtotal).toFixed(2),
          taxRate: dec(row.tax_rate).toFixed(2),
          taxTotal: dec(row.tax_total).toFixed(2),
          total: dec(row.total).toFixed(2),
          paidAmount: dec(row.paid_amount).toFixed(2),
          unitCost: dec(row.unit_cost).toFixed(2),
          netProfit: dec(row.net_profit).toFixed(2),
          customerBonusConfirmed: Boolean(row.customer_bonus_confirmed),
          customerConfirmationCode: str(row.customer_confirmation_code),
          bonusAnomaly: Boolean(row.bonus_anomaly),
          anomalyReason: str(row.anomaly_reason),
          /** رمز ZATCA المبني على الخادم من ملف المنشأة — لا تُخترَع بيانات البائع في الواجهة. */
          qrPayload: str(row.zatca_qr_tlv ?? row.qr_payload ?? ''),
          notes: str(row.notes),
          createdAt: iso(row.created_at),
        })),
        movements: movements.map((m) => ({
          id: str(m.id),
          movementType: str(m.movement_type),
          batchNo: str(m.batch_no),
          qty: dec(m.qty).toFixed(2),
          unitPrice: dec(m.unit_price).toFixed(2),
          amount: dec(m.amount).toFixed(2),
          reason: str(m.reason),
          inventoryTransactionId: m.inventory_transaction_id
            ? str(m.inventory_transaction_id)
            : null,
          voucherId: m.voucher_id ? str(m.voucher_id) : null,
          salesmanName: str(m.salesman_name),
          customerName: str(m.customer_name),
          actorLabel: str(m.actor_label),
          approvedByLabel: str(m.approved_by_label),
          createdAt: iso(m.created_at),
        })),
      };
    });
  }

  /**
   * Phase 5: Comprehensive Analytical Reports for Reps, Custody, Transfers, Collections & Production.
   */
  async getReports(
    tenantId: string,
    filters: { salesmanId?: string; fromDate?: string; toDate?: string } = {},
  ) {
    const dash = await this.dashboard(tenantId);
    const filteredLoadOrders = filters.salesmanId
      ? dash.loadOrders.filter((l) => l.salesmanId === filters.salesmanId)
      : dash.loadOrders;
    const filteredDocs = filters.salesmanId
      ? dash.documents.filter((d) => d.salesmanId === filters.salesmanId)
      : dash.documents;

    return {
      generatedAt: new Date().toISOString(),
      policy: dash.policy,
      summary: dash.summary,
      repCustodyReport: dash.repPerformance.filter(
        (r) => !filters.salesmanId || r.salesmanId === filters.salesmanId,
      ),
      transfersReport: filteredLoadOrders.map((l) => ({
        loadOrderId: l.id,
        loadOrderNumber: l.number,
        loadDate: l.loadDate,
        salesmanId: l.salesmanId,
        salesmanName: l.salesmanName,
        productionBatchNo: l.productionBatchNo,
        warehouseId: l.warehouseId,
        vanWarehouseId: l.vanWarehouseId,
        stockTransferId: l.stockTransferId,
        returnTransferId: l.returnTransferId,
        loadedQty: l.loadedQty,
        soldQty: l.soldQty,
        bonusQty: l.bonusQty,
        returnedQty: l.returnedQty,
        damagedQty: l.damagedQty,
        shortageQty: l.shortageQty,
        shortageValue: l.shortageValue,
        shortagePolicyStatus: l.shortagePolicyStatus,
        remainingQty: l.remainingQty,
        status: l.status,
      })),
      collectionsReport: filteredDocs.map((d) => ({
        documentId: d.id,
        documentNumber: d.number,
        salesInvoiceId: d.salesInvoiceId,
        receiptVoucherId: d.receiptVoucherId,
        docDate: d.docDate,
        salesmanName: d.salesmanName,
        customerName: d.customerName,
        paymentMethod: d.paymentMethod,
        grandTotal: d.total,
        paidAmount: d.paidAmount,
        outstandingBalance: Decimal.max(0, dec(d.total).minus(dec(d.paidAmount))).toFixed(2),
      })),
      productionReport: dash.productionBatches,
      customerPriceAuditReport: dash.customerPriceHistory,
    };
  }

  /**
   * 🔎 فحص ما قبل التفويض — «هل لمواد هذه الدفعة قيمة؟».
   *
   * التكلفة الرسمية للإنتاج هي ما يخرج من الرفّ فعلاً. فإن كانت مواد الدفعة كلها بلا قيمة
   * (رصيد افتتاحي بلا تسعير، أو مادة لم تُقيَّم) فإن الأمر الرسمي سيُدخل الناتج إلى الدفتر
   * بصفر، ورقمٌ يُكتب في هذه الشاشة لا يغيّر ما سجّله المستودع — فتصير للكمية الواحدة
   * تقييمان. لذا يُرفض الإنتاج **قبل أن تُصرف مادة**، لأن الأمر الرسمي يُرحَّل في معاملةٍ
   * مستقلة تُثبَّت فوراً ولا رجعة فيها.
   *
   * سؤالٌ واحد للقراءة فقط («هل لأي مادةٍ قيمة موجبة في هذا المستودع؟») يكفي: لا حاجة إلى
   * تكرار حساب الكميات ونسب الفاقد الذي يقوم به المحرك، ولا إلى مخالفة حساباته مستقبلاً.
   */
  private async assertMaterialsAreValued(
    tenantId: string,
    input: {
      warehouseId: string;
      bomId: string | null;
      componentItemIds: string[];
      itemId: string | null;
    },
  ): Promise<void> {
    const materialItemIds = input.bomId
      ? (
          await withTenantTx(this.database.db, tenantId, async (tx) =>
            rows(
              await tx.execute(sql`
                SELECT component_item_id::text
                FROM bom_lines
                WHERE tenant_id = ${tenantId}::uuid AND bom_id = ${input.bomId}::uuid
              `),
            ).map((row) => str(row.component_item_id)),
          )
        ).filter(Boolean)
      : input.componentItemIds.filter(Boolean);

    const materialsHaveValue =
      materialItemIds.length > 0 &&
      Boolean(
        await withTenantTx(this.database.db, tenantId, async (tx) =>
          first(
            await tx.execute(sql`
              SELECT 1 AS ok
              FROM stock_balances
              WHERE tenant_id = ${tenantId}::uuid
                AND warehouse_id = ${input.warehouseId}::uuid
                AND item_id IN (${sql.join(
                  materialItemIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})
                AND COALESCE(quantity, 0) > 0
                AND COALESCE(value, 0) > 0
              LIMIT 1
            `),
          ),
        ),
      );

    if (!materialsHaveValue) {
      throw new DomainError(
        'VAN_PRODUCTION_COST_REQUIRED',
        'مواد هذه الدفعة لا قيمة لها في رصيد المستودع (رصيد افتتاحي بلا تسعير أو مادة لم تُقيَّم)، ' +
          'وتكلفة الإنتاج الرسمية هي ما يخرج من الرفّ فعلاً — فلا يمكن لرقمٍ يُكتب في هذه الشاشة ' +
          'أن يقيّم ناتجاً يدخل المستودع بقيمة صفر، وإلا صار للكمية الواحدة تقييمان. ' +
          'قيّم مواد الإنتاج رسمياً (إذن إدخال مخزني أو رصيد افتتاحي بقيمة) ثم أعد تسجيل الدفعة. ' +
          'لم تُصرف أي مادة ولم تُسجَّل أي دفعة.',
        422,
        { field: 'unitCost', itemId: input.itemId },
      );
    }
  }

  /**
   * Pillar 1 (Phase 2 & 3): Record daily factory/bakery production batch (`إنتاج يومي للمصنع والمخبز`),
   * linking to official `WmsBomService` (BOM) or `ProductionOrdersService` (مكوّنات مدخلة).
   *
   * **مصدر المواد إلزامي**: قائمة مواد أو مكوّنات، وإلا 422 `VAN_PRODUCTION_INPUT_REQUIRED`.
   * `InventoryService.recordInTx` + `item_lots` تبقى مسجِّل الحركة الرسمية للدفعة نفسها
   * (وللدفعات التي لم يُنشأ لها أمر رسمي) — لا باباً لإدخال مخزون بلا مصدر.
   */
  async createProductionBatch(
    tenantId: string,
    userId: string,
    body: {
      batchNo?: string;
      itemId?: string | null;
      warehouseId?: string | null;
      branchId?: string | null;
      productionDate?: string;
      bomId?: string | null;
      components?: Array<{ itemId: string; qty: string; unitId?: string }>;
      itemName?: string;
      producedQty?: string;
      scrapQty?: string;
      /** سبب الفاقد — إلزامي مع أي كمية فاقد: فاقدٌ بلا سبب لا يُراجَع ولا يُحمَّل على تكلفة. */
      scrapReason?: string;
      unitCost?: string;
      supervisorName?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const producedQty = dec(body.producedQty);
    if (!producedQty.isFinite() || producedQty.lte(0)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'أدخل كمية الإنتاج اليومية بالكيلو (أكبر من صفر)',
        422,
        { field: 'producedQty' },
      );
    }
    /**
     * 🗑️ الفاقد (الخردة) — كميته وسببه ودفعته تُسجَّل معاً. الكمية وحدها لا تكفي: فاقدٌ
     * بلا سبب لا يُراجَع، ولا يُعرف هل هو عجينٌ زائد أم حرقٌ أم وزنٌ خاطئ. والفاقد لا
     * يدخل المخزون الصالح للبيع أبداً (يُسجَّل حركةً مستقلة بقيمته).
     */
    const scrapQty = dec(body.scrapQty ?? '0');
    if (!scrapQty.isFinite() || scrapQty.lt(0)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'كمية الفاقد يجب أن تكون رقماً محدوداً موجباً أو صفراً',
        422,
        { field: 'scrapQty' },
      );
    }
    const scrapReason = body.scrapReason?.trim() || '';
    if (scrapQty.gt(0) && !scrapReason) {
      throw new DomainError(
        'VAN_PRODUCTION_SCRAP_REASON_REQUIRED',
        'سجّل سبب الفاقد (الخردة) مع كميته — فاقد بلا سبب لا يمكن مراجعته أو تحميل تكلفته',
        422,
        { field: 'scrapReason', scrapQty: scrapQty.toFixed(4) },
      );
    }
    const productionDate = body.productionDate?.trim() || new Date().toISOString().slice(0, 10);
    const idempotencyKey = body.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT id::text FROM factory_production_batches
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
              AND deleted_at IS NULL
            LIMIT 1
          `),
        ),
      );
      if (existing) {
        return this.dashboard(tenantId);
      }
    }

    /**
     * الصنف المسجّل — a production batch that names no catalogue item cannot move stock,
     * because `stock_balances` is keyed by (tenant, item, warehouse). A free-text name
     * used to be accepted and produced a batch row with `item_id = NULL` and an official
     * balance that never moved: the factory "produced" 50 kg the inventory screen had
     * never heard of. The item is now mandatory and must be a stocked item of this tenant.
     */
    const itemId = body.itemId?.trim() || null;
    if (!itemId) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'اختر الصنف المنتج من الأصناف المسجلة في النظام — لا يمكن تسجيل إنتاج لصنف غير مسجل لأن رصيد المستودع الرسمي يُحتسب بالصنف',
        422,
        { field: 'itemId' },
      );
    }

    const itemRow = await withTenantTx(this.database.db, tenantId, async (tx) =>
      first(
        await tx.execute(sql`
          SELECT id::text, name_ar, sku, kind, purchase_price::text AS cost_price,
                 sale_price::text AS sale_price, track_lot, base_unit_id::text
          FROM items
          WHERE id = ${itemId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          LIMIT 1
        `),
      ),
    );
    if (!itemRow) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'الصنف المحدد غير موجود في هذه المنشأة',
        422,
        { field: 'itemId' },
      );
    }
    if (str(itemRow.kind) !== 'stock') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'الصنف المحدد ليس صنفًا مخزنيًا (kind = stock) فلا يمكن إنتاجه وتوريده للمستودع',
        422,
        { field: 'itemId' },
      );
    }

    const bomId = body.bomId?.trim() || null;

    /**
     * المستودع الرئيسي — resolved, never skipped (see `resolveMainWarehouseIdInTx`).
     * This is the second half of the reported defect: the screen sent no warehouse, the
     * service treated that as "nothing to record", and `stock_balances` stayed at zero.
     */
    const warehouseId = await withTenantTx(this.database.db, tenantId, (tx) =>
      this.resolveMainWarehouseIdInTx(tx, tenantId, body.warehouseId, body.branchId ?? null),
    );
    if (!warehouseId) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'لا يوجد مستودع مفعّل في المنشأة لتوريد الإنتاج إليه — أنشئ مستودعًا من شاشة المستودعات ثم أعد التسجيل',
        422,
        { field: 'warehouseId' },
      );
    }

    /**
     * 🧾 (ب) دفعةُ إنتاجٍ بلا قائمة مواد (BOM) وبلا مكوّنات = **رفضٌ صريح**، لا ترحيلٌ صامت.
     *
     * لماذا: دفعةٌ كهذه تُدخل كميةً إلى المخزون بلا مصدرٍ لها — لا مواد صُرفت ولا تكلفة
     * محسوبة، أي «مخزون من العدم» يُقابلها ربحٌ مصطنع عند أول بيع وتسوية جرد بلا أساس.
     * والبديل النظامي موجود ولا يحتاج هذا الباب: الوارد من خارج المنشأة يُسجَّل بإذن إدخال
     * مخزني رسمي (أو بتسوية جرد معتمدة) فيمرّ على نفس قيود المخزون والصلاحيات والتدقيق.
     *
     * موضع الرفض **بعد** حسم المستودع و**قبل** أي تفويض: مفتاح عدم التكرار (idempotency)
     * يُحسم قبله، فإعادة نفس الطلب تُعيد نفس النتيجة بدل تنفيذٍ ثانٍ.
     */
    const componentLines = (body.components ?? []).filter(
      (line) => str(line?.itemId ?? '').trim() !== '',
    );
    if (!bomId && componentLines.length === 0) {
      throw new DomainError(
        'VAN_PRODUCTION_INPUT_REQUIRED',
        'دفعة الإنتاج تحتاج مصدراً للمواد: اربطها بقائمة مواد (BOM) أو أدخل المكوّنات المصروفة ' +
          '(الصنف والكمية). لا تُسجَّل دفعة إنتاج بلا مواد لأنها تُدخل مخزوناً بلا مصدر ولا تكلفة، ' +
          'والوارد من خارج المنشأة موضعه إذن إدخال مخزني رسمي أو تسوية جرد معتمدة.',
        422,
        { field: 'components', itemId },
      );
    }

    /**
     * 💵 التكلفة المدخلة تُفحص **قبل** أي تفويض: أمر الإنتاج/التصنيع الرسمي يُرحَّل في
     * معاملةٍ مستقلة تُثبَّت فوراً، فرفضٌ بعدها يعني أن المواد صُرفت والناتج دخل رسمياً ثم
     * قيل للمستخدم «طلبك مرفوض» — وأقرب إعادة إرسال تستهلك المواد مرة ثانية. كل فحصٍ لا
     * يحتاج نتيجة الأمر يُحسم قبله.
     */
    const typedUnitCost =
      body.unitCost !== undefined && String(body.unitCost).trim() !== ''
        ? dec(body.unitCost)
        : null;
    if (typedUnitCost !== null && (!typedUnitCost.isFinite() || typedUnitCost.lte(0))) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'تكلفة الوحدة المدخلة يجب أن تكون رقماً موجباً محدوداً — لا صفر ولا سالب ولا نص',
        422,
        { field: 'unitCost' },
      );
    }
    const itemCardCost = itemRow?.cost_price ? dec(itemRow.cost_price) : new Decimal(0);

    await this.assertMaterialsAreValued(tenantId, {
      warehouseId,
      bomId,
      componentItemIds: componentLines.map((line) => str(line.itemId)).filter(Boolean),
      itemId,
    });

    let linkedProductionOrderId: string | null = null;
    let linkedManufacturingOrderId: string | null = null;
    let resolvedUnitCostFromOrder: Decimal | null = null;

    // Official manufacturing/production order integration (executed before opening inner tx)
    if (bomId && warehouseId) {
      const mfgOrder = await this.wmsBom.createOrder(tenantId, {
        bomId,
        warehouseId,
        qty: producedQty.toFixed(4),
      });
      if (mfgOrder?.id) {
        const producedOrder = await this.wmsBom.produce(tenantId, mfgOrder.id, {
          qty: producedQty.toFixed(4),
          // 🏷️ دفعة المخبز هي دفعة الناتج (اللوت): صنفٌ يُتتبَّع بالدفعات لا يستلمه المخزون
          // بلا `lot_id`، والأمر الرسمي هو من يسجّل الحركة هنا.
          outputLot: { lotNo: String(body.batchNo ?? '').trim() || null, productionDate },
        });
        if (producedOrder) {
          linkedManufacturingOrderId = producedOrder.id;
          if (producedOrder.actualUnitCost) {
            resolvedUnitCostFromOrder = dec(producedOrder.actualUnitCost);
          }
        }
      }
    } else if (warehouseId && itemId && componentLines.length > 0) {
      const prodOrder = await this.productionOrders.create(tenantId, {
        warehouseId,
        outputItemId: itemId,
        outputQty: producedQty.toFixed(4),
        components: componentLines,
        notes: body.notes,
      });
      const completedOrder = await this.productionOrders.complete(tenantId, prodOrder.id, {
        outputLot: { lotNo: String(body.batchNo ?? '').trim() || null, productionDate },
      });
      linkedProductionOrderId = completedOrder.id;
      if (completedOrder.unitCost) {
        resolvedUnitCostFromOrder = dec(completedOrder.unitCost);
      }
    }

    /**
     * 💵 تكلفة الإنتاج — الترتيب المعتمد، وبلا صفر افتراضي صامت:
     *
     *   1. التكلفة الفعلية من أمر تصنيع/إنتاج **رسمي مُرحَّل** (`WmsBomService.produce` ←
     *      `actualUnitCost` أو `ProductionOrdersService.complete` ← `unitCost`)؛
     *   2. وإلا تكلفة الوحدة المدخلة يدوياً من مستخدم مخوَّل — بشرط أن تكون موجبة ومحدودة؛
     *   3. وإلا تكلفة الصنف من بطاقته (`purchase_price`) إن كانت موجبة؛
     *   4. وإلا **رفض صريح**. صفرٌ صامت يعني مخزوناً بلا قيمة: ربحٌ مصطنع عند أول بيع،
     *      وتقييمٌ ناقص لكل ما يُصرف منه، وتسوية جرد (عجزاً أو فائضاً) بقيمة صفر.
     *
     * وأساس التكلفة يُحفظ ويُعرض (`costBasis`) حتى يعرف المحاسب هل الرقم تكلفة فعلية من
     * أمر تصنيع أم إدخالاً يدوياً أم تكلفة البطاقة.
     */
    const resolvedUnitCost =
      resolvedUnitCostFromOrder ?? typedUnitCost ?? (itemCardCost.gt(0) ? itemCardCost : null);
    if (resolvedUnitCost === null || !resolvedUnitCost.isFinite() || resolvedUnitCost.lte(0)) {
      throw new DomainError(
        'VAN_PRODUCTION_COST_REQUIRED',
        'لا توجد تكلفة صالحة لترحيل الإنتاج: اربط الإنتاج بأمر تصنيع رسمي (BOM أو مكوّنات) ' +
          'أو أدخل تكلفة الوحدة يدوياً (موجبة) أو سجّل تكلفة الصنف في بطاقته. ' +
          'لا يُرحَّل إنتاج بتكلفة صفر لأن المخزون يُقيَّم بها.',
        422,
        { field: 'unitCost', itemId },
      );
    }
    const costBasis: 'manufacturing_order' | 'manual_input' | 'item_cost' =
      resolvedUnitCostFromOrder !== null
        ? 'manufacturing_order'
        : typedUnitCost !== null
          ? 'manual_input'
          : 'item_cost';

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const unitCost = resolvedUnitCost;
      const totalCost = producedQty.mul(unitCost);

      const datePart = productionDate.replace(/-/g, '');
      const branchId = await this.resolveDefaultBranchIdInTx(tx, tenantId, body.branchId ?? null, warehouseId);
      const allocatedBatchNo =
        String(body.batchNo ?? '').trim() ||
        (
          await this.sequences.next(
            {
              tenantId,
              branchId: branchId ?? undefined,
              docType: 'factory_production_batch',
            },
            tx,
            { prefix: `PROD-${datePart}-`, padding: 4 },
          )
        ).display;

      const itemName = itemRow?.name_ar ? str(itemRow.name_ar) : String(body.itemName ?? '').trim();
      const batchId = newId();

      /**
       * الدفعة الرسمية — `item_lots` when the item card says it is lot-tracked, so the
       * produced quantity is traceable by the same lot the stock report and the expiry
       * screen read.
       */
      let linkedLotId: string | null = null;
      let linkedInventoryTxId: string | null = null;

      // حين يستلم الأمرُ الرسمي الناتجَ فهو من يحسم الدفعة (اللوت) ويكتبها على الحركة،
      // والدفعة هنا تقرأها من الحركة نفسها — إنشاءُ دفعةٍ ثانية يعني رقمين لكميةٍ واحدة.
      if (!linkedProductionOrderId && !linkedManufacturingOrderId && itemRow?.track_lot === true) {
        const existingLot = first(
          await tx.execute(sql`
            SELECT id::text FROM item_lots
            WHERE tenant_id = ${tenantId}::uuid AND item_id = ${itemId}::uuid AND lot_no = ${allocatedBatchNo} AND deleted_at IS NULL
            LIMIT 1
          `),
        );
        if (existingLot?.id) {
          linkedLotId = str(existingLot.id);
        } else {
          linkedLotId = newId();
          await tx.execute(sql`
            INSERT INTO item_lots (id, tenant_id, item_id, lot_no, production_date, received_at)
            VALUES (${linkedLotId}::uuid, ${tenantId}::uuid, ${itemId}::uuid, ${allocatedBatchNo}, ${productionDate}::date, now())
          `);
        }
      }

      /**
       * الحركة الرسمية — the acceptance criterion of this whole flow.
       *
       * `InventoryService.recordInTx` is the only writer of `stock_balances` and
       * `inventory_transactions`, so calling it is what makes the produced quantity appear
       * on the item card, the stock report and the valuation — not a row in the add-on
       * table. It is skipped only when an official manufacturing order already received the
       * finished goods into the same warehouse (`WmsBomService.produce` /
       * `ProductionOrdersService.complete`), because recording it twice would double the
       * balance.
       */
      if (!linkedProductionOrderId && !linkedManufacturingOrderId) {
        const rec = await this.inventory.recordInTx(tx, tenantId, [
          {
            itemId,
            warehouseId,
            qty: producedQty.toFixed(4),
            unitCost: unitCost.toFixed(4),
            lotId: linkedLotId ?? undefined,
            direction: 'in',
            docType: 'factory_production_batch',
            docId: batchId,
            lineId: batchId,
          },
        ]);
        linkedInventoryTxId = rec.transactionIds[0] ?? null;
      }

      /**
       * 🔗 الحركة الرسمية للدفعة — حين يستلم الأمرُ الرسمي (تصنيع أو إنتاج) الناتجَ في نفس
       * المستودع، لا تسجّل الدفعة حركةً ثانية (تسجيلها مرتين يضاعف الرصيد)، لكنها **تشير إلى
       * حركة الأمر نفسها**: بلا هذا الربط تبقى الدفعة وحركة المندوب (`van_stock_movements`)
       * وتقرير العهدة برقم حركةٍ فارغ لكميةٍ موجودة رسمياً في المخزون — أي أثرٌ مقطوع.
       */
      if (!linkedInventoryTxId && (linkedProductionOrderId || linkedManufacturingOrderId)) {
        const officialDocType = linkedProductionOrderId ? 'production_order' : 'manufacturing_order';
        const officialDocId = linkedProductionOrderId ?? str(linkedManufacturingOrderId);
        const officialRow = first(
          await tx.execute(sql`
            SELECT id::text, lot_id::text FROM inventory_transactions
            WHERE tenant_id = ${tenantId}::uuid
              AND doc_type = ${officialDocType}
              AND doc_id = ${officialDocId}::uuid
              AND item_id = ${itemId}::uuid
              AND direction = 'in'
            ORDER BY occurred_at DESC
            LIMIT 1
          `),
        );
        linkedInventoryTxId = officialRow?.id ? str(officialRow.id) : null;
        // الدفعة (اللوت) التي كتبها الأمر على الحركة الرسمية — نفسها التي يقرؤها تقرير
        // الصلاحية والجرد، فلا رقمين لكميةٍ واحدة.
        linkedLotId = officialRow?.lot_id ? str(officialRow.lot_id) : null;
      }

      await tx.execute(sql`
        INSERT INTO factory_production_batches (
          id, tenant_id, branch_id, batch_no, production_date, item_id, item_name, warehouse_id,
          production_order_id, manufacturing_order_id, lot_id, inventory_transaction_id,
          produced_qty, scrap_qty, issued_qty, returned_good_qty, damaged_qty,
          unit_cost, total_cost, status, supervisor_name, notes, idempotency_key, created_by,
          cost_basis
        ) VALUES (
          ${batchId}::uuid, ${tenantId}::uuid, ${branchId}::uuid, ${allocatedBatchNo}, ${productionDate}::date,
          ${itemId}::uuid, ${itemName}, ${warehouseId}::uuid,
          ${linkedProductionOrderId}::uuid, ${linkedManufacturingOrderId}::uuid,
          ${linkedLotId}::uuid, ${linkedInventoryTxId}::uuid,
          ${producedQty.toFixed(4)}::numeric, ${scrapQty.toFixed(4)}::numeric, 0, 0, 0,
          ${unitCost.toFixed(4)}::numeric, ${totalCost.toFixed(4)}::numeric,
          'active', ${body.supervisorName?.trim() || 'مشرف الإنتاج'},
          ${body.notes?.trim() || null}, ${idempotencyKey}, ${userId}::uuid,
          ${costBasis}
        )
      `);

      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, item_id, inventory_transaction_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'production_in', ${allocatedBatchNo},
          ${itemId}::uuid, ${linkedInventoryTxId}::uuid,
          ${producedQty.toFixed(4)}::numeric,
          ${unitCost.toFixed(4)}::numeric, ${totalCost.toFixed(4)}::numeric,
          ${`إنتاج يومي جديد وتوريد للمستودع الرئيسي — ${itemName}`},
          ${idempotencyKey ? `prod-move:${idempotencyKey}` : null},
          ${userId}::uuid
        )
      `);

      /**
       * فاقد التصنيع — recorded as its own movement so the scrap is visible and auditable,
       * and never counted inside `produced_qty` (which is the saleable quantity that
       * actually entered the official balance).
       */
      if (scrapQty.gt(0)) {
        /**
         * 🗑️ نص سبب حركة الفاقد — يقول الحقيقة في المسارين (BOM أو مكوّنات): الأمر الرسمي
         * يُنتج الكمية الصالحة وحدها (`outputQty = produced_qty`) فلا تُصرف مواد للفاقد،
         * وتكلفته مسجّلة هنا للمتابعة لا محمّلة على المنتج الجيد. وتحميل فاقد المخبز على
         * تكلفة المنتج قرار سياسة لم يُتخذ بعد (التقرير §10) — والشاشة لا تدّعيه.
         */
        const scrapReasonText =
          `فاقد تصنيع أثناء إنتاج الدفعة ${allocatedBatchNo}: ${scrapReason} — غير صالح للبيع ` +
          `ولم يُورَّد للمستودع (تكلفته ${scrapQty.mul(unitCost).toFixed(2)} ريال مسجّلة هنا ` +
          'للمتابعة، وغير محمّلة على تكلفة المنتج الجيد: الأمر الرسمي يُنتج الكمية الصالحة وحدها ' +
          'فلا تُصرف مواد للفاقد، وتحميل فاقد المخبز على المنتج قرار سياسة لم يُتخذ)';
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, item_id,
            qty, unit_price, amount, reason, idempotency_key, actor_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_damage', ${allocatedBatchNo},
            ${itemId}::uuid,
            ${scrapQty.toFixed(4)}::numeric, ${unitCost.toFixed(4)}::numeric,
            ${scrapQty.mul(unitCost).toFixed(4)}::numeric,
            ${scrapReasonText},
            ${idempotencyKey ? `prod-scrap:${idempotencyKey}` : null},
            ${userId}::uuid
          )
        `);
      }
    });

    return this.dashboard(tenantId);
  }

  /**
   * Pillar 4 & 5 (Phase 5): Customer Price Tiers with Effective Dating & Immutable Price Audit History.
   */
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
      const policy = await this.loadTenantPolicyInTx(tx, tenantId);
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
    return this.dashboard(tenantId);
  }

  /**
   * Pillar 1 & 2 (Phase 2 & 3): Issue goods from Factory Warehouse to Sales Rep Custody (`أمر تحميل وصرف عهدة لمندوب`),
   * using atomic `SequencesService.next` and linking to official `stock_transfers` / `InventoryService.recordInTx`.
   */
  async createLoadOrder(
    tenantId: string,
    userId: string,
    body: {
      salesmanId?: string;
      branchId?: string | null;
      warehouseId?: string | null;
      vanWarehouseId?: string | null;
      itemId?: string | null;
      vehiclePlate?: string;
      productionBatchNo?: string;
      loadedQty?: string;
      maxBonusQty?: string;
      maxBonusPct?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const salesmanId = str(body.salesmanId).trim();
    if (!salesmanId) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'اختر المندوب لأمر التحميل', 422, {
        field: 'salesmanId',
      });
    }
    const loadedQty = dec(body.loadedQty);
    if (loadedQty.lte(0)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'الكمية المحمّلة للمندوب يجب أن تكون أكبر من صفر',
        422,
        { field: 'loadedQty' },
      );
    }

    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT id::text FROM van_load_orders
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
              AND deleted_at IS NULL
            LIMIT 1
          `),
        ),
      );
      if (existing) {
        return this.dashboard(tenantId);
      }
    }

    /**
     * التحقق المسبق — everything the official transfer needs, resolved before any write,
     * so a rejected supply never leaves a half-moved balance behind.
     */
    const plan = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.loadTenantPolicyInTx(tx, tenantId);
      const maxBonusQty = dec(body.maxBonusQty ?? policy.defaultMaxBonusQty ?? '20');
      const maxBonusPct = dec(body.maxBonusPct ?? policy.defaultMaxBonusPct ?? '20');

      const salesman = first(
        await tx.execute(sql`
          SELECT s.id::text, s.name, s.active, s.warehouse_id::text, s.vehicle_plate,
                 s.employee_id::text
          FROM salesmen s
          WHERE s.id = ${salesmanId}::uuid AND s.tenant_id = ${tenantId}::uuid
          LIMIT 1
        `),
      );
      if (!salesman) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'المندوب المحدد غير موجود', 422, {
          field: 'salesmanId',
        });
      }
      if (salesman.active === false) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `المندوب (${str(salesman.name)}) موقوف — فعّله من شاشة المندوبين قبل صرف عهدة له`,
          422,
          { field: 'salesmanId' },
        );
      }

      /**
       * مستودع السيارة — the rep's own assigned warehouse when the caller did not name
       * one. A supply with nowhere to land is what made custody invisible before.
       */
      const vanWarehouseId =
        body.vanWarehouseId?.trim() || (salesman.warehouse_id ? str(salesman.warehouse_id) : '');
      if (!vanWarehouseId) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `لم يُحدد مستودع سيارة المندوب (${str(salesman.name)}) — أسند له مستودعًا من شاشة المندوبين أو اختره في طلب التوريد`,
          422,
          { field: 'vanWarehouseId' },
        );
      }

      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const batchNo = String(body.productionBatchNo ?? '').trim() || `PROD-${datePart}-0001`;
      const batchRow = first(
        await tx.execute(sql`
          SELECT item_id::text, warehouse_id::text, unit_cost::text, lot_id::text,
                 produced_qty::text, issued_qty::text, returned_good_qty::text, damaged_qty::text
          FROM factory_production_batches
          WHERE tenant_id = ${tenantId}::uuid AND batch_no = ${batchNo} AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `),
      );

      const effectiveItemId = body.itemId?.trim() || (batchRow?.item_id ? str(batchRow.item_id) : '');
      if (!effectiveItemId) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'اختر الصنف المورَّد للمندوب من الأصناف المسجلة (أو حدد دفعة إنتاج مرتبطة بصنف)',
          422,
          { field: 'itemId' },
        );
      }
      const itemRow = first(
        await tx.execute(sql`
          SELECT id::text, name_ar, kind, sale_price::text, purchase_price::text AS cost_price,
                 track_lot
          FROM items
          WHERE id = ${effectiveItemId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (!itemRow) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'الصنف المحدد غير موجود في هذه المنشأة',
          422,
          { field: 'itemId' },
        );
      }

      const effectiveWarehouseId =
        (await this.resolveMainWarehouseIdInTx(
          tx,
          tenantId,
          body.warehouseId ?? (batchRow?.warehouse_id ? str(batchRow.warehouse_id) : null),
          body.branchId ?? null,
        )) ?? '';
      if (!effectiveWarehouseId) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'لا يوجد مستودع رئيسي مفعّل لصرف العهدة منه',
          422,
          { field: 'warehouseId' },
        );
      }
      if (effectiveWarehouseId === vanWarehouseId) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'مستودع الصرف ومستودع سيارة المندوب واحد — حدد مستودعين مختلفين حتى تُسجَّل مناولة مخزنية رسمية',
          422,
          { field: 'vanWarehouseId' },
        );
      }

      const vanWarehouseRow = first(
        await tx.execute(sql`
          SELECT id::text, branch_id::text FROM warehouses
          WHERE id = ${vanWarehouseId}::uuid AND tenant_id = ${tenantId}::uuid
            AND is_active = true AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (!vanWarehouseRow) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'مستودع سيارة المندوب غير موجود أو غير مفعّل',
          422,
          { field: 'vanWarehouseId' },
        );
      }

      const resolvedBranchId = await this.resolveDefaultBranchIdInTx(
        tx,
        tenantId,
        body.branchId,
        effectiveWarehouseId,
      );

      // 🧊 لا توريد إلى سيارةٍ قيد تسوية الجرد: الكمية الجديدة ستدخل في فرق الجرد.
      await this.assertVanWarehouseNotSettlingInTx(tx, tenantId, {
        vanWarehouseId,
        itemId: effectiveItemId,
      });

      /** الرصيد الرسمي المتاح في المستودع الرئيسي — read, not assumed. */
      const balanceRow = first(
        await tx.execute(sql`
          SELECT COALESCE(quantity, 0)::text AS qty
          FROM stock_balances
          WHERE tenant_id = ${tenantId}::uuid
            AND item_id = ${effectiveItemId}::uuid
            AND warehouse_id = ${effectiveWarehouseId}::uuid
        `),
      );
      const availableQty = dec(balanceRow?.qty);
      if (availableQty.lt(loadedQty)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `الرصيد الرسمي المتوفر في المستودع الرئيسي (${availableQty.toFixed(2)}) لا يكفي لتوريد (${loadedQty.toFixed(2)}) — سجّل الإنتاج أولًا أو خفّض الكمية`,
          422,
          { field: 'loadedQty', available: availableQty.toFixed(4) },
        );
      }

      let referenceUnitPrice = batchRow?.unit_cost ? dec(batchRow.unit_cost) : new Decimal(0);
      if (itemRow.sale_price && dec(itemRow.sale_price).gt(0)) {
        referenceUnitPrice = dec(itemRow.sale_price);
      } else if (referenceUnitPrice.lte(0) && itemRow.cost_price) {
        referenceUnitPrice = dec(itemRow.cost_price);
      }
      const batchUnitCost = batchRow?.unit_cost ? dec(batchRow.unit_cost) : new Decimal(0);

      return {
        policy,
        maxBonusQty,
        maxBonusPct,
        salesmanName: str(salesman.name),
        vehiclePlate: body.vehiclePlate?.trim() || (salesman.vehicle_plate ? str(salesman.vehicle_plate) : null),
        vanWarehouseId,
        effectiveItemId,
        effectiveWarehouseId,
        resolvedBranchId,
        batchNo,
        batchRow,
        batchUnitCost,
        referenceUnitPrice,
        estimatedValue: loadedQty.mul(referenceUnitPrice),
        lotId: batchRow?.lot_id ? str(batchRow.lot_id) : null,
        itemTrackLot: itemRow.track_lot === true,
      };
    });

    const allocatedNumber = await withTenantTx(this.database.db, tenantId, (tx) =>
      this.sequences.next(
        { tenantId, branchId: plan.resolvedBranchId ?? undefined, docType: 'van_load_order' },
        tx,
        { prefix: 'VLO-', padding: 4 },
      ),
    );
    const number = allocatedNumber.display;
    const loadOrderId = newId();

    /**
     * 1) أمر التحميل مسودة — written first so a failed transfer never leaves custody
     *    claimed without goods, and so the state machine has a row to advance.
     */
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO van_load_orders (
          id, tenant_id, number, salesman_id, branch_id, warehouse_id, van_warehouse_id,
          item_id, vehicle_plate, load_date, production_batch_no, status,
          loaded_qty, received_qty, loaded_total_value, unit_cost,
          sold_qty, bonus_qty, returned_qty, damaged_qty, shortage_qty,
          max_bonus_qty, max_bonus_pct, notes, idempotency_key, created_by
        ) VALUES (
          ${loadOrderId}::uuid, ${tenantId}::uuid, ${number}, ${salesmanId}::uuid,
          ${plan.resolvedBranchId}::uuid, ${plan.effectiveWarehouseId}::uuid, ${plan.vanWarehouseId}::uuid,
          ${plan.effectiveItemId}::uuid, ${plan.vehiclePlate}, CURRENT_DATE, ${plan.batchNo}, 'draft',
          ${loadedQty.toFixed(4)}::numeric, 0, ${plan.estimatedValue.toFixed(4)}::numeric,
          ${plan.batchUnitCost.toFixed(4)}::numeric,
          0, 0, 0, 0, 0,
          ${plan.maxBonusQty.toFixed(4)}::numeric, ${plan.maxBonusPct.toFixed(2)}::numeric,
          ${body.notes?.trim() || null}, ${idempotencyKey}, ${userId}::uuid
        )
      `);
    });

    /**
     * 2) المناولة المخزنية الرسمية — `InventoryService.createTransfer` writes the official
     *    `stock_transfers` + `stock_transfer_lines`, and `sendTransfer` is the only thing
     *    that moves the goods out of the main warehouse (Dr بضاعة تحت التحويل / Cr المخزون).
     *
     *    Nothing is added to the van yet: the quantity sits in transit until the rep
     *    confirms receipt, which is what keeps custody honest.
     */
    let transferId: string | null = null;
    let transferNumber = '';
    let sentValue = '0.0000';
    try {
      const transfer = await this.inventory.createTransfer(tenantId, {
        branchId: plan.resolvedBranchId ?? undefined,
        fromWarehouseId: plan.effectiveWarehouseId,
        toWarehouseId: plan.vanWarehouseId,
        lines: [
          {
            itemId: plan.effectiveItemId,
            qty: loadedQty.toFixed(4),
            unitCost: plan.batchUnitCost.toFixed(4),
            /**
             * الدفعة الرسمية — only when the item card says it is lot-tracked. The van batch
             * number is a production label; handing it to the inventory engine for an item
             * with `track_lot = false` is refused (`LOT_NOT_TRACKED`), and rightly so.
             */
            lotId: plan.itemTrackLot ? (plan.lotId ?? undefined) : undefined,
            batchNo: plan.itemTrackLot ? plan.batchNo : undefined,
          },
        ],
      });
      transferId = transfer.id;
      transferNumber = transfer.number;
      const sent = await this.inventory.sendTransfer(tenantId, transfer.id, { allowNegative: false });
      sentValue = sent.value;
    } catch (error) {
      /**
       * ⛑️ التعويض — a supply is three steps that cannot share one transaction (the official
       * transfer API opens its own). If the send fails, the draft transfer and the draft load
       * order must not survive as if nothing happened: the transfer is cancelled through the
       * official service (which mirrors the movement back and reverses the send journal) and
       * the order is marked `canceled` with the reason, so a retry starts clean.
       */
      await this.compensateFailedSupply(tenantId, loadOrderId, transferId, error);
      throw error;
    }

    /** 3) بانتظار استلام المندوب. */
    try {
      await this.markSupplyAwaitingReceipt(tenantId, {
        loadOrderId,
        loadOrderNumber: number,
        transferId: transferId as string,
        transferNumber,
        sentValue,
        plan,
        salesmanId,
        loadedQty,
        idempotencyKey,
        userId,
      });
    } catch (error) {
      // The goods already moved: put them back through the official cancellation path.
      await this.compensateFailedSupply(tenantId, loadOrderId, transferId, error);
      throw error;
    }

    return this.dashboard(tenantId);
  }

  /** الخطوة الثالثة من ساغا التوريد — separate method so its failure can be compensated. */
  private async markSupplyAwaitingReceipt(
    tenantId: string,
    input: {
      loadOrderId: string;
      loadOrderNumber: string;
      transferId: string;
      transferNumber: string;
      sentValue: string;
      plan: {
        batchNo: string;
        effectiveItemId: string;
        referenceUnitPrice: Decimal;
        estimatedValue: Decimal;
        salesmanName: string;
        batchRow?: Record<string, unknown> | null;
      };
      salesmanId: string;
      loadedQty: Decimal;
      idempotencyKey: string | null;
      userId: string;
    },
  ): Promise<void> {
    const { loadOrderId, loadOrderNumber, transferId, transferNumber, sentValue, plan, salesmanId, loadedQty } =
      input;
    const idempotencyKey = input.idempotencyKey;
    const userId = input.userId;
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      /**
       * الحركة الرسمية الصادرة — `inventory_tx_id` is a foreign key to
       * `inventory_transactions`, so it must hold the movement the send actually wrote
       * (read back by transfer id), never the transfer's own id.
       */
      const sentTx = first(
        await tx.execute(sql`
          SELECT id::text FROM inventory_transactions
          WHERE tenant_id = ${tenantId}::uuid
            AND doc_type = 'stock_transfer'
            AND doc_id = ${transferId}::uuid
          ORDER BY created_at ASC
          LIMIT 1
        `),
      );
      const sentInventoryTxId = sentTx?.id ? str(sentTx.id) : null;

      await tx.execute(sql`
        UPDATE van_load_orders
        SET stock_transfer_id = ${transferId}::uuid,
            inventory_tx_id = ${sentInventoryTxId}::uuid,
            status = 'pending_receipt',
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
      `);

      if (plan.batchRow) {
        await tx.execute(sql`
          UPDATE factory_production_batches
          SET issued_qty = issued_qty + ${loadedQty.toFixed(4)}::numeric,
              updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid AND batch_no = ${plan.batchNo} AND deleted_at IS NULL
        `);
      }

      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'van_load', ${plan.batchNo}, ${loadOrderId}::uuid,
          ${salesmanId}::uuid, ${plan.effectiveItemId}::uuid,
          ${loadedQty.toFixed(4)}::numeric, ${plan.referenceUnitPrice.toFixed(4)}::numeric,
          ${plan.estimatedValue.toFixed(4)}::numeric,
          ${`صرف عهدة للمندوب (${plan.salesmanName}) بموجب مناولة مخزنية رسمية ${transferNumber} بقيمة ${sentValue} ريال — بانتظار تأكيد الاستلام`},
          ${idempotencyKey ? `load-move:${idempotencyKey}` : null},
          ${userId}::uuid
        )
      `);

      await this.notifyRepOfSupplyInTx(tx, tenantId, {
        salesmanId,
        loadOrderId,
        number: loadOrderNumber,
        transferNumber,
        itemName: str(plan.batchRow?.item_id ? '' : ''),
        qty: loadedQty,
      });
    });
  }

  /**
   * ⛑️ تعويض توريدٍ فشل في منتصفه — the supply saga spans three steps that cannot share one
   * transaction (the official transfer API opens its own). A failure after the goods moved would
   * otherwise leave a `draft` order next to a sent transfer: stock in transit that nobody owns.
   *
   * The compensation is deliberately conservative:
   * - the official `cancelTransfer` is what puts the quantity back and reverses the send journal
   *   (never a hand-written mirror movement);
   * - the load order is marked `canceled` with the reason and the outcome written to
   *   `stock_settlement_note` — it is never deleted, so the audit trail keeps the attempt;
   * - if the cancellation itself fails, that is recorded on the order for the warehouse keeper
   *   instead of being swallowed, and the **original** error is still what the caller sees.
   */
  private async compensateFailedSupply(
    tenantId: string,
    loadOrderId: string,
    transferId: string | null,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const transferOutcome = transferId
      ? await (async () => {
          try {
            await this.inventory.cancelTransfer(tenantId, transferId, `إلغاء توريد فاشل: ${reason}`);
            return 'أُلغيت المناقلة الرسمية وأعادت الكميات وقيد الإرسال إلى المستودع المصدر';
          } catch (cancelError) {
            return `⚠️ تعذّر إلغاء المناقلة الرسمية (${
              cancelError instanceof Error ? cancelError.message : String(cancelError)
            }) — يلزم تدخل أمين المستودع يدوياً`;
          }
        })()
      : 'لم تُنشأ مناقلة رسمية';

    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        await tx.execute(sql`
          UPDATE van_load_orders
          SET status = 'canceled',
              stock_settlement_status = 'not_required',
              stock_settlement_note = ${`فشل تنفيذ التوريد: ${reason} — ${transferOutcome}`},
              updated_at = now()
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
            AND status IN ('draft', 'pending_receipt')
        `);
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, load_order_id, qty, unit_price, amount, reason,
            idempotency_key
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_load_canceled', ${loadOrderId}::uuid,
            0, 0, 0, ${`إلغاء أمر تحميل بعد فشل التنفيذ: ${reason} — ${transferOutcome}`},
            ${`load-cancel:${loadOrderId}`}
          )
        `);
      });
    } catch {
      // Recorded on the order above; the caller must still see the original failure.
    }
  }

  /**
   * إشعار المندوب — a supply that arrives silently is a supply the rep never confirms,
   * and the goods then sit in transit forever. Delivered to the membership that owns the
   * salesman's employee card, so it reaches his own login only.
   */
  private async notifyRepOfSupplyInTx(
    tx: DrizzleTx,
    tenantId: string,
    input: {
      salesmanId: string;
      loadOrderId: string;
      number: string;
      transferNumber: string;
      itemName: string;
      qty: Decimal;
    },
  ): Promise<void> {
    const membershipRow = first(
      await tx.execute(sql`
        SELECT e.membership_id::text
        FROM salesmen s
        JOIN employees e ON e.id = s.employee_id
        WHERE s.id = ${input.salesmanId}::uuid AND s.tenant_id = ${tenantId}::uuid
          AND e.deleted_at IS NULL AND e.membership_id IS NOT NULL
        LIMIT 1
      `),
    );
    const membershipId = membershipRow?.membership_id ? str(membershipRow.membership_id) : null;
    if (!membershipId) return;
    await this.notifications.createInTx(tx, {
      tenantId,
      membershipId,
      type: 'van_sales_supply_pending_receipt',
      payload: {
        title: `🚐 توريد جديد بانتظار تأكيدك (${input.number})`,
        body: `تم صرف ${input.qty.toFixed(2)} كجم إلى عهدتك بموجب المناولة ${input.transferNumber} — أكّد الاستلام أو سجّل الفرق.`,
        href: '/van-sales/rep',
      },
    });
  }

  /**
   * تأكيد استلام التوريد — the rep's own confirmation that closes the official transfer.
   *
   * `InventoryService.receiveTransfer` is what puts the goods into the van warehouse
   * (Dr المخزون / Cr بضاعة تحت التحويل), so custody only ever appears here — never at
   * supply time. A short receipt records the difference and closes the remainder through
   * the official `closeTransfer(mode: 'shortage')` so nothing is left hanging in transit.
   */
  async confirmReceipt(
    tenantId: string,
    userId: string,
    membershipId: string | null,
    loadOrderId: string,
    body: { receivedQty?: string; notes?: string },
  ) {
    const context = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const order = first(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.status, l.salesman_id::text, l.item_id::text,
                 l.loaded_qty::text, l.received_qty::text, l.stock_transfer_id::text,
                 l.production_batch_no, l.van_warehouse_id::text, l.warehouse_id::text,
                 s.name AS salesman_name, s.employee_id::text,
                 e.membership_id::text AS salesman_membership_id
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          LEFT JOIN employees e ON e.id = s.employee_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!order) throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      const salesmanMembershipId = order.salesman_membership_id
        ? str(order.salesman_membership_id)
        : null;
      /**
       * من يملك التأكيد — the rep who owns the custody, or a back-office user holding
       * `van_sales.load.manage` (the accountant confirming on his behalf). A second rep
       * gets 403: hiding the button is not access control.
       */
      const isAssignedRep = Boolean(membershipId && salesmanMembershipId === membershipId);
      if (!isAssignedRep) {
        const allowed = first(
          await tx.execute(sql`
            SELECT 1 AS ok
            FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN role_permissions rp ON rp.role_id = mr.role_id
            WHERE m.tenant_id = ${tenantId}::uuid
              AND m.id = ${membershipId ?? ''}::uuid
              AND m.deleted_at IS NULL
              AND rp.permission_code IN ('van_sales.load.manage', 'van_sales.closing.approve')
            LIMIT 1
          `),
        );
        if (!allowed?.ok) {
          throw new DomainError(
            errorCodes.FORBIDDEN,
            'لا يجوز تأكيد استلام عهدة مندوب آخر — التأكيد من حساب المندوب نفسه أو من المحاسب المخوّل',
            403,
          );
        }
      }
      /**
       * الحالة تُفحص بعد التفويض — an unauthorised caller is told he is unauthorised, not
       * what state somebody else's custody is in.
       */
      if (str(order.status) !== 'pending_receipt') {
        throw new DomainError(
          'VAN_LOAD_ORDER_NOT_AWAITING_RECEIPT',
          str(order.status) === 'draft'
            ? 'أمر التحميل ما زال مسودة ولم يُصرف بعد — لا يمكن تأكيد استلامه'
            : 'تم تأكيد استلام أمر التحميل هذا مسبقًا ولا يمكن تكرار الاستلام',
          409,
        );
      }
      const loadedQty = dec(order.loaded_qty);
      const receivedQty =
        body.receivedQty === undefined || String(body.receivedQty).trim() === ''
          ? loadedQty
          : dec(body.receivedQty);
      if (!receivedQty.isFinite() || receivedQty.lt(0)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'الكمية المستلمة يجب أن تكون رقمًا موجبًا أو صفرًا',
          422,
          { field: 'receivedQty' },
        );
      }
      if (receivedQty.gt(loadedQty)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `الكمية المستلمة (${receivedQty.toFixed(2)}) تتجاوز الكمية المصروفة (${loadedQty.toFixed(2)})`,
          422,
          { field: 'receivedQty' },
        );
      }
      // 🧊 لا استلام يدخل سيارةً قيد تسوية الجرد — الكمية ستدخل في فرق جردٍ لم يُعتمد.
      await this.assertVanWarehouseNotSettlingInTx(tx, tenantId, {
        vanWarehouseId: order.van_warehouse_id ? str(order.van_warehouse_id) : null,
        itemId: order.item_id ? str(order.item_id) : null,
        exceptLoadOrderId: loadOrderId,
      });
      return { order, loadedQty, receivedQty, isAssignedRep };
    });

    const { order, loadedQty, receivedQty } = context;
    const transferId = order.stock_transfer_id ? str(order.stock_transfer_id) : null;
    const discrepancyQty = Decimal.max(0, loadedQty.minus(receivedQty));

    /**
     * ♻️ استكمال آمن — if a previous attempt received the transfer but failed before the order
     * was updated, the official transfer is already `received`; receiving it twice is refused by
     * the inventory engine, so the step is skipped and the order state is simply completed.
     */
    const transferState = transferId ? await this.inventory.getTransfer(tenantId, transferId) : null;
    const transferAlreadyReceived =
      transferState !== null &&
      ['received', 'partially_received', 'closed'].includes(str(transferState.status));

    if (transferId && receivedQty.gt(0) && !transferAlreadyReceived) {
      await this.inventory.receiveTransfer(tenantId, transferId, [
        { lineNo: 1, qty: receivedQty.toFixed(4) },
      ]);
    }
    /**
     * 🚫 لا تسوية مالية تلقائية لفرق الاستلام — the previous code closed the official transfer
     * with `mode: 'shortage'`, which posts Dr تسوية المخزون / Cr بضاعة تحت التحويل on its own:
     * a financial treatment of a loss nobody authorised. The quantity the rep did receive is now
     * the whole custody, the difference stays officially **in transit** on the transfer, and the
     * accountant decides through `closeTransitDifference` whether it went back to the source
     * (`return`) or was lost (`shortage`).
     */

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE van_load_orders
        SET received_qty = ${receivedQty.toFixed(4)}::numeric,
            discrepancy_qty = ${discrepancyQty.toFixed(4)}::numeric,
            discrepancy_notes = ${body.notes?.trim() || null},
            received_at = now(),
            received_by = ${userId}::uuid,
            status = 'loaded',
            stock_settlement_status = ${discrepancyQty.gt(0) ? 'pending_transit_decision' : 'not_required'},
            stock_settlement_note = ${
              discrepancyQty.gt(0)
                ? `فرق استلام ${discrepancyQty.toFixed(2)} كجم ما زال «بضاعة تحت التحويل» في المناقلة الرسمية — يلزم قرار المحاسب: إرجاعه للمصدر أو اعتباره عجزاً`
                : null
            },
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid
          AND tenant_id = ${tenantId}::uuid
          AND status = 'pending_receipt'
      `);

      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid,
          ${discrepancyQty.gt(0) ? 'van_receipt_discrepancy' : 'van_receipt_confirmed'},
          ${str(order.production_batch_no)}, ${loadOrderId}::uuid,
          ${str(order.salesman_id)}::uuid, ${order.item_id ? str(order.item_id) : null}::uuid,
          ${receivedQty.toFixed(4)}::numeric, 0, 0,
          ${discrepancyQty.gt(0)
            ? `تأكيد استلام جزئي: ${receivedQty.toFixed(2)} من ${loadedQty.toFixed(2)} كجم — فرق ${discrepancyQty.toFixed(2)} كجم${body.notes?.trim() ? ` (${body.notes.trim()})` : ''}`
            : `تأكيد المندوب استلام كامل الكمية (${receivedQty.toFixed(2)} كجم) ودخولها عهدته رسميًا`},
          ${`receipt:${loadOrderId}`},
          ${userId}::uuid
        )
      `);

      /**
       * إشعار المحاسب — a discrepancy is an exception the accountant must see, not a
       * number that quietly disagrees with the transfer.
       */
      const accountants = rows(
        await tx.execute(sql`
          SELECT m.id::text AS membership_id
          FROM memberships m
          JOIN membership_roles mr ON mr.membership_id = m.id
          JOIN role_permissions rp ON rp.role_id = mr.role_id
          WHERE m.tenant_id = ${tenantId}::uuid AND m.deleted_at IS NULL AND m.status = 'active'
            AND rp.permission_code IN ('van_sales.closing.approve', 'van_sales.load.manage')
          LIMIT 10
        `),
      );
      const title = discrepancyQty.gt(0)
        ? `⚠️ فرق في استلام التوريد (${str(order.number)})`
        : `✅ تأكيد استلام التوريد (${str(order.number)})`;
      const msgBody = discrepancyQty.gt(0)
        ? `استلم المندوب (${str(order.salesman_name)}) ${receivedQty.toFixed(2)} من ${loadedQty.toFixed(2)} كجم — فرق ${discrepancyQty.toFixed(2)} كجم يحتاج مراجعة.`
        : `استلم المندوب (${str(order.salesman_name)}) ${receivedQty.toFixed(2)} كجم ودخلت عهدة سيارة التوزيع.`;
      for (const accountant of accountants) {
        await this.notifications.createInTx(tx, {
          tenantId,
          membershipId: str(accountant.membership_id),
          type: discrepancyQty.gt(0) ? 'van_sales_receipt_discrepancy' : 'van_sales_receipt_confirmed',
          payload: { title, body: msgBody, href: '/van-sales?tab=loads' },
        });
      }
    });

    return this.dashboard(tenantId);
  }

  /**
   * من يملك قرار الاستلام — the rep who owns the custody or a back-office user holding
   * `van_sales.load.manage` / `van_sales.closing.approve`. Shared by the receipt, the refusal and
   * the transit-difference decision so the rule cannot drift between them.
   */
  private async assertReceiptActorInTx(
    tx: DrizzleTx,
    tenantId: string,
    membershipId: string | null,
    order: Record<string, unknown>,
  ): Promise<void> {
    if (membershipId && order.salesman_membership_id && str(order.salesman_membership_id) === membershipId) {
      return;
    }
    const allowed = first(
      await tx.execute(sql`
        SELECT 1 AS ok
        FROM memberships m
        JOIN membership_roles mr ON mr.membership_id = m.id
        JOIN role_permissions rp ON rp.role_id = mr.role_id
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.id = ${membershipId ?? ''}::uuid
          AND m.deleted_at IS NULL
          AND rp.permission_code IN ('van_sales.load.manage', 'van_sales.closing.approve')
        LIMIT 1
      `),
    );
    if (!allowed?.ok) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'لا يجوز التصرف في عهدة مندوب آخر — الإجراء من حساب المندوب نفسه أو من المحاسب المخوّل',
        403,
      );
    }
  }

  /**
   * ❌ رفض الاستلام — the rep refuses a supply (wrong item, damaged pallet, short truck…).
   * The quantity is officially still in transit, so the refusal closes the official transfer with
   * `mode: 'return'`: the goods go back to the source warehouse **at the cost they left at** and
   * the inventory engine writes its own balanced journal. No custody ever appears, and nothing is
   * hand-written into the stock ledger.
   */
  async rejectReceipt(
    tenantId: string,
    userId: string,
    membershipId: string | null,
    loadOrderId: string,
    body: { reason?: string } = {},
  ) {
    const order = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = first(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.status, l.salesman_id::text, l.item_id::text,
                 l.loaded_qty::text, l.received_qty::text, l.stock_transfer_id::text,
                 l.production_batch_no, s.name AS salesman_name, e.membership_id::text AS salesman_membership_id
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          LEFT JOIN employees e ON e.id = s.employee_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      await this.assertReceiptActorInTx(tx, tenantId, membershipId, row);
      if (str(row.status) !== 'pending_receipt') {
        throw new DomainError(
          'VAN_LOAD_ORDER_NOT_AWAITING_RECEIPT',
          str(row.status) === 'rejected' || str(row.status) === 'canceled'
            ? 'أمر التحميل مرفوض أو ملغى مسبقاً'
            : 'لا يمكن رفض استلام أمر لم يعد بانتظار الاستلام',
          409,
        );
      }
      return row;
    });

    const reason =
      body.reason?.trim() || `رفض المندوب استلام التوريد ${str(order.number)} — تُعاد الكمية إلى المستودع المصدر`;
    const transferId = order.stock_transfer_id ? str(order.stock_transfer_id) : null;
    if (transferId) {
      // Official mechanism: returns the outstanding quantity at its original cost + journal.
      await this.inventory.closeTransfer(tenantId, transferId, { mode: 'return', reason });
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE van_load_orders
        SET status = 'rejected',
            received_qty = 0,
            stock_settlement_status = 'settled_officially',
            stock_settlement_note = ${reason},
            notes = COALESCE(notes || ' | ', '') || ${`مرفوض: ${reason}`},
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid AND status = 'pending_receipt'
      `);
      // The batch never really issued these kilograms.
      await tx.execute(sql`
        UPDATE factory_production_batches
        SET issued_qty = GREATEST(0, issued_qty - ${dec(order.loaded_qty).toFixed(4)}::numeric),
            updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid
          AND batch_no = ${str(order.production_batch_no)}
          AND deleted_at IS NULL
      `);
      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'van_receipt_rejected', ${str(order.production_batch_no)},
          ${loadOrderId}::uuid, ${str(order.salesman_id)}::uuid,
          ${order.item_id ? str(order.item_id) : null}::uuid,
          ${dec(order.loaded_qty).toFixed(4)}::numeric, 0, 0, ${reason},
          ${`receipt-reject:${loadOrderId}`}, ${userId}::uuid
        )
      `);
      await this.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_receipt_discrepancy',
        title: `❌ رفض المندوب استلام التوريد (${str(order.number)})`,
        body: `${str(order.salesman_name)} رفض استلام ${dec(order.loaded_qty).toFixed(2)} كجم — أُعيدت الكمية رسمياً إلى المستودع المصدر. السبب: ${reason}`,
        href: '/van-sales?tab=loads',
      });
    });

    return this.dashboard(tenantId);
  }

  /**
   * 🚦 قرار فرق الاستلام — the quantity the rep did **not** receive is still officially in
   * transit. Closing it is a financial decision, so it is taken explicitly by an authorised user
   * and executed by the official inventory engine:
   *
   * | mode       | stock                         | journal (من ملف ترحيل `stock_transfer`)      |
   * |------------|-------------------------------|----------------------------------------------|
   * | `return`   | back into the source warehouse| Dr المخزون / Cr بضاعة تحت التحويل             |
   * | `shortage` | nothing moves (it is lost)    | Dr تسوية المخزون / Cr بضاعة تحت التحويل       |
   *
   * Nothing here is decided by the system, and no account is invented: both accounts come from the
   * tenant's own posting profile, and a missing mapping is refused by the inventory engine.
   */
  async closeTransitDifference(
    tenantId: string,
    userId: string,
    loadOrderId: string,
    body: { mode?: string; reason?: string },
  ) {
    const mode = body.mode === 'shortage' ? 'shortage' : body.mode === 'return' ? 'return' : null;
    if (!mode) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'قرار فرق الاستلام مطلوب صراحةً: `return` لإرجاع الكمية إلى المستودع المصدر، أو `shortage` لاعتبارها عجزاً في التحويل',
        422,
        { field: 'mode' },
      );
    }

    const order = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = first(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.status, l.salesman_id::text, l.item_id::text,
                 l.loaded_qty::text, l.received_qty::text, l.discrepancy_qty::text,
                 l.stock_transfer_id::text, l.stock_settlement_status, l.production_batch_no,
                 s.name AS salesman_name
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      if (dec(row.discrepancy_qty).lte(0)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'لا يوجد فرق استلام على أمر التحميل هذا',
          422,
          { field: 'discrepancyQty' },
        );
      }
      if (str(row.stock_settlement_status) === 'settled_officially') {
        throw new DomainError(
          'VAN_TRANSIT_DIFFERENCE_ALREADY_CLOSED',
          'فرق الاستلام مقفل مسبقاً بقرار سابق — لا يمكن إقفاله مرتين',
          409,
        );
      }
      if (!row.stock_transfer_id) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'أمر التحميل غير مرتبط بمناقلة رسمية — لا يمكن إقفال فرق الاستلام خارج آلية المخزون الرسمية',
          422,
          { field: 'stockTransferId' },
        );
      }
      return row;
    });

    const reason =
      body.reason?.trim() ||
      `قرار فرق الاستلام (${mode === 'return' ? 'إرجاع إلى المصدر' : 'اعتباره عجز تحويل'}) لأمر التحميل ${str(order.number)}`;
    const closed = await this.inventory.closeTransfer(tenantId, str(order.stock_transfer_id), {
      mode,
      reason,
    });

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE van_load_orders
        SET stock_settlement_status = 'settled_officially',
            stock_settlement_note = ${`${reason} — أُقفلت المناقلة رسمياً (${str(closed.status)}) بقيمة ${str(closed.value)} ريال`},
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
          AND stock_settlement_status <> 'settled_officially'
      `);
      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id, approved_by_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'van_transit_difference', ${str(order.production_batch_no)},
          ${loadOrderId}::uuid, ${str(order.salesman_id)}::uuid,
          ${order.item_id ? str(order.item_id) : null}::uuid,
          ${dec(order.discrepancy_qty).toFixed(4)}::numeric, 0, ${str(closed.value)}::numeric,
          ${reason}, ${`transit-close:${loadOrderId}:${mode}`}, ${userId}::uuid, ${userId}::uuid
        )
      `);
      await this.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_receipt_discrepancy',
        title: `🚦 أُقفل فرق الاستلام (${str(order.number)})`,
        body: `${dec(order.discrepancy_qty).toFixed(2)} كجم — ${reason}`,
        href: '/van-sales?tab=loads',
      });
    });

    return this.dashboard(tenantId);
  }

  /**
   * 🗑️ إلغاء أمر تحميل — allowed only while nothing has been received and nothing has been sold.
   * A sent transfer is cancelled through the official service, which mirrors the movement back into
   * the source warehouse **and reverses the send journal**, and the batch's `issued_qty` is given
   * back. The order is kept (never deleted) with the reason, so the audit trail shows the attempt.
   */
  async cancelLoadOrder(tenantId: string, userId: string, loadOrderId: string, body: { reason?: string } = {}) {
    const order = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = first(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.status, l.salesman_id::text, l.item_id::text,
                 l.loaded_qty::text, l.received_qty::text, l.sold_qty::text, l.bonus_qty::text,
                 l.stock_transfer_id::text, l.production_batch_no, s.name AS salesman_name
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      if (!['draft', 'pending_receipt'].includes(str(row.status))) {
        throw new DomainError(
          'VAN_LOAD_ORDER_NOT_CANCELLABLE',
          'لا يمكن إلغاء أمر تحميل بعد تأكيد الاستلام أو بعد أي بيع — استخدم المرتجع وإغلاق الوردية',
          409,
        );
      }
      if (dec(row.sold_qty).gt(0) || dec(row.bonus_qty).gt(0) || dec(row.received_qty).gt(0)) {
        throw new DomainError(
          'VAN_LOAD_ORDER_NOT_CANCELLABLE',
          'تحركت كميات على أمر التحميل هذا (استلام أو بيع أو بونص) فلا يجوز إلغاؤه',
          409,
        );
      }
      return row;
    });

    const reason = body.reason?.trim() || `إلغاء أمر التحميل ${str(order.number)}`;
    let transferOutcome = 'لا توجد مناقلة رسمية';
    if (order.stock_transfer_id) {
      const cancelled = await this.inventory.cancelTransfer(
        tenantId,
        str(order.stock_transfer_id),
        reason,
      );
      transferOutcome = `أُلغيت المناقلة الرسمية (${str(cancelled.status)})`;
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE van_load_orders
        SET status = 'canceled',
            stock_settlement_status = 'not_required',
            stock_settlement_note = ${`${reason} — ${transferOutcome}`},
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
          AND status IN ('draft', 'pending_receipt')
      `);
      await tx.execute(sql`
        UPDATE factory_production_batches
        SET issued_qty = GREATEST(0, issued_qty - ${dec(order.loaded_qty).toFixed(4)}::numeric),
            updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid
          AND batch_no = ${str(order.production_batch_no)}
          AND deleted_at IS NULL
      `);
      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'van_load_canceled', ${str(order.production_batch_no)},
          ${loadOrderId}::uuid, ${str(order.salesman_id)}::uuid,
          ${order.item_id ? str(order.item_id) : null}::uuid,
          ${dec(order.loaded_qty).toFixed(4)}::numeric, 0, 0, ${`${reason} — ${transferOutcome}`},
          ${`load-cancel-manual:${loadOrderId}`}, ${userId}::uuid
        )
      `);
      await this.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_supply_pending_receipt',
        title: `🗑️ أُلغي أمر تحميل (${str(order.number)})`,
        body: `${str(order.salesman_name)} — ${reason}. ${transferOutcome}.`,
        href: '/van-sales?tab=loads',
      });
    });

    return this.dashboard(tenantId);
  }

  /** إشعار أصحاب صلاحية الاعتماد — one query, one rule, reused by every exception path. */
  private async notifyAccountantsInTx(
    tx: DrizzleTx,
    tenantId: string,
    input: { type: string; title: string; body: string; href: string },
  ): Promise<void> {
    const accountants = rows(
      await tx.execute(sql`
        SELECT DISTINCT m.id::text AS membership_id
        FROM memberships m
        JOIN membership_roles mr ON mr.membership_id = m.id
        JOIN role_permissions rp ON rp.role_id = mr.role_id
        WHERE m.tenant_id = ${tenantId}::uuid AND m.deleted_at IS NULL AND m.status = 'active'
          AND rp.permission_code IN ('van_sales.closing.approve', 'van_sales.load.manage')
        LIMIT 10
      `),
    );
    for (const accountant of accountants) {
      await this.notifications.createInTx(tx, {
        tenantId,
        membershipId: str(accountant.membership_id),
        type: input.type,
        payload: { title: input.title, body: input.body, href: input.href },
      });
    }
  }

  /**
   * Pillar 3, 4, 5, 7, 8 (Phase 2, 3, 5): Issue Van Sales Document
   * with 5-level price priority, atomic sequence numbering, idempotency,
   * tax policy verification, and official `SalesService.createInTx` / `postInTx` linking.
   */
  async createDocument(
    tenantId: string,
    userId: string,
    body: {
      loadOrderId?: string;
      partyId?: string | null;
      customerName?: string;
      itemId?: string | null;
      invoiceMode?: 'zatca_tax' | 'internal_delivery';
      paymentMethod?: 'cash' | 'card' | 'credit';
      /** الصندوق الذي يستقر فيه نقد المندوب — يُمرَّر إلى سند/تسوية الفاتورة الرسمية. */
      cashLocationId?: string | null;
      soldQty?: string;
      bonusQty?: string;
      bonusReason?: string;
      unitPrice?: string;
      discountAmount?: string;
      discountReason?: string;
      allowPriceDiscountOverride?: boolean;
      customerBonusConfirmed?: boolean;
      customerConfirmationCode?: string;
      allowBonusOverride?: boolean;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const loadOrderId = str(body.loadOrderId).trim();
    if (!loadOrderId) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'يجب اختيار أمر التحميل / دفعة الإنتاج الخاصة بالمندوب لمنع بيع بضاعة من خارج المخبز',
        422,
        { field: 'loadOrderId' },
      );
    }
    const soldQty = dec(body.soldQty);
    const bonusQty = dec(body.bonusQty ?? '0');
    if (soldQty.lte(0) && bonusQty.lte(0)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'أدخل الكمية المباعة بالكيلو', 422, {
        field: 'soldQty',
      });
    }

    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT id::text FROM van_sales_documents
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
              AND deleted_at IS NULL
            LIMIT 1
          `),
        ),
      );
      if (existing) {
        return this.dashboard(tenantId);
      }
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.loadTenantPolicyInTx(tx, tenantId);

      const loadOrder = first(
        await tx.execute(sql`
          SELECT * FROM van_load_orders
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          FOR UPDATE
        `),
      );
      if (!loadOrder) {
        throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      }
      if (str(loadOrder.status) === 'settled') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'أمر التحميل هذا تم إغلاقه وتصفيته مسبقاً',
          422,
        );
      }
      /**
       * العهدة الفعلية — what the rep confirmed he received, not what the warehouse sent.
       *
       * Selling against `loaded_qty` let a document be issued for goods still sitting in
       * transit (or never handed over at all), which is how a van "sold" stock its official
       * balance did not hold. Before receipt confirmation the custody is zero and the sale
       * is refused with the reason named.
       */
      if (str(loadOrder.status) === 'draft' || str(loadOrder.status) === 'pending_receipt') {
        throw new DomainError(
          'VAN_LOAD_ORDER_NOT_RECEIVED',
          'لا يمكن البيع من عهدة لم يؤكّد المندوب استلامها بعد — أكّد الاستلام من تطبيق المندوب أولًا',
          409,
        );
      }

      const effectiveItemIdForBalanceCheck =
        body.itemId?.trim() || (loadOrder.item_id ? str(loadOrder.item_id) : null);

      const loaded = dec(loadOrder.received_qty).gt(0)
        ? dec(loadOrder.received_qty)
        : dec(loadOrder.loaded_qty);
      const currentSold = dec(loadOrder.sold_qty);
      const currentBonus = dec(loadOrder.bonus_qty);
      const currentReturned = dec(loadOrder.returned_qty);
      const currentDamaged = dec(loadOrder.damaged_qty);
      const remaining = loaded
        .minus(currentSold)
        .minus(currentBonus)
        .minus(currentReturned)
        .minus(currentDamaged);
      const totalOutThisDoc = soldQty.plus(bonusQty);

      if (totalOutThisDoc.gt(remaining)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `رفض أمني لمنع خلط بضاعة خارجية: الكمية المطلوبة (${totalOutThisDoc.toFixed(2)} كجم) تتجاوز الرصيد المتبقي في سيارة المندوب من دفعة المخبز رقم ${str(loadOrder.production_batch_no)} (${remaining.toFixed(2)} كجم متبقي).`,
          422,
          { field: 'soldQty' },
        );
      }

      /**
       * الرصيد الرسمي في مستودع السيارة — the same guard the inventory engine applies,
       * checked up front so the operator gets a van-sales message naming the custody
       * instead of a generic `STOCK_INSUFFICIENT` from deep inside the posting engine.
       */
      const vanWarehouseId = loadOrder.van_warehouse_id ? str(loadOrder.van_warehouse_id) : null;
      /**
       * 🧊 لا بيع من سيارةٍ عليها وردية قيد تسوية الجرد (ولو كان البيع من أمر تحميل آخر):
       * إخراج كمية الآن يغيّر الرصيد الذي سيُسوَّى ضدّه مستند الجرد، فيمتصّ الفرق حركةً
       * لم يعتمدها المحاسب.
       */
      await this.assertVanWarehouseNotSettlingInTx(tx, tenantId, {
        vanWarehouseId,
        itemId: effectiveItemIdForBalanceCheck,
        exceptLoadOrderId: loadOrderId,
      });
      if (vanWarehouseId && effectiveItemIdForBalanceCheck) {
        const vanBalance = first(
          await tx.execute(sql`
            SELECT COALESCE(quantity, 0)::text AS qty
            FROM stock_balances
            WHERE tenant_id = ${tenantId}::uuid
              AND item_id = ${effectiveItemIdForBalanceCheck}::uuid
              AND warehouse_id = ${vanWarehouseId}::uuid
          `),
        );
        const available = dec(vanBalance?.qty);
        if (available.lt(totalOutThisDoc)) {
          throw new DomainError(
            errorCodes.VALIDATION_FAILED,
            `الرصيد الرسمي المتوفر في مستودع سيارة المندوب (${available.toFixed(2)}) لا يكفي لبيع (${totalOutThisDoc.toFixed(2)}) — راجع التوريد والاستلام`,
            422,
            { field: 'soldQty', available: available.toFixed(4) },
          );
        }
      }

      const partyId = body.partyId ? str(body.partyId).trim() || null : null;
      const effectiveItemId =
        body.itemId?.trim() || (loadOrder.item_id ? str(loadOrder.item_id) : null);

      // 5-Level Price Priority Hierarchy (Phase 5):
      // 1. Customer + Item active price rule (`van_sales_customer_prices` where item_id = effectiveItemId)
      // 2. Customer general active price rule (`van_sales_customer_prices` where item_id IS NULL)
      // 3. Default Price List (`price_list_items` on default `price_lists`)
      // 4. Item card `sale_price` (`items.sale_price`)
      // 5. Supplied `body.unitPrice`
      let customerRule: Record<string, unknown> | undefined;
      if (partyId) {
        customerRule = first(
          await tx.execute(sql`
            SELECT * FROM van_sales_customer_prices
            WHERE tenant_id = ${tenantId}::uuid
              AND party_id = ${partyId}::uuid
              AND deleted_at IS NULL
              AND effective_from <= CURRENT_DATE
              AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
              AND (${effectiveItemId}::uuid IS NULL OR item_id = ${effectiveItemId}::uuid OR item_id IS NULL)
            ORDER BY (CASE WHEN item_id IS NOT NULL THEN 0 ELSE 1 END) ASC, updated_at DESC
            LIMIT 1
          `),
        );
      }

      let baseCatalogPrice: Decimal | null = null;
      let itemTaxRate: Decimal | null = null;
      let itemTaxGroupId: string | undefined;
      /**
       * تتبّع الدفعات — the item card decides whether a batch number may travel on the
       * official invoice line. The sales engine refuses one for an item that is not
       * lot-tracked (`LOT_NOT_TRACKED`), and the van batch label is a production reference
       * the add-on table keeps either way.
       */
      let itemTrackLot = false;
      if (effectiveItemId) {
        const plRow = first(
          await tx.execute(sql`
            SELECT pli.unit_price::text AS price
            FROM price_list_items pli
            JOIN price_lists pl ON pl.id = pli.price_list_id
            WHERE pli.tenant_id = ${tenantId}::uuid
              AND pli.item_id = ${effectiveItemId}::uuid
              AND pl.is_default = true
              AND pl.deleted_at IS NULL
            LIMIT 1
          `),
        );
        const itemCard = first(
          await tx.execute(sql`
            SELECT i.sale_price::text, i.tax_group_id::text, tg.rate::text AS tax_rate,
                   i.track_lot
            FROM items i
            LEFT JOIN tax_groups tg ON tg.id = i.tax_group_id
            WHERE i.id = ${effectiveItemId}::uuid AND i.tenant_id = ${tenantId}::uuid AND i.deleted_at IS NULL
            LIMIT 1
          `),
        );
        itemTrackLot = itemCard?.track_lot === true;
        if (plRow?.price && dec(plRow.price).gt(0)) {
          baseCatalogPrice = dec(plRow.price);
        } else if (itemCard?.sale_price && dec(itemCard.sale_price).gt(0)) {
          baseCatalogPrice = dec(itemCard.sale_price);
        }
        if (itemCard?.tax_rate !== undefined && itemCard?.tax_rate !== null) {
          itemTaxRate = dec(itemCard.tax_rate);
        }
        if (itemCard?.tax_group_id) {
          itemTaxGroupId = str(itemCard.tax_group_id);
        }
      }

      const tierUnitPrice = customerRule ? dec(customerRule.unit_price) : null;
      const fallbackPrice = tierUnitPrice ?? baseCatalogPrice;
      const requestedUnitPrice =
        body.unitPrice !== undefined && String(body.unitPrice).trim() !== ''
          ? dec(body.unitPrice)
          : (fallbackPrice ?? new Decimal(0));

      if (
        tierUnitPrice &&
        customerRule?.lock_price !== false &&
        requestedUnitPrice.lt(tierUnitPrice) &&
        !body.allowPriceDiscountOverride
      ) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `منع تغيير السعر غير المصرح به: سعر هذا العميل مثبّت في النظام عند (${tierUnitPrice.toFixed(2)} ريال/كجم). لا يُسمح للمندوب بالبيع بسعر أقل (${requestedUnitPrice.toFixed(2)} ريال/كجم) إلا بموافقة الإدارة.`,
          422,
          { field: 'unitPrice' },
        );
      }
      const resolvedUnitPrice =
        tierUnitPrice && customerRule?.lock_price !== false && !body.allowPriceDiscountOverride
          ? tierUnitPrice
          : requestedUnitPrice;
      if (resolvedUnitPrice.lte(0)) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'حدد سعر البيع للكيلو', 422, {
          field: 'unitPrice',
        });
      }

      const discountAmount = Decimal.max(0, dec(body.discountAmount ?? '0'));
      const grossBeforeDiscount = soldQty.mul(resolvedUnitPrice);
      const maxDiscountPct = customerRule ? dec(customerRule.max_discount_pct) : new Decimal(0);
      const discountPct = grossBeforeDiscount.gt(0)
        ? discountAmount.div(grossBeforeDiscount).mul(100)
        : new Decimal(0);
      if (
        discountAmount.gt(0) &&
        discountPct.gt(maxDiscountPct) &&
        !body.allowPriceDiscountOverride
      ) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `منع الخصم غير المصرح به: قيمة الخصم (${discountAmount.toFixed(2)} ريال — ${discountPct.toFixed(1)}%) تتجاوز السقف المسموح للعميل (${maxDiscountPct.toFixed(1)}%). يتطلب اعتماد صاحب المصنع أو المحاسب.`,
          422,
          { field: 'discountAmount' },
        );
      }

      // Bonus anti-fraud controls
      const loadMaxBonusRemaining = dec(loadOrder.max_bonus_qty).minus(currentBonus);
      const customerMaxBonusKg = customerRule
        ? dec(customerRule.max_bonus_kg_per_invoice)
        : dec(loadOrder.max_bonus_qty);
      const customerMaxBonusPct = customerRule
        ? dec(customerRule.max_bonus_pct)
        : dec(loadOrder.max_bonus_pct);
      const bonusPctOfSale = soldQty.gt(0)
        ? bonusQty.div(soldQty).mul('100')
        : new Decimal('100');

      let bonusAnomaly = false;
      const anomalyReasons: string[] = [];

      if (bonusQty.gt(0)) {
        if (!body.bonusReason || !body.bonusReason.trim()) {
          throw new DomainError(
            errorCodes.VALIDATION_FAILED,
            'يجب تحديد سبب منح الكمية المجانية / البونص (ترويجي، عينات، تعويض تلف…)',
            422,
            { field: 'bonusReason' },
          );
        }
        if (bonusQty.gt(loadMaxBonusRemaining)) {
          bonusAnomaly = true;
          anomalyReasons.push(
            `تجاوز سقف البونص المتبقي لأمر التحميل (${loadMaxBonusRemaining.toFixed(2)} كجم)`,
          );
        }
        if (bonusQty.gt(customerMaxBonusKg)) {
          bonusAnomaly = true;
          anomalyReasons.push(
            `الكمية المجانية (${bonusQty.toFixed(2)} كجم) تتجاوز الحد المسموح للعميل في الفاتورة (${customerMaxBonusKg.toFixed(2)} كجم)`,
          );
        }
        if (bonusPctOfSale.gt(customerMaxBonusPct)) {
          bonusAnomaly = true;
          anomalyReasons.push(
            `نسبة البونص (${bonusPctOfSale.toFixed(1)}%) أعلى من النسبة المعتمدة (${customerMaxBonusPct.toFixed(1)}%)`,
          );
        }
        if (bonusAnomaly && !body.customerBonusConfirmed && !body.allowBonusOverride) {
          throw new DomainError(
            errorCodes.VALIDATION_FAILED,
            `تنبيه رقابة البونص المجاني: ${anomalyReasons.join(' · ')}. يُرجى إدخال رمز تأكيد استلام العميل للكمية المجانية أو اعتماد الإدارة.`,
            422,
            { field: 'bonusQty' },
          );
        }
      }

      // Tax & Invoice Mode Policy Guard (Phase 5 & Section 3: never assume tax exemption without approved policy)
      const invoiceMode =
        body.invoiceMode ??
        (customerRule &&
        str(customerRule.preferred_invoice_mode) === 'internal_delivery' &&
        policy.allowInternalDeliveryWithoutTax
          ? 'internal_delivery'
          : 'zatca_tax');

      if (invoiceMode === 'internal_delivery' && !policy.allowInternalDeliveryWithoutTax) {
        throw new DomainError(
          'VAN_SALES_INTERNAL_DELIVERY_POLICY_REQUIRED',
          'وضع إشعار التسليم الداخلي بدون ضريبة غير مفعل افتراضياً. يتطلب اعتماد السياسة الضريبية والمحاسبية في إعدادات المنشأة (van_sales.policy.allowInternalDeliveryWithoutTax) قبل الاستخدام.',
          422,
          { field: 'invoiceMode' },
        );
      }

      // Resolve VAT rate from item tax group or tenant default tax group
      let resolvedVatRate = itemTaxRate;
      if (resolvedVatRate === null) {
        const defaultTaxGroup = first(
          await tx.execute(sql`
            SELECT id::text, rate::text FROM tax_groups
            WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
            ORDER BY rate DESC
            LIMIT 1
          `),
        );
        if (defaultTaxGroup?.rate !== undefined && defaultTaxGroup?.rate !== null) {
          resolvedVatRate = dec(defaultTaxGroup.rate);
          if (!itemTaxGroupId && defaultTaxGroup.id) {
            itemTaxGroupId = str(defaultTaxGroup.id);
          }
        } else {
          resolvedVatRate = new Decimal('15');
        }
      }

      const subtotal = Decimal.max(0, grossBeforeDiscount.minus(discountAmount));
      const taxRate = invoiceMode === 'zatca_tax' ? resolvedVatRate : new Decimal('0');
      const taxTotal =
        invoiceMode === 'zatca_tax' ? subtotal.mul(taxRate.div(100)) : new Decimal('0');
      const grandTotal = subtotal.plus(taxTotal);
      const paymentMethod = body.paymentMethod ?? 'cash';
      const paidAmount = paymentMethod === 'credit' ? new Decimal('0') : grandTotal;
      const taxPolicyStatus =
        invoiceMode === 'zatca_tax' ? 'standard_vat' : 'pending_tax_policy';

      // Credit limit enforcement (checking both customerRule.credit_limit and parties.credit_limit)
      if (paymentMethod === 'credit' && partyId) {
        const partyRow = first(
          await tx.execute(sql`
            SELECT credit_limit::text FROM parties
            WHERE id = ${partyId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
            LIMIT 1
          `),
        );
        const creditLimit = customerRule
          ? dec(customerRule.credit_limit)
          : partyRow?.credit_limit
            ? dec(partyRow.credit_limit)
            : null;
        if (creditLimit && creditLimit.gt(0)) {
          const unpaidRow = first(
            await tx.execute(sql`
              SELECT COALESCE(SUM(total - paid_amount), 0)::text AS unpaid
              FROM van_sales_documents
              WHERE tenant_id = ${tenantId}::uuid AND party_id = ${partyId}::uuid AND deleted_at IS NULL
            `),
          );
          const currentDebt = dec(unpaidRow?.unpaid);
          if (
            currentDebt.plus(grandTotal).gt(creditLimit) &&
            !body.allowPriceDiscountOverride
          ) {
            throw new DomainError(
              errorCodes.VALIDATION_FAILED,
              `تجاوز الحد الائتماني للعميل: مديونية العميل بعد هذه الفاتورة (${currentDebt.plus(grandTotal).toFixed(2)} ريال) تتجاوز سقف الائتمان المسموح (${creditLimit.toFixed(2)} ريال).`,
              422,
              { field: 'paymentMethod' },
            );
          }
        }
      }

      // Cost & Net Profit calculation
      const batchRow = first(
        await tx.execute(sql`
          SELECT unit_cost::text FROM factory_production_batches
          WHERE tenant_id = ${tenantId}::uuid
            AND batch_no = ${str(loadOrder.production_batch_no)}
            AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      const unitCost = batchRow
        ? dec(batchRow.unit_cost)
        : dec(loadOrder.unit_cost).gt(0)
          ? dec(loadOrder.unit_cost)
          : new Decimal('0');
      const totalCogs = soldQty.plus(bonusQty).mul(unitCost);
      const netProfit = subtotal.minus(totalCogs);

      const resolvedBranchId = await this.resolveDefaultBranchIdInTx(
        tx,
        tenantId,
        loadOrder.branch_id ? str(loadOrder.branch_id) : null,
        loadOrder.van_warehouse_id
          ? str(loadOrder.van_warehouse_id)
          : loadOrder.warehouse_id
            ? str(loadOrder.warehouse_id)
            : null,
      );

      const prefix = invoiceMode === 'zatca_tax' ? 'VTX-' : 'VDL-';
      const allocated = await this.sequences.next(
        {
          tenantId,
          branchId: resolvedBranchId ?? undefined,
          docType: invoiceMode === 'zatca_tax' ? 'van_sales_tax_doc' : 'van_sales_delivery_doc',
        },
        tx,
        { prefix, padding: 5 },
      );
      const number = allocated.display;
      const docId = newId();

      // Official Sales Invoice creation (`sales_invoices` + `sales_invoice_lines`) via `SalesService.createInTx`
      let linkedSalesInvoiceId: string | null = null;
      let linkedSalesInvoiceNumber: string | null = null;
      if (resolvedBranchId && (partyId || body.customerName?.trim())) {
        const invoiceWarehouseId = loadOrder.van_warehouse_id
          ? str(loadOrder.van_warehouse_id)
          : loadOrder.warehouse_id
            ? str(loadOrder.warehouse_id)
            : undefined;
        const salesLines: SalesLineInput[] = [];
        if (soldQty.gt(0)) {
          salesLines.push({
            itemId: effectiveItemId ?? undefined,
            description: `مبيعات توزيع — دفعة ${str(loadOrder.production_batch_no)} (${number})`,
            quantity: soldQty.toFixed(4),
            unitPrice: resolvedUnitPrice.toFixed(4),
            discountAmount: discountAmount.toFixed(4),
            taxRate: taxRate.toFixed(4),
            taxGroupId: itemTaxGroupId,
            batchNo: itemTrackLot ? str(loadOrder.production_batch_no) : undefined,
            metadata: {
              isBonus: false,
              vanDocumentId: docId,
              vanDocumentNumber: number,
              loadOrderId,
              productionBatchNo: str(loadOrder.production_batch_no),
            },
          });
        }
        if (bonusQty.gt(0)) {
          salesLines.push({
            itemId: effectiveItemId ?? undefined,
            description: `بونص مجاني — ${body.bonusReason?.trim() || 'ترويجي'} (${number})`,
            quantity: bonusQty.toFixed(4),
            unitPrice: '0.0000',
            discountAmount: '0.0000',
            taxRate: '0.0000',
            batchNo: itemTrackLot ? str(loadOrder.production_batch_no) : undefined,
            metadata: {
              isBonus: true,
              bonusReason: body.bonusReason?.trim() || 'ترويجي',
              customerBonusConfirmed: Boolean(body.customerBonusConfirmed),
              customerConfirmationCode: body.customerConfirmationCode?.trim() || null,
              vanDocumentId: docId,
              vanDocumentNumber: number,
              loadOrderId,
              productionBatchNo: str(loadOrder.production_batch_no),
            },
          });
        }
        if (salesLines.length > 0) {
          linkedSalesInvoiceId = await this.sales.createInTx(tx, tenantId, {
            branchId: resolvedBranchId,
            warehouseId: invoiceWarehouseId,
            partyId: partyId ?? undefined,
            salesmanId: str(loadOrder.salesman_id),
            cashCustomerName: !partyId ? body.customerName?.trim() || 'عميل توزيع' : undefined,
            kind: 'sale',
            lines: salesLines,
          });

          /**
           * الترحيل الرسمي — one official path, not a parallel one.
           *
           * `SalesService.postInTx` is what numbers the invoice, relieves the van's
           * **official** stock balance (`recordAutoStock` reads the invoice's own lines and
           * warehouse), posts the revenue/VAT/COGS journal and, for a cash sale, writes the
           * `invoice_payments` row and `paid_total`. Doing the stock movement here as well
           * would double-count it, so the van flow never calls `recordInTx` for a sale it
           * hands to the sales engine.
           *
           * The bonus line travels on the same invoice at a zero price: it leaves stock and
           * lands in COGS without inflating revenue or output VAT — which is the only
           * treatment that keeps the free quantity visible on the document *and* honest in
           * the ledger.
           */
          const settlementMethod =
            paymentMethod === 'card' ? 'card' : paymentMethod === 'cash' ? 'cash' : 'credit';
          /**
           * الصندوق وحسابه — a cash sale debits the till's own account, and that account
           * must come from a real cash location (never from a guess). The rep's cash box is
           * the one named on the request; otherwise the branch's default safe.
           */
          const cashLocationRow =
            settlementMethod === 'credit'
              ? undefined
              : first(
                  await tx.execute(sql`
                    SELECT id::text, account_id::text FROM cash_locations
                    WHERE tenant_id = ${tenantId}::uuid
                      AND (${body.cashLocationId ?? null}::uuid IS NULL
                           OR id = ${body.cashLocationId ?? null}::uuid)
                      AND (${resolvedBranchId}::uuid IS NULL OR branch_id = ${resolvedBranchId}::uuid)
                      AND is_active = true AND deleted_at IS NULL
                    ORDER BY (id = ${body.cashLocationId ?? null}::uuid) DESC NULLS LAST,
                             is_default DESC NULLS LAST, created_at ASC
                    LIMIT 1
                  `),
                );
          const salesProfile = await this.resolvePostingProfileOrNullInTx(
            tx,
            tenantId,
            resolvedBranchId,
            'sales_invoice',
          );
          const settlementAccountId =
            settlementMethod === 'credit'
              ? undefined
              : (cashLocationRow?.account_id
                ? str(cashLocationRow.account_id)
                : (salesProfile?.[settlementMethod === 'card' ? 'bankAccountId' : 'cashAccountId'] ??
                  salesProfile?.cashAccountId ??
                  undefined));
          if (settlementMethod !== 'credit' && !settlementAccountId) {
            throw new DomainError(
              errorCodes.VALIDATION_FAILED,
              'بيع نقدي يتطلّب صندوقًا مرتبطًا بحساب محاسبي — أنشئ صندوقًا من شاشة مواقع النقد أو حدّد حساب النقد في ملف الترحيل',
              422,
              { field: 'cashLocationId' },
            );
          }
          const posted = await this.sales.postInTx(tx, tenantId, linkedSalesInvoiceId, {
            settlement: settlementMethod as 'cash' | 'card' | 'credit',
            settlementAccountId,
            settlementCashLocationId:
              settlementMethod === 'credit' || !cashLocationRow?.id
                ? undefined
                : str(cashLocationRow.id),
          });
          linkedSalesInvoiceNumber = posted?.number ? str(posted.number) : null;
        }
      }

      const companyProfile = first(
        await tx.execute(sql`
          SELECT name_ar, tax_no FROM company_profiles
          WHERE tenant_id = ${tenantId}::uuid
          LIMIT 1
        `),
      );
      const qrTlv = buildZatcaTlvBase64({
        sellerName: str(companyProfile?.name_ar) || 'مصنع ومخابز التوزيع',
        vatNumber: str(companyProfile?.tax_no) || '300000000000003',
        timestampIso: new Date().toISOString(),
        invoiceTotal: grandTotal.toFixed(2),
        vatTotal: taxTotal.toFixed(2),
      });

      await tx.execute(sql`
        INSERT INTO van_sales_documents (
          id, tenant_id, branch_id, number, load_order_id, salesman_id, party_id, customer_name,
          item_id, doc_mode, invoice_mode, tax_policy_status, payment_method, doc_date,
          batch_code, production_batch_no,
          sold_qty, bonus_qty, bonus_reason, unit_price, discount_amount, discount_reason,
          discount_approved_by, subtotal, tax_rate, tax_total, total, paid_amount,
          unit_cost, net_profit, qr_payload, zatca_qr_tlv, sales_invoice_id,
          customer_bonus_confirmed, customer_confirmation_code, bonus_anomaly, anomaly_reason,
          notes, idempotency_key, created_by
        ) VALUES (
          ${docId}::uuid, ${tenantId}::uuid, ${resolvedBranchId}::uuid, ${number}, ${loadOrderId}::uuid,
          ${str(loadOrder.salesman_id)}::uuid, ${partyId}::uuid,
          ${body.customerName?.trim() || null},
          ${effectiveItemId}::uuid,
          ${invoiceMode}, ${invoiceMode}, ${taxPolicyStatus}, ${paymentMethod}, CURRENT_DATE,
          ${str(loadOrder.production_batch_no)}, ${str(loadOrder.production_batch_no)},
          ${soldQty.toFixed(4)}::numeric, ${bonusQty.toFixed(4)}::numeric,
          ${body.bonusReason?.trim() || null},
          ${resolvedUnitPrice.toFixed(4)}::numeric,
          ${discountAmount.toFixed(4)}::numeric,
          ${body.discountReason?.trim() || null},
          ${body.allowPriceDiscountOverride ? userId : null}::uuid,
          ${subtotal.toFixed(4)}::numeric,
          ${taxRate.toFixed(2)}::numeric, ${taxTotal.toFixed(4)}::numeric,
          ${grandTotal.toFixed(4)}::numeric, ${paidAmount.toFixed(4)}::numeric,
          ${unitCost.toFixed(4)}::numeric, ${netProfit.toFixed(4)}::numeric,
          ${qrTlv}, ${qrTlv}, ${linkedSalesInvoiceId}::uuid,
          ${Boolean(body.customerBonusConfirmed)},
          ${body.customerConfirmationCode?.trim() || null},
          ${bonusAnomaly},
          ${anomalyReasons.length > 0 ? anomalyReasons.join(' · ') : null},
          ${body.notes?.trim() || null},
          ${idempotencyKey},
          ${userId}::uuid
        )
      `);

      const cashAdd = paymentMethod === 'cash' ? grandTotal : new Decimal('0');
      await tx.execute(sql`
        UPDATE van_load_orders
        SET sold_qty = sold_qty + ${soldQty.toFixed(4)}::numeric,
            bonus_qty = bonus_qty + ${bonusQty.toFixed(4)}::numeric,
            expected_cash = expected_cash + ${cashAdd.toFixed(4)}::numeric,
            status = 'in_route',
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
      `);

      /**
       * أثر الحركة الرسمية — the official `inventory_transactions` the sales engine wrote
       * when it posted the invoice, so the van audit trail points at the real ledger row
       * instead of only at itself.
       */
      const officialSaleTx = linkedSalesInvoiceId
        ? first(
            await tx.execute(sql`
              SELECT id::text FROM inventory_transactions
              WHERE tenant_id = ${tenantId}::uuid
                AND doc_type = 'sales_invoice'
                AND doc_id = ${linkedSalesInvoiceId}::uuid
              ORDER BY created_at ASC
              LIMIT 1
            `),
          )
        : undefined;
      const officialSaleTxId = officialSaleTx?.id ? str(officialSaleTx.id) : null;

      /**
       * أثر المخزون الرسمي على المستند نفسه — the van document points at the official
       * `inventory_transactions` row the sales engine wrote, so an auditor can go from the
       * printed rep document straight to the ledger movement that relieved the van warehouse.
       */
      if (officialSaleTxId) {
        await tx.execute(sql`
          UPDATE van_sales_documents
          SET inventory_tx_id = ${officialSaleTxId}::uuid
          WHERE id = ${docId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      }

      if (soldQty.gt(0)) {
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, party_id, item_id,
            inventory_transaction_id, qty, unit_price, amount, reason, idempotency_key, actor_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_sale', ${str(loadOrder.production_batch_no)},
            ${loadOrderId}::uuid, ${str(loadOrder.salesman_id)}::uuid, ${partyId}::uuid,
            ${effectiveItemId}::uuid, ${officialSaleTxId}::uuid,
            ${soldQty.toFixed(4)}::numeric, ${resolvedUnitPrice.toFixed(4)}::numeric,
            ${grandTotal.toFixed(4)}::numeric,
            ${`بيع للعميل بموجب الفاتورة الرسمية ${linkedSalesInvoiceNumber ?? number}`},
            ${idempotencyKey ? `sale-move:${idempotencyKey}` : null},
            ${userId}::uuid
          )
        `);
      }
      if (bonusQty.gt(0)) {
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, party_id, item_id,
            inventory_transaction_id, qty, unit_price, amount, reason, idempotency_key, actor_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_bonus', ${str(loadOrder.production_batch_no)},
            ${loadOrderId}::uuid, ${str(loadOrder.salesman_id)}::uuid, ${partyId}::uuid,
            ${effectiveItemId}::uuid, ${officialSaleTxId}::uuid,
            ${bonusQty.toFixed(4)}::numeric, 0, 0,
            ${`كمية مجانية / بونص (${body.bonusReason?.trim() || 'ترويجي'}) في الفاتورة ${linkedSalesInvoiceNumber ?? number} — صُرفت من المخزون بالتكلفة بلا إيراد ولا ضريبة مخرجات`},
            ${idempotencyKey ? `bonus-move:${idempotencyKey}` : null},
            ${userId}::uuid
          )
        `);
      }
    });

    return this.dashboard(tenantId);
  }

  private async resolveShortageUnitPriceInTx(
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
  async submitClosing(
    tenantId: string,
    userId: string,
    loadOrderId: string,
    body: {
      returnedQty?: string;
      damagedQty?: string;
      damageReason?: string;
      collectedCash?: string;
      /**
       * 🧮 المتبقي الفعلي في السيارة عند الجرد — the physical count the rep declares.
       * Everything the rep neither sold, returned nor damaged **and** cannot physically show
       * is the shortage carried into the accountant's review.
       */
      actualRemainingQty?: string;
      closingNotes?: string;
    },
  ) {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.loadTenantPolicyInTx(tx, tenantId);
      const loadOrder = first(
        await tx.execute(sql`
          SELECT l.*, COALESCE(s.name, 'مندوب') AS salesman_name
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!loadOrder) {
        throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      }
      if (str(loadOrder.status) === 'settled') {
        throw new DomainError(
          'VAN_LOAD_ORDER_ALREADY_SETTLED',
          'تم اعتماد وتصفية هذه الوردية مسبقاً',
          409,
        );
      }

      /**
       * 📦 أساس العهدة — custody is what the rep **confirmed receiving** (`received_qty`), not
       * what left the main warehouse. The difference between the two is still in transit until
       * the receipt step, and charging it to the rep would bill him for goods he never held.
       * Legacy orders created before the receipt workflow keep `loaded_qty` as their basis.
       */
      const received = dec(loadOrder.received_qty);
      const loaded = received.gt(0) ? received : dec(loadOrder.loaded_qty);
      const sold = dec(loadOrder.sold_qty);
      const bonus = dec(loadOrder.bonus_qty);
      const returnedQty = Decimal.max(0, dec(body.returnedQty ?? '0'));
      const damagedQty = Decimal.max(0, dec(body.damagedQty ?? '0'));
      const collectedCash = Decimal.max(0, dec(body.collectedCash ?? loadOrder.expected_cash));
      /**
       * 🧮 المتبقي الفعلي — when the rep does not declare a physical count, nothing is assumed
       * in his favour: the whole unaccounted remainder is treated as a shortage, exactly as
       * before. Declaring a count is what turns part of that remainder into stock still in the
       * van, and the accountant sees both numbers side by side.
       */
      const actualRemainingQty =
        body.actualRemainingQty === undefined || body.actualRemainingQty === null
          ? new Decimal('0')
          : Decimal.max(0, dec(body.actualRemainingQty));

      if (damagedQty.gt(0) && (!body.damageReason || !body.damageReason.trim())) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'عند تسجيل كمية تالفة يجب كتابة سبب التلف بوضوح لإحالته للفحص الفعلي من المحاسب وأمين المستودع',
          422,
          { field: 'damageReason' },
        );
      }

      const accountedQty = sold.plus(bonus).plus(returnedQty).plus(damagedQty);
      if (accountedQty.plus(actualRemainingQty).gt(loaded)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `مجموع الكميات (المباع ${sold.toFixed(2)} + البونص ${bonus.toFixed(2)} + المرتجع السليم ${returnedQty.toFixed(2)} + التالف ${damagedQty.toFixed(2)} + المتبقي الفعلي ${actualRemainingQty.toFixed(2)} = ${accountedQty.plus(actualRemainingQty).toFixed(2)} كجم) يتجاوز العهدة المستلمة أصلاً (${loaded.toFixed(2)} كجم). إن كانت الكمية الزائدة موجودة فعلاً في السيارة فأبلغ المحاسب: تسجيل الفائض يتم عند الاعتماد بإقرار صريح، لا من حساب المندوب.`,
          422,
          { field: 'actualRemainingQty' },
        );
      }

      /** المتوقع مقابل الفعلي — the expected remainder is what the documents say must still be
       * in the van; the shortage is only what the physical count cannot show. */
      const expectedRemaining = loaded.minus(accountedQty);
      const shortageQty = Decimal.max(0, expectedRemaining.minus(actualRemainingQty));
      const unitChargePrice = await this.resolveShortageUnitPriceInTx(
        tx,
        tenantId,
        loadOrder,
        policy,
      );
      const shortageValue = shortageQty.mul(unitChargePrice);
      const shortagePolicyStatus =
        policy.shortageValuationBasis && policy.shortageValuationBasis !== 'unconfigured'
          ? 'policy_configured'
          : 'pending_policy_approval';

      await tx.execute(sql`
        UPDATE van_load_orders
        SET status = 'pending_closing',
            returned_qty = ${returnedQty.toFixed(4)}::numeric,
            damaged_qty = ${damagedQty.toFixed(4)}::numeric,
            actual_remaining_qty = ${actualRemainingQty.toFixed(4)}::numeric,
            shortage_qty = ${shortageQty.toFixed(4)}::numeric,
            shortage_value = ${shortageValue.toFixed(4)}::numeric,
            shortage_policy_status = ${shortagePolicyStatus},
            collected_cash = ${collectedCash.toFixed(4)}::numeric,
            damage_reason = ${body.damageReason?.trim() || null},
            closing_notes = ${body.closingNotes?.trim() || null},
            closing_submitted_at = now(),
            closing_submitted_by = ${userId}::uuid,
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
      `);

      const recipients = rows(
        await tx.execute(sql`
          SELECT id::text AS membership_id
          FROM memberships
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND status = 'active'
          LIMIT 10
        `),
      );
      const title = `🚚 طلب اعتماد إغلاق وردية المندوب (${str(loadOrder.salesman_name)}) — ${str(loadOrder.number)}`;
      const msgBody = `المستلم: ${loaded.toFixed(1)} كجم | المباع: ${sold.toFixed(1)} كجم | البونص: ${bonus.toFixed(1)} كجم | المرتجع السليم: ${returnedQty.toFixed(1)} كجم | تالف للفحص: ${damagedQty.toFixed(1)} كجم | المتوقع متبقياً: ${expectedRemaining.toFixed(1)} كجم | الفعلي بالجرد: ${actualRemainingQty.toFixed(1)} كجم | عجز على المندوب: ${shortageQty.toFixed(1)} كجم (${shortageValue.toFixed(2)} ريال). بانتظار اعتماد المحاسب.`;
      for (const r of recipients) {
        await this.notifications.createInTx(tx, {
          tenantId,
          membershipId: str(r.membership_id),
          type: 'van_sales_closing_request',
          payload: { title, body: msgBody, href: '/van-sales?tab=loads' },
        });
      }
    });

    return this.dashboard(tenantId);
  }

  /**
   * Pillar 2 (Stage 2 — Phase 2, 3, 4) & Pillar 7: Accountant inspects damaged goods,
   * enforces idempotency and segregation of duties, records official inventory movements,
   * and zeroes out rep custody (`0.00 kg`).
   */
  async approveClosing(
    tenantId: string,
    userId: string,
    loadOrderId: string,
    body: {
      returnedQty?: string;
      damagedQty?: string;
      collectedCash?: string;
      damageInspected?: boolean;
      salaryDeductionApproved?: boolean;
      selfApprovalOverride?: boolean;
      notes?: string;
      /** 🧮 تصحيح المحاسب للجرد الفعلي بعد العدّ بنفسه (اختياري — وإلا يؤخذ جرد المندوب). */
      actualRemainingQty?: string;
      /**
       * ما يُفعل بالكمية التي عادت مع المندوب: `return_to_main` إرجاع رسمي للمستودع الرئيسي،
       * أو `carry_over` بقاءها عهدةً للوردية التالية. **إلزامي** عند وجود متبقٍ فعلي.
       */
      remainingAction?: string;
      /**
       * 🖋️ تفويض صريح بترحيل تسوية الجرد الرسمية. بدونه يُنشأ مستند الجرد الرسمي
       * **مسودةً** ولا يُرحَّل شيء، وتبقى العهدة `pending_stock_settlement`.
       */
      settleStockAdjustment?: boolean;
      /**
       * ⚖️ إقرار صريح بأن الجرد الفعلي **أكبر** من العهدة المستلمة (فائض). بدون هذا الإقرار
       * يُرفض الرقم حمايةً من خطأ الإدخال؛ وبعد الإقرار يُسجَّل الفائض في مستند الجرد الرسمي
       * نفسه — لا عجزاً، ولا إيراداً، ولا هديةً.
       */
      surplusAcknowledged?: boolean;
    },
  ) {
    const phase1 = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.loadTenantPolicyInTx(tx, tenantId);
      const loadOrder = first(
        await tx.execute(sql`
          SELECT l.*, COALESCE(s.name, 'مندوب') AS salesman_name
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!loadOrder) {
        throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      }

      // Phase 3 Idempotency Guard: never allow settling an already settled load order
      if (['settled', 'reconciled'].includes(str(loadOrder.status))) {
        throw new DomainError(
          'VAN_LOAD_ORDER_ALREADY_SETTLED',
          'تم اعتماد وتصفية أمر التحميل هذا مسبقاً ولا يمكن إعادة ترحيله',
          409,
        );
      }
      /**
       * ♻️ استكمال لا إعادة — an approval whose quantities were already applied but whose stock
       * reconciliation is still open comes back here to be **completed**, not repeated: the
       * return/damage movements, the damage journal and the closing movement rows are all skipped
       * on resume, so a retry can never move a kilogram or post a line twice.
       */
      const isResume = str(loadOrder.status) === 'pending_stock_settlement';

      // Phase 4 Segregation of Duties Guard: prevent non-owner self-approval or when policy enforces strict separation
      if (
        loadOrder.closing_submitted_by &&
        str(loadOrder.closing_submitted_by) === userId &&
        !body.selfApprovalOverride
      ) {
        const membershipRow = first(
          await tx.execute(sql`
            SELECT is_owner FROM memberships
            WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
            LIMIT 1
          `),
        );
        const isOwner = Boolean(membershipRow?.is_owner);
        if (policy.preventSelfApproval || !isOwner) {
          throw new DomainError(
            'SELF_APPROVAL_FORBIDDEN',
            'منع الاعتماد الذاتي: لا يجوز لنفس مدخل طلب إغلاق العهدة اعتماد تسويته مالياً؛ يجب اعتماده من المحاسب أو مدير المستودع.',
            403,
          );
        }
      }

      /**
       * 📦 أساس العهدة — the accountant settles what the rep actually received, exactly like
       * the submission step, so approving a closing can never re-open the transit difference.
       */
      const received = dec(loadOrder.received_qty);
      const loaded = received.gt(0) ? received : dec(loadOrder.loaded_qty);
      const sold = dec(loadOrder.sold_qty);
      const bonus = dec(loadOrder.bonus_qty);
      /** 🧮 المتبقي الفعلي الذي أعلنه المندوب عند الجرد — stored by `submitClosing`, and the
       * accountant may replace it with his own count (he is the one authorising the settlement). */
      const actualRemainingQty =
        body.actualRemainingQty !== undefined && String(body.actualRemainingQty).trim() !== ''
          ? Decimal.max(0, dec(body.actualRemainingQty))
          : Decimal.max(0, dec(loadOrder.actual_remaining_qty));
      const returnedQty =
        body.returnedQty !== undefined
          ? Decimal.max(0, dec(body.returnedQty))
          : dec(loadOrder.returned_qty);
      const damagedQty =
        body.damagedQty !== undefined
          ? Decimal.max(0, dec(body.damagedQty))
          : dec(loadOrder.damaged_qty);
      const collectedCash =
        body.collectedCash !== undefined
          ? Decimal.max(0, dec(body.collectedCash))
          : dec(loadOrder.collected_cash);

      // Phase 4: Never assume damage is inspected without explicit confirmation when damagedQty > 0
      if (damagedQty.gt(0) && body.damageInspected !== true) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'لا يمكن اعتماد إغلاق الوردية بوجود كميات تالفة دون تأكيد الفحص الفعلي للتالف (damageInspected: true) من المحاسب أو أمين المستودع',
          422,
          { field: 'damageInspected' },
        );
      }

      const accountedQty = sold.plus(bonus).plus(returnedQty).plus(damagedQty);
      /**
       * ⚖️ الفائض عن العهدة — a physical count larger than the custody is a **fact** the
       * accountant has to be able to record: refusing it leaves kilograms that exist nowhere in
       * the ledger, and the van balance can then never be reconciled with what is in the van.
       * The rep's own submission still refuses it (that is where a typo belongs), and here it is
       * accepted only on an explicit acknowledgement, which is written to the audit trail. It is
       * never turned into revenue, a bonus or a shortage: it goes into the same official count
       * document and is valued by the inventory engine on the tenant's own accounts.
       */
      const countedTotal = accountedQty.plus(actualRemainingQty);
      if (countedTotal.gt(loaded)) {
        if (body.surplusAcknowledged !== true) {
          throw new DomainError(
            'VAN_CLOSING_SURPLUS_ACK_REQUIRED',
            `الجرد الفعلي (${actualRemainingQty.toFixed(2)} كجم) أكبر من المتبقي حسب المستندات (${loaded
              .minus(accountedQty)
              .toFixed(2)} كجم) بفائض ${countedTotal.minus(loaded).toFixed(2)} كجم — أكد الإقرار بالفائض (surplusAcknowledged) ليُسجَّل في مستند الجرد الرسمي`,
            422,
            {
              field: 'surplusAcknowledged',
              surplusQty: countedTotal.minus(loaded).toFixed(4),
            },
          );
        }
      }

      /** المتوقع مقابل الفعلي — the same arithmetic the rep saw when he submitted. */
      const expectedRemaining = loaded.minus(accountedQty);
      const shortageQty = Decimal.max(0, expectedRemaining.minus(actualRemainingQty));
      const surplusQty = Decimal.max(0, actualRemainingQty.minus(expectedRemaining));
      /** موجب = عجز، سالب = فائض — the signed difference between book and physical count. */
      const countVariance = expectedRemaining.minus(actualRemainingQty);

      /**
       * ما يُفعل بالمتبقي الفعلي — a decision, not a default. Leaving kilograms in the van while
       * the custody is declared closed is how a van balance stops matching reality, so the
       * accountant must say whether they go back to the main warehouse or stay as the rep's
       * opening custody for the next shift.
       */
      const remainingAction =
        body.remainingAction !== undefined && String(body.remainingAction).trim() !== ''
          ? String(body.remainingAction).trim()
          : loadOrder.remaining_action
            ? str(loadOrder.remaining_action)
            : null;
      if (
        actualRemainingQty.gt(0) &&
        remainingAction !== 'return_to_main' &&
        remainingAction !== 'carry_over'
      ) {
        throw new DomainError(
          'VAN_CLOSING_REMAINING_ACTION_REQUIRED',
          `يوجد متبقٍ فعلي بالجرد (${actualRemainingQty.toFixed(2)} كجم) في سيارة المندوب: حدّد مصيره صراحةً — ` +
            '`return_to_main` لإرجاعه رسمياً إلى المستودع الرئيسي، أو `carry_over` لإبقائه عهدةً للوردية التالية. ' +
            'لا تُغلق العهدة مع بقاء كمية بلا قرار.',
          422,
          { field: 'remainingAction' },
        );
      }
      /**
       * 🔒 شرط مطابقة المخزون — the custody may not be declared closed while the official van
       * balance still disagrees with the count, or while counted kilograms have no destination.
       * Both are settled through the official inventory engine in the second phase.
       */
      const needsCountSettlement = !countVariance.isZero();
      const needsRemainingMove = actualRemainingQty.gt(0) && remainingAction === 'return_to_main';
      const requiresStockSettlement = needsCountSettlement || needsRemainingMove;

      const unitChargePrice = await this.resolveShortageUnitPriceInTx(
        tx,
        tenantId,
        loadOrder,
        policy,
      );
      const shortageValue = shortageQty.mul(unitChargePrice);
      const damageInspected = damagedQty.gt(0) ? body.damageInspected === true : false;
      // Phase 4: Never assume salary deduction is approved unless explicitly passed as true
      const salaryDeductionApproved =
        shortageQty.gt(0) ? body.salaryDeductionApproved === true : false;
      const shortagePolicyStatus =
        policy.shortageValuationBasis && policy.shortageValuationBasis !== 'unconfigured'
          ? 'policy_configured'
          : 'pending_policy_approval';

      const warehouseId = loadOrder.warehouse_id ? str(loadOrder.warehouse_id) : null;
      const vanWarehouseId = loadOrder.van_warehouse_id ? str(loadOrder.van_warehouse_id) : null;
      const itemId = loadOrder.item_id ? str(loadOrder.item_id) : null;
      const batchUnitCost = dec(loadOrder.unit_cost).gt(0)
        ? dec(loadOrder.unit_cost)
        : new Decimal('0');

      let returnInventoryTxId: string | null = null;
      let damageInventoryTxId: string | null = null;
      /** قيمة التلف كما قيّدها دفتر المخزون الرسمي نفسه، لا كما تُقدَّر هنا. */
      let damageValue = new Decimal('0');
      let damageJournalEntryId: string | null = loadOrder.damage_journal_entry_id
        ? str(loadOrder.damage_journal_entry_id)
        : null;
      let damagePostingStatus: 'posted' | 'pending_posting_profile' = damageJournalEntryId
        ? 'posted'
        : 'pending_posting_profile';

      /**
       * 🏷️ الدفعة — للأصناف المتتبَّعة بالدفعات تُنسَب كل حركة إغلاق (مرتجع سليم، تالف،
       * متبقٍ يُعاد، وفرق جرد) إلى دفعتها. لا تُختار دفعة بديلة عشوائياً ولا يُتجاوز التحقق
       * لإمرار الحركة: إن لم توجد دفعة صالحة تُرفض العملية برسالة تُسمّي ما يلزم إصلاحه،
       * لأن حركة بلا دفعة على صنفٍ متتبَّع تُفقد تتبّع الصلاحية إلى الأبد.
       */
      let countLotId: string | null = null;
      if (itemId && (returnedQty.gt(0) || damagedQty.gt(0) || requiresStockSettlement)) {
        const lot = await this.resolveCountLotInTx(tx, tenantId, {
          itemId,
          productionBatchNo: loadOrder.production_batch_no
            ? str(loadOrder.production_batch_no)
            : null,
          vanWarehouseId: vanWarehouseId ?? '',
        });
        if (lot.tracked && !lot.lotId) {
          throw new DomainError(
            'VAN_LOT_REQUIRED_FOR_CLOSING',
            `الصنف يُتتبَّع بالدفعات ولا توجد دفعة صالحة لرصيد السيارة (دفعة الإنتاج: ${str(
              loadOrder.production_batch_no || 'غير محددة',
            )}) — لا تُرحَّل حركة إغلاق (مرتجع/تالف/متبقٍ/جرد) بلا دفعة. صحّح ربط الدفعة بالإنتاج ثم أعد الاعتماد.`,
            422,
            { field: 'productionBatchNo' },
          );
        }
        countLotId = lot.tracked ? lot.lotId : null;
      }

      // Official inventory movements for returned good stock & inspected damaged stock.
      // `!isResume`: a completing call must never move these kilograms a second time.
      if (!isResume && returnedQty.gt(0) && warehouseId && itemId) {
        if (vanWarehouseId && vanWarehouseId !== warehouseId) {
          const retMoves = await this.inventory.recordInTx(
            tx,
            tenantId,
            [
              {
                itemId,
                warehouseId: vanWarehouseId,
                qty: returnedQty.toFixed(4),
                unitCost: batchUnitCost.toFixed(4),
                direction: 'out',
                docType: 'van_return',
                docId: loadOrderId,
                lineId: newId(),
                lotId: countLotId ?? undefined,
              },
              {
                itemId,
                warehouseId,
                qty: returnedQty.toFixed(4),
                unitCost: batchUnitCost.toFixed(4),
                direction: 'in',
                docType: 'van_return',
                docId: loadOrderId,
                lineId: newId(),
                lotId: countLotId ?? undefined,
              },
            ],
            { allowNegative: true },
          );
          returnInventoryTxId = retMoves.transactionIds[1] ?? retMoves.transactionIds[0] ?? null;
        } else {
          const retMoves = await this.inventory.recordInTx(tx, tenantId, [
            {
              itemId,
              warehouseId,
              qty: returnedQty.toFixed(4),
              unitCost: batchUnitCost.toFixed(4),
              direction: 'in',
              docType: 'van_return',
              docId: loadOrderId,
              lineId: newId(),
              lotId: countLotId ?? undefined,
            },
          ]);
          returnInventoryTxId = retMoves.transactionIds[0] ?? null;
        }
      }

      if (!isResume && damagedQty.gt(0) && vanWarehouseId && itemId) {
        const dmgMoves = await this.inventory.recordInTx(
          tx,
          tenantId,
          [
            {
              itemId,
              warehouseId: vanWarehouseId,
              qty: damagedQty.toFixed(4),
              unitCost: batchUnitCost.toFixed(4),
              direction: 'out',
              docType: 'van_damage_writeoff',
              docId: loadOrderId,
              lineId: newId(),
              lotId: countLotId ?? undefined,
            },
          ],
          { allowNegative: true },
        );
        damageInventoryTxId = dmgMoves.transactionIds[0] ?? null;

        /**
         * 📒 القيد الرسمي للتلف — taking the damaged kilograms out of the van without a journal
         * would leave the inventory account holding stock that no longer exists, so the write-off
         * is completed with the same balanced entry `InventoryService.postVoucher` writes for a
         * `stock_out` voucher: Dr تسوية المخزون / Cr المخزون. Both accounts come from the
         * tenant's own `stock_voucher` posting profile and are never invented here; when the
         * tenant has not mapped them yet the stock leg still happens (the goods really are gone)
         * and the financial leg is reported as pending instead of being silently skipped.
         */
        const damageTxRow = damageInventoryTxId
          ? first(
              await tx.execute(sql`
                SELECT total_cost::text FROM inventory_transactions
                WHERE id = ${damageInventoryTxId}::uuid AND tenant_id = ${tenantId}::uuid
                LIMIT 1
              `),
            )
          : undefined;
        damageValue = damageTxRow ? dec(damageTxRow.total_cost) : damagedQty.mul(batchUnitCost);
        const damageBranchId = await this.resolveDefaultBranchIdInTx(
          tx,
          tenantId,
          loadOrder.branch_id ? str(loadOrder.branch_id) : null,
          warehouseId,
        );
        const stockProfile = damageBranchId
          ? await this.resolvePostingProfileOrNullInTx(tx, tenantId, damageBranchId, 'stock_voucher')
          : null;
        const inventoryAccountId = stockProfile?.inventoryAccountId ?? null;
        const adjustmentAccountId = stockProfile?.inventoryAdjustmentAccountId ?? null;
        if (damageValue.gt(0) && damageBranchId && inventoryAccountId && adjustmentAccountId) {
          const today = new Date().toISOString().slice(0, 10);
          const fiscalPeriodId = await this.accounting.openPeriodForDateInTx(tx, tenantId, today);
          const damageEntry = await this.accounting.postJournalInTx(tx, tenantId, {
            branchId: damageBranchId,
            fiscalPeriodId,
            date: today,
            description: `إثبات تلف معتمد بعد الفحص الفعلي — ${str(loadOrder.number)}`,
            lines: [
              {
                accountId: adjustmentAccountId,
                debit: damageValue.toFixed(4),
                description: 'بضاعة تالفة معتمدة من إغلاق وردية مندوب',
              },
              {
                accountId: inventoryAccountId,
                credit: damageValue.toFixed(4),
                description: 'إخراج التالف من مخزون سيارة المندوب',
              },
            ],
            sourceType: 'van_load_order',
            sourceId: loadOrderId,
            idempotencyKey: `van-damage-writeoff:${loadOrderId}`,
          });
          damageJournalEntryId = damageEntry?.id ? str(damageEntry.id) : null;
          damagePostingStatus = 'posted';
        }
      }

      await tx.execute(sql`
        UPDATE van_load_orders
        SET status = ${requiresStockSettlement ? 'pending_stock_settlement' : 'settled'},
            returned_qty = ${returnedQty.toFixed(4)}::numeric,
            damaged_qty = ${damagedQty.toFixed(4)}::numeric,
            actual_remaining_qty = ${actualRemainingQty.toFixed(4)}::numeric,
            return_inventory_tx_id = COALESCE(${returnInventoryTxId}::uuid, return_inventory_tx_id),
            shortage_qty = ${shortageQty.toFixed(4)}::numeric,
            shortage_value = ${shortageValue.toFixed(4)}::numeric,
            shortage_policy_status = ${shortagePolicyStatus},
            collected_cash = ${collectedCash.toFixed(4)}::numeric,
            damage_inspected = ${damageInspected},
            damage_inspected_by = ${damageInspected ? userId : null}::uuid,
            damage_journal_entry_id = COALESCE(${damageJournalEntryId}::uuid, damage_journal_entry_id),
            salary_deduction_approved = ${salaryDeductionApproved},
            remaining_action = COALESCE(${remainingAction}::text, remaining_action),
            stock_settlement_status = ${
              requiresStockSettlement ? 'pending_count_decision' : 'not_required'
            },
            stock_settlement_note = ${
              requiresStockSettlement
                ? `فرق الجرد ${countVariance.toFixed(2)} كجم (المتوقع ${expectedRemaining.toFixed(2)} / الفعلي ${actualRemainingQty.toFixed(2)})${
                    surplusQty.gt(0)
                      ? ` — منه فائض ${surplusQty.toFixed(2)} كجم عن المستندات بإقرار صريح من المعتمد`
                      : ''
                  }${
                    needsRemainingMove
                      ? ` + متبقٍ فعلي ${actualRemainingQty.toFixed(2)} كجم مطلوب إرجاعه للمستودع الرئيسي`
                      : ''
                  } — لا تُغلق العهدة قبل تسويته مخزنياً`
                : null
            },
            approved_at = COALESCE(approved_at, now()),
            approved_by = ${userId}::uuid,
            settled_at = ${requiresStockSettlement ? null : new Date()}::timestamptz,
            notes = COALESCE(${body.notes?.trim() || null}, notes),
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
      `);

      if (!isResume) await tx.execute(sql`
        UPDATE factory_production_batches
        SET returned_good_qty = returned_good_qty + ${returnedQty.toFixed(4)}::numeric,
            damaged_qty = damaged_qty + ${damagedQty.toFixed(4)}::numeric,
            updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid
          AND batch_no = ${str(loadOrder.production_batch_no)}
          AND deleted_at IS NULL
      `);

      if (!isResume && returnedQty.gt(0)) {
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
            inventory_transaction_id, qty, unit_price, amount, reason, idempotency_key,
            actor_user_id, approved_by_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_return', ${str(loadOrder.production_batch_no)},
            ${loadOrderId}::uuid, ${str(loadOrder.salesman_id)}::uuid, ${itemId}::uuid,
            ${returnInventoryTxId}::uuid,
            ${returnedQty.toFixed(4)}::numeric, 0, 0,
            ${`إرجاع بضاعة سليمة للمستودع الرئيسي عند إغلاق الوردية ${str(loadOrder.number)}`},
            ${`closing-return:${loadOrderId}`},
            ${userId}::uuid, ${userId}::uuid
          )
        `);
      }
      if (!isResume && damagedQty.gt(0)) {
        const batchRow = first(
          await tx.execute(sql`
            SELECT unit_cost::text FROM factory_production_batches
            WHERE tenant_id = ${tenantId}::uuid
              AND batch_no = ${str(loadOrder.production_batch_no)}
              AND deleted_at IS NULL
            LIMIT 1
          `),
        );
        const damageUnitCost = batchRow ? dec(batchRow.unit_cost) : batchUnitCost;
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
            inventory_transaction_id, qty, unit_price, amount, reason, idempotency_key,
            actor_user_id, approved_by_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_damage', ${str(loadOrder.production_batch_no)},
            ${loadOrderId}::uuid, ${str(loadOrder.salesman_id)}::uuid, ${itemId}::uuid,
            ${damageInventoryTxId}::uuid,
            ${damagedQty.toFixed(4)}::numeric,
            ${damageUnitCost.toFixed(4)}::numeric,
            ${damageValue.toFixed(4)}::numeric,
            ${`بضاعة تالفة تم فحصها فعلياً واعتمادها (${str(loadOrder.damage_reason) || 'تلف نقل'}) — ${str(loadOrder.number)}`},
            ${`closing-damage:${loadOrderId}`},
            ${userId}::uuid, ${userId}::uuid
          )
        `);
      }
      if (!isResume && shortageQty.gt(0)) {
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, item_id,
            qty, unit_price, amount, reason, idempotency_key, actor_user_id, approved_by_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_shortage', ${str(loadOrder.production_batch_no)},
            ${loadOrderId}::uuid, ${str(loadOrder.salesman_id)}::uuid, ${itemId}::uuid,
            ${shortageQty.toFixed(4)}::numeric,
            ${unitChargePrice.toFixed(4)}::numeric,
            ${shortageValue.toFixed(4)}::numeric,
            ${`عجز عهدة محسوب على المندوب (${shortageQty.toFixed(2)} كجم = ${shortageValue.toFixed(2)} ريال) — ${str(loadOrder.number)}`},
            ${`closing-shortage:${loadOrderId}`},
            ${userId}::uuid, ${userId}::uuid
          )
        `);
      }

      const recipients = rows(
        await tx.execute(sql`
          SELECT id::text AS membership_id
          FROM memberships
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND status = 'active'
          LIMIT 10
        `),
      );
      const title = requiresStockSettlement
        ? `⏳ اعتُمدت كميات وردية (${str(loadOrder.salesman_name)}) — العهدة بانتظار تسوية المخزون`
        : `✅ تم اعتماد إغلاق وردية المندوب (${str(loadOrder.salesman_name)}) وتصفير العهدة`;
      const msgBody = `أمر التحميل ${str(loadOrder.number)}: العهدة ${loaded.toFixed(1)} كجم | المباع ${sold.toFixed(1)} | البونص ${bonus.toFixed(1)} | المرتجع ${returnedQty.toFixed(1)} | التالف ${damagedQty.toFixed(1)} | المتوقع ${expectedRemaining.toFixed(1)} مقابل الفعلي ${actualRemainingQty.toFixed(1)} كجم.${
        damagedQty.gt(0)
          ? damagePostingStatus === 'posted'
            ? ` رُحِّل قيد التلف الرسمي بقيمة ${damageValue.toFixed(2)} ريال (Dr تسوية المخزون / Cr المخزون).`
            : ` ⚠️ قيد التلف المالي معلّق: لم يُحدَّد حساب تسوية المخزون أو حساب المخزون في ملف ترحيل stock_voucher، فأُخرجت الكمية من الرصيد الرسمي دون قيد — يلزم تهيئة الحسابين ثم إعادة الترحيل.`
          : ''
      }${
        shortageQty.gt(0)
          ? ` عجز ${shortageQty.toFixed(1)} كجم (${shortageValue.toFixed(2)} ريال) بحالة ${shortagePolicyStatus} — لا يُرحَّل مالياً على المندوب قبل اعتماد سياسة التقييم والحساب المقابل.`
          : ''
      }${
        requiresStockSettlement
          ? ` ⚠️ لم تُغلق العهدة بعد: رصيد السيارة الرسمي يختلف عن الجرد الفعلي بمقدار ${countVariance.abs().toFixed(2)} كجم${
              needsRemainingMove
                ? `، ويلزم إرجاع ${actualRemainingQty.toFixed(2)} كجم إلى المستودع الرئيسي`
                : ''
            }. التسوية تتم بمستند جرد رسمي يحتاج تفويضاً صريحاً بترحيله.`
          : ''
      }`;
      for (const r of recipients) {
        await this.notifications.createInTx(tx, {
          tenantId,
          membershipId: str(r.membership_id),
          type: 'van_sales_closing_approved',
          payload: { title, body: msgBody, href: '/van-sales?tab=loads' },
        });
      }

      return {
        number: str(loadOrder.number),
        salesmanName: str(loadOrder.salesman_name),
        branchId: await this.resolveDefaultBranchIdInTx(
          tx,
          tenantId,
          loadOrder.branch_id ? str(loadOrder.branch_id) : null,
          vanWarehouseId ?? warehouseId,
        ),
        itemId,
        warehouseId,
        vanWarehouseId,
        productionBatchNo: str(loadOrder.production_batch_no),
        countedRemaining: actualRemainingQty,
        expectedRemaining,
        countVariance,
        remainingAction,
        needsCountSettlement,
        needsRemainingMove,
        requiresStockSettlement,
        countLotId,
        stockAdjustmentId: loadOrder.stock_adjustment_id ? str(loadOrder.stock_adjustment_id) : null,
        remainingInventoryTxId: loadOrder.remaining_inventory_tx_id
          ? str(loadOrder.remaining_inventory_tx_id)
          : null,
      };
    });

    /**
     * المرحلة الثانية — التسوية المخزنية الرسمية. تُنفَّذ خارج معاملة الكميات لأن محرّك الجرد
     * الرسمي (`createAdjustment` / `postAdjustment`) يفتح معاملاته الخاصة، وتُستأنَف بأمان عند
     * الفشل: كل خطوة فيها محميّة بما يُثبت أنها لم تُنفَّذ من قبل.
     */
    if (phase1.requiresStockSettlement) {
      await this.runStockSettlement(tenantId, userId, loadOrderId, phase1, {
        settleStockAdjustment: body.settleStockAdjustment === true,
      });
    }

    return this.dashboard(tenantId);
  }

  /**
   * 🧾 تسوية المخزون الرسمية لإغلاق الوردية — the four things a closing must keep separate:
   *
   * | # | ما يُحسم هنا | الأداة الرسمية |
   * |---|--------------|----------------|
   * | 1 | **الكمية في المخزون** — رصيد السيارة الرسمي يصير مساوياً للجرد الفعلي | `InventoryService.createAdjustment` + `postAdjustment` (جرد وتسوية رسمية) |
   * | 2 | **إثبات العجز وقيمته** | `stock_adjustment_lines.variance_qty/variance_value` + `van_load_orders.shortage_qty/shortage_value` |
   * | 3 | **من يتحمّل القيمة** | **لا يُحسم هنا**: الحساب المقابل هو `inventoryAdjustmentAccountId` من ملف ترحيل المستأجر (حساب فروقات الجرد القائم)، ولا يُمسّ راتب المندوب ولا ذمته |
   * | 4 | **الاعتماد** | `postAdjustment(approved: true)` لا يُنفَّذ إلا بتفويض صريح من حامل `van_sales.closing.approve` |
   *
   * Without that explicit authorisation the official count document is created as a **draft** —
   * visible on the stocktake screen — and the custody stays `pending_stock_settlement`, so the
   * system never declares a day closed while the stock ledger disagrees with the shelf.
   */
  /**
   * 🧊 تجميد سيارةٍ قيد التسوية — while a load order sits in `pending_stock_settlement`, the
   * official van balance is *the number the count document is about to settle against*. Any
   * movement in that window (توريد جديد، تأكيد استلام، بيع من وردية أخرى على السيارة نفسها)
   * would be absorbed into the variance silently: the count would "settle" a difference that
   * is not the one the accountant approved.
   *
   * So the movement is refused, not warned about — a procedural note is not a control. The
   * refusal names the order that is being settled and what to do (complete or cancel its
   * settlement first). `exceptLoadOrderId` lets the settling order's own steps through.
   */
  private async assertVanWarehouseNotSettlingInTx(
    tx: DrizzleTx,
    tenantId: string,
    input: { vanWarehouseId: string | null; itemId: string | null; exceptLoadOrderId?: string | null },
  ): Promise<void> {
    if (!input.vanWarehouseId) return;
    const settling = first(
      await tx.execute(sql`
        SELECT number, stock_settlement_status, stock_settlement_note
        FROM van_load_orders
        WHERE tenant_id = ${tenantId}::uuid
          AND van_warehouse_id = ${input.vanWarehouseId}::uuid
          AND status = 'pending_stock_settlement'
          AND deleted_at IS NULL
          ${input.itemId ? sql`AND item_id = ${input.itemId}::uuid` : sql``}
          ${input.exceptLoadOrderId ? sql`AND id <> ${input.exceptLoadOrderId}::uuid` : sql``}
        ORDER BY load_date DESC
        LIMIT 1
      `),
    );
    if (!settling) return;
    throw new DomainError(
      'VAN_WAREHOUSE_UNDER_SETTLEMENT',
      `سيارة التوزيع قيد تسوية جرد (أمر ${str(settling.number)}) — لا يمكن تحريك مخزونها قبل إتمام التسوية أو إلغائها، ` +
        'وإلا امتصّ مستند الجرد حركةً لم يعتمدها المحاسب. أكمل التسوية من «استكمال تسوية المخزون» ثم أعد العملية.',
      409,
      { field: 'vanWarehouseId', settlingOrderNumber: str(settling.number) },
    );
  }

  /**
   * 🏷️ دفعة مستند الجرد — resolved from what exists, in the order the official engine can
   * verify it: the lot the production batch carries, a lot registered under the batch number,
   * then the lot of the last movement that actually entered the van warehouse. Returns
   * `tracked` so the caller can tell "no lot needed" from "lot needed but missing".
   */
  private async resolveCountLotInTx(
    tx: DrizzleTx,
    tenantId: string,
    input: { itemId: string; productionBatchNo: string | null; vanWarehouseId: string },
  ): Promise<{ tracked: boolean; lotId: string | null }> {
    const item = first(
      await tx.execute(sql`
        SELECT track_lot FROM items
        WHERE id = ${input.itemId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        LIMIT 1
      `),
    );
    if (item?.track_lot !== true) return { tracked: false, lotId: null };

    const batchNo = input.productionBatchNo?.trim() || null;
    if (batchNo) {
      const fromBatch = first(
        await tx.execute(sql`
          SELECT lot_id::text FROM factory_production_batches
          WHERE tenant_id = ${tenantId}::uuid AND batch_no = ${batchNo}
            AND item_id = ${input.itemId}::uuid AND lot_id IS NOT NULL AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `),
      );
      if (fromBatch?.lot_id) return { tracked: true, lotId: str(fromBatch.lot_id) };

      const byLotNo = first(
        await tx.execute(sql`
          SELECT id::text FROM item_lots
          WHERE tenant_id = ${tenantId}::uuid AND item_id = ${input.itemId}::uuid
            AND lot_no = ${batchNo} AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (byLotNo?.id) return { tracked: true, lotId: str(byLotNo.id) };
    }

    const inVan = first(
      await tx.execute(sql`
        SELECT lot_id::text FROM inventory_transactions
        WHERE tenant_id = ${tenantId}::uuid AND item_id = ${input.itemId}::uuid
          AND warehouse_id = ${input.vanWarehouseId}::uuid AND lot_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      `),
    );
    return { tracked: true, lotId: inVan?.lot_id ? str(inVan.lot_id) : null };
  }

  private async runStockSettlement(
    tenantId: string,
    userId: string,
    loadOrderId: string,
    plan: {
      number: string;
      salesmanName: string;
      branchId: string | null;
      itemId: string | null;
      warehouseId: string | null;
      vanWarehouseId: string | null;
      productionBatchNo: string;
      countedRemaining: Decimal;
      expectedRemaining: Decimal;
      countVariance: Decimal;
      remainingAction: string | null;
      needsCountSettlement: boolean;
      needsRemainingMove: boolean;
      /** 🏷️ دفعة الصنف المتتبَّع — تُنسب إليها حركة المتبقي ومستند الجرد. */
      countLotId: string | null;
      stockAdjustmentId: string | null;
      remainingInventoryTxId: string | null;
    },
    options: { settleStockAdjustment: boolean },
  ): Promise<void> {
    if (!plan.vanWarehouseId || !plan.itemId) {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        await tx.execute(sql`
          UPDATE van_load_orders
          SET stock_settlement_status = 'blocked_missing_accounts',
              stock_settlement_note = 'لا يمكن تسوية الجرد: أمر التحميل بلا مستودع سيارة أو بلا صنف — يلزم تصحيح البطاقة ثم إعادة الاعتماد',
              updated_at = now()
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      });
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'لا يمكن تسوية الجرد الرسمي لأمر تحميل بلا مستودع سيارة أو بلا صنف محدد',
        422,
        { field: 'vanWarehouseId' },
      );
    }

    // 1) مستند الجرد الرسمي — created once, reused by every resume (never a second count).
    let adjustmentId = plan.stockAdjustmentId;
    if (plan.needsCountSettlement && !adjustmentId) {
      if (!plan.branchId) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'لا يمكن إنشاء مستند الجرد الرسمي بلا فرع محدد لأمر التحميل',
          422,
          { field: 'branchId' },
        );
      }
      /**
       * 🏷️ الدفعة — `createAdjustment`/`postAdjustment` refuse a count line for a lot-tracked
       * item without its lot (`INVENTORY_LOT_REQUIRED`), and rightly so: a count that cannot be
       * attributed to a lot cannot be traced to an expiry date. The lot is read, never invented —
       * from the production batch, then from a lot registered under the batch number, then from
       * what actually sits in the van.
       */
      const countLot = plan.countLotId
        ? { tracked: true, lotId: plan.countLotId }
        : await withTenantTx(this.database.db, tenantId, (tx) =>
            this.resolveCountLotInTx(tx, tenantId, {
              itemId: plan.itemId as string,
              productionBatchNo: plan.productionBatchNo,
              vanWarehouseId: plan.vanWarehouseId as string,
            }),
          );
      if (countLot.tracked && !countLot.lotId) {
        await withTenantTx(this.database.db, tenantId, async (tx) => {
          await tx.execute(sql`
            UPDATE van_load_orders
            SET stock_settlement_status = 'pending_count_decision',
                stock_settlement_note = ${`تعذّر تحديد دفعة الصنف المتتبَّع بالدفعات لإنشاء مستند الجرد الرسمي (دفعة الإنتاج: ${
                  plan.productionBatchNo || 'غير محددة'
                }) — حدّد الدفعة ثم أعد التسوية`},
                updated_at = now()
            WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
          `);
        });
        throw new DomainError(
          'VAN_COUNT_LOT_REQUIRED',
          'الصنف يُتتبَّع بالدفعات ولا توجد دفعة محددة لرصيد السيارة — لا يمكن إنشاء مستند الجرد الرسمي بلا دفعة',
          422,
          { field: 'productionBatchNo' },
        );
      }

      const created = await this.inventory.createAdjustment(tenantId, {
        branchId: plan.branchId,
        warehouseId: plan.vanWarehouseId,
        reason: `جرد إغلاق وردية المندوب (${plan.salesmanName}) ${plan.number} — المتوقع ${plan.expectedRemaining.toFixed(2)} مقابل الفعلي ${plan.countedRemaining.toFixed(2)} كجم`,
        lines: [
          {
            itemId: plan.itemId,
            countedQty: plan.countedRemaining.toFixed(4),
            lotId: countLot.lotId ?? undefined,
            note: plan.countVariance.gt(0)
              ? `عجز جرد ${plan.countVariance.toFixed(2)} كجم عن رصيد السيارة الرسمي`
              : `فائض جرد ${plan.countVariance.abs().toFixed(2)} كجم عن رصيد السيارة الرسمي`,
          },
        ],
      });
      adjustmentId = created.id ?? null;
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        await tx.execute(sql`
          UPDATE van_load_orders
          SET stock_adjustment_id = ${adjustmentId}::uuid, updated_at = now()
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      });
    }

    // 2) ترحيل التسوية — only on the explicit authorisation of the approver.
    let adjustmentPosted = false;
    if (adjustmentId && options.settleStockAdjustment) {
      try {
        await this.inventory.postAdjustment(tenantId, adjustmentId, { approved: true });
        adjustmentPosted = true;
      } catch (error) {
        const alreadyPosted =
          error instanceof DomainError && error.code === 'ADJUSTMENT_INVALID_STATE';
        if (alreadyPosted) {
          adjustmentPosted = true;
        } else {
          const missingAccounts =
            error instanceof DomainError &&
            (error.code === errorCodes.ACCOUNT_PROFILE_MISSING ||
              error.code === 'INVENTORY_PROFILE_KEY_MISSING');
          await withTenantTx(this.database.db, tenantId, async (tx) => {
            await tx.execute(sql`
              UPDATE van_load_orders
              SET stock_settlement_status = ${missingAccounts ? 'blocked_missing_accounts' : 'pending_count_decision'},
                  stock_settlement_note = ${`تعذّر ترحيل مستند الجرد الرسمي: ${
                    error instanceof Error ? error.message : String(error)
                  }${
                    missingAccounts
                      ? ' — يلزم تحديد حساب المخزون وحساب تسوية الجرد في ملف ترحيل stock_adjustment ثم إعادة الاعتماد'
                      : ''
                  }`},
                  updated_at = now()
              WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
            `);
          });
          throw error;
        }
      }
    }

    /**
     * ✔️ تحقق ما بعد الترحيل — هل سوّى المستند الفرقَ الذي اعتمده المحاسب، أم امتصّ حركةً
     * دخلت السيارة أثناء التسوية؟ محرك الجرد يحسب الفرق من الرصيد الذي يقرأه **لحظة
     * الترحيل**، فبيعٌ أو توريدٌ متزامن كان سيختفي داخل فرق الجرد. التسوية نفسها تبقى صحيحة
     * (الرصيد صار مساوياً للجرد)، لكن الكمية الممتصّة تُكتب على أمر التحميل ويُبلَّغ المحاسبون
     * — لا تُبتلع. والتجميد الوقائي (`assertVanWarehouseNotSettlingInTx`) هو ما يمنعها أصلاً.
     */
    let absorbedVariance = new Decimal(0);
    if (adjustmentPosted && plan.needsCountSettlement && adjustmentId) {
      const postedLine = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT variance_qty::text FROM stock_adjustment_lines
            WHERE tenant_id = ${tenantId}::uuid AND adjustment_id = ${adjustmentId}::uuid
            ORDER BY line_no ASC
            LIMIT 1
          `),
        ),
      );
      // المُتوقَّع من الاعتماد: `variance = counted − book = −countVariance`.
      absorbedVariance = dec(postedLine?.variance_qty).minus(plan.countVariance.negated());
    }

    // 3) مصير المتبقي الفعلي — an official movement back to the main warehouse, exactly once,
    //    and only after the count itself is settled so the two never fight over the same balance.
    let remainingTxId = plan.remainingInventoryTxId;
    if (
      plan.needsRemainingMove &&
      !remainingTxId &&
      plan.warehouseId &&
      plan.warehouseId !== plan.vanWarehouseId &&
      (!plan.needsCountSettlement || adjustmentPosted)
    ) {
      const moves = await withTenantTx(this.database.db, tenantId, (tx) =>
        this.inventory.recordInTx(
          tx,
          tenantId,
          [
            {
              itemId: plan.itemId as string,
              warehouseId: plan.vanWarehouseId as string,
              qty: plan.countedRemaining.toFixed(4),
              direction: 'out',
              docType: 'van_return',
              docId: loadOrderId,
              lineId: newId(),
              lotId: plan.countLotId ?? undefined,
              costing: 'outAtAvg',
            },
            {
              itemId: plan.itemId as string,
              warehouseId: plan.warehouseId as string,
              qty: plan.countedRemaining.toFixed(4),
              direction: 'in',
              docType: 'van_return',
              docId: loadOrderId,
              lineId: newId(),
              lotId: plan.countLotId ?? undefined,
              costing: 'inWithCost',
            },
          ],
          { allowNegative: false },
        ),
      );
      remainingTxId = moves.transactionIds[1] ?? moves.transactionIds[0] ?? null;
    }

    // 4) الحالة النهائية — settled only when the ledger and the shelf agree.
    const countResolved = !plan.needsCountSettlement || adjustmentPosted;
    const remainingResolved = !plan.needsRemainingMove || Boolean(remainingTxId);
    const closed = countResolved && remainingResolved;
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE van_load_orders
        SET status = ${closed ? 'settled' : 'pending_stock_settlement'},
            settled_at = ${closed ? new Date() : null}::timestamptz,
            stock_adjustment_id = COALESCE(${adjustmentId}::uuid, stock_adjustment_id),
            remaining_inventory_tx_id = COALESCE(${remainingTxId}::uuid, remaining_inventory_tx_id),
            stock_settlement_status = ${closed ? 'settled_officially' : 'pending_count_decision'},
            stock_settlement_note = ${
              closed
                ? `سُوِّي رصيد السيارة رسمياً مع الجرد الفعلي (${plan.countedRemaining.toFixed(2)} كجم)${
                    plan.needsCountSettlement
                      ? ` بفارق ${plan.countVariance.toFixed(2)} كجم عبر مستند الجرد الرسمي`
                      : ''
                  }${plan.needsRemainingMove ? '، وأُعيد المتبقي إلى المستودع الرئيسي' : ''}${
                    absorbedVariance.isZero()
                      ? ''
                      : ` — ⚠️ امتصّ مستند الجرد حركةً إضافية بمقدار ${absorbedVariance
                          .abs()
                          .toFixed(2)} كجم لم تكن ضمن الاعتماد: راجع حركات السيارة في فترة التسوية`
                  }`
                : `بانتظار تسوية المخزون: ${
                    plan.needsCountSettlement && !adjustmentPosted
                      ? 'مستند الجرد الرسمي مسودة — يلزم تفويض بترحيله'
                      : 'يلزم إرجاع المتبقي الفعلي إلى المستودع الرئيسي'
                  }`
            },
            updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
      `);

      if (plan.needsCountSettlement) {
        await tx.execute(sql`
          INSERT INTO van_stock_movements (
            id, tenant_id, movement_type, batch_no, load_order_id, item_id,
            qty, unit_price, amount, reason, idempotency_key, actor_user_id, approved_by_user_id
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, 'van_count_settlement', ${plan.productionBatchNo},
            ${loadOrderId}::uuid, ${plan.itemId}::uuid,
            ${plan.countVariance.abs().toFixed(4)}::numeric, 0, 0,
            ${`تسوية جرد إغلاق الوردية ${plan.number}: المتوقع ${plan.expectedRemaining.toFixed(2)} / الفعلي ${plan.countedRemaining.toFixed(2)} كجم — ${
              adjustmentPosted ? 'مستند الجرد الرسمي مُرحَّل' : 'مستند الجرد الرسمي مسودة بانتظار التفويض'
            }`},
            ${`count-settlement:${loadOrderId}`},
            ${userId}::uuid, ${adjustmentPosted ? userId : null}::uuid
          )
          /* مفتاح ثابت لكل وردية: إعادة المحاولة تُحدِّث الأثر ولا تكتب سطراً ثانياً. */
          ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
          DO UPDATE SET
            reason = EXCLUDED.reason,
            qty = EXCLUDED.qty,
            approved_by_user_id = COALESCE(EXCLUDED.approved_by_user_id, van_stock_movements.approved_by_user_id)
        `);
      }

      await this.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_closing_approved',
        title: closed
          ? `✅ سُوِّيت وردية (${plan.salesmanName}) ${plan.number} مخزنياً وأُغلقت العهدة`
          : `⏳ وردية (${plan.salesmanName}) ${plan.number} بانتظار تسوية المخزون`,
        body: closed
          ? `رصيد السيارة الرسمي صار مطابقاً للجرد الفعلي (${plan.countedRemaining.toFixed(2)} كجم)${
              plan.needsRemainingMove ? ' وأُعيد المتبقي إلى المستودع الرئيسي' : ''
            }. مسؤولية العجز المالية ما زالت معلّقة (حالة ${plan.countVariance.gt(0) ? 'بانتظار اعتماد السياسة' : 'لا عجز'}).`
          : `فرق الجرد ${plan.countVariance.toFixed(2)} كجم — ${
              plan.needsCountSettlement && !adjustmentPosted
                ? 'مستند الجرد الرسمي مسودة، ويلزم تفويض حامل صلاحية الاعتماد بترحيله'
                : 'يلزم إرجاع المتبقي الفعلي إلى المستودع الرئيسي'
            }. العهدة لم تُغلق بعد.`,
        href: '/van-sales?tab=loads',
      });
    });
  }

  /**
   * ♻️ استكمال تسوية مخزون وردية معلّقة — the recovery path for a closing whose quantities were
   * approved but whose stock reconciliation stopped half-way (missing accounts, a failed call, a
   * closed browser). It runs the same official mechanism and is safe to call repeatedly.
   */
  async settleLoadOrderStock(
    tenantId: string,
    userId: string,
    loadOrderId: string,
    body: { settleStockAdjustment?: boolean; remainingAction?: string } = {},
  ) {
    const plan = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const loadOrder = first(
        await tx.execute(sql`
          SELECT l.*, COALESCE(s.name, 'مندوب') AS salesman_name
          FROM van_load_orders l
          LEFT JOIN salesmen s ON s.id = l.salesman_id
          WHERE l.id = ${loadOrderId}::uuid AND l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          FOR UPDATE OF l
        `),
      );
      if (!loadOrder) throw new DomainError(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 404);
      if (str(loadOrder.status) !== 'pending_stock_settlement') {
        throw new DomainError(
          'VAN_LOAD_ORDER_NOT_PENDING_SETTLEMENT',
          ['settled', 'reconciled'].includes(str(loadOrder.status))
            ? 'تمت تسوية أمر التحميل هذا وإغلاق عهدته مسبقاً'
            : 'أمر التحميل ليس في حالة انتظار تسوية المخزون',
          409,
        );
      }
      const received = dec(loadOrder.received_qty);
      const loaded = received.gt(0) ? received : dec(loadOrder.loaded_qty);
      const accounted = dec(loadOrder.sold_qty)
        .plus(dec(loadOrder.bonus_qty))
        .plus(dec(loadOrder.returned_qty))
        .plus(dec(loadOrder.damaged_qty));
      const countedRemaining = Decimal.max(0, dec(loadOrder.actual_remaining_qty));
      const expectedRemaining = loaded.minus(accounted);
      const countVariance = expectedRemaining.minus(countedRemaining);
      const remainingAction =
        body.remainingAction !== undefined && String(body.remainingAction).trim() !== ''
          ? String(body.remainingAction).trim()
          : loadOrder.remaining_action
            ? str(loadOrder.remaining_action)
            : null;
      if (
        countedRemaining.gt(0) &&
        remainingAction !== 'return_to_main' &&
        remainingAction !== 'carry_over'
      ) {
        throw new DomainError(
          'VAN_CLOSING_REMAINING_ACTION_REQUIRED',
          `يوجد متبقٍ فعلي (${countedRemaining.toFixed(2)} كجم): حدّد \`return_to_main\` أو \`carry_over\``,
          422,
          { field: 'remainingAction' },
        );
      }
      const needsCountSettlement = !countVariance.isZero();
      const needsRemainingMove = countedRemaining.gt(0) && remainingAction === 'return_to_main';
      await tx.execute(sql`
        UPDATE van_load_orders
        SET remaining_action = COALESCE(${remainingAction}::text, remaining_action), updated_at = now()
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      return {
        number: str(loadOrder.number),
        salesmanName: str(loadOrder.salesman_name),
        branchId: await this.resolveDefaultBranchIdInTx(
          tx,
          tenantId,
          loadOrder.branch_id ? str(loadOrder.branch_id) : null,
          loadOrder.van_warehouse_id ? str(loadOrder.van_warehouse_id) : null,
        ),
        itemId: loadOrder.item_id ? str(loadOrder.item_id) : null,
        warehouseId: loadOrder.warehouse_id ? str(loadOrder.warehouse_id) : null,
        vanWarehouseId: loadOrder.van_warehouse_id ? str(loadOrder.van_warehouse_id) : null,
        productionBatchNo: str(loadOrder.production_batch_no),
        countedRemaining,
        expectedRemaining,
        countVariance,
        remainingAction,
        needsCountSettlement,
        needsRemainingMove,
        countLotId: await (async () => {
          if (!loadOrder.item_id) return null;
          const lot = await withTenantTx(this.database.db, tenantId, (tx) =>
            this.resolveCountLotInTx(tx, tenantId, {
              itemId: str(loadOrder.item_id),
              productionBatchNo: loadOrder.production_batch_no
                ? str(loadOrder.production_batch_no)
                : null,
              vanWarehouseId: loadOrder.van_warehouse_id ? str(loadOrder.van_warehouse_id) : '',
            }),
          );
          if (lot.tracked && !lot.lotId) {
            throw new DomainError(
              'VAN_LOT_REQUIRED_FOR_CLOSING',
              'الصنف يُتتبَّع بالدفعات ولا توجد دفعة صالحة لرصيد السيارة — لا تُستكمل تسوية الجرد بلا دفعة',
              422,
              { field: 'productionBatchNo' },
            );
          }
          return lot.tracked ? lot.lotId : null;
        })(),
        stockAdjustmentId: loadOrder.stock_adjustment_id ? str(loadOrder.stock_adjustment_id) : null,
        remainingInventoryTxId: loadOrder.remaining_inventory_tx_id
          ? str(loadOrder.remaining_inventory_tx_id)
          : null,
      };
    });

    if (!plan.needsCountSettlement && !plan.needsRemainingMove) {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        await tx.execute(sql`
          UPDATE van_load_orders
          SET status = 'settled', settled_at = now(), stock_settlement_status = 'settled_officially',
              stock_settlement_note = 'لا فرق بين رصيد السيارة الرسمي والجرد الفعلي', updated_at = now()
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      });
      return this.dashboard(tenantId);
    }

    await this.runStockSettlement(tenantId, userId, loadOrderId, plan, {
      settleStockAdjustment: body.settleStockAdjustment === true,
    });
    return this.dashboard(tenantId);
  }

  /**
   * Direct settlement endpoint — delegates to `approveClosing` without silently assuming
   * damage inspection if damagedQty > 0 unless caller explicitly confirms `damageInspected`.
   */
  async settleLoadOrder(
    tenantId: string,
    id: string,
    body: {
      returnedQty?: string;
      damagedQty?: string;
      collectedCash?: string;
      damageInspected?: boolean;
      salaryDeductionApproved?: boolean;
      notes?: string;
    },
    userId?: string,
  ) {
    const damaged = dec(body.damagedQty ?? '0');
    return this.approveClosing(tenantId, userId ?? newId(), id, {
      returnedQty: body.returnedQty,
      damagedQty: body.damagedQty,
      collectedCash: body.collectedCash,
      damageInspected: damaged.gt(0) ? body.damageInspected : true,
      salaryDeductionApproved: body.salaryDeductionApproved,
      notes: body.notes,
    });
  }

  /**
   * Pillar 5 (Phase 2 & 3): Record Customer Collection Receipt (`سند تحصيل مديونية من عميل`),
   * enforcing idempotency, balance bounds, and linking to official `sales_invoices` payments & `TreasuryService` vouchers.
   */
  async collectCustomerDebt(
    tenantId: string,
    userId: string,
    body: {
      documentId?: string;
      collectedAmount?: string;
      cashLocationId?: string;
      offsetAccountId?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const documentId = str(body.documentId).trim();
    const collectedAmount = dec(body.collectedAmount);
    if (!documentId || collectedAmount.lte(0)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'حدد الفاتورة الآجلة ومبلغ التحصيل', 422);
    }

    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT id::text FROM van_stock_movements
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
              AND movement_type = 'collection_receipt'
            LIMIT 1
          `),
        ),
      );
      if (existing) {
        return this.dashboard(tenantId);
      }
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const doc = first(
        await tx.execute(sql`
          SELECT * FROM van_sales_documents
          WHERE id = ${documentId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          FOR UPDATE
        `),
      );
      if (!doc) throw new DomainError(errorCodes.NOT_FOUND, 'الفاتورة غير موجودة', 404);

      const docTotal = dec(doc.total);
      const currentPaid = dec(doc.paid_amount);
      const remainingDebt = Decimal.max(0, docTotal.minus(currentPaid));

      if (remainingDebt.lte(0)) {
        throw new DomainError(
          'INVOICE_ALREADY_PAID',
          'هذه الفاتورة مسددة بالكامل مسبقاً ولا يمكن تسجيل تحصيل إضافي عليها',
          409,
        );
      }
      if (collectedAmount.gt(remainingDebt)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `مبلغ التحصيل (${collectedAmount.toFixed(2)} ريال) يتجاوز الرصيد المتبقي على الفاتورة (${remainingDebt.toFixed(2)} ريال)`,
          422,
          { field: 'collectedAmount' },
        );
      }

      const nextPaid = currentPaid.plus(collectedAmount);
      let linkedVoucherId: string | null = null;
      let voucherPosted = false;

      /**
       * سند القبض الرسمي — created *and posted* through `TreasuryService`, so the cash the
       * rep collected lands in the box balance and the ledger (Dr الصندوق / Cr ذمم العملاء)
       * instead of only in the add-on table.
       *
       * The offsetting account is the customer receivable account from the branch posting
       * profile when the caller does not name one — never a hardcoded account.
       */
      if (body.cashLocationId?.trim() && doc.branch_id) {
        const branchId = str(doc.branch_id);
        const profile = await this.resolvePostingProfileOrNullInTx(
          tx,
          tenantId,
          branchId,
          'receipt_voucher',
        );
        const partyReceivable = doc.party_id
          ? first(
              await tx.execute(sql`
                SELECT receivable_account_id::text FROM parties
                WHERE id = ${str(doc.party_id)}::uuid AND tenant_id = ${tenantId}::uuid
                LIMIT 1
              `),
            )
          : undefined;
        const resolvedOffsetAccountId =
          body.offsetAccountId?.trim() ||
          (partyReceivable?.receivable_account_id
            ? str(partyReceivable.receivable_account_id)
            : (profile?.receivableAccountId ?? null));

        const salesmanRow = doc.salesman_id
          ? first(
              await tx.execute(sql`
                SELECT employee_id::text FROM salesmen
                WHERE id = ${str(doc.salesman_id)}::uuid AND tenant_id = ${tenantId}::uuid
                LIMIT 1
              `),
            )
          : undefined;
        const employeeSalesmanId = salesmanRow?.employee_id
          ? str(salesmanRow.employee_id)
          : undefined;

        const createdVoucher = await this.treasury.createVoucherInTx(tx, tenantId, {
          branchId,
          kind: 'receipt',
          subtype: doc.party_id ? 'customer' : 'account',
          date: new Date().toISOString().slice(0, 10),
          method: 'cash',
          cashLocationId: body.cashLocationId.trim(),
          partyId: doc.party_id ? str(doc.party_id) : undefined,
          salesmanId: employeeSalesmanId,
          counterAccountId: resolvedOffsetAccountId ?? undefined,
          amount: collectedAmount.toFixed(4),
          referenceNo: str(doc.number),
          description: `سند قبض وتحصيل مديونية للفاتورة ${str(doc.number)}`,
          idempotencyKey: `van-collection-voucher:${documentId}:${idempotencyKey ?? collectedAmount.toFixed(4)}`,
        });
        if (createdVoucher?.id) {
          linkedVoucherId = createdVoucher.id;
          /**
           * الترحيل — posting is what moves the money: it numbers the voucher, opens the
           * fiscal period, writes the entry (Dr الصندوق / Cr ذمم العملاء) and bumps the cash
           * box balance. A draft receipt voucher is a promise, not a collection, so the
           * invoice is only marked paid when the voucher could genuinely post — i.e. when a
           * receivable account resolves. Without one the voucher stays draft and the gap is
           * reported instead of being papered over.
           */
          if (resolvedOffsetAccountId) {
            await this.treasury.postVoucherInTx(tx, tenantId, linkedVoucherId, {});
            voucherPosted = true;
          }
        }
      }

      // Sync official `sales_invoices` and `invoice_payments` if linked
      if (doc.sales_invoice_id) {
        const salesInvoiceId = str(doc.sales_invoice_id);
        /**
         * `invoice_payments.idempotency_key` is NOT NULL and unique per tenant, and the
         * table has no `invoice_type` column — the row used to be inserted with a column
         * that does not exist and without the key, so **every** collection against a posted
         * official invoice failed. The key is derived from the van document plus this
         * collection's own idempotency key, so a replayed collection cannot allocate twice.
         */
        const paymentIdempotencyKey = `van-collection:${documentId}:${idempotencyKey ?? collectedAmount.toFixed(4)}`;
        await tx.execute(sql`
          INSERT INTO invoice_payments (
            id, tenant_id, invoice_id, method, amount, cash_location_id, reference,
            idempotency_key, created_by
          ) VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, ${salesInvoiceId}::uuid,
            'cash', ${collectedAmount.toFixed(4)}::numeric,
            ${body.cashLocationId?.trim() || null}::uuid,
            ${`تحصيل فاتورة توزيع ${str(doc.number)}`},
            ${paymentIdempotencyKey}, ${userId}::uuid
          )
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        `);
        const invoiceRow = first(
          await tx.execute(sql`
            SELECT total::text, COALESCE(paid_total, 0)::text AS paid
            FROM sales_invoices
            WHERE id = ${salesInvoiceId}::uuid AND tenant_id = ${tenantId}::uuid
            LIMIT 1
          `),
        );
        const invoiceTotal = dec(invoiceRow?.total);
        const invoicePaid = dec(invoiceRow?.paid).plus(collectedAmount);
        const paymentStatus = invoicePaid.gte(invoiceTotal)
          ? 'paid'
          : invoicePaid.gt(0)
            ? 'partial'
            : 'unpaid';
        await tx.execute(sql`
          UPDATE sales_invoices
          SET paid_total = ${invoicePaid.toFixed(4)}::numeric,
              payment_status = ${paymentStatus},
              updated_at = now()
          WHERE id = ${salesInvoiceId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      }

      await tx.execute(sql`
        UPDATE van_sales_documents
        SET paid_amount = ${nextPaid.toFixed(4)}::numeric,
            receipt_voucher_id = COALESCE(${linkedVoucherId}::uuid, receipt_voucher_id)
        WHERE id = ${documentId}::uuid AND tenant_id = ${tenantId}::uuid
      `);

      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, party_id,
          voucher_id, qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'collection_receipt', ${str(doc.production_batch_no)},
          ${doc.load_order_id ? str(doc.load_order_id) : null}::uuid,
          ${doc.salesman_id ? str(doc.salesman_id) : null}::uuid,
          ${doc.party_id ? str(doc.party_id) : null}::uuid,
          ${linkedVoucherId}::uuid,
          0, 0, ${collectedAmount.toFixed(4)}::numeric,
          ${`سند قبض ${voucherPosted ? 'مُرحَّل' : linkedVoucherId ? 'مسجّل (غير مُرحَّل — يلزم تحديد حساب ذمم العملاء)' : 'بدون سند خزينة'} لتحصيل مديونية الفاتورة ${str(doc.number)} ${body.notes ? `— ${body.notes.trim()}` : ''}`},
          ${idempotencyKey},
          ${userId}::uuid
        )
      `);
    });

    return this.dashboard(tenantId);
  }

  /**
   * 🧑‍💼 شاشة المندوبين — the salesman card read with everything distribution needs around
   * it: the employee behind it, the login account that employee owns, the van warehouse
   * that holds the custody, and the custody itself (official balance + open load orders).
   *
   * There is deliberately no second salesman table: `POST/PATCH /sales/salesmen` writes the
   * official card (now carrying `warehouse_id` / `vehicle_plate`), and this reads it.
   */
  async listSalesmenWithCustody(tenantId: string) {
    const salesmen = await this.sales.listSalesmenWithCustody(tenantId);
    const custody = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const balances = rows(
        await tx.execute(sql`
          SELECT s.id::text AS salesman_id, b.item_id::text, b.quantity::text, b.value::text,
                 COALESCE(i.name_ar, i.sku, 'صنف') AS item_name,
                 COALESCE(w.name, 'مستودع') AS warehouse_name
          FROM salesmen s
          JOIN warehouses w ON w.id = s.warehouse_id
          JOIN stock_balances b ON b.warehouse_id = w.id AND b.tenant_id = s.tenant_id
          JOIN items i ON i.id = b.item_id
          WHERE s.tenant_id = ${tenantId}::uuid
          ORDER BY s.name ASC, i.name_ar ASC
        `),
      );
      const openOrders = rows(
        await tx.execute(sql`
          SELECT salesman_id::text,
                 COUNT(*)::int AS open_orders,
                 COUNT(*) FILTER (WHERE status = 'pending_receipt')::int AS pending_receipts,
                 COUNT(*) FILTER (WHERE status = 'pending_closing')::int AS pending_closings,
                 COALESCE(SUM(received_qty - sold_qty - bonus_qty - returned_qty - damaged_qty - shortage_qty), 0)::text AS custody_qty,
                 COALESCE(SUM(expected_cash - collected_cash), 0)::text AS outstanding_cash
          FROM van_load_orders
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
            AND status NOT IN ('settled', 'canceled', 'rejected')
          GROUP BY salesman_id
        `),
      );
      return { balances, openOrders };
    });

    const balanceByRep = new Map<string, Array<Record<string, unknown>>>();
    for (const row of custody.balances) {
      const key = str(row.salesman_id);
      balanceByRep.set(key, [...(balanceByRep.get(key) ?? []), row]);
    }
    const orderByRep = new Map<string, Record<string, unknown>>(
      custody.openOrders.map((row) => [str(row.salesman_id), row]),
    );

    return salesmen.map((rep) => {
      const id = str(rep.id);
      const order = orderByRep.get(id);
      const items = (balanceByRep.get(id) ?? []).map((row) => ({
        itemId: str(row.item_id),
        itemName: str(row.item_name),
        warehouseName: str(row.warehouse_name),
        quantity: dec(row.quantity).toFixed(4),
        value: dec(row.value).toFixed(4),
      }));
      const permissions = Array.isArray(rep.permissions)
        ? (rep.permissions as string[])
        : String(rep.permissions ?? '')
            .replace(/[{}]/g, '')
            .split(',')
            .map((code) => code.trim())
            .filter(Boolean);
      return {
        id,
        name: str(rep.name),
        active: rep.active !== false,
        employeeRef: rep.employeeRef ? str(rep.employeeRef) : null,
        commissionRate: str(rep.commissionRate ?? '0'),
        collectionCommissionRate: str(rep.collectionCommissionRate ?? '0'),
        profitCommissionRate: str(rep.profitCommissionRate ?? '0'),
        tel: rep.tel ? str(rep.tel) : null,
        mobile: rep.mobile ? str(rep.mobile) : null,
        email: rep.email ? str(rep.email) : null,
        notes: rep.notes ? str(rep.notes) : null,
        employeeId: rep.employeeId ? str(rep.employeeId) : null,
        employeeNo: rep.employeeNo ? str(rep.employeeNo) : null,
        employeeName: rep.employeeName ? str(rep.employeeName) : null,
        employeeStatus: rep.employeeStatus ? str(rep.employeeStatus) : null,
        membershipId: rep.membershipId ? str(rep.membershipId) : null,
        membershipStatus: rep.membershipStatus ? str(rep.membershipStatus) : null,
        userEmail: rep.userEmail ? str(rep.userEmail) : null,
        userStatus: rep.userStatus ? str(rep.userStatus) : null,
        roleCount: Number(rep.roleCount ?? 0),
        permissions,
        warehouseId: rep.warehouseId ? str(rep.warehouseId) : null,
        warehouseName: rep.warehouseName ? str(rep.warehouseName) : null,
        warehouseCode: rep.warehouseCode ? str(rep.warehouseCode) : null,
        vehiclePlate: rep.vehiclePlate ? str(rep.vehiclePlate) : null,
        custody: {
          openLoadOrders: Number(order?.open_orders ?? 0),
          pendingReceipts: Number(order?.pending_receipts ?? 0),
          pendingClosings: Number(order?.pending_closings ?? 0),
          custodyQty: dec(order?.custody_qty).toFixed(4),
          outstandingCash: dec(order?.outstanding_cash).toFixed(4),
          items,
        },
        /** ما ينقص البطاقة قبل أن يعمل المندوب فعليًا. */
        readiness: {
          hasEmployee: Boolean(rep.employeeId),
          hasLoginAccount: Boolean(rep.membershipId),
          loginActive: str(rep.membershipStatus) === 'active',
          hasVanWarehouse: Boolean(rep.warehouseId),
          hasVanSalesPermissions: permissions.some((code) => code === '*' || code.startsWith('van_sales.')),
        },
      };
    });
  }

  /**
   * 🔗 ربط المندوب بحساب دخول — creates (or reuses) the official user + membership through
   * `MembershipsService`, puts them on the official rep role through `RolesService`, links
   * the employee card to that membership, and scopes the login to the rep's own van
   * warehouse.
   *
   * Everything goes through the platform's own writers, so an invitation, a password reset
   * and the scope rules behave exactly as they do for any other staff account — no parallel
   * authentication path for distribution.
   */
  async linkSalesmanAccount(
    tenantId: string,
    actorUserId: string,
    salesmanId: string,
    body: {
      email?: string;
      fullName?: string;
      branchScope?: string[] | null;
      restrictToVanWarehouse?: boolean;
    },
  ) {
    const salesman = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = first(
        await tx.execute(sql`
          SELECT s.id::text, s.name, s.employee_id::text, s.warehouse_id::text,
                 e.id::text AS employee_id, e.membership_id::text, e.name AS employee_name,
                 e.branch_id::text AS employee_branch_id
          FROM salesmen s
          LEFT JOIN employees e ON e.id = s.employee_id AND e.deleted_at IS NULL
          WHERE s.id = ${salesmanId}::uuid AND s.tenant_id = ${tenantId}::uuid
          LIMIT 1
        `),
      );
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المندوب غير موجود', 404);
      return row;
    });

    const email = body.email?.trim().toLowerCase();
    if (!email) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'أدخل البريد الإلكتروني لحساب دخول المندوب',
        422,
        { field: 'email' },
      );
    }

    /** دور المندوب — found by name, created once with the rep's own permissions. */
    const existingRoles = await this.roles.list(tenantId, { limit: 200, offset: 0 });
    const repRoleName = 'مندوب توزيع';
    let role = (existingRoles.data ?? []).find((row) => row.name === repRoleName);
    if (!role) {
      role = await this.roles.create(tenantId, actorUserId, {
        name: repRoleName,
        description: 'دور مندوب التوزيع: رؤية عهدته، إصدار فواتيره، تحصيل مديونياته، وتقديم إغلاق ورديته',
        permissionCodes: [
          'van_sales.view',
          'van_sales.invoice.create',
          'van_sales.collection.create',
          'van_sales.closing.submit',
        ],
      });
    }

    /**
     * حساب واحد للشخص الواحد — when the employee card already owns a membership, that login
     * is reused (role + scope are applied to it) instead of creating a second account for the
     * same rep. The response therefore reports the account's real e-mail, not the one typed.
     */
    const reusedExistingAccount = Boolean(salesman.membership_id);

    const membership = salesman.membership_id
      ? await this.memberships.update(tenantId, actorUserId, str(salesman.membership_id), {
          roleIds: [role.id],
          status: 'active',
        })
      : await this.memberships.create(tenantId, actorUserId, {
          email,
          fullName: body.fullName?.trim() || str(salesman.employee_name || salesman.name),
          displayName: str(salesman.name),
          roleIds: [role.id],
          branchScope: body.branchScope ?? null,
        });

    /**
     * البريد الفعلي للحساب — read back from `users` through the membership, because it
     * differs from the one typed whenever an existing login was reused.
     */
    const accountEmail = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = first(
        await tx.execute(sql`
          SELECT u.email FROM memberships m
          JOIN users u ON u.id = m.user_id
          WHERE m.id = ${membership.id}::uuid AND m.tenant_id = ${tenantId}::uuid
          LIMIT 1
        `),
      );
      return row?.email ? str(row.email) : email;
    });

    /** قيد الحساب على مستودع سيارة المندوب — so he cannot read another van's balance. */
    if (body.restrictToVanWarehouse !== false && salesman.warehouse_id) {
      await this.memberships.replaceScopes(tenantId, actorUserId, membership.id, [
        { roleId: role.id, scopeType: 'warehouse', scopeId: str(salesman.warehouse_id) },
      ]);
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (salesman.employee_id) {
        await tx.execute(sql`
          UPDATE employees
          SET membership_id = ${membership.id}::uuid, updated_at = now()
          WHERE id = ${str(salesman.employee_id)}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      }
    });

    return {
      salesmanId,
      salesmanName: str(salesman.name),
      membershipId: membership.id,
      /** البريد الفعلي لحساب الدخول — قد يختلف عن المُدخل إن وُجد حساب قائم أُعيد استعماله. */
      email: accountEmail,
      requestedEmail: email,
      reusedExistingAccount,
      status: membership.status,
      roleId: role.id,
      roleName: role.name,
      employeeLinked: Boolean(salesman.employee_id),
      scopedToVanWarehouse: Boolean(
        body.restrictToVanWarehouse !== false && salesman.warehouse_id,
      ),
      /**
       * المستخدم الجديد يُنشأ بلا كلمة مرور (`status = invited`, `must_change_password`):
       * كلمة المرور لا تُخترَع هنا — يصله رابط التفعيل الرسمي من منصة الهوية.
       */
      activationRequired: membership.status !== 'active',
    };
  }

  /**
   * 🚐 مساحة عمل المندوب — `GET /van-sales/me`.
   *
   * Everything here is derived from the caller's own membership
   * (`memberships → employees → salesmen`), never from an id in the request, and every
   * quantity is the **official** `stock_balances` row of his van warehouse. A rep with no
   * salesman card gets an empty workspace rather than somebody else's.
   */
  async repWorkspace(tenantId: string, membershipId: string | null) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rep = await this.resolveSalesmanForMembershipInTx(tx, tenantId, membershipId);
      if (!rep) {
        return {
          isRep: false,
          salesmanId: null,
          salesmanName: null,
          warehouseId: null,
          vehiclePlate: null,
          balances: [],
          pendingReceipts: [],
          loadOrders: [],
          documents: [],
          collections: [],
          custody: null,
          notifications: [],
          message:
            'حسابك غير مرتبط ببطاقة مندوب توزيع — اطلب من المحاسب ربطك من شاشة المندوبين',
        };
      }

      const balances = await this.officialStockBalancesInTx(tx, tenantId, {
        warehouseIds: rep.warehouseId ? [rep.warehouseId] : [],
      });

      const pendingReceipts = rows(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.load_date::text, l.status,
                 l.loaded_qty::text, l.received_qty::text, l.discrepancy_qty::text,
                 l.production_batch_no, l.stock_transfer_id::text,
                 COALESCE(i.name_ar, 'صنف') AS item_name,
                 COALESCE(w_from.name, 'المستودع الرئيسي') AS from_warehouse_name
          FROM van_load_orders l
          LEFT JOIN items i ON i.id = l.item_id
          LEFT JOIN warehouses w_from ON w_from.id = l.warehouse_id
          WHERE l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
            AND l.salesman_id = ${rep.salesmanId}::uuid
            AND l.status = 'pending_receipt'
          ORDER BY l.created_at DESC
        `),
      );

      const loadOrders = rows(
        await tx.execute(sql`
          SELECT l.id::text, l.number, l.load_date::text, l.status,
                 l.loaded_qty::text, l.received_qty::text, l.sold_qty::text, l.bonus_qty::text,
                 l.returned_qty::text, l.damaged_qty::text, l.shortage_qty::text,
                 l.shortage_value::text, l.expected_cash::text, l.collected_cash::text,
                 l.actual_remaining_qty::text, l.discrepancy_qty::text, l.discrepancy_notes,
                 l.stock_settlement_status, l.stock_settlement_note, l.remaining_action,
                 l.production_batch_no, l.closing_submitted_at, l.approved_at,
                 COALESCE(i.name_ar, 'صنف') AS item_name
          FROM van_load_orders l
          LEFT JOIN items i ON i.id = l.item_id
          WHERE l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
            AND l.salesman_id = ${rep.salesmanId}::uuid
          ORDER BY l.created_at DESC
          LIMIT 50
        `),
      );

      const documents = rows(
        await tx.execute(sql`
          SELECT d.id::text, d.number, d.doc_date::text, d.document_kind, d.invoice_mode,
                 d.payment_method, d.sold_qty::text, d.bonus_qty::text, d.unit_price::text,
                 d.subtotal::text, d.tax_total::text, d.total::text, d.paid_amount::text,
                 d.sales_invoice_id::text, si.number AS invoice_number, si.status AS invoice_status,
                 COALESCE(p.name, d.customer_name, 'عميل نقدي') AS customer_name,
                 COALESCE(i.name_ar, 'صنف') AS item_name
          FROM van_sales_documents d
          LEFT JOIN sales_invoices si ON si.id = d.sales_invoice_id
          LEFT JOIN parties p ON p.id = d.party_id
          LEFT JOIN items i ON i.id = d.item_id
          WHERE d.tenant_id = ${tenantId}::uuid AND d.deleted_at IS NULL
            AND d.salesman_id = ${rep.salesmanId}::uuid
          ORDER BY d.created_at DESC
          LIMIT 100
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
          ORDER BY m.created_at DESC
          LIMIT 50
        `),
      );

      const notifications = rows(
        await tx.execute(sql`
          SELECT n.id::text, n.type, n.payload::text, n.read_at, n.created_at
          FROM notifications n
          WHERE n.tenant_id = ${tenantId}::uuid AND n.membership_id = ${membershipId}::uuid
          ORDER BY n.created_at DESC
          LIMIT 20
        `),
      );

      const totals = documents.reduce<{
        revenue: Decimal;
        collected: Decimal;
        outstanding: Decimal;
        cashSales: Decimal;
        creditSales: Decimal;
      }>(
        (acc, doc) => {
          const docTotal = dec(doc.total);
          const docPaid = dec(doc.paid_amount);
          acc.revenue = acc.revenue.plus(docTotal);
          acc.collected = acc.collected.plus(docPaid);
          acc.outstanding = acc.outstanding.plus(Decimal.max(0, docTotal.minus(docPaid)));
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

      const openCustody = loadOrders
        .filter((order) => !['settled', 'canceled', 'rejected'].includes(str(order.status)))
        .reduce<{ expectedKg: Decimal; pendingClosings: number }>(
          (acc, order) => {
            const received = dec(order.received_qty).gt(0) ? dec(order.received_qty) : dec(order.loaded_qty);
            const left = received
              .minus(dec(order.sold_qty))
              .minus(dec(order.bonus_qty))
              .minus(dec(order.returned_qty))
              .minus(dec(order.damaged_qty))
              .minus(dec(order.shortage_qty));
            return {
              expectedKg: acc.expectedKg.plus(Decimal.max(0, left)),
              pendingClosings: acc.pendingClosings + (str(order.status) === 'pending_closing' ? 1 : 0),
            };
          },
          { expectedKg: new Decimal(0), pendingClosings: 0 },
        );

      return {
        isRep: true,
        salesmanId: rep.salesmanId,
        salesmanName: rep.salesmanName,
        employeeId: rep.employeeId,
        warehouseId: rep.warehouseId,
        vehiclePlate: rep.vehiclePlate,
        active: rep.active,
        balances,
        custodyKg: balances
          .reduce((sum, row) => sum.plus(dec(row.quantity)), new Decimal(0))
          .toFixed(4),
        custodyValue: balances
          .reduce((sum, row) => sum.plus(dec(row.value)), new Decimal(0))
          .toFixed(4),
        pendingReceipts: pendingReceipts.map((row) => ({
          id: str(row.id),
          number: str(row.number),
          loadDate: str(row.load_date),
          status: str(row.status),
          loadedQty: dec(row.loaded_qty).toFixed(4),
          receivedQty: dec(row.received_qty).toFixed(4),
          productionBatchNo: str(row.production_batch_no),
          stockTransferId: row.stock_transfer_id ? str(row.stock_transfer_id) : null,
          itemName: str(row.item_name),
          fromWarehouseName: str(row.from_warehouse_name),
        })),
        loadOrders: loadOrders.map((row) => ({
          id: str(row.id),
          number: str(row.number),
          loadDate: str(row.load_date),
          status: str(row.status),
          itemName: str(row.item_name),
          productionBatchNo: str(row.production_batch_no),
          loadedQty: dec(row.loaded_qty).toFixed(4),
          receivedQty: dec(row.received_qty).toFixed(4),
          soldQty: dec(row.sold_qty).toFixed(4),
          bonusQty: dec(row.bonus_qty).toFixed(4),
          returnedQty: dec(row.returned_qty).toFixed(4),
          damagedQty: dec(row.damaged_qty).toFixed(4),
          shortageQty: dec(row.shortage_qty).toFixed(4),
          shortageValue: dec(row.shortage_value).toFixed(4),
          expectedCash: dec(row.expected_cash).toFixed(4),
          collectedCash: dec(row.collected_cash).toFixed(4),
          outstandingCash: Decimal.max(0, dec(row.expected_cash).minus(dec(row.collected_cash))).toFixed(4),
          /** المتبقي المتوقع قبل الجرد — ما تقول المستندات إنه يجب أن يبقى في السيارة. */
          expectedRemainingQty: Decimal.max(
            0,
            (dec(row.received_qty).gt(0) ? dec(row.received_qty) : dec(row.loaded_qty))
              .minus(dec(row.sold_qty))
              .minus(dec(row.bonus_qty))
              .minus(dec(row.returned_qty))
              .minus(dec(row.damaged_qty)),
          ).toFixed(4),
          actualRemainingQty: dec(row.actual_remaining_qty).toFixed(4),
          discrepancyQty: dec(row.discrepancy_qty).toFixed(4),
          discrepancyNotes: str(row.discrepancy_notes),
          stockSettlementStatus: str(row.stock_settlement_status || 'not_required'),
          stockSettlementNote: str(row.stock_settlement_note),
          remainingAction: row.remaining_action ? str(row.remaining_action) : null,
          closingSubmittedAt: row.closing_submitted_at ? iso(row.closing_submitted_at) : null,
          approvedAt: row.approved_at ? iso(row.approved_at) : null,
        })),
        documents: documents.map((row) => ({
          id: str(row.id),
          number: str(row.number),
          docDate: str(row.doc_date),
          documentKind: str(row.document_kind || 'sale'),
          invoiceMode: str(row.invoice_mode),
          paymentMethod: str(row.payment_method),
          customerName: str(row.customer_name),
          itemName: str(row.item_name),
          soldQty: dec(row.sold_qty).toFixed(4),
          bonusQty: dec(row.bonus_qty).toFixed(4),
          unitPrice: dec(row.unit_price).toFixed(4),
          subtotal: dec(row.subtotal).toFixed(2),
          taxTotal: dec(row.tax_total).toFixed(2),
          total: dec(row.total).toFixed(2),
          paidAmount: dec(row.paid_amount).toFixed(2),
          outstanding: Decimal.max(0, dec(row.total).minus(dec(row.paid_amount))).toFixed(2),
          salesInvoiceId: row.sales_invoice_id ? str(row.sales_invoice_id) : null,
          invoiceNumber: row.invoice_number ? str(row.invoice_number) : null,
          invoiceStatus: row.invoice_status ? str(row.invoice_status) : null,
        })),
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
          revenue: totals.revenue.toFixed(2),
          cashSales: totals.cashSales.toFixed(2),
          creditSales: totals.creditSales.toFixed(2),
          collected: totals.collected.toFixed(2),
          outstanding: totals.outstanding.toFixed(2),
        },
        custody: {
          expectedKg: openCustody.expectedKg.toFixed(4),
          officialKg: balances
            .reduce((sum, row) => sum.plus(dec(row.quantity)), new Decimal(0))
            .toFixed(4),
          pendingClosings: openCustody.pendingClosings,
        },
        notifications: notifications.map((row) => ({
          id: str(row.id),
          type: str(row.type),
          read: Boolean(row.read_at),
          createdAt: iso(row.created_at),
          payload: (() => {
            try {
              return JSON.parse(str(row.payload)) as Record<string, unknown>;
            } catch {
              return { raw: str(row.payload) };
            }
          })(),
        })),
      };
    });
  }

  /**
   * 🖨️ نسختا الطباعة — one official sale document, printed twice.
   *
   * Copy 1 («نسخة العميل») is the customer's receipt; copy 2 («نسخة المندوب») carries the
   * same numbers plus a signature box the rep brings back to the accountant. The print
   * timestamp is its own field, independent of the sale date, because an auditor reads the
   * two as different facts. No second invoice is created here — only a view of the one that
   * already exists.
   */
  async documentPrintView(
    tenantId: string,
    documentId: string,
    options: { copies?: number } = {},
  ) {
    const requestedCopies = Math.max(1, Math.min(6, Number(options.copies ?? 2)));
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const doc = first(
        await tx.execute(sql`
          SELECT d.*, si.number AS invoice_number, si.status AS invoice_status,
                 si.total::text AS invoice_total, si.paid_total::text AS invoice_paid,
                 COALESCE(p.name, d.customer_name, 'عميل نقدي') AS customer_name_resolved,
                 p.tax_no AS customer_tax_no_resolved, p.phone AS customer_phone,
                 p.address::text AS customer_address,
                 COALESCE(i.name_ar, i.sku, 'صنف') AS item_name, i.sku AS item_sku,
                 COALESCE(s.name, 'مندوب توزيع') AS salesman_name, s.mobile AS salesman_mobile,
                 COALESCE(w.name, 'سيارة التوزيع') AS van_warehouse_name,
                 l.number AS load_order_number
          FROM van_sales_documents d
          LEFT JOIN sales_invoices si ON si.id = d.sales_invoice_id
          LEFT JOIN parties p ON p.id = d.party_id
          LEFT JOIN items i ON i.id = d.item_id
          LEFT JOIN salesmen s ON s.id = d.salesman_id
          LEFT JOIN van_load_orders l ON l.id = d.load_order_id
          LEFT JOIN warehouses w ON w.id = l.van_warehouse_id
          WHERE d.id = ${documentId}::uuid AND d.tenant_id = ${tenantId}::uuid AND d.deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (!doc) throw new DomainError(errorCodes.NOT_FOUND, 'مستند البيع غير موجود', 404);

      const company = first(
        await tx.execute(sql`
          SELECT cp.name_ar, cp.name_en, cp.tax_no, cp.cr_no, cp.email, cp.phones::text,
                 cp.address::text
          FROM company_profiles cp
          WHERE cp.tenant_id = ${tenantId}::uuid
          LIMIT 1
        `),
      );

      const lines: Array<Record<string, unknown>> = [];
      const soldQty = dec(doc.sold_qty);
      const bonusQty = dec(doc.bonus_qty);
      if (soldQty.gt(0)) {
        lines.push({
          kind: 'sale',
          itemName: str(doc.item_name),
          sku: str(doc.item_sku),
          quantity: soldQty.toFixed(3),
          unitPrice: dec(doc.unit_price).toFixed(2),
          discount: dec(doc.discount_amount).toFixed(2),
          lineTotal: Decimal.max(0, soldQty.mul(dec(doc.unit_price)).minus(dec(doc.discount_amount))).toFixed(2),
        });
      }
      if (bonusQty.gt(0)) {
        lines.push({
          kind: 'bonus',
          itemName: `${str(doc.item_name)} — كمية مجانية (بونص)`,
          sku: str(doc.item_sku),
          quantity: bonusQty.toFixed(3),
          unitPrice: '0.00',
          discount: '0.00',
          lineTotal: '0.00',
          reason: str(doc.bonus_reason) || 'ترويجي',
        });
      }

      const invoiceMode = str(doc.invoice_mode);
      const appliesVat = invoiceMode === 'zatca_tax';
      const base = {
        documentId: str(doc.id),
        documentNumber: str(doc.number),
        /** رقم الفاتورة الرسمية — the number the accountant and ZATCA know. */
        invoiceNumber: doc.invoice_number ? str(doc.invoice_number) : null,
        invoiceStatus: doc.invoice_status ? str(doc.invoice_status) : null,
        saleDate: str(doc.doc_date),
        companyName: str(company?.name_ar ?? ''),
        companyNameEn: str(company?.name_en ?? ''),
        companyTaxNo: str(company?.tax_no ?? ''),
        companyCrNo: str(company?.cr_no ?? ''),
        companyEmail: str(company?.email ?? ''),
        companyPhones: (() => {
          try {
            return JSON.parse(str(company?.phones ?? '[]')) as string[];
          } catch {
            return [] as string[];
          }
        })(),
        companyAddress: (() => {
          try {
            return JSON.parse(str(company?.address ?? 'null')) as Record<string, unknown> | null;
          } catch {
            return null;
          }
        })(),
        customerName: str(doc.customer_name_resolved),
        customerTaxNo: str(doc.customer_tax_no_resolved ?? doc.customer_tax_no ?? ''),
        customerPhone: str(doc.customer_phone ?? ''),
        customerMobile: str(doc.customer_mobile ?? ''),
        salesmanName: str(doc.salesman_name),
        salesmanMobile: str(doc.salesman_mobile ?? ''),
        vanWarehouseName: str(doc.van_warehouse_name),
        loadOrderNumber: str(doc.load_order_number ?? ''),
        productionBatchNo: str(doc.production_batch_no),
        invoiceMode,
        taxPolicyStatus: str(doc.tax_policy_status),
        paymentMethod: str(doc.payment_method),
        lines,
        subtotal: dec(doc.subtotal).toFixed(2),
        discountTotal: dec(doc.discount_amount).toFixed(2),
        vatRate: appliesVat ? dec(doc.tax_rate).toFixed(2) : '0.00',
        vatTotal: appliesVat ? dec(doc.tax_total).toFixed(2) : '0.00',
        grandTotal: dec(doc.total).toFixed(2),
        paidAmount: dec(doc.paid_amount).toFixed(2),
        outstandingAmount: Decimal.max(0, dec(doc.total).minus(dec(doc.paid_amount))).toFixed(2),
        bonusQtyTotal: bonusQty.toFixed(3),
        qrPayload: str(doc.zatca_qr_tlv ?? doc.qr_payload ?? ''),
        notes: str(doc.notes ?? ''),
        /**
         * تاريخ ووقت الطباعة — its own fact, stamped when the sheet is rendered, never the
         * sale date. A document reprinted next month must say so.
         */
        printedAt: new Date().toISOString(),
      };

      const kinds = requestedCopies >= 2 ? ['customer', 'rep'] : ['customer'];
      const copies = Array.from({ length: requestedCopies }, (_, index) => {
        const kind = kinds[index] ?? 'customer';
        return {
          ...base,
          copyIndex: index + 1,
          kind,
          copyLabel: kind === 'rep' ? 'نسخة المندوب (تُعاد موقّعة من العميل إلى المحاسب)' : 'نسخة العميل',
          requiresCustomerSignature: kind === 'rep',
          signatureBlock:
            kind === 'rep'
              ? {
                  customerSignatureLabel: 'توقيع العميل / المستلم',
                  repSignatureLabel: 'توقيع المندوب',
                  accountantNote: 'تُعاد هذه النسخة موقّعة من العميل إلى المحاسب مع إغلاق الوردية',
                }
              : null,
        };
      });

      return { ...base, copies, copiesCount: copies.length };
    });
  }

  /**
   * ↩️ مرتجع العميل — a real return, not a negative sale.
   *
   * It creates the official `sale_return` invoice referencing the original (so the sales
   * engine restores stock at the cost it left at and posts the credit), records the quantity
   * back into the rep's van warehouse, and updates the custody counters the shift closing
   * reads. Replaying it with the same idempotency key returns the same result.
   */
  async createReturnDocument(
    tenantId: string,
    userId: string,
    body: {
      documentId?: string;
      returnedQty?: string;
      reason?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const documentId = str(body.documentId).trim();
    const returnedQty = dec(body.returnedQty);
    if (!documentId) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'حدد مستند البيع الأصلي للمرتجع', 422, {
        field: 'documentId',
      });
    }
    if (!returnedQty.isFinite() || returnedQty.lte(0)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'كمية المرتجع يجب أن تكون أكبر من صفر',
        422,
        { field: 'returnedQty' },
      );
    }

    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT id::text FROM van_sales_documents
            WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${idempotencyKey}
              AND deleted_at IS NULL
            LIMIT 1
          `),
        ),
      );
      if (existing) return this.dashboard(tenantId);
    }

    const source = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const doc = first(
        await tx.execute(sql`
          SELECT d.id::text, d.number, d.document_kind, d.load_order_id::text, d.salesman_id::text,
                 d.party_id::text, d.customer_name, d.item_id::text, d.sold_qty::text, d.bonus_qty::text,
                 d.unit_price::text, d.discount_amount::text, d.tax_rate::text, d.invoice_mode,
                 d.production_batch_no, d.sales_invoice_id::text, d.branch_id::text,
                 l.van_warehouse_id::text, l.warehouse_id::text, l.status AS load_status,
                 l.returned_qty::text AS load_returned_qty, l.received_qty::text, l.loaded_qty::text,
                 l.sold_qty::text AS load_sold_qty, l.bonus_qty::text AS load_bonus_qty,
                 l.damaged_qty::text AS load_damaged_qty,
                 it.track_lot AS item_track_lot
          FROM van_sales_documents d
          LEFT JOIN van_load_orders l ON l.id = d.load_order_id
          LEFT JOIN items it ON it.id = d.item_id
          WHERE d.id = ${documentId}::uuid AND d.tenant_id = ${tenantId}::uuid AND d.deleted_at IS NULL
          LIMIT 1
        `),
      );
      if (!doc) throw new DomainError(errorCodes.NOT_FOUND, 'مستند البيع غير موجود', 404);
      if (str(doc.document_kind) === 'return') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'لا يمكن إرجاع مرتجع — أنشئ مستند بيع جديد بدلًا من ذلك',
          422,
        );
      }
      const soldQty = dec(doc.sold_qty).plus(dec(doc.bonus_qty));
      const alreadyReturned = rows(
        await tx.execute(sql`
          SELECT COALESCE(SUM(sold_qty), 0)::text AS qty
          FROM van_sales_documents
          WHERE tenant_id = ${tenantId}::uuid AND reference_document_id = ${documentId}::uuid
            AND document_kind = 'return' AND deleted_at IS NULL
        `),
      );
      const returnedBefore = dec(alreadyReturned[0]?.qty);
      if (returnedBefore.plus(returnedQty).gt(soldQty)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `إجمالي المرتجع (${returnedBefore.plus(returnedQty).toFixed(2)}) يتجاوز الكمية المباعة في المستند (${soldQty.toFixed(2)})`,
          422,
          { field: 'returnedQty' },
        );
      }
      return doc;
    });

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const vanWarehouseId = source.van_warehouse_id
        ? str(source.van_warehouse_id)
        : source.warehouse_id
          ? str(source.warehouse_id)
          : null;
      const branchId = source.branch_id
        ? str(source.branch_id)
        : await this.resolveDefaultBranchIdInTx(tx, tenantId, null, vanWarehouseId);
      const itemId = source.item_id ? str(source.item_id) : null;

      /**
       * فاتورة المرتجع الرسمية — `kind: 'sale_return'` referencing the original invoice, so
       * the sales engine restores the stock at the cost it left at and posts the credit
       * note against the same accounts. One mechanism, the official one.
       */
      let returnInvoiceId: string | null = null;
      if (branchId && itemId) {
        returnInvoiceId = await this.sales.createInTx(tx, tenantId, {
          branchId,
          warehouseId: vanWarehouseId ?? undefined,
          partyId: source.party_id ? str(source.party_id) : undefined,
          salesmanId: source.salesman_id ? str(source.salesman_id) : undefined,
          cashCustomerName: !source.party_id ? str(source.customer_name ?? 'عميل توزيع') : undefined,
          kind: 'sale_return',
          referenceInvoiceId: source.sales_invoice_id ? str(source.sales_invoice_id) : undefined,
          lines: [
            {
              itemId,
              description: `مرتجع عميل من مستند التوزيع ${str(source.number)}${body.reason?.trim() ? ` — ${body.reason.trim()}` : ''}`,
              quantity: returnedQty.toFixed(4),
              unitPrice: dec(source.unit_price).toFixed(4),
              discountAmount: '0.0000',
              taxRate: str(source.invoice_mode) === 'zatca_tax' ? dec(source.tax_rate).toFixed(4) : '0.0000',
              batchNo: source.item_track_lot === true ? str(source.production_batch_no) : undefined,
              metadata: {
                isVanReturn: true,
                sourceVanDocumentId: documentId,
                sourceVanDocumentNumber: str(source.number),
                returnReason: body.reason?.trim() || null,
              },
            },
          ],
        });
        try {
          await this.sales.postInTx(tx, tenantId, returnInvoiceId, { settlement: 'credit' });
        } catch (error) {
          /**
           * A return whose credit cannot be posted yet (no posting profile mapped for this
           * branch) still has to give the goods back to the rep — the stock is real even
           * when the accounting is not configured. The invoice stays draft, the stock is
           * restored here explicitly, and the gap is reported instead of hidden.
           */
          if (
            !(
              error instanceof DomainError &&
              (error.code === errorCodes.ACCOUNT_PROFILE_MISSING ||
                error.code === 'SALES_WAREHOUSE_REQUIRED')
          )
          ) {
            throw error;
          }
          if (vanWarehouseId) {
            await this.inventory.recordInTx(tx, tenantId, [
              {
                itemId,
                warehouseId: vanWarehouseId,
                qty: returnedQty.toFixed(4),
                unitCost: dec(source.unit_price).toFixed(4),
                direction: 'in',
                docType: 'sales_return',
                docId: returnInvoiceId,
                lineId: newId(),
                costing: 'returnAtOriginalCost',
              },
            ]);
          }
        }
      }

      const allocated = await this.sequences.next(
        { tenantId, branchId: branchId ?? undefined, docType: 'van_sales_return_doc' },
        tx,
        { prefix: 'VRT-', padding: 5 },
      );
      const returnDocId = newId();
      const unitPrice = dec(source.unit_price);
      const returnTotal = returnedQty.mul(unitPrice);

      await tx.execute(sql`
        INSERT INTO van_sales_documents (
          id, tenant_id, branch_id, number, document_kind, reference_document_id,
          load_order_id, salesman_id, party_id, customer_name, item_id,
          doc_mode, invoice_mode, tax_policy_status, payment_method, doc_date,
          batch_code, production_batch_no, sold_qty, bonus_qty, unit_price,
          subtotal, tax_rate, tax_total, total, paid_amount, sales_invoice_id,
          notes, idempotency_key, created_by
        ) VALUES (
          ${returnDocId}::uuid, ${tenantId}::uuid, ${branchId}::uuid, ${allocated.display},
          'return', ${documentId}::uuid,
          ${source.load_order_id ? str(source.load_order_id) : null}::uuid,
          ${str(source.salesman_id)}::uuid, ${source.party_id ? str(source.party_id) : null}::uuid,
          ${source.customer_name ? str(source.customer_name) : null}, ${itemId}::uuid,
          ${str(source.invoice_mode)}, ${str(source.invoice_mode)},
          ${str(source.invoice_mode) === 'zatca_tax' ? 'standard_vat' : 'pending_tax_policy'},
          'credit', CURRENT_DATE,
          ${str(source.production_batch_no)}, ${str(source.production_batch_no)},
          ${returnedQty.toFixed(4)}::numeric, 0, ${unitPrice.toFixed(4)}::numeric,
          ${returnTotal.toFixed(4)}::numeric,
          ${str(source.invoice_mode) === 'zatca_tax' ? dec(source.tax_rate).toFixed(2) : '0.00'}::numeric,
          ${str(source.invoice_mode) === 'zatca_tax'
            ? returnTotal.mul(dec(source.tax_rate).div(100)).toFixed(4)
            : '0'}::numeric,
          ${returnTotal.toFixed(4)}::numeric, 0, ${returnInvoiceId}::uuid,
          ${[body.reason?.trim(), body.notes?.trim()].filter(Boolean).join(' — ') || null},
          ${idempotencyKey}, ${userId}::uuid
        )
      `);

      /** العهدة — the returned quantity is back in the rep's custody for the shift closing. */
      if (source.load_order_id) {
        await tx.execute(sql`
          UPDATE van_load_orders
          SET returned_qty = returned_qty + ${returnedQty.toFixed(4)}::numeric,
              expected_cash = GREATEST(0, expected_cash - ${returnTotal.toFixed(4)}::numeric),
              updated_at = now()
          WHERE id = ${str(source.load_order_id)}::uuid AND tenant_id = ${tenantId}::uuid
        `);
      }

      await tx.execute(sql`
        INSERT INTO van_stock_movements (
          id, tenant_id, movement_type, batch_no, load_order_id, salesman_id, party_id, item_id,
          qty, unit_price, amount, reason, idempotency_key, actor_user_id
        ) VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'customer_return', ${str(source.production_batch_no)},
          ${source.load_order_id ? str(source.load_order_id) : null}::uuid,
          ${str(source.salesman_id)}::uuid, ${source.party_id ? str(source.party_id) : null}::uuid,
          ${itemId}::uuid,
          ${returnedQty.toFixed(4)}::numeric, ${unitPrice.toFixed(4)}::numeric,
          ${returnTotal.toFixed(4)}::numeric,
          ${`مرتجع عميل من المستند ${str(source.number)}${body.reason?.trim() ? ` — السبب: ${body.reason.trim()}` : ''}`},
          ${idempotencyKey ? `return-move:${idempotencyKey}` : null},
          ${userId}::uuid
        )
      `);

      return this.dashboard(tenantId);
    });
  }

  /**
   * Phase 6: Resumable Dry-Run & Safe Backfill Tool for Legacy Van Sales Data (`أداة فحص ومطابقة البيانات القديمة`).
   * - Defaults strictly to `mode: 'dry_run'` (zero writes).
   * - Never classifies or deletes records by name, date, or missing audit logs.
   * - Previews counts, differences, conflicts, and resumable backfill plan.
   */
  async reconcileLegacyData(
    tenantId: string,
    userId: string,
    options: {
      mode?: 'dry_run' | 'execute';
      resumeFromId?: string;
      batchLimit?: number;
    } = {},
  ) {
    const mode = options.mode === 'execute' ? 'execute' : 'dry_run';
    const batchLimit = Math.max(1, Math.min(200, Number(options.batchLimit ?? 50)));
    const resumeFromId = options.resumeFromId?.trim() || null;

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const batchCounts = first(
        await tx.execute(sql`
          SELECT
            COUNT(*)::int AS total_batches,
            COUNT(*) FILTER (
              WHERE inventory_transaction_id IS NOT NULL
                 OR production_order_id IS NOT NULL
                 OR manufacturing_order_id IS NOT NULL
            )::int AS linked_batches,
            COUNT(*) FILTER (
              WHERE inventory_transaction_id IS NULL
                AND production_order_id IS NULL
                AND manufacturing_order_id IS NULL
            )::int AS unlinked_batches
          FROM factory_production_batches
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      );

      const loadCounts = first(
        await tx.execute(sql`
          SELECT
            COUNT(*)::int AS total_loads,
            COUNT(*) FILTER (WHERE stock_transfer_id IS NOT NULL)::int AS linked_loads,
            COUNT(*) FILTER (WHERE stock_transfer_id IS NULL)::int AS unlinked_loads,
            COUNT(*) FILTER (WHERE shortage_qty > 0 AND shortage_policy_status = 'pending_policy_approval')::int AS pending_shortage_policy
          FROM van_load_orders
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      );

      const docCounts = first(
        await tx.execute(sql`
          SELECT
            COUNT(*)::int AS total_docs,
            COUNT(*) FILTER (WHERE sales_invoice_id IS NOT NULL)::int AS linked_docs,
            COUNT(*) FILTER (WHERE sales_invoice_id IS NULL)::int AS unlinked_docs,
            COUNT(*) FILTER (WHERE invoice_mode = 'internal_delivery')::int AS internal_delivery_docs
          FROM van_sales_documents
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      );

      const priceWithoutHistoryRows = rows(
        await tx.execute(sql`
          SELECT cp.*
          FROM van_sales_customer_prices cp
          WHERE cp.tenant_id = ${tenantId}::uuid
            AND cp.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM van_sales_customer_price_history h
              WHERE h.tenant_id = cp.tenant_id AND h.customer_price_id = cp.id
            )
          ORDER BY cp.id ASC
          LIMIT ${batchLimit}
        `),
      );

      const unlinkedDocsRows = rows(
        await tx.execute(sql`
          SELECT d.*
          FROM van_sales_documents d
          WHERE d.tenant_id = ${tenantId}::uuid
            AND d.deleted_at IS NULL
            AND d.sales_invoice_id IS NULL
            AND (${resumeFromId}::uuid IS NULL OR d.id > ${resumeFromId}::uuid)
          ORDER BY d.id ASC
          LIMIT ${batchLimit}
        `),
      );

      const duplicateDocNumbers = rows(
        await tx.execute(sql`
          SELECT number, COUNT(*)::int AS cnt
          FROM van_sales_documents
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          GROUP BY number
          HAVING COUNT(*) > 1
        `),
      );

      const resolvedBranchId = await this.resolveDefaultBranchIdInTx(tx, tenantId);
      const conflicts: Array<{ entityType: string; entityId: string; code: string; detail: string }> =
        [];
      const plan: Array<{
        entityType: string;
        entityId: string;
        number: string;
        action: string;
        canBackfillSafely: boolean;
        blockingReason: string | null;
      }> = [];

      for (const dup of duplicateDocNumbers) {
        conflicts.push({
          entityType: 'van_sales_documents',
          entityId: str(dup.number),
          code: 'DUPLICATE_DOCUMENT_NUMBER',
          detail: `رقم الفاتورة (${str(dup.number)}) مكرر ${Number(dup.cnt)} مرات ويحتاج مراجعة يدوية دون إعادة ترقيم تلقائي.`,
        });
      }

      const succeeded: Array<{ entityType: string; entityId: string; linkedId: string }> = [];
      const failed: Array<{ entityType: string; entityId: string; reason: string }> = [];
      let nextResumeCursor: string | null = null;

      for (const cp of priceWithoutHistoryRows) {
        const cpId = str(cp.id);
        plan.push({
          entityType: 'van_sales_customer_prices',
          entityId: cpId,
          number: str(cp.price_tier_label),
          action: 'backfill_price_audit_history',
          canBackfillSafely: true,
          blockingReason: null,
        });
        if (mode === 'execute') {
          const histId = newId();
          await tx.execute(sql`
            INSERT INTO van_sales_customer_price_history (
              id, tenant_id, customer_price_id, party_id, item_id,
              previous_unit_price, new_unit_price,
              max_bonus_pct, max_bonus_kg_per_invoice, max_discount_pct, lock_price,
              effective_from, effective_to, change_reason, changed_by
            ) VALUES (
              ${histId}::uuid, ${tenantId}::uuid, ${cpId}::uuid, ${str(cp.party_id)}::uuid,
              ${cp.item_id ? str(cp.item_id) : null}::uuid,
              NULL, ${dec(cp.unit_price).toFixed(4)}::numeric,
              ${dec(cp.max_bonus_pct).toFixed(2)}::numeric,
              ${dec(cp.max_bonus_kg_per_invoice).toFixed(4)}::numeric,
              ${dec(cp.max_discount_pct).toFixed(2)}::numeric,
              ${cp.lock_price !== false},
              COALESCE(${cp.effective_from ? str(cp.effective_from) : null}::date, CURRENT_DATE),
              ${cp.effective_to ? str(cp.effective_to) : null}::date,
              'تأريخ أولي للبيانات السابقة (Backfill)',
              ${userId}::uuid
            )
          `);
          succeeded.push({
            entityType: 'van_sales_customer_prices',
            entityId: cpId,
            linkedId: histId,
          });
        }
      }

      for (const doc of unlinkedDocsRows) {
        const docId = str(doc.id);
        nextResumeCursor = docId;
        const docNumber = str(doc.number);
        const docMode = str(doc.invoice_mode || doc.doc_mode || 'zatca_tax');
        const branchId = doc.branch_id ? str(doc.branch_id) : resolvedBranchId;
        const hasCustomer = Boolean(doc.party_id || (doc.customer_name && str(doc.customer_name).trim()));

        if (docMode === 'internal_delivery') {
          conflicts.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            code: 'INTERNAL_DELIVERY_TAX_POLICY_PENDING',
            detail: `المستند ${docNumber} من نوع internal_delivery؛ متوقف عن الترحيل الرسمي حتى اعتماد السياسة الضريبية.`,
          });
          plan.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            number: docNumber,
            action: 'skip_pending_tax_policy',
            canBackfillSafely: false,
            blockingReason: 'INTERNAL_DELIVERY_TAX_POLICY_PENDING',
          });
          if (mode === 'execute') {
            failed.push({
              entityType: 'van_sales_documents',
              entityId: docId,
              reason: 'INTERNAL_DELIVERY_TAX_POLICY_PENDING',
            });
          }
          continue;
        }

        if (!branchId || !hasCustomer) {
          const reason = !branchId ? 'MISSING_BRANCH_ID' : 'MISSING_CUSTOMER';
          conflicts.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            code: reason,
            detail: `المستند ${docNumber} يفتقد الفرع أو العميل اللازم لربطه بجدول sales_invoices.`,
          });
          plan.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            number: docNumber,
            action: 'skip_missing_master_ref',
            canBackfillSafely: false,
            blockingReason: reason,
          });
          if (mode === 'execute') {
            failed.push({ entityType: 'van_sales_documents', entityId: docId, reason });
          }
          continue;
        }

        plan.push({
          entityType: 'van_sales_documents',
          entityId: docId,
          number: docNumber,
          action: 'create_linked_draft_sales_invoice',
          canBackfillSafely: true,
          blockingReason: null,
        });

        if (mode === 'execute') {
          const soldQty = dec(doc.sold_qty);
          const bonusQty = dec(doc.bonus_qty);
          const lines: SalesLineInput[] = [];
          if (soldQty.gt(0)) {
            lines.push({
              itemId: doc.item_id ? str(doc.item_id) : undefined,
              description: `فاتورة توزيع مرحلة (${docNumber})`,
              quantity: soldQty.toFixed(4),
              unitPrice: dec(doc.unit_price).toFixed(4),
              discountAmount: dec(doc.discount_amount).toFixed(4),
              taxRate: dec(doc.tax_rate).toFixed(4),
              batchNo: str(doc.production_batch_no),
              metadata: {
                isBonus: false,
                legacyBackfill: true,
                vanDocumentId: docId,
                vanDocumentNumber: docNumber,
              },
            });
          }
          if (bonusQty.gt(0)) {
            lines.push({
              itemId: doc.item_id ? str(doc.item_id) : undefined,
              description: `بونص مجاني (${docNumber})`,
              quantity: bonusQty.toFixed(4),
              unitPrice: '0.0000',
              discountAmount: '0.0000',
              taxRate: '0.0000',
              batchNo: str(doc.production_batch_no),
              metadata: {
                isBonus: true,
                legacyBackfill: true,
                bonusReason: str(doc.bonus_reason) || 'ترويجي',
                vanDocumentId: docId,
                vanDocumentNumber: docNumber,
              },
            });
          }
          const createdInvoiceId = await this.sales.createInTx(tx, tenantId, {
            branchId,
            partyId: doc.party_id ? str(doc.party_id) : undefined,
            salesmanId: doc.salesman_id ? str(doc.salesman_id) : undefined,
            cashCustomerName: !doc.party_id
              ? str(doc.customer_name) || 'عميل توزيع'
              : undefined,
            kind: 'sale',
            lines,
          });
          await tx.execute(sql`
            UPDATE van_sales_documents
            SET branch_id = COALESCE(branch_id, ${branchId}::uuid),
                sales_invoice_id = ${createdInvoiceId}::uuid
            WHERE id = ${docId}::uuid AND tenant_id = ${tenantId}::uuid
          `);
          succeeded.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            linkedId: createdInvoiceId,
          });
        }
      }

      return {
        mode,
        executedAt: new Date().toISOString(),
        counts: {
          totalProductionBatches: Number(batchCounts?.total_batches ?? 0),
          linkedProductionBatches: Number(batchCounts?.linked_batches ?? 0),
          unlinkedProductionBatches: Number(batchCounts?.unlinked_batches ?? 0),
          totalLoadOrders: Number(loadCounts?.total_loads ?? 0),
          linkedLoadOrders: Number(loadCounts?.linked_loads ?? 0),
          unlinkedLoadOrders: Number(loadCounts?.unlinked_loads ?? 0),
          pendingShortagePolicyOrders: Number(loadCounts?.pending_shortage_policy ?? 0),
          totalDocuments: Number(docCounts?.total_docs ?? 0),
          linkedDocuments: Number(docCounts?.linked_docs ?? 0),
          unlinkedDocuments: Number(docCounts?.unlinked_docs ?? 0),
          internalDeliveryDocuments: Number(docCounts?.internal_delivery_docs ?? 0),
          customerPricesWithoutHistory: priceWithoutHistoryRows.length,
        },
        conflicts,
        plan,
        execution: {
          succeededCount: succeeded.length,
          failedCount: failed.length,
          succeeded,
          failed,
          nextResumeCursor,
        },
      };
    });
  }
}

