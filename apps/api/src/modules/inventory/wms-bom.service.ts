import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  binBalances,
  binTransfers,
  bomLines,
  boms,
  inventoryTransactions,
  itemLots,
  items,
  manufacturingMoves,
  manufacturingOrders,
  stockBalances,
  warehouseBins,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
  type RecipeLine,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AccountingService } from '../accounting/accounting.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { SequencesService } from '../platform-services/index.js';

import { InventoryService } from './inventory.service.js';
import { postProductionJournalInTx } from './production-posting.js';
import { resolveOutputLotInTx, type OutputLotInput } from './production-output-lot.js';
import {
  WmsRuleError,
  advanceProduction,
  applyBinCount,
  applyBinIssue,
  applyBinReceipt,
  applyBinTransfer,
  assertBom,
  componentDemand,
  finishedGoodsCost,
  type BinQty,
  type BinRef,
  type OrderStatus,
} from './wms-bom.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIN_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export type BinInput = {
  warehouseId: string;
  code: string;
  zone?: string;
  aisle?: string;
  rack?: string;
  level?: string;
};

export type BinMoveInput = {
  itemId: string;
  qty: string;
  lotId?: string | null;
  unitCost?: string;
};

export type BinTransferInput = {
  fromBinId: string;
  toBinId: string;
  itemId: string;
  qty: string;
  lotId?: string | null;
};

export type BinCountInput = {
  binId: string;
  itemId: string;
  countedQty: string;
  lotId?: string | null;
  unitCost?: string;
};

export type BomInput = {
  productItemId: string;
  name: string;
  version?: number;
  lines: Array<{ componentItemId: string; qty: string; scrapPercent?: string; unitId?: string }>;
};

export type ManufacturingOrderInput = {
  bomId: string;
  warehouseId: string;
  qty: string;
};

export type ProduceInput = {
  qty: string;
  componentBinId?: string;
  outputBinId?: string;
  /**
   * 🏷️ دفعة الناتج — رقم الدفعة التي ينتمي إليها الإنتاج (وتاريخ إنتاجها اختياراً). صنفٌ
   * يُتتبَّع بالدفعات لا يستلمه المخزون بلا `lot_id`، وبلا هذا الحقل كان إنتاجه بأمر تصنيع
   * رسمي مستحيلاً (انظر `production-output-lot.ts`).
   */
  outputLot?: OutputLotInput;
};

type LockedBin = BinRef & { code: string };

function asDomain<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WmsRuleError) throw new DomainError(error.code, error.message, 422);
    throw error;
  }
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function actorId() {
  return tryGetAuthContext()?.userId ?? null;
}

function positiveDecimal(value: string, code: string, message: string) {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite() || parsed.lte(0)) throw new Error('invalid');
    return parsed;
  } catch {
    throw new DomainError(code, message, 422);
  }
}

function moneyText(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite() || parsed.lt(0)) throw new Error('invalid');
    return parsed.toFixed(4);
  } catch {
    throw new DomainError('UNIT_COST_INVALID', 'Unit cost cannot be negative', 422);
  }
}

function recipeOf(value: unknown): RecipeLine[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) throw new DomainError('ORDER_RECIPE_INVALID', 'The order recipe is unreadable', 422);
  return parsed.map((line) => {
    const row = line as Partial<RecipeLine>;
    if (!row.componentItemId || row.qty === undefined) {
      throw new DomainError('ORDER_RECIPE_INVALID', 'The order recipe is unreadable', 422);
    }
    return {
      componentItemId: row.componentItemId,
      qty: String(row.qty),
      scrapPercent: String(row.scrapPercent ?? '0'),
    };
  });
}

function toBinQty(rows: BinQty[]): BinQty[] {
  return rows.map((row) => ({
    binId: row.binId,
    itemId: row.itemId,
    lotId: row.lotId,
    quantity: row.quantity,
  }));
}

