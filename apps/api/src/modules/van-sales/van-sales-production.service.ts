/**
 * Factory production batches (van-sales flavour) on top of the official production/WMS engines.
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
import { ProductionOrdersService } from '../inventory/production-orders.service.js';
import { WmsBomService } from '../inventory/wms-bom.service.js';
import { SequencesService } from '../platform-services/index.js';

import { rows, first, str, dec } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';

@Injectable()
export class VanSalesProductionService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly inventory: InventoryService,
    private readonly productionOrders: ProductionOrdersService,
    private readonly wmsBom: WmsBomService,
    private readonly sequences: SequencesService,
    private readonly shared: VanSalesSharedService,
    private readonly reporting: VanSalesReportingService
  ) {}

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
        return this.reporting.dashboard(tenantId);
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
      this.shared.resolveMainWarehouseIdInTx(tx, tenantId, body.warehouseId, body.branchId ?? null),
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
      const branchId = await this.shared.resolveDefaultBranchIdInTx(tx, tenantId, body.branchId ?? null, warehouseId);
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

    return this.reporting.dashboard(tenantId);
  }

  /**
   * Pillar 4 & 5 (Phase 5): Customer Price Tiers with Effective Dating & Immutable Price Audit History.
   */
}
