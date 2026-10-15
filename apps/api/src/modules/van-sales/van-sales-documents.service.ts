/**
 * Rep-facing documents: sales documents (+returns, print view) and the rep workspace read model.
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
import { InventoryService } from '../inventory/inventory.service.js';
import { SequencesService } from '../platform-services/index.js';
import { SalesService, type SalesLineInput } from '../sales/sales.service.js';

import { rows, first, str, dec, iso, buildZatcaTlvBase64 } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';

@Injectable()
export class VanSalesDocumentsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly inventory: InventoryService,
    private readonly sequences: SequencesService,
    private readonly sales: SalesService,
    private readonly shared: VanSalesSharedService,
    private readonly reporting: VanSalesReportingService
  ) {}

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
        return this.reporting.dashboard(tenantId);
      }
    }

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const policy = await this.shared.loadTenantPolicyInTx(tx, tenantId);

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
      await this.shared.assertVanWarehouseNotSettlingInTx(tx, tenantId, {
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

      const resolvedBranchId = await this.shared.resolveDefaultBranchIdInTx(
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
          const salesProfile = await this.shared.resolvePostingProfileOrNullInTx(
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

    return this.reporting.dashboard(tenantId);
  }

  async repWorkspace(tenantId: string, membershipId: string | null) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rep = await this.shared.resolveSalesmanForMembershipInTx(tx, tenantId, membershipId);
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

      const balances = await this.shared.officialStockBalancesInTx(tx, tenantId, {
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
      if (existing) return this.reporting.dashboard(tenantId);
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
        : await this.shared.resolveDefaultBranchIdInTx(tx, tenantId, null, vanWarehouseId);
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

      return this.reporting.dashboard(tenantId);
    });
  }

  /**
   * Phase 6: Resumable Dry-Run & Safe Backfill Tool for Legacy Van Sales Data (`أداة فحص ومطابقة البيانات القديمة`).
   * - Defaults strictly to `mode: 'dry_run'` (zero writes).
   * - Never classifies or deletes records by name, date, or missing audit logs.
   * - Previews counts, differences, conflicts, and resumable backfill plan.
   */
}
