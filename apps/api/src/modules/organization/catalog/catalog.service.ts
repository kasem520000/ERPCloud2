import { Injectable, Inject } from '@nestjs/common';
import { and, asc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import { Decimal } from 'decimal.js';
import {
  itemBarcodes,
  itemCategories,
  itemComponents,
  itemUnits,
  items,
  newId,
  taxGroups,
  unitsOfMeasure,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { CustomFieldsService } from '../../custom-fields/custom-fields.service.js';
import { UsageService } from '../../usage/index.js';

/** One line of a bill of materials. `ratio` is base units per one of `unitId`. */
export type ItemComponentRow = {
  itemId: string;
  componentItemId: string;
  sku: string;
  nameAr: string | null;
  qty: string;
  unitId: string;
  unitCode: string;
  unitNameAr: string | null;
  kind: string;
  warehouseId: string | null;
  warehouseName: string | null;
  baseUnitId: string;
};

export type ItemComponentInput = {
  componentItemId: string;
  qty: string;
  unitId?: string;
  kind?: 'component' | 'additive';
  warehouseId?: string | null;
};

export type CatalogItemInput = {
  sku: string;
  barcode?: string;
  nameAr: string;
  nameEn?: string;
  categoryId: string;
  baseUnitId: string;
  kind?: 'stock' | 'service' | 'composite';
  salePrice?: string;
  purchasePrice?: string;
  taxGroupId?: string;
  minQty?: string;
  maxQty?: string;
  trackLot?: boolean;
  trackSerial?: boolean;
};

/**
 * وحدات القياس المتعددة — the desktop `ItemUnits` table. `ratio` is **base units per one
 * of this unit** (desktop `perc`): a carton of 12 makes `ratio = 12`, and
 * `InventoryOper` moves `qty × ratio` base units, never the entered quantity.
 */
export type ItemUnitInput = {
  unitId: string;
  ratio: string;
  barcode?: string | null;
  salePrice?: string;
  purchasePrice?: string;
  isDefaultSale?: boolean;
  isDefaultPurchase?: boolean;
};
export type ItemUnitRow = {
  itemId: string;
  unitId: string;
  unitCode: string;
  unitNameAr: string;
  ratio: string;
  barcode: string | null;
  salePrice: string | null;
  purchasePrice: string | null;
  isDefaultSale: boolean;
  isDefaultPurchase: boolean;
};
export type ItemBarcodeInput = { barcode: string; unitId?: string | null };
export type ItemBarcodeRow = {
  barcode: string;
  itemId: string;
  unitId: string | null;
  unitNameAr: string | null;
  createdAt?: Date | string;
};

export type CategoryInput = { code: string; nameAr: string; nameEn?: string; parentId?: string };
export type UnitInput = { code: string; nameAr: string; nameEn?: string };
export type TaxGroupInput = {
  nameAr: string;
  nameEn?: string;
  rate: string;
  vatAccountId?: string;
  isInclusiveDefault?: boolean;
};

export type CatalogItemPatch = {
  sku?: string;
  barcode?: string | null;
  nameAr?: string;
  nameEn?: string | null;
  categoryId?: string;
  kind?: 'stock' | 'service' | 'composite';
  salePrice?: string;
  purchasePrice?: string;
  taxGroupId?: string | null;
  showInPos?: boolean;
  minQty?: string;
  maxQty?: string | null;
  trackLot?: boolean;
  trackSerial?: boolean;
};
export type CategoryPatch = {
  code?: string;
  nameAr?: string;
  nameEn?: string | null;
  parentId?: string | null;
};
export type UnitPatch = { code?: string; nameAr?: string; nameEn?: string | null };
export type TaxGroupPatch = {
  nameAr?: string;
  nameEn?: string | null;
  rate?: string;
  vatAccountId?: string | null;
  isInclusiveDefault?: boolean;
};

/**
 * A master-data card is editable, but not infinitely: once a row has been used by a
 * document, the fields that would silently rewrite history are frozen. For an item that
 * is its base unit — every stored quantity and moving-average cost is expressed in it, so
 * changing it after the fact would reinterpret movements that already happened. Names,
 * prices, barcode, category and tax group stay editable, because those are what people
 * actually need to correct.
 */
const IMMUTABLE_AFTER_USE = 'CATALOG_ITEM_IN_USE';

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly usage: UsageService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async listItems(tenantId: string, q?: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(items)
        .where(
          and(
            eq(items.tenantId, tenantId),
            isNull(items.deletedAt),
            q ? ilike(items.nameAr, `%${q}%`) : undefined,
          ),
        )
        .orderBy(asc(items.nameAr))
        .limit(100),
    );
    return this.customFields.decorate(tenantId, 'item', rows);
  }

  async createItem(tenantId: string, input: CatalogItemInput) {
    // P-C5: الأصناف مقياسٌ محدود.
    await this.usage.assertWithinLimit(tenantId, 'items');
    const id = newId();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.insert(items).values({
        id,
        tenantId,
        sku: input.sku,
        barcode: input.barcode,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        categoryId: input.categoryId,
        baseUnitId: input.baseUnitId,
        kind: input.kind ?? 'stock',
        salePrice: input.salePrice,
        purchasePrice: input.purchasePrice,
        taxGroupId: input.taxGroupId,
        minQty: input.minQty,
        maxQty: input.maxQty,
        trackLot: input.trackLot ?? false,
        trackSerial: input.trackSerial ?? false,
      });
    });
    return this.getItem(tenantId, id);
  }

  /**
   * Update an item card. `baseUnitId` is not in the patch type at all, so it cannot be
   * changed by mistake; `sku` is refused once the item has moved, because the SKU is what
   * printed documents and barcode labels already carry.
   */
  async updateItem(tenantId: string, id: string, patch: CatalogItemPatch) {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.requireItem(tx, tenantId, id);
      if (patch.sku && patch.sku !== current.sku && (await this.itemHasMovements(tx, tenantId, id))) {
        throw new DomainError(
          IMMUTABLE_AFTER_USE,
          'This item already has movements; its SKU can no longer be changed',
          409,
        );
      }
      await tx
        .update(items)
        .set({
          sku: patch.sku ?? current.sku,
          barcode: patch.barcode === undefined ? current.barcode : patch.barcode,
          nameAr: patch.nameAr ?? current.nameAr,
          nameEn: patch.nameEn === undefined ? current.nameEn : patch.nameEn,
          categoryId: patch.categoryId ?? current.categoryId,
          kind: patch.kind ?? current.kind,
          salePrice: patch.salePrice ?? current.salePrice,
          purchasePrice: patch.purchasePrice ?? current.purchasePrice,
          taxGroupId: patch.taxGroupId === undefined ? current.taxGroupId : patch.taxGroupId,
          showInPos: patch.showInPos ?? current.showInPos,
          minQty: patch.minQty ?? current.minQty,
          maxQty: patch.maxQty === undefined ? current.maxQty : patch.maxQty,
          trackLot: patch.trackLot ?? current.trackLot,
          trackSerial: patch.trackSerial ?? current.trackSerial,
          updatedAt: new Date(),
        })
        .where(and(eq(items.tenantId, tenantId), eq(items.id, id)));
    });
    return this.getItem(tenantId, id);
  }

  // --------------------------------------------------- وحدات القياس المتعددة

  /** The item's own unit, plus every unit it can be counted, sold or bought in. */
  async listItemUnits(tenantId: string, itemId: string): Promise<ItemUnitRow[]> {
    return withTenantTx(this.database.db, tenantId, (tx) => this.itemUnitRows(tx, tenantId, itemId));
  }

  /**
   * Reads the rows inside the caller's transaction. It has to: `withTenantTx` takes its
   * own connection, so a write made moments earlier in another call is invisible to a
   * fresh one — `setItemUnit` would answer with the row it had not yet committed.
   */
  private async itemUnitRows(tx: DrizzleTx, tenantId: string, itemId: string): Promise<ItemUnitRow[]> {
    const item = await this.requireItem(tx, tenantId, itemId);
    const rows = await tx
      .select({
        itemId: itemUnits.itemId,
        unitId: itemUnits.unitId,
        unitCode: unitsOfMeasure.code,
        unitNameAr: unitsOfMeasure.nameAr,
        ratio: itemUnits.ratio,
        barcode: itemUnits.barcode,
        salePrice: itemUnits.salePrice,
        purchasePrice: itemUnits.purchasePrice,
        isDefaultSale: itemUnits.isDefaultSale,
        isDefaultPurchase: itemUnits.isDefaultPurchase,
      })
      .from(itemUnits)
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, itemUnits.unitId))
      .where(and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.itemId, itemId)))
      .orderBy(asc(unitsOfMeasure.nameAr));
    // The base unit is always answerable, even when nobody configured it explicitly.
    const base = rows.find((row) => row.unitId === item.baseUnitId);
    const baseRow: ItemUnitRow = base ?? {
      itemId,
      unitId: item.baseUnitId,
      unitCode: '',
      unitNameAr: 'الوحدة الأساسية',
      ratio: '1',
      barcode: null,
      salePrice: item.salePrice ?? null,
      purchasePrice: item.purchasePrice ?? null,
      isDefaultSale: false,
      isDefaultPurchase: false,
    };
    return [baseRow, ...rows.filter((row) => row.unitId !== item.baseUnitId)];
  }

  /**
   * Define (or redefine) one unit of an item. The base unit cannot be given a ratio other
   * than 1 — it *is* the unit every other ratio is expressed against.
   */
  async setItemUnit(tenantId: string, itemId: string, input: ItemUnitInput): Promise<ItemUnitRow> {
    const ratio = new Decimal(input.ratio);
    if (!ratio.isFinite() || ratio.lte(0))
      throw new DomainError(
        'CATALOG_UNIT_RATIO_INVALID',
        'The conversion factor must be greater than zero',
        422,
        { field: 'ratio' },
      );
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const item = await this.requireItem(tx, tenantId, itemId);
      await this.requireUnit(tx, tenantId, input.unitId);
      if (input.unitId === item.baseUnitId && !ratio.eq(1)) {
        throw new DomainError(
          'CATALOG_UNIT_RATIO_INVALID',
          'The base unit always converts 1:1 — change the item’s base unit instead',
          422,
          { field: 'ratio' },
        );
      }
      if (input.isDefaultSale || input.isDefaultPurchase) {
        // Only one default per role, or the picker has no choice to make.
        await tx
          .update(itemUnits)
          .set(input.isDefaultSale ? { isDefaultSale: false } : { isDefaultPurchase: false })
          .where(and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.itemId, itemId)));
      }
      await tx
        .insert(itemUnits)
        .values({
          tenantId,
          itemId,
          unitId: input.unitId,
          ratio: ratio.toFixed(6),
          barcode: input.barcode ?? null,
          salePrice: input.salePrice,
          purchasePrice: input.purchasePrice,
          isDefaultSale: input.isDefaultSale ?? false,
          isDefaultPurchase: input.isDefaultPurchase ?? false,
        })
        .onConflictDoUpdate({
          target: [itemUnits.itemId, itemUnits.unitId],
          set: {
            tenantId,
            ratio: ratio.toFixed(6),
            barcode: input.barcode === undefined ? sql`${itemUnits.barcode}` : input.barcode,
            salePrice: input.salePrice ?? null,
            purchasePrice: input.purchasePrice ?? null,
            isDefaultSale: input.isDefaultSale ?? false,
            isDefaultPurchase: input.isDefaultPurchase ?? false,
          },
        });
      const rows = await this.itemUnitRows(tx, tenantId, itemId);
      return rows.find((row) => row.unitId === input.unitId) ?? rows[0]!;
    });
  }

  async removeItemUnit(tenantId: string, itemId: string, unitId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const item = await this.requireItem(tx, tenantId, itemId);
      if (unitId === item.baseUnitId) {
        throw new DomainError('CATALOG_UNIT_IMMUTABLE', 'The base unit cannot be removed from an item', 409);
      }
      await tx
        .delete(itemUnits)
        .where(
          and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.itemId, itemId), eq(itemUnits.unitId, unitId)),
        );
      return { itemId, unitId, deleted: true };
    });
  }

  // ------------------------------------------------------------ مكوّنات الصنف (BOM)

  /**
   * مكوّنات الصنف — the bill of materials, as the desktop keeps it on the item card
   * (`frmItems` → تبويب «المكونات», `Class/ItemComponent.cs`).
   *
   * `kind` carries the desktop's `IsAdded` bit in words: `component` is consumed when the
   * assembly is built, `additive` is *produced* by it — a by-product or the packaging the
   * finished item gains. Production orders currently consume `component` lines only.
   */
  async listItemComponents(tenantId: string, itemId: string): Promise<ItemComponentRow[]> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.requireItem(tx, tenantId, itemId);
      return this.componentRows(tx, tenantId, itemId);
    });
  }

  async setItemComponent(
    tenantId: string,
    itemId: string,
    input: ItemComponentInput,
  ): Promise<ItemComponentRow> {
    const qty = new Decimal(input.qty);
    if (!qty.isFinite() || qty.lte(0))
      throw new DomainError(
        'CATALOG_COMPONENT_QTY_INVALID',
        'The component quantity must be greater than zero',
        422,
        { field: 'qty' },
      );
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.requireItem(tx, tenantId, itemId);
      if (input.componentItemId === itemId)
        throw new DomainError(
          'CATALOG_COMPONENT_SELF',
          'An item cannot be a component of itself',
          422,
        );
      const component = await this.requireItem(tx, tenantId, input.componentItemId);
      // Counting a component in a unit the item does not define is how a quantity stops
      // being convertible: the ledger stores base units, and there would be no ratio to
      // convert with.
      const ratio = await this.componentUnitRatio(
        tx,
        tenantId,
        component,
        input.unitId ?? component.baseUnitId,
      );
      if (input.warehouseId) {
        const [warehouse] = await tx
          .select({ id: warehouses.id })
          .from(warehouses)
          .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, input.warehouseId), isNull(warehouses.deletedAt)));
        if (!warehouse)
          throw new DomainError('WAREHOUSE_NOT_FOUND', 'Warehouse was not found', 404);
      }
      await this.assertNoCycle(tx, tenantId, itemId, input.componentItemId);

      await tx
        .insert(itemComponents)
        .values({
          tenantId,
          itemId,
          componentItemId: input.componentItemId,
          qty: qty.toFixed(4),
          unitId: input.unitId ?? component.baseUnitId,
          kind: input.kind ?? 'component',
          warehouseId: input.warehouseId ?? null,
        })
        .onConflictDoUpdate({
          target: [itemComponents.itemId, itemComponents.componentItemId],
          set: {
            tenantId,
            qty: qty.toFixed(4),
            unitId: input.unitId ?? component.baseUnitId,
            kind: input.kind ?? 'component',
            warehouseId: input.warehouseId ?? null,
          },
        });
      const ratioRow = ratio;
      const rows = await this.componentRows(tx, tenantId, itemId);
      const saved = rows.find((row) => row.componentItemId === input.componentItemId);
      return saved ?? { ...rows[0]!, ratio: ratioRow.toFixed(6) };
    });
  }

  async removeItemComponent(tenantId: string, itemId: string, componentItemId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.requireItem(tx, tenantId, itemId);
      const deleted = await tx
        .delete(itemComponents)
        .where(
          and(
            eq(itemComponents.tenantId, tenantId),
            eq(itemComponents.itemId, itemId),
            eq(itemComponents.componentItemId, componentItemId),
          ),
        )
        .returning({ componentItemId: itemComponents.componentItemId });
      return { itemId, componentItemId, deleted: deleted.length > 0 };
    });
  }

  /**
   * `GET /inventory/items/:id/components` is not the only reader: the production screen
   * asks for the bill of materials of the item it is about to build, scaled to the
   * quantity it plans to build.
   */
  async componentsFor(
    tx: DrizzleTx,
    tenantId: string,
    itemId: string,
    outputQty: Decimal,
  ): Promise<Array<{ itemId: string; qty: string; unitId: string }>> {
    const rows = await tx
      .select()
      .from(itemComponents)
      .where(and(eq(itemComponents.tenantId, tenantId), eq(itemComponents.itemId, itemId), eq(itemComponents.kind, 'component')));
    return rows.map((row) => ({
      itemId: row.componentItemId,
      qty: new Decimal(row.qty).times(outputQty).toFixed(4),
      unitId: row.unitId,
    }));
  }

  private async componentRows(tx: DrizzleTx, tenantId: string, itemId: string): Promise<ItemComponentRow[]> {
    return tx
      .select({
        itemId: itemComponents.itemId,
        componentItemId: itemComponents.componentItemId,
        sku: items.sku,
        nameAr: items.nameAr,
        qty: itemComponents.qty,
        unitId: itemComponents.unitId,
        unitCode: unitsOfMeasure.code,
        unitNameAr: unitsOfMeasure.nameAr,
        kind: itemComponents.kind,
        warehouseId: itemComponents.warehouseId,
        warehouseName: warehouses.name,
        baseUnitId: items.baseUnitId,
      })
      .from(itemComponents)
      .innerJoin(items, eq(items.id, itemComponents.componentItemId))
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, itemComponents.unitId))
      .leftJoin(warehouses, eq(warehouses.id, itemComponents.warehouseId))
      .where(and(eq(itemComponents.tenantId, tenantId), eq(itemComponents.itemId, itemId)))
      .orderBy(asc(items.sku));
  }

  /** Base units per one of `unitId` for this item — 1 when it is the base unit. */
  private async componentUnitRatio(
    tx: DrizzleTx,
    tenantId: string,
    item: { id: string; baseUnitId: string },
    unitId: string,
  ): Promise<Decimal> {
    if (unitId === item.baseUnitId) return new Decimal(1);
    const [row] = await tx
      .select({ ratio: itemUnits.ratio })
      .from(itemUnits)
      .where(and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.itemId, item.id), eq(itemUnits.unitId, unitId)));
    if (!row)
      throw new DomainError(
        'CATALOG_COMPONENT_UNIT_INVALID',
        'The component unit must be the item’s base unit or one of the units defined on its card',
        422,
        { field: 'unitId' },
      );
    return new Decimal(row.ratio);
  }

  /**
   * A bill of materials that contains itself cannot be costed: building one unit would
   * need one unit of itself first. The walk is bounded, because a cycle in the data
   * would otherwise spin forever.
   */
  private async assertNoCycle(tx: DrizzleTx, tenantId: string, itemId: string, componentItemId: string, depth = 0) {
    if (depth > 10) return;
    const children = await tx
      .select({ componentItemId: itemComponents.componentItemId })
      .from(itemComponents)
      .where(and(eq(itemComponents.tenantId, tenantId), eq(itemComponents.itemId, componentItemId)));
    if (children.some((child) => child.componentItemId === itemId))
      throw new DomainError(
        'CATALOG_COMPONENT_CYCLE',
        'This component already contains the item you are adding it to',
        409,
      );
    for (const child of children) {
      await this.assertNoCycle(tx, tenantId, itemId, child.componentItemId, depth + 1);
    }
  }

  private async requireUnit(tx: DrizzleTx, tenantId: string, unitId: string) {
    const [row] = await tx
      .select({ id: unitsOfMeasure.id })
      .from(unitsOfMeasure)
      .where(
        and(
          eq(unitsOfMeasure.tenantId, tenantId),
          eq(unitsOfMeasure.id, unitId),
          isNull(unitsOfMeasure.deletedAt),
        ),
      );
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Unit of measure was not found', 404);
    return row;
  }

  // ------------------------------------------------------- الباركود المتعدد

  /** Every barcode that must resolve to this item: its own, its units', and extra labels. */
  async listItemBarcodes(tenantId: string, itemId: string): Promise<ItemBarcodeRow[]> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const item = await this.requireItem(tx, tenantId, itemId);
      const extra = await tx
        .select({
          barcode: itemBarcodes.barcode,
          unitId: itemBarcodes.unitId,
          unitNameAr: unitsOfMeasure.nameAr,
          createdAt: itemBarcodes.createdAt,
        })
        .from(itemBarcodes)
        .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, itemBarcodes.unitId))
        .where(and(eq(itemBarcodes.tenantId, tenantId), eq(itemBarcodes.itemId, itemId)))
        .orderBy(asc(itemBarcodes.barcode));
      const rows: ItemBarcodeRow[] = [];
      if (item.barcode?.trim())
        rows.push({ barcode: item.barcode.trim(), itemId, unitId: null, unitNameAr: 'الوحدة الأساسية' });
      for (const row of extra) rows.push({ ...row, itemId });
      return rows;
    });
  }

  async addItemBarcode(tenantId: string, itemId: string, input: ItemBarcodeInput): Promise<ItemBarcodeRow> {
    const barcode = input.barcode.trim();
    if (!barcode)
      throw new DomainError('CATALOG_BARCODE_REQUIRED', 'A barcode is required', 422, { field: 'barcode' });
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.requireItem(tx, tenantId, itemId);
      if (input.unitId) await this.requireUnit(tx, tenantId, input.unitId);
      // A barcode that already belongs to another item would make the scanner lie.
      const [owner] = await tx
        .select({ itemId: itemBarcodes.itemId })
        .from(itemBarcodes)
        .where(and(eq(itemBarcodes.tenantId, tenantId), eq(itemBarcodes.barcode, barcode)));
      if (owner && owner.itemId !== itemId) {
        throw new DomainError('CATALOG_BARCODE_TAKEN', 'This barcode already belongs to another item', 409, {
          field: 'barcode',
        });
      }
      await tx
        .insert(itemBarcodes)
        .values({ tenantId, barcode, itemId, unitId: input.unitId ?? null })
        .onConflictDoUpdate({
          target: [itemBarcodes.tenantId, itemBarcodes.barcode],
          set: { itemId, unitId: input.unitId ?? null },
        });
      return { barcode, itemId, unitId: input.unitId ?? null, unitNameAr: null };
    });
  }

  async removeItemBarcode(tenantId: string, barcode: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .delete(itemBarcodes)
        .where(and(eq(itemBarcodes.tenantId, tenantId), eq(itemBarcodes.barcode, barcode)));
      // The item's own barcode lives on the item card; clear it there too so one DELETE
      // really does remove the label from the scanner.
      await tx
        .update(items)
        .set({ barcode: null, updatedAt: new Date() })
        .where(and(eq(items.tenantId, tenantId), eq(items.barcode, barcode)));
      return { barcode, deleted: true };
    });
  }

  /**
   * Deleting an item that has moved would orphan every ledger row that points at it, so
   * a used item is **archived** (soft-deleted + deactivated) and an unused one is removed.
   * Either way it disappears from the pickers; only one of them disappears from history.
   */
  async removeItem(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.requireItem(tx, tenantId, id);
      const used = await this.itemHasMovements(tx, tenantId, id);
      await tx
        .update(items)
        .set({ deletedAt: new Date(), showInPos: false, updatedAt: new Date() })
        .where(and(eq(items.tenantId, tenantId), eq(items.id, id)));
      return { id, archived: used, deleted: !used };
    });
  }

  async getItem(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      return tx
        .select()
        .from(items)
        .where(and(eq(items.id, id), eq(items.tenantId, tenantId), isNull(items.deletedAt)));
    });
    if (!row) return row;
    const [decorated] = await this.customFields.decorate(tenantId, 'item', [row]);
    return decorated ?? row;
  }

  private async requireItem(tx: DrizzleTx, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.id, id), isNull(items.deletedAt)));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Item was not found', 404);
    return row;
  }

  /** Any inventory movement or invoice line is enough to make the item historical. */
  private async itemHasMovements(tx: DrizzleTx, tenantId: string, id: string) {
    const result = await tx.execute(sql`
      SELECT EXISTS (SELECT 1 FROM inventory_transactions WHERE tenant_id = ${tenantId} AND item_id = ${id})
          OR EXISTS (SELECT 1 FROM sales_invoice_lines WHERE tenant_id = ${tenantId} AND item_id = ${id})
          OR EXISTS (SELECT 1 FROM purchase_invoice_lines WHERE tenant_id = ${tenantId} AND item_id = ${id}) AS used
    `);
    return Boolean((result.rows[0] as { used: boolean }).used);
  }

  async listCategories(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(itemCategories)
        .where(and(eq(itemCategories.tenantId, tenantId), isNull(itemCategories.deletedAt)))
        .orderBy(asc(itemCategories.nameAr)),
    );
  }

  /**
   * An item cannot exist without a category and a base unit, so the two directories
   * below are part of the same module: without them `POST items` is unusable from a UI.
   */
  async createCategory(tenantId: string, input: CategoryInput) {
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(itemCategories).values({
        id,
        tenantId,
        code: input.code,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        parentId: input.parentId,
      }),
    );
    const rows = await this.listCategories(tenantId);
    return rows.find((row) => row.id === id);
  }

  async updateCategory(tenantId: string, id: string, patch: CategoryPatch) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(itemCategories)
        .where(
          and(
            eq(itemCategories.tenantId, tenantId),
            eq(itemCategories.id, id),
            isNull(itemCategories.deletedAt),
          ),
        );
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'Category was not found', 404);
      if (patch.parentId === id)
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'A category cannot be its own parent', 422);
      const [row] = await tx
        .update(itemCategories)
        .set({
          code: patch.code ?? current.code,
          nameAr: patch.nameAr ?? current.nameAr,
          nameEn: patch.nameEn === undefined ? current.nameEn : patch.nameEn,
          parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
          updatedAt: new Date(),
        })
        .where(and(eq(itemCategories.tenantId, tenantId), eq(itemCategories.id, id)))
        .returning();
      return row;
    });
  }

  /** A category with items behind it is kept: removing it would leave those items nameless. */
  async removeCategory(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const inUse = await tx.execute(
        sql`SELECT EXISTS (SELECT 1 FROM items WHERE tenant_id = ${tenantId} AND category_id = ${id} AND deleted_at IS NULL) AS used`,
      );
      if ((inUse.rows[0] as { used: boolean }).used) {
        throw new DomainError(
          'CATEGORY_IN_USE',
          'Move the items to another category before deleting this one',
          409,
        );
      }
      const result = await tx
        .update(itemCategories)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(itemCategories.tenantId, tenantId),
            eq(itemCategories.id, id),
            isNull(itemCategories.deletedAt),
          ),
        );
      if (!result.rowCount) throw new DomainError(errorCodes.NOT_FOUND, 'Category was not found', 404);
      return { id, deleted: true };
    });
  }

  async listUnits(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(unitsOfMeasure)
        .where(and(eq(unitsOfMeasure.tenantId, tenantId), isNull(unitsOfMeasure.deletedAt)))
        .orderBy(asc(unitsOfMeasure.code)),
    );
  }

  async createUnit(tenantId: string, input: UnitInput) {
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(unitsOfMeasure)
        .values({ id, tenantId, code: input.code, nameAr: input.nameAr, nameEn: input.nameEn }),
    );
    const rows = await this.listUnits(tenantId);
    return rows.find((row) => row.id === id);
  }

  async updateUnit(tenantId: string, id: string, patch: UnitPatch) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(unitsOfMeasure)
        .where(
          and(
            eq(unitsOfMeasure.tenantId, tenantId),
            eq(unitsOfMeasure.id, id),
            isNull(unitsOfMeasure.deletedAt),
          ),
        );
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'Unit was not found', 404);
      const [row] = await tx
        .update(unitsOfMeasure)
        .set({
          code: patch.code ?? current.code,
          nameAr: patch.nameAr ?? current.nameAr,
          nameEn: patch.nameEn === undefined ? current.nameEn : patch.nameEn,
          updatedAt: new Date(),
        })
        .where(and(eq(unitsOfMeasure.tenantId, tenantId), eq(unitsOfMeasure.id, id)))
        .returning();
      return row;
    });
  }

  /** A unit that is some item's base unit is the meaning of that item's quantities. */
  async removeUnit(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const inUse = await tx.execute(
        sql`SELECT EXISTS (SELECT 1 FROM items WHERE tenant_id = ${tenantId} AND base_unit_id = ${id} AND deleted_at IS NULL) AS used`,
      );
      if ((inUse.rows[0] as { used: boolean }).used) {
        throw new DomainError('UNIT_IN_USE', 'This unit is the base unit of at least one item', 409);
      }
      const result = await tx
        .update(unitsOfMeasure)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(unitsOfMeasure.tenantId, tenantId),
            eq(unitsOfMeasure.id, id),
            isNull(unitsOfMeasure.deletedAt),
          ),
        );
      if (!result.rowCount) throw new DomainError(errorCodes.NOT_FOUND, 'Unit was not found', 404);
      return { id, deleted: true };
    });
  }

  async listTaxGroups(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(taxGroups)
        .where(and(eq(taxGroups.tenantId, tenantId), isNull(taxGroups.deletedAt)))
        .orderBy(asc(taxGroups.nameAr)),
    );
  }

  async createTaxGroup(tenantId: string, input: TaxGroupInput) {
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(taxGroups).values({
        id,
        tenantId,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        rate: input.rate,
        vatAccountId: input.vatAccountId,
        isInclusiveDefault: input.isInclusiveDefault ?? false,
      }),
    );
    const rows = await this.listTaxGroups(tenantId);
    return rows.find((row) => row.id === id);
  }

  /**
   * A tax group's **rate** is deliberately editable only while unused. Every posted
   * invoice stored the rate it was issued with, so editing the group does not rewrite
   * them — but it would silently change what the same group means going forward, which is
   * how a 15% invoice ends up next to a 5% invoice under one name. Create a new group for
   * a new rate; rename this one freely.
   */
  async updateTaxGroup(tenantId: string, id: string, patch: TaxGroupPatch) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(taxGroups)
        .where(and(eq(taxGroups.tenantId, tenantId), eq(taxGroups.id, id), isNull(taxGroups.deletedAt)));
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'Tax group was not found', 404);
      if (patch.rate && patch.rate !== current.rate) {
        const used = await tx.execute(
          sql`SELECT EXISTS (SELECT 1 FROM sales_invoice_lines WHERE tenant_id = ${tenantId} AND tax_group_id = ${id}) AS used`,
        );
        if ((used.rows[0] as { used: boolean }).used) {
          throw new DomainError(
            'TAX_GROUP_RATE_LOCKED',
            'This tax group has already been used on invoices; create a new group for the new rate',
            409,
          );
        }
      }
      const [row] = await tx
        .update(taxGroups)
        .set({
          nameAr: patch.nameAr ?? current.nameAr,
          nameEn: patch.nameEn === undefined ? current.nameEn : patch.nameEn,
          rate: patch.rate ?? current.rate,
          vatAccountId: patch.vatAccountId === undefined ? current.vatAccountId : patch.vatAccountId,
          isInclusiveDefault: patch.isInclusiveDefault ?? current.isInclusiveDefault,
          updatedAt: new Date(),
        })
        .where(and(eq(taxGroups.tenantId, tenantId), eq(taxGroups.id, id)))
        .returning();
      return row;
    });
  }
}