@Injectable()
export class WmsBomService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly inventory: InventoryService,
    private readonly sequences: SequencesService,
    // 🏭 ترحيل الإنتاج الاختياري (PHASE_E) — يُستعملان معاً في `production-posting.ts` وحده.
    private readonly accounting: AccountingService,
    private readonly profiles: PostingProfilesService,
  ) {}

  listBins(tenantId: string, warehouseId?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(warehouseBins)
        .where(and(eq(warehouseBins.tenantId, tenantId), warehouseId ? eq(warehouseBins.warehouseId, warehouseId) : undefined))
        .orderBy(warehouseBins.code)
        .limit(500),
    );
  }

  createBin(tenantId: string, input: BinInput) {
    const code = input.code.trim();
    if (!BIN_CODE.test(code)) throw new DomainError('BIN_CODE_INVALID', 'Bin code must look like A-01-01', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const warehouse = await this.warehouse(tx, tenantId, input.warehouseId);
      const [taken] = await tx
        .select({ id: warehouseBins.id })
        .from(warehouseBins)
        .where(and(eq(warehouseBins.tenantId, tenantId), eq(warehouseBins.warehouseId, warehouse.id), eq(warehouseBins.code, code)));
      if (taken) throw new DomainError('BIN_CODE_TAKEN', 'This bin code already exists in the warehouse', 409);
      const id = newId();
      await tx.insert(warehouseBins).values({
        id,
        tenantId,
        warehouseId: warehouse.id,
        code,
        zone: blank(input.zone),
        aisle: blank(input.aisle),
        rack: blank(input.rack),
        level: blank(input.level),
        isActive: true,
        createdBy: actorId(),
      });
      return this.bin(tx, tenantId, id);
    });
  }

  setBinActive(tenantId: string, binId: string, isActive: boolean) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.lockBin(tx, tenantId, binId);
      await tx
        .update(warehouseBins)
        .set({ isActive, updatedAt: new Date(), updatedBy: actorId() })
        .where(and(eq(warehouseBins.tenantId, tenantId), eq(warehouseBins.id, binId)));
      return this.bin(tx, tenantId, binId);
    });
  }

  listBalances(tenantId: string, filters: { warehouseId?: string; binId?: string; itemId?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: binBalances.id,
          binId: binBalances.binId,
          binCode: warehouseBins.code,
          warehouseId: warehouseBins.warehouseId,
          zone: warehouseBins.zone,
          itemId: binBalances.itemId,
          itemSku: items.sku,
          itemName: items.nameAr,
          lotId: binBalances.lotId,
          quantity: binBalances.quantity,
        })
        .from(binBalances)
        .innerJoin(warehouseBins, and(eq(warehouseBins.id, binBalances.binId), eq(warehouseBins.tenantId, tenantId)))
        .innerJoin(items, and(eq(items.id, binBalances.itemId), eq(items.tenantId, tenantId)))
        .where(
          and(
            eq(binBalances.tenantId, tenantId),
            filters.warehouseId ? eq(warehouseBins.warehouseId, filters.warehouseId) : undefined,
            filters.binId ? eq(binBalances.binId, filters.binId) : undefined,
            filters.itemId ? eq(binBalances.itemId, filters.itemId) : undefined,
          ),
        )
        .orderBy(warehouseBins.code, items.sku)
        .limit(500),
    );
  }

  listTransfers(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(binTransfers)
        .where(eq(binTransfers.tenantId, tenantId))
        .orderBy(desc(binTransfers.createdAt))
        .limit(100),
    );
  }

  receive(tenantId: string, binId: string, input: BinMoveInput) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const bin = await this.lockBin(tx, tenantId, binId);
      const lotId = await this.prepareItem(tx, tenantId, input.itemId, input.lotId);
      const rows = await this.quantities(tx, tenantId, [bin.id]);
      const next = asDomain(() => applyBinReceipt(rows, bin, { itemId: input.itemId, lotId, qty: input.qty }));
      const unitCost = moneyText(input.unitCost) ?? (await this.lookupAverage(tx, tenantId, bin.warehouseId, input.itemId));
      await this.inventory.recordInTx(tx, tenantId, [
        {
          itemId: input.itemId,
          warehouseId: bin.warehouseId,
          qty: new Decimal(input.qty).toFixed(4),
          unitCost,
          lotId: lotId ?? undefined,
          direction: 'in',
          docType: 'bin_receipt',
          docId: bin.id,
          lineId: newId(),
        },
      ]);
      await this.persistQty(tx, tenantId, bin.id, input.itemId, lotId, qtyOf(next, bin.id, input.itemId, lotId));
      return this.balanceView(tx, tenantId, bin.id, input.itemId, lotId);
    });
  }

  issue(tenantId: string, binId: string, input: BinMoveInput) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const bin = await this.lockBin(tx, tenantId, binId);
      const lotId = await this.prepareItem(tx, tenantId, input.itemId, input.lotId);
      const rows = await this.quantities(tx, tenantId, [bin.id]);
      const next = asDomain(() => applyBinIssue(rows, bin, { itemId: input.itemId, lotId, qty: input.qty }));
      await this.inventory.recordInTx(tx, tenantId, [
        {
          itemId: input.itemId,
          warehouseId: bin.warehouseId,
          qty: new Decimal(input.qty).toFixed(4),
          lotId: lotId ?? undefined,
          direction: 'out',
          docType: 'bin_issue',
          docId: bin.id,
          lineId: newId(),
        },
      ]);
      await this.persistQty(tx, tenantId, bin.id, input.itemId, lotId, qtyOf(next, bin.id, input.itemId, lotId));
      return this.balanceView(tx, tenantId, bin.id, input.itemId, lotId);
    });
  }

  transfer(tenantId: string, input: BinTransferInput) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [from, to] = await this.lockPair(tx, tenantId, input.fromBinId, input.toBinId);
      const lotId = await this.prepareItem(tx, tenantId, input.itemId, input.lotId);
      const rows = await this.quantities(tx, tenantId, [from.id, to.id]);
      const next = asDomain(() => applyBinTransfer(rows, from, to, { itemId: input.itemId, lotId, qty: input.qty }));
      await this.persistQty(tx, tenantId, from.id, input.itemId, lotId, qtyOf(next, from.id, input.itemId, lotId));
      await this.persistQty(tx, tenantId, to.id, input.itemId, lotId, qtyOf(next, to.id, input.itemId, lotId));
      await tx.insert(binTransfers).values({
        id: newId(),
        tenantId,
        fromBinId: from.id,
        toBinId: to.id,
        itemId: input.itemId,
        lotId,
        quantity: new Decimal(input.qty).toFixed(4),
        createdBy: actorId(),
      });
      return {
        from: await this.balanceView(tx, tenantId, from.id, input.itemId, lotId),
        to: await this.balanceView(tx, tenantId, to.id, input.itemId, lotId),
      };
    });
  }

  count(tenantId: string, input: BinCountInput) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const bin = await this.lockBin(tx, tenantId, input.binId);
      const lotId = await this.prepareItem(tx, tenantId, input.itemId, input.lotId);
      const rows = await this.quantities(tx, tenantId, [bin.id]);
      const counted = asDomain(() => applyBinCount(rows, bin, { itemId: input.itemId, lotId, countedQty: input.countedQty }));
      const delta = new Decimal(counted.delta);
      if (delta.gt(0)) {
        const unitCost = moneyText(input.unitCost) ?? (await this.lookupAverage(tx, tenantId, bin.warehouseId, input.itemId));
        await this.inventory.recordInTx(tx, tenantId, [
          {
            itemId: input.itemId,
            warehouseId: bin.warehouseId,
            qty: delta.toFixed(4),
            unitCost,
            lotId: lotId ?? undefined,
            direction: 'in',
            docType: 'bin_count',
            docId: bin.id,
            lineId: newId(),
          },
        ]);
      } else if (delta.lt(0)) {
        await this.inventory.recordInTx(tx, tenantId, [
          {
            itemId: input.itemId,
            warehouseId: bin.warehouseId,
            qty: delta.abs().toFixed(4),
            lotId: lotId ?? undefined,
            direction: 'out',
            docType: 'bin_count',
            docId: bin.id,
            lineId: newId(),
          },
        ]);
      }
      await this.persistQty(tx, tenantId, bin.id, input.itemId, lotId, qtyOf(counted.rows, bin.id, input.itemId, lotId));
      return this.balanceView(tx, tenantId, bin.id, input.itemId, lotId);
    });
  }

  listBoms(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const cards = await tx.select().from(boms).where(eq(boms.tenantId, tenantId)).orderBy(desc(boms.createdAt)).limit(200);
      if (!cards.length) return [];
      const lines = await tx
        .select()
        .from(bomLines)
        .where(and(eq(bomLines.tenantId, tenantId), inArray(bomLines.bomId, cards.map((card) => card.id))));
      return cards.map((card) => ({ ...card, lines: lines.filter((line) => line.bomId === card.id) }));
    });
  }

  createBom(tenantId: string, input: BomInput) {
    const name = input.name.trim();
    if (!name || name.length > 120) throw new DomainError('BOM_NAME_INVALID', 'The bill of materials needs a name', 422);
    const lines = input.lines.map((line) => ({
      componentItemId: line.componentItemId,
      qty: line.qty,
      scrapPercent: line.scrapPercent,
    }));
    asDomain(() => assertBom(input.productItemId, lines));
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.knownItems(tx, tenantId, [input.productItemId, ...lines.map((line) => line.componentItemId)]);
      const version = input.version ?? (await this.nextVersion(tx, tenantId, input.productItemId));
      if (!Number.isInteger(version) || version < 1) throw new DomainError('BOM_VERSION_INVALID', 'Version must be a positive integer', 422);
      const [taken] = await tx
        .select({ id: boms.id })
        .from(boms)
        .where(and(eq(boms.tenantId, tenantId), eq(boms.productItemId, input.productItemId), eq(boms.version, version)));
      if (taken) throw new DomainError('BOM_VERSION_TAKEN', 'This version already exists for the product', 409);
      const id = newId();
      await tx.insert(boms).values({
        id,
        tenantId,
        productItemId: input.productItemId,
        name,
        version,
        isActive: true,
        createdBy: actorId(),
      });
      await tx.insert(bomLines).values(
        input.lines.map((line) => ({
          id: newId(),
          tenantId,
          bomId: id,
          componentItemId: line.componentItemId,
          qty: new Decimal(line.qty).toFixed(4),
          unitId: line.unitId ?? null,
          scrapPercent: new Decimal(line.scrapPercent ?? 0).toFixed(4),
        })),
      );
      return this.bom(tx, tenantId, id);
    });
  }

  listOrders(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const orders = await tx
        .select()
        .from(manufacturingOrders)
        .where(eq(manufacturingOrders.tenantId, tenantId))
        .orderBy(desc(manufacturingOrders.createdAt))
        .limit(200);
      return this.withPlans(tx, tenantId, orders);
    });
  }

  getOrder(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [order] = await tx
        .select()
        .from(manufacturingOrders)
        .where(and(eq(manufacturingOrders.tenantId, tenantId), eq(manufacturingOrders.id, id)));
      if (!order) throw new DomainError('MANUFACTURING_ORDER_NOT_FOUND', 'Manufacturing order was not found', 404);
      const [planned] = await this.withPlans(tx, tenantId, [order]);
      return planned;
    });
  }

  createOrder(tenantId: string, input: ManufacturingOrderInput) {
    const planned = positiveDecimal(input.qty, 'ORDER_QTY_INVALID', 'Planned quantity must be greater than zero');
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [bom] = await tx.select().from(boms).where(and(eq(boms.tenantId, tenantId), eq(boms.id, input.bomId)));
      if (!bom) throw new DomainError('BOM_NOT_FOUND', 'Bill of materials was not found', 404);
      if (!bom.isActive) throw new DomainError('BOM_INACTIVE', 'This bill of materials is inactive', 422);
      const warehouse = await this.warehouse(tx, tenantId, input.warehouseId);
      const lines = await tx.select().from(bomLines).where(and(eq(bomLines.tenantId, tenantId), eq(bomLines.bomId, bom.id)));
      const recipe: RecipeLine[] = lines.map((line) => ({
        componentItemId: line.componentItemId,
        qty: line.qty,
        scrapPercent: line.scrapPercent,
      }));
      asDomain(() => assertBom(bom.productItemId, recipe));
      const allocated = await this.sequences.next(
        { tenantId, branchId: warehouse.branchId, docType: 'manufacturing_order' },
        tx,
        { prefix: 'MF-', padding: 6 },
      );
      const id = newId();
      await tx.insert(manufacturingOrders).values({
        id,
        tenantId,
        bomId: bom.id,
        warehouseId: warehouse.id,
        branchId: warehouse.branchId,
        number: allocated.display,
        productItemId: bom.productItemId,
        qtyPlanned: planned.toFixed(4),
        qtyProduced: '0.0000',
        status: 'draft',
        costTotal: '0.0000',
        recipe,
        createdBy: actorId(),
      });
      return this.getOrderInTx(tx, tenantId, id);
    });
  }

  produce(tenantId: string, orderId: string, input: ProduceInput) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const order = await this.lockOrder(tx, tenantId, orderId);
      const recipe = recipeOf(order.recipe);
      const step = asDomain(() =>
        advanceProduction(
          { qtyPlanned: order.qtyPlanned, qtyProduced: order.qtyProduced, status: order.status },
          input.qty,
        ),
      );
      const demand = asDomain(() => componentDemand(recipe, input.qty));
      if (demand.length === 0) throw new DomainError('BOM_COMPONENTS_REQUIRED', 'The order has no components', 422);
      const produceQty = positiveDecimal(input.qty, 'PRODUCE_QTY_INVALID', 'Produced quantity must be greater than zero');
      const componentBin = input.componentBinId ? await this.lockBin(tx, tenantId, input.componentBinId) : null;
      const outputBin = input.outputBinId ? await this.lockBin(tx, tenantId, input.outputBinId) : null;
      if (componentBin && componentBin.warehouseId !== order.warehouseId) {
        throw new DomainError('BIN_WAREHOUSE_MISMATCH', 'Component bin must belong to the order warehouse', 422);
      }
      if (outputBin && outputBin.warehouseId !== order.warehouseId) {
        throw new DomainError('BIN_WAREHOUSE_MISMATCH', 'Output bin must belong to the order warehouse', 422);
      }
      if (componentBin) await this.issueComponentsFromBin(tx, tenantId, componentBin, demand);

      const consumed = await this.inventory.recordInTx(
        tx,
        tenantId,
        demand.map((line) => ({
          itemId: line.componentItemId,
          warehouseId: order.warehouseId,
          qty: line.qty,
          direction: 'out' as const,
          docType: 'manufacturing_order',
          docId: order.id,
          lineId: newId(),
        })),
      );
      const charged = await tx
        .select()
        .from(inventoryTransactions)
        .where(and(eq(inventoryTransactions.tenantId, tenantId), inArray(inventoryTransactions.id, consumed.transactionIds)));
      const movedValue = charged.reduce((sum, row) => sum.plus(row.totalCost), new Decimal(0));
      const unitCostValue = movedValue.div(produceQty);

      // 🏷️ دفعة الناتج: رقمُ المستدعي (دفعة المخبز) وإلا رقم الأمر نفسه.
      const outputLotId = await resolveOutputLotInTx(tx, tenantId, {
        itemId: order.productItemId,
        lot: input.outputLot,
        orderNumber: order.number,
      });

      await this.inventory.recordInTx(tx, tenantId, [
        {
          itemId: order.productItemId,
          warehouseId: order.warehouseId,
          qty: produceQty.toFixed(4),
          unitCost: unitCostValue.toFixed(4),
          lotId: outputLotId ?? undefined,
          direction: 'in',
          docType: 'manufacturing_order',
          docId: order.id,
          lineId: newId(),
        },
      ]);
      if (outputBin) {
        const rows = await this.quantities(tx, tenantId, [outputBin.id]);
        const next = asDomain(() => applyBinReceipt(rows, outputBin, { itemId: order.productItemId, qty: produceQty.toFixed(4) }));
        await this.persistQty(
          tx,
          tenantId,
          outputBin.id,
          order.productItemId,
          null,
          qtyOf(next, outputBin.id, order.productItemId, null),
        );
      }

      await tx.insert(manufacturingMoves).values([
        ...charged.map((row) => ({
          id: newId(),
          tenantId,
          orderId: order.id,
          itemId: row.itemId,
          type: 'consume',
          qty: row.qty,
          unitCost: row.unitCost,
          cost: row.totalCost,
        })),
        {
          id: newId(),
          tenantId,
          orderId: order.id,
          itemId: order.productItemId,
          type: 'produce',
          qty: produceQty.toFixed(4),
          unitCost: unitCostValue.toFixed(4),
          cost: movedValue.toFixed(4),
        },
      ]);
      await tx
        .update(manufacturingOrders)
        .set({
          qtyProduced: step.qtyProduced,
          status: step.status,
          costTotal: new Decimal(order.costTotal).plus(movedValue).toFixed(4),
          updatedAt: new Date(),
          updatedBy: actorId(),
        })
        .where(and(eq(manufacturingOrders.tenantId, tenantId), eq(manufacturingOrders.id, order.id)));

      /**
       * 🏭 قيد الإنتاج — اختياري ومحايد افتراضياً.
       *
       * القيمة المُرحَّلة هي `movedValue` نفسها: ما خرج من الرفّ كمكوّنات بالتكلفة المتوسطة
       * الفعلية، وهو بالضبط ما دخل به المنتج التام (`unitCostValue = movedValue / produceQty`).
       * فإن ربطت المنشأة حسابَي المواد الخام والمنتج التام صار للفصل أثر في الدفتر، وإن لم
       * تربط بقي الإنتاج محايداً كما كان. الطرف الواحد وحده مرفوض: لا قيد بنصف خريطة.
       */
      const [warehouseRow] = await tx
        .select({ branchId: warehouses.branchId })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, order.warehouseId)));
      const posting = await postProductionJournalInTx(tx, tenantId, {
        accounting: this.accounting,
        profiles: this.profiles,
      }, {
        docType: 'manufacturing_order',
        orderId: order.id,
        orderNumber: order.number,
        branchId: warehouseRow?.branchId ?? null,
        consumedValue: movedValue,
        // الإنتاج الجزئي المتكرر على الأمر نفسه ⇒ خطوةٌ مفتاحها ما قبل وما بعد.
        stepKey: `${order.qtyProduced}_${step.qtyProduced}`,
      });

      const produced = await this.getOrderInTx(tx, tenantId, order.id);
      if (!produced) {
        throw new DomainError('MANUFACTURING_ORDER_NOT_FOUND', 'Manufacturing order was not found', 404);
      }
      return { ...produced, ...posting };
    });
  }

  private async issueComponentsFromBin(
    tx: DrizzleTx,
    tenantId: string,
    bin: BinRef,
    demand: Array<{ componentItemId: string; qty: string }>,
  ) {
    let rows = await this.quantities(tx, tenantId, [bin.id]);
    for (const line of demand) {
      rows = asDomain(() => applyBinIssue(rows, bin, { itemId: line.componentItemId, qty: line.qty }));
      await this.persistQty(tx, tenantId, bin.id, line.componentItemId, null, qtyOf(rows, bin.id, line.componentItemId, null));
    }
  }

  private async withPlans(
    tx: DrizzleTx,
    tenantId: string,
    orders: Array<typeof manufacturingOrders.$inferSelect>,
  ) {
    if (!orders.length) return [];
    const componentIds = [...new Set(orders.flatMap((order) => recipeOf(order.recipe).map((line) => line.componentItemId)))];
    const averages = new Map<string, string>();
    if (componentIds.length) {
      const stock = await tx
        .select({
          warehouseId: stockBalances.warehouseId,
          itemId: stockBalances.itemId,
          quantity: stockBalances.quantity,
          averageCost: stockBalances.averageCost,
        })
        .from(stockBalances)
        .where(and(eq(stockBalances.tenantId, tenantId), inArray(stockBalances.itemId, componentIds)));
      for (const row of stock) {
        if (new Decimal(row.quantity).gt(0)) averages.set(`${row.warehouseId}:${row.itemId}`, row.averageCost);
      }
    }
    const moves = await tx
      .select()
      .from(manufacturingMoves)
      .where(and(eq(manufacturingMoves.tenantId, tenantId), inArray(manufacturingMoves.orderId, orders.map((order) => order.id))));
    return orders.map((order) => {
      const recipe = recipeOf(order.recipe);
      const demand = asDomain(() => componentDemand(recipe, order.qtyPlanned));
      const averageMap = Object.fromEntries(
        demand.map((line) => [line.componentItemId, averages.get(`${order.warehouseId}:${line.componentItemId}`) ?? '0']),
      );
      const planned = asDomain(() => finishedGoodsCost(demand, averageMap, order.qtyPlanned));
      const produced = new Decimal(order.qtyProduced);
      return {
        ...order,
        recipe,
        plannedCost: planned.componentCost,
        plannedUnitCost: planned.unitCost,
        actualCost: order.costTotal,
        actualUnitCost: produced.gt(0) ? new Decimal(order.costTotal).div(produced).toFixed(4) : null,
        moves: moves.filter((move) => move.orderId === order.id),
      };
    });
  }

  private async getOrderInTx(tx: DrizzleTx, tenantId: string, id: string) {
    const [order] = await tx
      .select()
      .from(manufacturingOrders)
      .where(and(eq(manufacturingOrders.tenantId, tenantId), eq(manufacturingOrders.id, id)));
    if (!order) throw new DomainError('MANUFACTURING_ORDER_NOT_FOUND', 'Manufacturing order was not found', 404);
    const [planned] = await this.withPlans(tx, tenantId, [order]);
    return planned;
  }

  private async lockOrder(tx: DrizzleTx, tenantId: string, orderId: string) {
    const rows = rowsOf<{
      id: string;
      number: string;
      warehouseId: string;
      productItemId: string;
      qtyPlanned: string;
      qtyProduced: string;
      status: OrderStatus;
      costTotal: string;
      recipe: unknown;
    }>(await tx.execute(sql`
      SELECT id,
             number,
             warehouse_id AS "warehouseId",
             product_item_id AS "productItemId",
             qty_planned::text AS "qtyPlanned",
             qty_produced::text AS "qtyProduced",
             status,
             cost_total::text AS "costTotal",
             recipe
      FROM manufacturing_orders
      WHERE tenant_id = ${tenantId}::uuid AND id = ${orderId}::uuid
      FOR UPDATE
    `));
    const order = rows[0];
    if (!order) throw new DomainError('MANUFACTURING_ORDER_NOT_FOUND', 'Manufacturing order was not found', 404);
    if (order.status !== 'draft' && order.status !== 'in_progress' && order.status !== 'done') {
      throw new DomainError('ORDER_STATUS_INVALID', 'Manufacturing order status is not recognised', 422);
    }
    return order;
  }

  private async warehouse(tx: DrizzleTx, tenantId: string, warehouseId: string) {
    const [warehouse] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt)));
    if (!warehouse || !warehouse.isActive) throw new DomainError('WAREHOUSE_NOT_FOUND', 'Warehouse was not found', 404);
    return warehouse;
  }

  private async bin(tx: DrizzleTx, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(warehouseBins)
      .where(and(eq(warehouseBins.tenantId, tenantId), eq(warehouseBins.id, id)));
    if (!row) throw new DomainError('BIN_NOT_FOUND', 'Bin was not found', 404);
    return row;
  }

  private async lockBin(tx: DrizzleTx, tenantId: string, binId: string): Promise<LockedBin> {
    const rows = rowsOf<LockedBin>(await tx.execute(sql`
      SELECT id, warehouse_id AS "warehouseId", is_active AS "active", code
      FROM warehouse_bins
      WHERE tenant_id = ${tenantId}::uuid AND id = ${binId}::uuid
      FOR UPDATE
    `));
    const bin = rows[0];
    if (!bin) throw new DomainError('BIN_NOT_FOUND', 'Bin was not found', 404);
    return bin;
  }

  private async lockPair(tx: DrizzleTx, tenantId: string, fromId: string, toId: string) {
    const firstId = fromId < toId ? fromId : toId;
    const secondId = fromId < toId ? toId : fromId;
    const first = await this.lockBin(tx, tenantId, firstId);
    const second = await this.lockBin(tx, tenantId, secondId);
    return fromId === first.id ? [first, second] as const : [second, first] as const;
  }

  private async prepareItem(tx: DrizzleTx, tenantId: string, itemId: string, lotId: string | null | undefined) {
    const [item] = await tx
      .select({ id: items.id, trackLot: items.trackLot, deletedAt: items.deletedAt })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)));
    if (!item || item.deletedAt) throw new DomainError('ITEM_NOT_FOUND', 'Item was not found', 404);
    if (!lotId) {
      if (item.trackLot) throw new DomainError('LOT_REQUIRED', 'This item is tracked by lot', 422);
      return null;
    }
    const [lot] = await tx
      .select({ id: itemLots.id })
      .from(itemLots)
      .where(and(eq(itemLots.tenantId, tenantId), eq(itemLots.id, lotId), eq(itemLots.itemId, itemId)));
    if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot was not found for this item', 404);
    return lotId;
  }

  private async knownItems(tx: DrizzleTx, tenantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const known = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), inArray(items.id, unique), isNull(items.deletedAt)));
    if (known.length !== unique.length) throw new DomainError('ITEM_NOT_FOUND', 'One of the items was not found', 404);
  }

  private async nextVersion(tx: DrizzleTx, tenantId: string, productItemId: string) {
    const [highest] = await tx
      .select({ version: boms.version })
      .from(boms)
      .where(and(eq(boms.tenantId, tenantId), eq(boms.productItemId, productItemId)))
      .orderBy(desc(boms.version))
      .limit(1);
    return (highest?.version ?? 0) + 1;
  }

  private async lookupAverage(tx: DrizzleTx, tenantId: string, warehouseId: string, itemId: string) {
    const [stock] = await tx
      .select({ quantity: stockBalances.quantity, averageCost: stockBalances.averageCost })
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.warehouseId, warehouseId), eq(stockBalances.itemId, itemId)));
    if (stock && new Decimal(stock.quantity).gt(0)) return stock.averageCost;
    const [item] = await tx
      .select({ purchasePrice: items.purchasePrice })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)));
    return item?.purchasePrice ?? '0.0000';
  }

  private async quantities(tx: DrizzleTx, tenantId: string, binIds: string[]) {
    const rows = await tx
      .select({
        binId: binBalances.binId,
        itemId: binBalances.itemId,
        lotId: binBalances.lotId,
        quantity: binBalances.quantity,
      })
      .from(binBalances)
      .where(and(eq(binBalances.tenantId, tenantId), inArray(binBalances.binId, binIds)));
    return toBinQty(rows);
  }

  private async persistQty(
    tx: DrizzleTx,
    tenantId: string,
    binId: string,
    itemId: string,
    lotId: string | null,
    quantity: string,
  ) {
    const locked = rowsOf<{ id: string }>(await tx.execute(sql`
      SELECT id
      FROM bin_balances
      WHERE tenant_id = ${tenantId}::uuid
        AND bin_id = ${binId}::uuid
        AND item_id = ${itemId}::uuid
        AND lot_id IS NOT DISTINCT FROM ${lotId}::uuid
      FOR UPDATE
    `));
    const existing = locked[0];
    if (!existing) {
      await tx.execute(sql`
        INSERT INTO bin_balances (id, tenant_id, bin_id, item_id, lot_id, quantity, updated_at)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${binId}::uuid, ${itemId}::uuid, ${lotId}::uuid, ${quantity}, now())
      `);
      return;
    }
    await tx.execute(sql`
      UPDATE bin_balances
      SET quantity = ${quantity}, updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${existing.id}::uuid
    `);
  }

  private async balanceView(tx: DrizzleTx, tenantId: string, binId: string, itemId: string, lotId: string | null) {
    const rows = rowsOf<{ quantity: string }>(await tx.execute(sql`
      SELECT quantity::text AS quantity
      FROM bin_balances
      WHERE tenant_id = ${tenantId}::uuid
        AND bin_id = ${binId}::uuid
        AND item_id = ${itemId}::uuid
        AND lot_id IS NOT DISTINCT FROM ${lotId}::uuid
    `));
    return { binId, itemId, lotId, quantity: rows[0]?.quantity ?? '0.0000' };
  }

  private async bom(tx: DrizzleTx, tenantId: string, id: string) {
    const [card] = await tx.select().from(boms).where(and(eq(boms.tenantId, tenantId), eq(boms.id, id)));
    if (!card) throw new DomainError('BOM_NOT_FOUND', 'Bill of materials was not found', 404);
    const lines = await tx.select().from(bomLines).where(and(eq(bomLines.tenantId, tenantId), eq(bomLines.bomId, id)));
    return { ...card, lines };
  }
}

function blank(value: string | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function qtyOf(rows: BinQty[], binId: string, itemId: string, lotId: string | null) {
  const found = rows.find((row) => row.binId === binId && row.itemId === itemId && (row.lotId ?? null) === lotId);
  return found?.quantity ?? '0.0000';
}

export function requireUuid(value: unknown, field: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!UUID.test(text)) throw new DomainError('INVALID_ID', `${field} must be a UUID`, 422);
  return text;
}

export function optionalUuid(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireUuid(value, field);
}

export function textField(value: unknown) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}
