/**
 * Cross-cutting in-transaction helpers shared by every van-sales saga service.
 *
 * M1 decomposition (see ./README.md): extracted verbatim from the former van-sales.service.ts —
 * pure code movement, no behavior change.
 */
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import { type DrizzleTx } from '@erp/database';

import { PostingProfilesService } from '../organization/index.js';
import { NotificationsService } from '../platform-services/index.js';

export function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

export function first(result: unknown): Record<string, unknown> | undefined {
  return rows(result)[0];
}

export function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function dec(value: unknown): Decimal {
  try {
    return new Decimal(value === null || value === undefined || value === '' ? 0 : String(value));
  } catch {
    return new Decimal(0);
  }
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

export function buildZatcaTlvBase64(params: {
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
export class VanSalesSharedService {
  constructor(
    private readonly postingProfiles: PostingProfilesService,
    private readonly notifications: NotificationsService
  ) {}

  async loadTenantPolicyInTx(
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

  async resolveDefaultBranchIdInTx(
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

  async resolveMainWarehouseIdInTx(
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

  async resolvePostingProfileOrNullInTx(
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

  async resolveSalesmanForMembershipInTx(
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

  async officialStockBalancesInTx(
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

  async assertVanWarehouseNotSettlingInTx(
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

  async resolveCountLotInTx(
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

  async notifyAccountantsInTx(
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
}
