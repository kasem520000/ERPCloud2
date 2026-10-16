import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  inventoryTransactions,
  itemUnits,
  items,
  productionOrderComponents,
  productionOrders,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AccountingService } from '../accounting/accounting.service.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { SequencesService } from '../platform-services/index.js';
import { CatalogService } from '../organization/catalog/catalog.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';

import { InventoryService } from './inventory.service.js';
import { postProductionJournalInTx } from './production-posting.js';
import { resolveOutputLotInTx, type OutputLotInput } from './production-output-lot.js';

export type ProductionOrderInput = {
  branchId?: string;
  warehouseId: string;
  orderDate?: string;
  outputItemId: string;
  outputQty: string;
  /** 📄 رقم المرجع — the document this build answers. */
  referenceNo?: string;
  /** 📅 تاريخ المرجع — the date of the referenced document. */
  referenceDate?: string;
  /** 📐 الوحدة the produced quantity is counted in; defaults to the item's base unit. */
  unitId?: string;
  notes?: string;
  /**
   * Leave it out and the bill of materials on the item card fills it in, scaled to the
   * quantity being built — that is what makes the المكونات tab worth keeping.
   */
  components?: Array<{ itemId: string; qty: string; unitId?: string }>;
};

const dec = (input: string | number | null | undefined) => new Decimal(input ?? 0);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * أمر الإنتاج — turn components into a finished item.
 *
 * **M6.2 — إنتاج على مرحلتين:** `issue()` تصرف المكوّنات إلى الأرضية (draft →
 * in_progress) ويستلم `complete()` الناتج لاحقًا بتكلفة ما صُرف فعلاً. المسار الموروث
 * (draft → complete مباشرة) كما هو: لا سلوك يتغير لمنشأة قائمة. وقيمة المكوّنات بين
 * الخطوتين هي «تحت التشغيل» إن ربطت المنشأة `wipAccountId` — انظر `production-posting.ts`.
 *
 * The order is ledger-neutral **by default**: whatever value leaves the warehouse as
 * components re-enters it as the produced item, so with one inventory control account the
 * balance sheet does not move and no journal entry is owed. A tenant that keeps materials and
 * finished goods in different accounts says so in «الإعدادات ← الربط المحاسبي»
 * (`manufacturing_order`/`production_order` + `rawMaterialsAccountId`/`finishedGoodsAccountId`)
 * and `production-posting.ts` then posts «م. منتج تام ← م. مواد خام» for exactly that value;
 * mapping one side only is refused rather than half-posted. What *does* have to be right either
 * way is the cost handed to the
 * output. Components leave at the moving average the inventory service computes, and the
 * output is valued at exactly the total that left, divided by the produced quantity —
 * anything else silently invents or destroys inventory value, and the first place it
 * shows up is a wrong gross margin on whatever is later sold.
 */
