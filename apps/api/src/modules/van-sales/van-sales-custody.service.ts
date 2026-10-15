/**
 * Custody settlement: shift closing, approval, the stock-settlement engine, customer collections, and the salesmen/custody view.
 *
 * M1 decomposition (see ./README.md): extracted verbatim from the former van-sales.service.ts —
 * pure code movement, no behavior change.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AccountingService } from '../accounting/accounting.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { MembershipsService } from '../platform/tenancy/memberships.service.js';
import { RolesService } from '../platform/tenancy/roles.service.js';
import { NotificationsService } from '../platform-services/index.js';
import { SalesService } from '../sales/sales.service.js';
import { TreasuryService } from '../treasury/treasury.service.js';

import { rows, first, str, dec } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';
import { VanSalesPricingService } from './van-sales-pricing.service.js';

@Injectable()
export class VanSalesCustodyService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly accounting: AccountingService,
    private readonly inventory: InventoryService,
    private readonly memberships: MembershipsService,
    private readonly roles: RolesService,
    private readonly notifications: NotificationsService,
    private readonly sales: SalesService,
    private readonly treasury: TreasuryService,
    private readonly shared: VanSalesSharedService,
    private readonly reporting: VanSalesReportingService,
    private readonly pricing: VanSalesPricingService
  ) {}

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
      const policy = await this.shared.loadTenantPolicyInTx(tx, tenantId);
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
      const unitChargePrice = await this.pricing.resolveShortageUnitPriceInTx(
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

    return this.reporting.dashboard(tenantId);
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
      const policy = await this.shared.loadTenantPolicyInTx(tx, tenantId);
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

      const unitChargePrice = await this.pricing.resolveShortageUnitPriceInTx(
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
        const lot = await this.shared.resolveCountLotInTx(tx, tenantId, {
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
        const damageBranchId = await this.shared.resolveDefaultBranchIdInTx(
          tx,
          tenantId,
          loadOrder.branch_id ? str(loadOrder.branch_id) : null,
          warehouseId,
        );
        const stockProfile = damageBranchId
          ? await this.shared.resolvePostingProfileOrNullInTx(tx, tenantId, damageBranchId, 'stock_voucher')
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
        branchId: await this.shared.resolveDefaultBranchIdInTx(
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

    return this.reporting.dashboard(tenantId);
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
            this.shared.resolveCountLotInTx(tx, tenantId, {
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

      await this.shared.notifyAccountantsInTx(tx, tenantId, {
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
        branchId: await this.shared.resolveDefaultBranchIdInTx(
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
            this.shared.resolveCountLotInTx(tx, tenantId, {
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
      return this.reporting.dashboard(tenantId);
    }

    await this.runStockSettlement(tenantId, userId, loadOrderId, plan, {
      settleStockAdjustment: body.settleStockAdjustment === true,
    });
    return this.reporting.dashboard(tenantId);
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
        return this.reporting.dashboard(tenantId);
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
        const profile = await this.shared.resolvePostingProfileOrNullInTx(
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

    return this.reporting.dashboard(tenantId);
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
}
