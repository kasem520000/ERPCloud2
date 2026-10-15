/**
 * Read models: the van-sales dashboard (also the load-order state snapshot consumed by the sagas) and the reports view.
 *
 * M1 decomposition (see ./README.md): extracted verbatim from the former van-sales.service.ts —
 * pure code movement, no behavior change.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import { rows, first, str, dec, iso } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';

@Injectable()
export class VanSalesReportingService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly shared: VanSalesSharedService
  ) {}

  async dashboard(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.shared.loadTenantPolicyInTx(tx, tenantId);

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
      const officialStock = await this.shared.officialStockBalancesInTx(tx, tenantId);
      const mainWarehouseId = await this.shared.resolveMainWarehouseIdInTx(tx, tenantId, null, null);
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
      const readinessBranchId = await this.shared.resolveDefaultBranchIdInTx(tx, tenantId, null, mainWarehouseId);
      const [salesProfile, transferProfile, voucherProfile] = await Promise.all([
        this.shared.resolvePostingProfileOrNullInTx(tx, tenantId, readinessBranchId, 'sales_invoice'),
        this.shared.resolvePostingProfileOrNullInTx(tx, tenantId, readinessBranchId, 'stock_transfer'),
        this.shared.resolvePostingProfileOrNullInTx(tx, tenantId, readinessBranchId, 'receipt_voucher'),
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
}