@Injectable()
export class ProductionOrdersService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
    private readonly inventory: InventoryService,
    private readonly catalog: CatalogService,
    // 🏭 ترحيل الإنتاج الاختياري (PHASE_E) — يُستعملان معاً في `production-posting.ts` وحده.
    private readonly accounting: AccountingService,
    private readonly profiles: PostingProfilesService,
  ) {}

  async list(tenantId: string, filters: { status?: string; warehouseId?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(productionOrders)
        .where(and(
          eq(productionOrders.tenantId, tenantId),
          filters.status ? eq(productionOrders.status, filters.status) : undefined,
          filters.warehouseId ? eq(productionOrders.warehouseId, filters.warehouseId) : undefined,
        ))
        .orderBy(desc(productionOrders.createdAt))
        .limit(200);
      if (!rows.length) return [];
      const components = await tx.select().from(productionOrderComponents).where(and(eq(productionOrderComponents.tenantId, tenantId), inArray(productionOrderComponents.orderId, rows.map((row) => row.id))));
      return rows.map((row) => ({ ...row, components: components.filter((line) => line.orderId === row.id).sort((a, b) => a.lineNo - b.lineNo) }));
    });
  }

  async get(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.load(tx, tenantId, id));
  }

  async create(tenantId: string, input: ProductionOrderInput) {
    if (!input.warehouseId) throw new DomainError('WAREHOUSE_REQUIRED', 'A production order needs a warehouse', 422);
    if (!input.outputItemId) throw new DomainError('PRODUCTION_OUTPUT_REQUIRED', 'A production order needs an output item', 422);
    const outputQty = dec(input.outputQty);
    if (!outputQty.isFinite() || outputQty.lte(0)) throw new DomainError('PRODUCTION_OUTPUT_QTY_INVALID', 'The produced quantity must be greater than zero', 422);
    const drafted = (input.components ?? []).map((component) => ({
      itemId: component.itemId,
      qty: component.qty,
      unitId: component.unitId,
    }));

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [warehouse] = await tx.select().from(warehouses).where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, input.warehouseId)));
      if (!warehouse) throw new DomainError('WAREHOUSE_NOT_FOUND', 'Warehouse was not found', 404);

      // Nothing typed on the screen: read the bill of materials off the item card.
      const lines =
        drafted.length > 0
          ? drafted
          : await this.catalog.componentsFor(tx, tenantId, input.outputItemId, outputQty);
      const seen = new Set<string>();
      const components = lines.map((component, index) => {
        const qty = dec(component.qty);
        if (!qty.isFinite() || qty.lte(0)) throw new DomainError('PRODUCTION_COMPONENT_QTY_INVALID', 'Every component needs a quantity greater than zero', 422);
        if (component.itemId === input.outputItemId) throw new DomainError('PRODUCTION_COMPONENT_IS_OUTPUT', 'An item cannot be both a component and the output', 422);
        if (seen.has(component.itemId)) throw new DomainError('PRODUCTION_COMPONENT_DUPLICATE', 'Each component may appear only once; combine the quantities', 422);
        seen.add(component.itemId);
        return { lineNo: index + 1, itemId: component.itemId, qty: qty.toFixed(4), unitId: component.unitId ?? null };
      });
      if (components.length === 0)
        throw new DomainError(
          'PRODUCTION_COMPONENTS_REQUIRED',
          'A production order needs at least one component — either pass them or define them on the item card',
          422,
        );

      const referenced = [input.outputItemId, ...components.map((component) => component.itemId)];
      const known = await tx.select({ id: items.id, baseUnitId: items.baseUnitId }).from(items).where(and(eq(items.tenantId, tenantId), inArray(items.id, referenced)));
      if (known.length !== new Set(referenced).size) throw new DomainError('ITEM_NOT_FOUND', 'One of the items on this order was not found', 404);
      const outputItem = known.find((row) => row.id === input.outputItemId)!;
      // 📐 الوحدة — a unit the item does not carry has no ratio, so it cannot be honoured.
      const unitId = input.unitId ? await this.outputUnit(tx, tenantId, outputItem, input.unitId) : outputItem.baseUnitId;

      const allocated = await this.sequences.next({ tenantId, branchId: input.branchId ?? warehouse.branchId ?? undefined, docType: 'production_order' }, tx, { prefix: 'MO-', padding: 6 });
      await tx.insert(productionOrders).values({
        id,
        tenantId,
        branchId: input.branchId ?? warehouse.branchId,
        warehouseId: input.warehouseId,
        number: allocated.display,
        orderDate: input.orderDate ?? today(),
        status: 'draft',
        outputItemId: input.outputItemId,
        outputQty: outputQty.toFixed(4),
        unitId,
        referenceNo: input.referenceNo?.trim() || null,
        referenceDate: input.referenceDate || null,
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      });
      await tx.insert(productionOrderComponents).values(components.map((component) => ({ ...component, orderId: id, tenantId })));
      return this.load(tx, tenantId, id);
    });
  }

  /**
   * Consume the components, produce the output, and record what the output actually cost.
   *
   * `outputLot` names the batch the produced quantity belongs to (a lot-tracked item cannot be
   * received without one — see `production-output-lot.ts`); left out, the order's own number is
   * the lot.
   */
  /**
   * 🏭 M6.2 — الصرف إلى الأرضية: المكوّنات تخرج من المستودع بالمتوسط المتحرك، ويبقى
   * الأمر `in_progress` حتى يستلم `complete()` الناتج. القيمة الخارجة هي تكلفة الأمر
   * (componentCost)، وهي أيضًا ما يُرحَّل «تحت التشغيل ← مواد خام» إن رُبط الحسابان.
   */
  async issue(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const order = await this.load(tx, tenantId, id);
      if (order.status !== 'draft') throw new DomainError('PRODUCTION_ORDER_INVALID_STATUS', 'Only a draft production order can be issued to the floor', 409);

      const componentCost = await this.consumeComponents(tx, tenantId, id, order);

      const [warehouseRow] = await tx.select({ branchId: warehouses.branchId }).from(warehouses).where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, order.warehouseId)));
      const posting = await postProductionJournalInTx(tx, tenantId, {
        accounting: this.accounting,
        profiles: this.profiles,
      }, {
        docType: 'production_order',
        orderId: id,
        orderNumber: order.number,
        branchId: order.branchId ?? warehouseRow?.branchId ?? null,
        consumedValue: componentCost,
        stepKey: 'issue',
        stage: 'issue',
      });

      await tx.update(productionOrders)
        .set({ status: 'in_progress', issuedAt: new Date(), componentCost: componentCost.toFixed(4), wipPosted: posting.journalEntryId !== null, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(productionOrders.tenantId, tenantId), eq(productionOrders.id, id)));

      return { ...(await this.load(tx, tenantId, id)), ...posting };
    });
  }

  async complete(tenantId: string, id: string, options: { outputLot?: OutputLotInput } = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const order = await this.load(tx, tenantId, id);
      if (order.status !== 'draft' && order.status !== 'in_progress')
        throw new DomainError('PRODUCTION_ORDER_INVALID_STATUS', 'Only a draft or issued production order can be completed', 409);

      /** الصرف حدث في `issue()` — لا يُستهلك شيء مرتين؛ القيمة مجتمعة على الأمر نفسه. */
      const componentCost =
        order.status === 'in_progress'
          ? dec(order.componentCost)
          : await this.consumeComponents(tx, tenantId, id, order);
      const unitCost = componentCost.div(dec(order.outputQty));

      // 🏷️ الناتج صنفٌ يُتتبَّع بالدفعات؟ الدفعة تُحسم هنا (رقمُ المستدعي أو رقم الأمر) —
      // بلا `lot_id` ترفض الحركةَ خدمةُ المخزون نفسها.
      const outputLotId = await resolveOutputLotInTx(tx, tenantId, {
        itemId: order.outputItemId,
        lot: options.outputLot,
        orderNumber: order.number,
      });

      await this.inventory.recordInTx(tx, tenantId, [{
        itemId: order.outputItemId,
        warehouseId: order.warehouseId,
        qty: order.outputQty,
        unitId: order.unitId ?? undefined,
        unitCost: unitCost.toFixed(4),
        lotId: outputLotId ?? undefined,
        direction: 'in' as const,
        docType: 'production_order',
        docId: id,
        lineId: order.outputItemId,
      }]);

      await tx.update(productionOrders)
        .set({ status: 'completed', completedAt: new Date(), componentCost: componentCost.toFixed(4), unitCost: unitCost.toFixed(4), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(productionOrders.tenantId, tenantId), eq(productionOrders.id, id)));

      /**
       * 🏭 قيد الإنتاج — اختياري ومحايد افتراضياً (انظر `production-posting.ts`).
       *
       * `componentCost` هو ما خرج من الرفّ فعلاً بالتكلفة المتوسطة، وهو نفسه ما قُوّم به
       * الناتج (`unitCost = componentCost / outputQty`)، فالقيد — إن رُبط حساباه — ينقل القيمة
       * نفسها من المواد الخام إلى المنتج التام بلا رقمٍ مُخترع. والأمر يُكمل مرة واحدة
       * (الحالة `draft` وحدها تُكمل) فالمفتاح ثابت.
       *
       * M6.2: على أمرٍ مصروف (`in_progress`) يكون الصرف قد رُحِّل «تحت التشغيل ← مواد خام»
       * إن كان `wipPosted`، فيصفّي هذا القيد القيمةَ من حيث دخلت: «منتج تام ← تحت التشغيل».
       */
      const [warehouseRow] = await tx.select({ branchId: warehouses.branchId }).from(warehouses).where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, order.warehouseId)));
      const posting = await postProductionJournalInTx(tx, tenantId, {
        accounting: this.accounting,
        profiles: this.profiles,
      }, {
        docType: 'production_order',
        orderId: id,
        orderNumber: order.number,
        branchId: order.branchId ?? warehouseRow?.branchId ?? null,
        consumedValue: componentCost,
        stepKey: 'complete',
        stage: 'complete',
        wipPosted: order.wipPosted,
      });

      return { ...(await this.load(tx, tenantId, id)), ...posting };
    });
  }

  /**
   * الاستهلاك المشترك للمسارين: يصرف كل المكوّنات بالمتوسط المتحرك، يقيّد تكلفتها على
   * سطور الأمر، ويعيد إجمالي ما خرج من الرفّ فعلاً. `lineId` هو الصنف نفسه — فهرس التفرد
   * (tenant, doc_type, doc_id, line_id) يعني «حركة واحدة لكل صنف في الأمر»، وهو الضمان
   * الذي يمنع استهلاكًا مزدوجًا بين `issue` و`complete`.
   */
  private async consumeComponents(
    tx: DrizzleTx,
    tenantId: string,
    id: string,
    order: Awaited<ReturnType<ProductionOrdersService['load']>>,
  ): Promise<Decimal> {
    const out = await this.inventory.recordInTx(tx, tenantId, order.components.map((component) => ({
      itemId: component.itemId,
      warehouseId: order.warehouseId,
      qty: component.qty,
      unitId: component.unitId ?? undefined,
      direction: 'out' as const,
      docType: 'production_order',
      docId: id,
      lineId: component.itemId,
    })));

    // Read back what the moving average actually charged; the cost of the output is not
    // a guess, it is the sum of what left the shelf.
    const consumed = await tx.select().from(inventoryTransactions).where(and(eq(inventoryTransactions.tenantId, tenantId), inArray(inventoryTransactions.id, out.transactionIds)));
    for (const row of consumed) {
      const component = order.components.find((line) => line.itemId === row.itemId);
      if (!component) continue;
      await tx.update(productionOrderComponents)
        .set({ unitCost: row.unitCost, lineCost: row.totalCost })
        .where(and(eq(productionOrderComponents.tenantId, tenantId), eq(productionOrderComponents.orderId, id), eq(productionOrderComponents.lineNo, component.lineNo)));
    }
    return consumed.reduce((sum, row) => sum.plus(dec(row.totalCost)), new Decimal(0));
  }

  async cancel(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const order = await this.load(tx, tenantId, id);
      // Stock has already moved — on a completed order as the output, on an issued order
      // as the components on the floor; either way you reverse it with an adjustment, not
      // by rewriting history. An issued order must run to its completion.
      if (order.status !== 'draft') throw new DomainError('PRODUCTION_ORDER_INVALID_STATUS', 'Only a draft production order can be cancelled — an issued order already moved its components to the floor and must be completed', 409);
      await tx.update(productionOrders)
        .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(productionOrders.tenantId, tenantId), eq(productionOrders.id, id)));
      return this.load(tx, tenantId, id);
    });
  }

  /** A produced quantity may be counted in the item's base unit or any unit on its card. */
  private async outputUnit(
    tx: DrizzleTx,
    tenantId: string,
    outputItem: { id: string; baseUnitId: string },
    unitId: string,
  ) {
    if (unitId === outputItem.baseUnitId) return unitId;
    const [row] = await tx
      .select({ unitId: itemUnits.unitId })
      .from(itemUnits)
      .where(and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.itemId, outputItem.id), eq(itemUnits.unitId, unitId)));
    if (!row) throw new DomainError('PRODUCTION_UNIT_INVALID', 'The produced quantity must be counted in the item base unit or one of its own units', 422, { field: 'unitId' });
    return row.unitId;
  }

  private async load(tx: DrizzleTx, tenantId: string, id: string) {
    const [order] = await tx.select().from(productionOrders).where(and(eq(productionOrders.tenantId, tenantId), eq(productionOrders.id, id)));
    if (!order) throw new DomainError('PRODUCTION_ORDER_NOT_FOUND', 'Production order was not found', 404);
    const components = await tx.select().from(productionOrderComponents).where(and(eq(productionOrderComponents.tenantId, tenantId), eq(productionOrderComponents.orderId, id)));
    const [output] = await tx.select({ baseUnitId: items.baseUnitId }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, order.outputItemId)));
    return { ...order, unitId: order.unitId ?? output?.baseUnitId ?? null, components: components.sort((a, b) => a.lineNo - b.lineNo) };
  }
}
