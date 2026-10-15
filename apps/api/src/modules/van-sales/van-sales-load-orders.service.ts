/**
 * The load-order saga: creation + supply to the van, rep receipt confirmation/refusal, transit-difference decisions and cancellation.
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
import { InventoryService } from '../inventory/inventory.service.js';
import { NotificationsService, SequencesService } from '../platform-services/index.js';

import { rows, first, str, dec } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';

@Injectable()
export class VanSalesLoadOrdersService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly inventory: InventoryService,
    private readonly sequences: SequencesService,
    private readonly notifications: NotificationsService,
    private readonly shared: VanSalesSharedService,
    private readonly reporting: VanSalesReportingService
  ) {}

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
        return this.reporting.dashboard(tenantId);
      }
    }

    /**
     * التحقق المسبق — everything the official transfer needs, resolved before any write,
     * so a rejected supply never leaves a half-moved balance behind.
     */
    const plan = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.shared.loadTenantPolicyInTx(tx, tenantId);
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
        (await this.shared.resolveMainWarehouseIdInTx(
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

      const resolvedBranchId = await this.shared.resolveDefaultBranchIdInTx(
        tx,
        tenantId,
        body.branchId,
        effectiveWarehouseId,
      );

      // 🧊 لا توريد إلى سيارةٍ قيد تسوية الجرد: الكمية الجديدة ستدخل في فرق الجرد.
      await this.shared.assertVanWarehouseNotSettlingInTx(tx, tenantId, {
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

    return this.reporting.dashboard(tenantId);
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
      await this.shared.assertVanWarehouseNotSettlingInTx(tx, tenantId, {
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

    return this.reporting.dashboard(tenantId);
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
      await this.shared.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_receipt_discrepancy',
        title: `❌ رفض المندوب استلام التوريد (${str(order.number)})`,
        body: `${str(order.salesman_name)} رفض استلام ${dec(order.loaded_qty).toFixed(2)} كجم — أُعيدت الكمية رسمياً إلى المستودع المصدر. السبب: ${reason}`,
        href: '/van-sales?tab=loads',
      });
    });

    return this.reporting.dashboard(tenantId);
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
      await this.shared.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_receipt_discrepancy',
        title: `🚦 أُقفل فرق الاستلام (${str(order.number)})`,
        body: `${dec(order.discrepancy_qty).toFixed(2)} كجم — ${reason}`,
        href: '/van-sales?tab=loads',
      });
    });

    return this.reporting.dashboard(tenantId);
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
      await this.shared.notifyAccountantsInTx(tx, tenantId, {
        type: 'van_sales_supply_pending_receipt',
        title: `🗑️ أُلغي أمر تحميل (${str(order.number)})`,
        body: `${str(order.salesman_name)} — ${reason}. ${transferOutcome}.`,
        href: '/van-sales?tab=loads',
      });
    });

    return this.reporting.dashboard(tenantId);
  }

  /** إشعار أصحاب صلاحية الاعتماد — one query, one rule, reused by every exception path. */
}
