/* eslint-disable no-restricted-syntax */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  accounts,
  inventoryTransactions,
  journalEntries,
  itemLots,
  itemSerials,
  stockDocumentSerials,
  itemBarcodes,
  itemUnits,
  items,
  stockAdjustmentLines,
  stockAdjustments,
  stockBalances,
  stockTransfers,
  stockTransferLines,
  stockVoucherLines,
  stockVouchers,
  unitsOfMeasure,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
  type StockBalance,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { AccountingService } from '../accounting/accounting.service.js';
import { WebhookPublisher } from '../developer/webhook-publisher.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';
import { getRequestContext } from '../../request-context/request-context.js';
import { SequencesService } from '../platform-services/index.js';

export type InventoryLine = {
  itemId: string;
  warehouseId: string;
  qty: string;
  /** Unit the quantity was entered in (default: the item's base unit). */
  unitId?: string;
  unitCost?: string;
  direction: 'in' | 'out';
  docType: string;
  docId: string;
  lineId?: string;
  /**
   * كيف تُقيَّم الحركة. `outAtAvg` هو الأصل للصادر، و`inWithCost` للوارد.
   * و`returnAtOriginalCost` رجوعُ ما خرج بسعره الأصلي (المرتجع)، و`outAtOriginalCost`
   * **عكسُ إدخال**: يصرف بالسعر الذي دخلت به الحركة الأصلية لا بمتوسط اليوم — بدونه
   * لا يعود رصيدُ المخزون وقيمتُه إلى ما كانا عليه بعد إلغاء فاتورة شراء (R3).
   */
  costing?: 'inWithCost' | 'outAtAvg' | 'returnAtOriginalCost' | 'outAtOriginalCost';
  lotId?: string;
  serialId?: string;
};

/** One line of a stock voucher (سند إدخال / إخراج / بضاعة أول المدة). */
export type StockVoucherLineInput = {
  itemId: string;
  qty: string;
  /** Unit the quantity was counted in (default: the item's base unit). */
  unitId?: string;
  unitCost?: string;
  lotId?: string;
  /** 📁 رقم الدفعة — R5: يُذكر بالاسم، والسطر يُنشئ الدفعة إن لم تكن مسجَّلة. */
  batchNo?: string;
  /** 📅 تاريخ الإنتاج المطبوع على العبوة. */
  productionDate?: string;
  /** ⏳ تاريخ الانتهاء المطبوع على العبوة. */
  expiryDate?: string;
  serialId?: string;
  /**
   * 🔢 الأرقام التسلسلية — one number per piece, the desktop's
   * `InvoiceItemDetail.ItemSerialNo`. Kept on the line through the draft and resolved
   * into `stock_document_serials` when the document posts.
   */
  serialNos?: string[];
  note?: string;
};
export type StockVoucherInput = {
  branchId: string;
  warehouseId: string;
  kind: 'stock_in' | 'stock_out' | 'opening';
  voucherDate?: string;
  reason?: string;
  /** An explicit contra account (تالف، هالك، عينة…); defaults to the variance account. */
  counterAccountId?: string;
  notes?: string;
  lines: StockVoucherLineInput[];
};
export type StockAdjustmentInput = {
  branchId: string;
  warehouseId: string;
  reason: string;
  lines: Array<{
    itemId: string;
    countedQty: string;
    unitId?: string;
    unitCost?: string;
    lotId?: string;
    /** 📁 رقم الدفعة وتواريخها — كما على العبوة (R5). */
    batchNo?: string;
    productionDate?: string;
    expiryDate?: string;
    /**
     * 🔢 الأرقام التسلسلية counted on the line. On a shortage they are consumed, on a
     * surplus they are brought in — the variance decides, not the clerk.
     */
    serialNos?: string[];
    note?: string;
  }>;
};

export const VOUCHER_KIND_LABELS: Record<string, string> = {
  stock_in: 'سند إدخال مخزني',
  stock_out: 'سند إخراج مخزني',
  opening: 'بضاعة أول المدة',
};

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
    private readonly accounting: AccountingService,
    private readonly profiles: PostingProfilesService,
    // P-C11 — `stock.below_reorder`: نقصُ المخزون خبرٌ يُعلَن عند وقوعه لا عند الجرد.
    private readonly webhooks: WebhookPublisher,
  ) {}

  /**
   * Transfer register. `createTransfer` and `receiveTransfer` existed without any way to
   * read the result back, which made the مناقلة screen impossible to build.
   */
  /**
   * 🔍 البحث — `frmSafesTransfer.xaml` «🔍 معايير البحث»: `🔢 رقم التحويل` ·
   * `📅 من تاريخ` · `📅 إلى تاريخ`, with `📋 كل الفترة` meaning "send no dates at all".
   * A transfer is a numbered document the receiving store keeps waiting for, so finding
   * one by its number is the ordinary case, not a special one.
   */
  async listTransfers(
    tenantId: string,
    status?: string,
    filters: { number?: string; from?: string; to?: string } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(stockTransfers)
        .where(
          and(
            eq(stockTransfers.tenantId, tenantId),
            status ? eq(stockTransfers.status, status) : undefined,
            filters.number ? ilike(stockTransfers.number, `%${filters.number}%`) : undefined,
            filters.from ? gte(stockTransfers.createdAt, new Date(`${filters.from}T00:00:00.000Z`)) : undefined,
            filters.to ? lte(stockTransfers.createdAt, new Date(`${filters.to}T23:59:59.999Z`)) : undefined,
          ),
        )
        .orderBy(sql`${stockTransfers.createdAt} DESC`)
        .limit(200);
      if (rows.length === 0) return [];
      const lines = await tx
        .select()
        .from(stockTransferLines)
        .where(
          and(
            eq(stockTransferLines.tenantId, tenantId),
            inArray(
              stockTransferLines.transferId,
              rows.map((row) => row.id),
            ),
          ),
        );
      return rows.map((row) => ({ ...row, lines: lines.filter((line) => line.transferId === row.id) }));
    });
  }

  async record(tenantId: string, lines: InventoryLine[]) {
    const created = await withTenantTx(this.database.db, tenantId, (tx) => this.recordInTx(tx, tenantId, lines));
    // P-C11 — الفحص **بعد** نجاح المعاملة: نقرأ رصيداً مثبَّتاً لا رصيداً داخل معاملةٍ بعد.
    await this.announceBelowReorder(tenantId, lines);
    return created;
  }

  /**
   * `stock.below_reorder` — يُعلَن لصنفٍ هبط إلى حدّه الأدنى أو دونه.
   *
   * وثلاثة شروط تُقرأ من الكود نفسه: أن يكون للصنف حدٌّ أدنى (`min_qty > 0`) — فصنفٌ بلا حدّ
   * لا «يخالف» حدّاً؛ وأن يكون الرصيد قد بلغه فعلاً (`quantity <= min_qty`)؛ وأن تُقرأ القيم
   * من القاعدة بعد الالتزام لا من الطلب (فالطلب يقول ما طُلب، والقاعدة تقول ما استقرّ).
   *
   * ويُعلَن عن كل (صنف، مخزن) مرّةً في النداء — لا مرّةً لكل سطر: حركةٌ من خمسة أسطر على
   * الصنف نفسه خبرٌ واحد.
   */
  private async announceBelowReorder(tenantId: string, lines: InventoryLine[]): Promise<void> {
    const pairs = new Map<string, { itemId: string; warehouseId: string }>();
    for (const line of lines) {
      pairs.set(`${line.itemId}:${line.warehouseId}`, { itemId: line.itemId, warehouseId: line.warehouseId });
    }
    for (const pair of pairs.values()) {
      const row = await withTenantTx(this.database.db, tenantId, async (tx) => {
        const [found] = await tx
          .select({
            quantity: stockBalances.quantity,
            minQty: items.minQty,
            sku: items.sku,
            nameAr: items.nameAr,
          })
          .from(stockBalances)
          .innerJoin(items, eq(items.id, stockBalances.itemId))
          .where(
            and(
              eq(stockBalances.tenantId, tenantId),
              eq(stockBalances.itemId, pair.itemId),
              eq(stockBalances.warehouseId, pair.warehouseId),
            ),
          )
          .limit(1);
        return found;
      });
      if (!row) continue;
      if (new Decimal(row.minQty).lte(0)) continue;
      if (new Decimal(row.quantity).gt(row.minQty)) continue;
      void this.webhooks.emit('stock.below_reorder', tenantId, {
        itemId: pair.itemId,
        warehouseId: pair.warehouseId,
        sku: row.sku,
        nameAr: row.nameAr,
        quantity: row.quantity,
        minQty: row.minQty,
      });
    }
  }

  /**
   * `allowNegative` lets a caller post an issuing document that takes the balance below
   * zero — a back-dated issue, or a shop that simply sells before it books the receipt.
   * It is gated on `inventory.negative.override`, and the caller's own request is the
   * only place the permission can be read honestly.
   */
  async recordInTx(
    tx: DrizzleTx,
    tenantId: string,
    lines: InventoryLine[],
    options: { allowNegative?: boolean } = {},
  ) {
    if (!lines.length)
      throw new DomainError('INVENTORY_LINES_REQUIRED', 'At least one inventory line is required', 422);
    const created: string[] = [];
    for (const line of lines) {
      const quantity = new Decimal(line.qty);
      if (!quantity.isFinite() || quantity.lte(0))
        throw new DomainError('INVALID_STOCK_QUANTITY', 'Quantity must be positive', 422);

      const { factor, unitId } = await this.resolveUnit(tx, tenantId, line);
      const baseQuantity = quantity.mul(factor);

      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version, updated_at)
        VALUES (${tenantId}, ${line.itemId}, ${line.warehouseId}, 0, 0, 0, 1, now())
        ON CONFLICT (tenant_id, item_id, warehouse_id) DO NOTHING
      `);
      const [balance] = rowsOf<StockBalance>(
        await tx.execute(sql`
        SELECT tenant_id AS "tenantId", item_id AS "itemId", warehouse_id AS "warehouseId",
               quantity, value, average_cost AS "averageCost", version, updated_at AS "updatedAt"
        FROM stock_balances
        WHERE tenant_id = ${tenantId} AND item_id = ${line.itemId} AND warehouse_id = ${line.warehouseId}
        FOR UPDATE
      `),
      );
      if (!balance)
        throw new DomainError('STOCK_BALANCE_LOCK_FAILED', 'Could not lock stock balance row', 500);

      const currentQty = new Decimal(balance.quantity);
      const currentValue = new Decimal(balance.value);
      // `average` is always per BASE unit — that is what the balance row stores.
      const average = currentQty.gt(0)
        ? currentValue.div(currentQty)
        : new Decimal(line.unitCost ?? '0').div(factor);
      // عكسُ إدخالٍ يصرف بالسعر الذي دخلت به الحركة نفسها (R3): بدونه يُصرف بمتوسط
      // اليوم فيبقى فرقٌ في قيمة المخزون بعد الإلغاء ولا تعود القيمة إلى ما كانت.
      const original = line.costing === 'outAtOriginalCost' && line.unitCost !== undefined
        ? new Decimal(line.unitCost)
        : undefined;
      const enteredCost = line.direction === 'in'
        ? new Decimal(line.unitCost ?? '0')
        : (original ?? average).mul(factor);
      const unitCost = enteredCost.div(factor);
      const nextQty =
        line.direction === 'in' ? currentQty.plus(baseQuantity) : currentQty.minus(baseQuantity);
      if (nextQty.lt(0) && !options.allowNegative) {
        throw new DomainError('STOCK_INSUFFICIENT', 'Stock is insufficient for this movement', 422, {
          field: 'lines',
        });
      }
      // القيمة تتحرّك بالتكلفة نفسها التي تُكتب في الحركة (`unitCost`) لا بمتوسطٍ آخر —
      // وإلا اختلف رصيد المخزون عن مجموع حركاته (كما كان يحدث في عكس الإدخال قبل R3).
      const nextValue =
        line.direction === 'in'
          ? currentValue.plus(baseQuantity.mul(unitCost))
          : currentValue.minus(baseQuantity.mul(unitCost));
      const averageCost = nextQty.isZero() ? '0.0000' : nextValue.div(nextQty).toFixed(4);
      const id = newId();

      await tx.insert(inventoryTransactions).values({
        id,
        tenantId,
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        occurredAt: new Date(),
        docType: line.docType,
        docId: line.docId,
        lineId: line.lineId,
        direction: line.direction,
        qty: line.qty,
        baseQty: baseQuantity.toFixed(4),
        unitId,
        factor: factor.toFixed(6),
        unitCost: unitCost.toFixed(4),
        totalCost: baseQuantity.mul(unitCost).toFixed(4),
        costing: line.costing ?? (line.direction === 'in' ? 'inWithCost' : 'outAtAvg'),
        lotId: line.lotId,
        serialId: line.serialId,
      });
      await tx
        .update(stockBalances)
        .set({
          quantity: nextQty.toFixed(4),
          value: nextValue.toFixed(4),
          averageCost,
          version: balance.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.itemId, line.itemId),
            eq(stockBalances.warehouseId, line.warehouseId),
          ),
        );

      if (line.serialId) {
        await tx
          .update(itemSerials)
          .set({
            status: line.direction === 'out' ? 'sold' : 'available',
            warehouseId: line.direction === 'out' ? null : line.warehouseId,
            updatedAt: new Date(),
          })
          .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, line.serialId)));
      }
      created.push(id);
    }
    return { transactionIds: created };
  }

  levels(tenantId: string, warehouseId?: string, itemId?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            warehouseId ? eq(stockBalances.warehouseId, warehouseId) : undefined,
            itemId ? eq(stockBalances.itemId, itemId) : undefined,
          ),
        )
        .orderBy(asc(stockBalances.itemId)),
    );
  }
  /**
   * The movement list. It now takes a period as well as an item and a warehouse, because
   * "everything that ever happened to this item" is only useful once it can be narrowed
   * to the month somebody is asking about — that is what `Inventorybalance()` and
   * `TotalItemStock(branch, date)` answered on the desktop.
   */
  async movements(
    tenantId: string,
    filters: { itemId?: string; warehouseId?: string; from?: string; to?: string; limit?: number } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: inventoryTransactions.id,
          itemId: inventoryTransactions.itemId,
          sku: items.sku,
          itemNameAr: items.nameAr,
          warehouseId: inventoryTransactions.warehouseId,
          warehouseNameAr: warehouses.name,
          direction: inventoryTransactions.direction,
          qty: inventoryTransactions.qty,
          baseQty: inventoryTransactions.baseQty,
          unitId: inventoryTransactions.unitId,
          unitNameAr: unitsOfMeasure.nameAr,
          factor: inventoryTransactions.factor,
          unitCost: inventoryTransactions.unitCost,
          totalCost: inventoryTransactions.totalCost,
          docType: inventoryTransactions.docType,
          docId: inventoryTransactions.docId,
          lotId: inventoryTransactions.lotId,
          serialId: inventoryTransactions.serialId,
          occurredAt: inventoryTransactions.occurredAt,
        })
        .from(inventoryTransactions)
        .innerJoin(items, eq(items.id, inventoryTransactions.itemId))
        .leftJoin(warehouses, eq(warehouses.id, inventoryTransactions.warehouseId))
        .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryTransactions.unitId))
        .where(
          and(
            eq(inventoryTransactions.tenantId, tenantId),
            filters.itemId ? eq(inventoryTransactions.itemId, filters.itemId) : undefined,
            filters.warehouseId ? eq(inventoryTransactions.warehouseId, filters.warehouseId) : undefined,
            filters.from
              ? sql`${inventoryTransactions.occurredAt}::date >= ${filters.from}::date`
              : undefined,
            filters.to ? sql`${inventoryTransactions.occurredAt}::date <= ${filters.to}::date` : undefined,
          ),
        )
        .orderBy(asc(inventoryTransactions.occurredAt))
        .limit(Math.min(Math.max(filters.limit ?? 500, 1), 2000)),
    );
  }

  /**
   * بطاقة الصنف — the item card, which is the stock ledger read the way a storekeeper
   * reads it: opening balance at `from`, every movement inside the period with a running
   * balance beside it, and the closing balance that must agree with `stock_balances`.
   *
   * Quantity and value are both carried, because a card that only counts units cannot
   * answer the question it exists for — what is this stock *worth* right now.
   */
  async itemCard(
    tenantId: string,
    filters: { itemId: string; warehouseId?: string; from?: string; to?: string } = { itemId: '' },
  ) {
    if (!filters.itemId)
      throw new DomainError('INVENTORY_ITEM_REQUIRED', 'An item is required for its card', 422, {
        field: 'item_id',
      });
    const [item] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: items.id, sku: items.sku, nameAr: items.nameAr, baseUnitId: items.baseUnitId })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.id, filters.itemId), isNull(items.deletedAt))),
    );
    if (!item) throw new DomainError('NOT_FOUND', 'Item was not found', 404);

    // Without a `from` there is no opening: the card starts at the first movement ever,
    // and counting everything twice is exactly the kind of subtly wrong total a store-
    // keeper would trust once and never again.
    const before = filters.from
      ? await withTenantTx(this.database.db, tenantId, (tx) =>
          tx
            .select()
            .from(inventoryTransactions)
            .where(
              and(
                eq(inventoryTransactions.tenantId, tenantId),
                eq(inventoryTransactions.itemId, filters.itemId),
                filters.warehouseId ? eq(inventoryTransactions.warehouseId, filters.warehouseId) : undefined,
                sql`${inventoryTransactions.occurredAt}::date < ${filters.from}::date`,
              ),
            )
            .orderBy(asc(inventoryTransactions.occurredAt)),
        )
      : [];

    const opening = before.reduce(
      (acc, row) => {
        const quantity = new Decimal(row.baseQty);
        const value = new Decimal(row.totalCost);
        return row.direction === 'in'
          ? { quantity: acc.quantity.plus(quantity), value: acc.value.plus(value) }
          : { quantity: acc.quantity.minus(quantity), value: acc.value.minus(value) };
      },
      { quantity: new Decimal(0), value: new Decimal(0) },
    );

    const rows = await this.movements(tenantId, {
      itemId: filters.itemId,
      warehouseId: filters.warehouseId,
      from: filters.from,
      to: filters.to,
      limit: 2000,
    });

    let quantity = opening.quantity;
    let value = opening.value;
    const ledger = rows.map((row) => {
      const moved = new Decimal(row.baseQty);
      const cost = new Decimal(row.totalCost);
      quantity = row.direction === 'in' ? quantity.plus(moved) : quantity.minus(moved);
      value = row.direction === 'in' ? value.plus(cost) : value.minus(cost);
      return {
        ...row,
        balanceQty: quantity.toFixed(4),
        balanceValue: value.toFixed(4),
        averageCost: quantity.abs().gt(0) ? value.div(quantity).toFixed(4) : '0.0000',
      };
    });

    const totals = rows.reduce(
      (acc, row) => {
        const moved = new Decimal(row.baseQty);
        const cost = new Decimal(row.totalCost);
        return row.direction === 'in'
          ? { ...acc, inQty: acc.inQty.plus(moved), inValue: acc.inValue.plus(cost) }
          : { ...acc, outQty: acc.outQty.plus(moved), outValue: acc.outValue.plus(cost) };
      },
      { inQty: new Decimal(0), inValue: new Decimal(0), outQty: new Decimal(0), outValue: new Decimal(0) },
    );

    return {
      itemId: filters.itemId,
      sku: item.sku,
      nameAr: item.nameAr,
      warehouseId: filters.warehouseId ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null,
      opening: { quantity: opening.quantity.toFixed(4), value: opening.value.toFixed(4) },
      totals: {
        inQty: totals.inQty.toFixed(4),
        inValue: totals.inValue.toFixed(4),
        outQty: totals.outQty.toFixed(4),
        outValue: totals.outValue.toFixed(4),
      },
      closing: { quantity: quantity.toFixed(4), value: value.toFixed(4) },
      rows: ledger,
    };
  }

  async valuationAsOf(tenantId: string, asOf: Date, warehouseId?: string, itemId?: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.tenantId, tenantId),
            sql`${inventoryTransactions.occurredAt} <= ${asOf}`,
            warehouseId ? eq(inventoryTransactions.warehouseId, warehouseId) : undefined,
            itemId ? eq(inventoryTransactions.itemId, itemId) : undefined,
          ),
        )
        .orderBy(asc(inventoryTransactions.occurredAt)),
    );
    const totals = new Map<string, { quantity: Decimal; value: Decimal }>();
    for (const row of rows) {
      const key = `${row.itemId}:${row.warehouseId}`;
      const current = totals.get(key) ?? { quantity: new Decimal(0), value: new Decimal(0) };
      const quantity = new Decimal(row.baseQty);
      const value = new Decimal(row.totalCost);
      if (row.direction === 'in') {
        current.quantity = current.quantity.plus(quantity);
        current.value = current.value.plus(value);
      } else {
        current.quantity = current.quantity.minus(quantity);
        current.value = current.value.minus(value);
      }
      totals.set(key, current);
    }
    return [...totals].map(([key, total]) => {
      const parts = key.split(':');
      const resultItemId = parts[0];
      const resultWarehouseId = parts[1];
      if (!resultItemId || !resultWarehouseId)
        throw new DomainError(
          'INVENTORY_REPLAY_INVALID_KEY',
          'Inventory replay produced an invalid balance key',
          500,
        );
      return {
        itemId: resultItemId,
        warehouseId: resultWarehouseId,
        quantity: total.quantity.toFixed(4),
        value: total.value.toFixed(4),
        averageCost: total.quantity.isZero() ? '0.0000' : total.value.div(total.quantity).toFixed(4),
      };
    });
  }

  async recomputeBalances(tenantId: string, warehouseId?: string, itemId?: string) {
    const valuation = await this.valuationAsOf(
      tenantId,
      new Date('9999-12-31T23:59:59.999Z'),
      warehouseId,
      itemId,
    );
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      for (const row of valuation) {
        await tx
          .insert(stockBalances)
          .values({
            tenantId,
            itemId: row.itemId,
            warehouseId: row.warehouseId,
            quantity: row.quantity,
            value: row.value,
            averageCost: row.averageCost,
            version: 1,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [stockBalances.tenantId, stockBalances.itemId, stockBalances.warehouseId],
            set: {
              quantity: row.quantity,
              value: row.value,
              averageCost: row.averageCost,
              version: sql`${stockBalances.version} + 1`,
              updatedAt: new Date(),
            },
          });
      }
      return { recomputed: valuation.length };
    });
  }

  async transfer(
    tenantId: string,
    input: {
      transferId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      lines: Array<{ itemId: string; qty: string; unitCost?: string; lotId?: string; serialId?: string }>;
    },
  ) {
    if (!input.lines.length || input.fromWarehouseId === input.toWarehouseId)
      throw new DomainError(
        'INVALID_STOCK_TRANSFER',
        'A transfer requires distinct warehouses and at least one line',
        422,
      );
    const outbound = input.lines.map((line) => ({
      ...line,
      warehouseId: input.fromWarehouseId,
      direction: 'out' as const,
      docType: 'stock_transfer',
      docId: input.transferId,
      costing: 'outAtAvg' as const,
    }));
    const inbound = input.lines.map((line) => ({
      ...line,
      warehouseId: input.toWarehouseId,
      direction: 'in' as const,
      docType: 'stock_transfer',
      docId: input.transferId,
      costing: 'inWithCost' as const,
    }));
    return this.record(tenantId, [...outbound, ...inbound]);
  }

  async adjust(
    tenantId: string,
    input: {
      adjustmentId: string;
      itemId: string;
      warehouseId: string;
      countedQty: string;
      unitCost?: string;
      approved: boolean;
      journalEntryId?: string;
    },
  ) {
    if (!input.approved)
      throw new DomainError(
        'ADJUSTMENT_APPROVAL_REQUIRED',
        'Stock adjustments require approval before posting',
        422,
      );
    if (!input.journalEntryId)
      throw new DomainError(
        'ADJUSTMENT_JOURNAL_REQUIRED',
        'An approved adjustment must reference a journal entry',
        422,
      );
    const current = await this.levels(tenantId, input.warehouseId, input.itemId);
    const existing = current[0];
    const delta = new Decimal(input.countedQty).minus(existing?.quantity ?? '0');
    if (delta.isZero()) return { adjustmentId: input.adjustmentId, transactionIds: [] };
    return this.record(tenantId, [
      {
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        qty: delta.abs().toFixed(4),
        unitCost: input.unitCost ?? existing?.averageCost ?? '0',
        direction: delta.gt(0) ? 'in' : 'out',
        docType: 'stock_adjustment',
        docId: input.adjustmentId,
        costing: delta.gt(0) ? 'inWithCost' : 'outAtAvg',
      },
    ]);
  }

  async createLot(
    tenantId: string,
    input: {
      itemId: string;
      lotNo: string;
      productionDate?: string;
      expiryDate?: string;
      receivedAt?: string;
    },
  ) {
    const [lot] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(itemLots)
        .values({
          id: newId(),
          tenantId,
          itemId: input.itemId,
          lotNo: input.lotNo,
          // 📅 الإنتاج شيء والاستلام شيء: كان العمود الواحد يكتب عنوان «تاريخ الإنتاج»
          // ويقرأه تقرير الصلاحية كتاريخ استلام (R5).
          productionDate: input.productionDate ?? null,
          expiryDate: input.expiryDate,
          receivedAt: input.receivedAt ? new Date(input.receivedAt) : null,
        })
        .returning(),
    );
    return lot;
  }

  listLots(tenantId: string, filters: { itemId?: string; q?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(itemLots)
        .where(
          and(
            eq(itemLots.tenantId, tenantId),
            isNull(itemLots.deletedAt),
            filters.itemId ? eq(itemLots.itemId, filters.itemId) : undefined,
            filters.q?.trim() ? ilike(itemLots.lotNo, `%${filters.q!.trim()}%`) : undefined,
          ),
        )
        .orderBy(asc(itemLots.lotNo)),
    );
  }

  /** 🗑️ حذف — a lot that already carries serials cannot be withdrawn. */
  async deleteLot(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [lot] = await tx
        .select()
        .from(itemLots)
        .where(and(eq(itemLots.tenantId, tenantId), eq(itemLots.id, id), isNull(itemLots.deletedAt)));
      if (!lot) throw new DomainError('LOT_NOT_FOUND', 'The lot was not found', 404);
      const [used] = await tx
        .select({ id: itemSerials.id })
        .from(itemSerials)
        .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.lotId, id), isNull(itemSerials.deletedAt)))
        .limit(1);
      if (used)
        throw new DomainError('LOT_IN_USE', 'This lot still carries serial numbers; delete them first', 409);
      await tx
        .update(itemLots)
        .set({ deletedAt: new Date(), deletedBy: tryGetAuthContext()?.userId })
        .where(and(eq(itemLots.tenantId, tenantId), eq(itemLots.id, id)));
      return { id, deleted: true };
    });
  }

  async createSerial(
    tenantId: string,
    input: { itemId: string; serialNo: string; lotId?: string; warehouseId?: string; status?: string },
  ) {
    const [serial] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(itemSerials)
        .values({
          id: newId(),
          tenantId,
          itemId: input.itemId,
          serialNo: input.serialNo,
          lotId: input.lotId,
          warehouseId: input.warehouseId,
          status: input.status ?? 'available',
        })
        .returning(),
    );
    return serial;
  }

  listSerials(
    tenantId: string,
    filters: { itemId?: string; status?: string; warehouseId?: string; q?: string } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(itemSerials)
        .where(
          and(
            eq(itemSerials.tenantId, tenantId),
            isNull(itemSerials.deletedAt),
            filters.itemId ? eq(itemSerials.itemId, filters.itemId) : undefined,
            filters.status ? eq(itemSerials.status, filters.status) : undefined,
            filters.warehouseId ? eq(itemSerials.warehouseId, filters.warehouseId) : undefined,
            filters.q?.trim() ? ilike(itemSerials.serialNo, `%${filters.q!.trim()}%`) : undefined,
          ),
        )
        .orderBy(asc(itemSerials.serialNo)),
    );
  }

  /**
   * ⚙️ توليد — the desktop's generator: `prefix` + a running number, `count` rows in one
   * go. All-or-nothing, because a half-generated batch is worse than none: the clerk
   * would not know which numbers are real.
   */
  async generateSerials(
    tenantId: string,
    input: { itemId: string; prefix: string; startAt?: number; count: number; warehouseId?: string; lotId?: string },
  ) {
    const prefix = input.prefix.trim();
    if (!prefix) throw new DomainError('SERIAL_PREFIX_REQUIRED', 'A generated serial needs a prefix', 422, { field: 'prefix' });
    const startAt = Number.isFinite(input.startAt) ? Math.max(0, Math.trunc(input.startAt ?? 1)) : 1;
    const count = Math.trunc(input.count);
    if (!Number.isFinite(count) || count < 1 || count > 500)
      throw new DomainError('SERIAL_COUNT_INVALID', 'Generate between 1 and 500 serials at a time', 422, { field: 'count' });

    const width = String(startAt + count - 1).length;
    const serialNos = Array.from({ length: count }, (_, index) => `${prefix}${String(startAt + index).padStart(width, '0')}`);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [item] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.id, input.itemId), isNull(items.deletedAt)));
      if (!item) throw new DomainError('ITEM_NOT_FOUND', 'The item was not found', 404);

      const existing = await tx
        .select({ serialNo: itemSerials.serialNo })
        .from(itemSerials)
        .where(and(eq(itemSerials.tenantId, tenantId), isNull(itemSerials.deletedAt), inArray(itemSerials.serialNo, serialNos)));
      if (existing.length)
        throw new DomainError(
          'SERIAL_DUPLICATE',
          `The serial ${existing[0]?.serialNo ?? ''} already exists`,
          409,
          { field: 'prefix', details: existing.map((row) => row.serialNo).slice(0, 5) },
        );

      const rows = serialNos.map((serialNo) => ({
        id: newId(),
        tenantId,
        itemId: input.itemId,
        serialNo,
        lotId: input.lotId ?? null,
        warehouseId: input.warehouseId ?? null,
        status: 'available',
      }));
      await tx.insert(itemSerials).values(rows);
      return { count: rows.length, serialNos };
    });
  }

  /** 🗑️ حذف — only a serial that never left the shelf can be withdrawn. */
  async deleteSerial(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [serial] = await tx
        .select()
        .from(itemSerials)
        .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, id), isNull(itemSerials.deletedAt)));
      if (!serial) throw new DomainError('SERIAL_NOT_FOUND', 'The serial was not found', 404);
      if (serial.status !== 'available')
        throw new DomainError(
          'SERIAL_INVALID_STATE',
          'Only an available serial can be deleted; return it to stock first',
          422,
        );
      await tx
        .update(itemSerials)
        .set({ deletedAt: new Date(), deletedBy: tryGetAuthContext()?.userId })
        .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, id)));
      return { id, deleted: true };
    });
  }

  async reserveSerials(tenantId: string, serialIds: string[]) {
    if (!serialIds.length) throw new DomainError('SERIALS_REQUIRED', 'At least one serial is required', 422);
    return this.transitionSerials(tenantId, serialIds, ['available'], 'reserved');
  }

  releaseSerials(tenantId: string, serialIds: string[]) {
    return this.transitionSerials(tenantId, serialIds, ['reserved'], 'available');
  }
  consumeSerials(tenantId: string, serialIds: string[]) {
    return this.transitionSerials(tenantId, serialIds, ['available', 'reserved'], 'sold');
  }
  returnSerials(tenantId: string, serialIds: string[]) {
    return this.transitionSerials(tenantId, serialIds, ['sold'], 'available');
  }

  private async transitionSerialsInTx(
    tx: DrizzleTx,
    tenantId: string,
    serialIds: string[],
    fromStatuses: string[],
    toStatus: string,
    warehouseId?: string,
  ) {
    if (!serialIds.length) return;
    const rows = await tx
      .select()
      .from(itemSerials)
      .where(and(eq(itemSerials.tenantId, tenantId), inArray(itemSerials.id, serialIds)));
    if (rows.length !== serialIds.length || rows.some((row) => !fromStatuses.includes(row.status)))
      throw new DomainError(
        'SERIAL_INVALID_STATE',
        'One or more serials cannot transition to the requested state',
        422,
        { field: 'serialIds' },
      );
    for (const serial of rows) {
      await tx
        .update(itemSerials)
        .set({ status: toStatus, ...(warehouseId ? { warehouseId } : {}), updatedAt: new Date() })
        .where(
          and(
            eq(itemSerials.tenantId, tenantId),
            eq(itemSerials.id, serial.id),
            inArray(itemSerials.status, fromStatuses),
          ),
        );
    }
  }

  private async transitionSerials(
    tenantId: string,
    serialIds: string[],
    fromStatuses: string[],
    toStatus: string,
  ) {
    if (!serialIds.length) throw new DomainError('SERIALS_REQUIRED', 'At least one serial is required', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      this.transitionSerialsInTx(tx, tenantId, serialIds, fromStatuses, toStatus).then(() => ({
        serialIds,
        status: toStatus,
      })),
    );
  }

  /**
   * `number` is optional: when the caller omits it the transfer takes the next value from
   * the document sequence. Letting the browser mint one (the old `TR-<timestamp>`) gives
   * an auditor a series with holes in it and no guarantee of uniqueness.
   *
   * `branchId` is what lets the transfer find a posting profile later — the two
   * warehouses may sit in different branches (مناقلة بين الفروع), and the branch of the
   * receiving warehouse is the one that owns the goods once they arrive.
   */
  async createTransfer(
    tenantId: string,
    input: {
      id?: string;
      number?: string;
      branchId?: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      lines: Array<{
        itemId: string;
        qty: string;
        unitCost?: string;
        lotId?: string;
        /** 📁 رقم الدفعة وتواريخها — كما على العبوة (R5). */
        batchNo?: string;
        productionDate?: string;
        expiryDate?: string;
        /**
         * Existing pieces to move, by id. Superseded by 🔢 `serialNos` below: an id only
         * works for a number the warehouse already owns and someone has already looked
         * up, which is not how a storeman reads a box off a shelf.
         */
        serialIds?: string[];
        /** 🔢 الأرقام التسلسلية read off the line — one per piece. */
        serialNos?: string[];
      }>;
    },
  ) {
    if (!input.lines.length || input.fromWarehouseId === input.toWarehouseId)
      throw new DomainError(
        'INVALID_STOCK_TRANSFER',
        'A transfer requires distinct warehouses and at least one line',
        422,
        { field: 'lines' },
      );
    if (input.lines.some((line) => !new Decimal(line.qty).gt(0)))
      throw new DomainError(
        'TRANSFER_QUANTITY_INVALID',
        'Transfer quantities must be greater than zero',
        422,
        { field: 'qty' },
      );
    const id = input.id ?? newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, tenantId),
            inArray(warehouses.id, [input.fromWarehouseId, input.toWarehouseId]),
          ),
        );
      const from = rows.find((row) => row.id === input.fromWarehouseId);
      const to = rows.find((row) => row.id === input.toWarehouseId);
      if (!from || !to)
        throw new DomainError(
          'TRANSFER_WAREHOUSE_INVALID',
          'Both warehouses must belong to this tenant',
          422,
          { field: 'fromWarehouseId' },
        );
      const lots = await this.resolveUploadedLots(tx, tenantId, input.lines);
      await this.assertStockable(
        tx,
        tenantId,
        input.lines.map((line, index) => ({ ...line, lotId: lots.get(index)?.lotId ?? null })),
      );
      const branchId = input.branchId ?? to.branchId ?? from.branchId;
      if (!branchId)
        throw new DomainError(
          'TRANSFER_BRANCH_REQUIRED',
          'A transfer needs a branch — set the branch on the warehouse or send one',
          422,
          { field: 'branchId' },
        );
      const number =
        input.number ??
        (
          await this.sequences.next({ tenantId, branchId, docType: 'stock_transfer' }, tx, {
            prefix: 'TR-',
            padding: 6,
          })
        ).display;
      await tx.insert(stockTransfers).values({
        id,
        tenantId,
        number,
        branchId,
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        status: 'draft',
      });
      await tx.insert(stockTransferLines).values(
        input.lines.map((line, index) => {
          const lot = lots.get(index);
          return {
            transferId: id,
            tenantId,
            lineNo: index + 1,
            itemId: line.itemId,
            qty: line.qty,
            unitCost: line.unitCost ?? '0',
            lotId: lot?.lotId ?? null,
            batchNo: lot?.batchNo ?? null,
            productionDate: lot?.productionDate ?? null,
            expiryDate: lot?.expiryDate ?? null,
            serialIds: line.serialIds ?? [],
            serialNos: (line.serialNos ?? []).map((value) => String(value).trim()).filter(Boolean),
          };
        }),
      );
      return { id, number, branchId, status: 'draft' };
    });
  }

  /**
   * 🔒 قراءة المناقلة — `forUpdate` لأربع عمليات الانتقال وحدها (إرسال، استلام، إقفال، إلغاء).
   * بلا قفل كان طلبان متزامنان على المناقلة نفسها يقرآن `in_transit` معاً فيعكس كلٌّ منهما
   * الكمية والقيد: بضاعة تعود مرتين ومرآتان لقيد واحد. القفل على صف المستند يجعل الثاني
   * ينتظر، ثم يقرأ الحالة المُودَعة فيرفضها (`TRANSFER_INVALID_STATE`) أو يعيد استخدام
   * العكس القائم. والقراءة العابرة (`getTransfer`) تبقى بلا قفل.
   */
  private async loadTransfer(
    tx: DrizzleTx,
    tenantId: string,
    transferId: string,
    options: { forUpdate?: boolean } = {},
  ) {
    const query = tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, transferId)));
    const [transfer] = options.forUpdate ? await query.for('update') : await query;
    if (!transfer) throw new DomainError('TRANSFER_NOT_FOUND', 'Transfer was not found', 404);
    const lines = await tx
      .select()
      .from(stockTransferLines)
      .where(and(eq(stockTransferLines.tenantId, tenantId), eq(stockTransferLines.transferId, transferId)));
    return { ...transfer, lines };
  }

  /**
   * Sending a transfer moves the goods out of the source warehouse and into بضاعة تحت
   * التحويل: Dr in-transit / Cr المخزون. Without that entry the stock is nowhere at all
   * for the days it spends on the road, and the inventory account is short by the value
   * that left it.
   */
  async sendTransfer(
    tenantId: string,
    transferId: string,
    options: { fiscalPeriodId?: string; allowNegative?: boolean } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const transfer = await this.loadTransfer(tx, tenantId, transferId, { forUpdate: true });
      if (transfer.status !== 'draft')
        throw new DomainError('TRANSFER_INVALID_STATE', 'Only draft transfers can be sent', 409);
      if (!transfer.lines.length)
        throw new DomainError('INVENTORY_LINES_REQUIRED', 'A transfer needs at least one line', 422);
      const allowNegative = options.allowNegative === true && this.canOverrideNegative();
      const branchId =
        transfer.branchId ??
        (
          await tx
            .select({ branchId: warehouses.branchId })
            .from(warehouses)
            .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, transfer.toWarehouseId)))
        )[0]?.branchId;
      if (!branchId)
        throw new DomainError(
          'TRANSFER_BRANCH_REQUIRED',
          'A transfer needs a branch before it can be sent',
          422,
          { field: 'branchId' },
        );

      const sent = await this.recordInTx(
        tx,
        tenantId,
        transfer.lines.map((line) => ({
          itemId: line.itemId,
          warehouseId: transfer.fromWarehouseId,
          qty: line.qty,
          unitCost: line.unitCost,
          direction: 'out' as const,
          docType: 'stock_transfer',
          docId: transferId,
          lineId: newId(),
          lotId: line.lotId ?? undefined,
          costing: 'outAtAvg' as const,
        })),
        { allowNegative },
      );
      /**
       * Stamp the cost the stock ledger actually used back onto the line. A مناقلة must
       * be value-neutral: the destination receives at exactly the cost the source
       * relieved, so the goods never change value on the road. Leaving the line's cost
       * at its `0` default (or at whatever the clerk typed) is how a transfer quietly
       * destroys value — the goods arrive worth nothing, and بضاعة تحت التحويل keeps a
       * balance that can never be cleared.
       */
      const sentMovements = await tx
        .select()
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.tenantId, tenantId),
            inArray(inventoryTransactions.id, sent.transactionIds),
          ),
        );
      for (const [index, line] of transfer.lines.entries()) {
        const movement = sentMovements.find((row) => row.id === sent.transactionIds[index]);
        if (!movement) continue;
        await tx
          .update(stockTransferLines)
          .set({ unitCost: movement.unitCost, sentQty: movement.qty })
          .where(
            and(
              eq(stockTransferLines.tenantId, tenantId),
              eq(stockTransferLines.transferId, transferId),
              eq(stockTransferLines.lineNo, line.lineNo),
            ),
          );
      }
      /**
       * 🔢 الأرقام التسلسلية named on the line. A مناقلة moves pieces the source already
       * owns — unlike a receipt it invents nothing — so each number has to be found
       * there, on the shelf, before the goods leave it. Their state is not spent, only
       * held: `available → reserved` keeps them booked to this transfer while they are
       * on the road.
       */
      const namedByLine = new Map<number, string[]>();
      for (const line of transfer.lines) {
        const numbers = (line.serialNos ?? []).map((value) => String(value).trim()).filter(Boolean);
        if (!numbers.length) continue;
        const unique = new Set(numbers);
        if (unique.size !== numbers.length)
          throw new DomainError('SERIAL_DUPLICATE', 'The same serial number appears twice on one line', 422, {
            field: 'serialNos',
          });
        const found = await tx
          .select()
          .from(itemSerials)
          .where(
            and(
              eq(itemSerials.tenantId, tenantId),
              eq(itemSerials.itemId, line.itemId),
              inArray(itemSerials.serialNo, numbers),
            ),
          );
        if (found.length !== numbers.length) {
          const missing = numbers.filter((value) => !found.some((row) => row.serialNo === value));
          throw new DomainError(
            'SERIAL_NOT_FOUND',
            `This item has no serial number ${missing[0]}`,
            422,
            { field: 'serialNos' },
          );
        }
        // A transfer line counts in base units — it has no unit of measure of its own —
        // so the quantity on the line is exactly the number of pieces to be named.
        const expected = new Decimal(line.qty).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
        if (found.length !== expected)
          throw new DomainError(
            'SERIAL_COUNT_MISMATCH',
            `This line moves ${Number(expected)} pieces but carries ${found.length} serial numbers`,
            422,
            { field: 'serialNos' },
          );
        const offShelf = found.find((row) => row.status !== 'available');
        if (offShelf)
          throw new DomainError(
            'SERIAL_INVALID_STATE',
            `Serial number ${offShelf.serialNo} is ${offShelf.status} and cannot be sent`,
            422,
            { field: 'serialNos' },
          );
        const elsewhere = found.find((row) => row.warehouseId !== transfer.fromWarehouseId);
        if (elsewhere)
          throw new DomainError(
            'SERIAL_WRONG_WAREHOUSE',
            `Serial number ${elsewhere.serialNo} is not in the sending warehouse`,
            422,
            { field: 'serialNos' },
          );
        namedByLine.set(line.lineNo, found.map((row) => row.id));
        await tx.insert(stockDocumentSerials).values(
          found.map((row) => ({
            id: newId(),
            tenantId,
            docType: 'stock_transfer',
            docId: transferId,
            lineNo: line.lineNo,
            itemId: line.itemId,
            serialId: row.id,
          })),
        );
      }
      if (namedByLine.size)
        for (const [lineNo, ids] of namedByLine) {
          const existing = transfer.lines.find((row) => row.lineNo === lineNo)?.serialIds ?? [];
          await tx
            .update(stockTransferLines)
            .set({ serialIds: Array.from(new Set([...existing, ...ids])) })
            .where(
              and(
                eq(stockTransferLines.tenantId, tenantId),
                eq(stockTransferLines.transferId, transferId),
                eq(stockTransferLines.lineNo, lineNo),
              ),
            );
        }

      for (const line of transfer.lines)
        await this.transitionSerialsInTx(tx, tenantId, [
          ...(line.serialIds ?? []),
          ...(namedByLine.get(line.lineNo) ?? []),
        ], ['available'], 'reserved');

      const value = await this.valueOfMovements(tx, tenantId, transferId, 'stock_transfer');
      let sentJournalEntryId: string | undefined;
      if (value.gt(0)) {
        const inventoryAccount = await this.profileAccount(
          tx,
          tenantId,
          branchId,
          'stock_transfer',
          'inventoryAccountId',
        );
        const transitAccount = await this.profileAccount(
          tx,
          tenantId,
          branchId,
          'stock_transfer',
          'stockInTransitAccountId',
        );
        const fiscalPeriodId =
          options.fiscalPeriodId ??
          (await this.accounting.openPeriodForDateInTx(tx, tenantId, new Date().toISOString().slice(0, 10)));
        const entry = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId,
          fiscalPeriodId,
          date: new Date().toISOString().slice(0, 10),
          description: `مناقلة ${transfer.number} — إرسال إلى بضاعة تحت التحويل`,
          lines: [
            { accountId: transitAccount, debit: value.toFixed(4), description: 'بضاعة تحت التحويل' },
            { accountId: inventoryAccount, credit: value.toFixed(4), description: 'خروج من المخزون' },
          ],
          sourceType: 'stock_transfer',
          sourceId: transferId,
          idempotencyKey: `stock-transfer-send:${transferId}`,
        });
        sentJournalEntryId = entry?.id;
      }

      await tx
        .update(stockTransfers)
        .set({
          status: 'in_transit',
          branchId,
          sentAt: new Date(),
          sentJournalEntryId: sentJournalEntryId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockTransfers.tenantId, tenantId),
            eq(stockTransfers.id, transferId),
            eq(stockTransfers.status, 'draft'),
          ),
        );
      const updated = await this.loadTransfer(tx, tenantId, transferId);
      return {
        transferId,
        number: updated.number,
        status: updated.status,
        value: value.toFixed(4),
        journalEntryId: sentJournalEntryId ?? null,
        lines: updated.lines.length,
      };
    });
  }

  /**
   * Receiving closes the in-transit balance: Dr المخزون / Cr بضاعة تحت التحويل at the
   * value that left, so a transfer is value-neutral and never re-prices the goods.
   */
  async receiveTransfer(
    tenantId: string,
    transferId: string,
    received: Array<{ lineNo: number; qty: string }>,
    options: { fiscalPeriodId?: string } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const transfer = await this.loadTransfer(tx, tenantId, transferId, { forUpdate: true });
      if (!['in_transit', 'partially_received'].includes(transfer.status))
        throw new DomainError('TRANSFER_INVALID_STATE', 'Transfer is not awaiting receipt', 409);
      const byLine = new Map(transfer.lines.map((line) => [line.lineNo, line]));
      const movements: InventoryLine[] = [];
      const serialIds: string[] = [];
      for (const input of received) {
        const line = byLine.get(input.lineNo);
        if (!line) throw new DomainError('TRANSFER_LINE_NOT_FOUND', 'Transfer line was not found', 404);
        const qty = new Decimal(input.qty);
        const already = new Decimal(line.receivedQty);
        const requested = new Decimal(line.qty);
        if (!qty.gt(0) || already.plus(qty).gt(requested))
          throw new DomainError(
            'TRANSFER_RECEIPT_INVALID',
            'Received quantity exceeds transfer quantity',
            422,
            { field: 'qty' },
          );
        movements.push({
          itemId: line.itemId,
          warehouseId: transfer.toWarehouseId,
          qty: qty.toFixed(4),
          unitCost: line.unitCost,
          direction: 'in',
          docType: 'stock_transfer_receipt',
          docId: transferId,
          lineId: newId(),
          lotId: line.lotId ?? undefined,
          costing: 'inWithCost',
        });
        serialIds.push(...(line.serialIds ?? []));
      }
      if (!movements.length) throw new DomainError('TRANSFER_RECEIPT_REQUIRED', 'Nothing to receive', 422);
      await this.recordInTx(tx, tenantId, movements);
      await this.transitionSerialsInTx(
        tx,
        tenantId,
        serialIds,
        ['reserved'],
        'available',
        transfer.toWarehouseId,
      );
      // 🔢 the numbers arrive on the receipt as well — a trace that stopped at the
      // send would leave a piece suspended in transit forever.
      if (serialIds.length)
        await tx.insert(stockDocumentSerials).values(
          serialIds.map((serialId) => {
            const line =
              byLine.get(
                received.find((row) => (byLine.get(row.lineNo)?.serialIds ?? []).includes(serialId))
                  ?.lineNo ?? -1,
              ) ?? transfer.lines[0];
            return {
              id: newId(),
              tenantId,
              docType: 'stock_transfer_receipt',
              docId: transferId,
              lineNo: line?.lineNo ?? 1,
              itemId: line?.itemId ?? '',
              serialId,
            };
          }),
        );

      const value = await this.valueOfMovements(tx, tenantId, transferId, 'stock_transfer_receipt');
      let receivedJournalEntryId: string | undefined;
      if (value.gt(0)) {
        const branchId =
          transfer.branchId ??
          (
            await tx
              .select({ branchId: warehouses.branchId })
              .from(warehouses)
              .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, transfer.toWarehouseId)))
          )[0]?.branchId;
        if (!branchId)
          throw new DomainError(
            'TRANSFER_BRANCH_REQUIRED',
            'A transfer needs a branch before it can be received',
            422,
            { field: 'branchId' },
          );
        const inventoryAccount = await this.profileAccount(
          tx,
          tenantId,
          branchId,
          'stock_transfer',
          'inventoryAccountId',
        );
        const transitAccount = await this.profileAccount(
          tx,
          tenantId,
          branchId,
          'stock_transfer',
          'stockInTransitAccountId',
        );
        const fiscalPeriodId =
          options.fiscalPeriodId ??
          (await this.accounting.openPeriodForDateInTx(tx, tenantId, new Date().toISOString().slice(0, 10)));
        const entry = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId,
          fiscalPeriodId,
          date: new Date().toISOString().slice(0, 10),
          description: `مناقلة ${transfer.number} — استلام`,
          lines: [
            { accountId: inventoryAccount, debit: value.toFixed(4), description: 'دخول إلى المخزون' },
            { accountId: transitAccount, credit: value.toFixed(4), description: 'خروج من بضاعة تحت التحويل' },
          ],
          sourceType: 'stock_transfer_receipt',
          sourceId: transferId,
          idempotencyKey: `stock-transfer-receive:${transferId}:${received.map((row) => `${row.lineNo}-${row.qty}`).join('|')}`,
        });
        receivedJournalEntryId = entry?.id;
        await tx
          .update(stockTransfers)
          .set({ receivedJournalEntryId, updatedAt: new Date() })
          .where(eq(stockTransfers.id, transferId));
      }

      for (const input of received) {
        await tx
          .update(stockTransferLines)
          .set({ receivedQty: sql`${stockTransferLines.receivedQty} + ${input.qty}` })
          .where(
            and(
              eq(stockTransferLines.tenantId, tenantId),
              eq(stockTransferLines.transferId, transferId),
              eq(stockTransferLines.lineNo, input.lineNo),
            ),
          );
      }
      const updated = await this.loadTransfer(tx, tenantId, transferId);
      const complete = updated.lines.every((line) => new Decimal(line.receivedQty).eq(new Decimal(line.qty)));
      await tx
        .update(stockTransfers)
        .set({
          status: complete ? 'received' : 'partially_received',
          receivedAt: complete ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, transferId)));
      return {
        transferId,
        status: complete ? 'received' : 'partially_received',
        value: value.toFixed(4),
        journalEntryId: receivedJournalEntryId ?? null,
        lines: updated.lines,
      };
    });
  }

  // ── بضاعة في الطريق — what is still on the road, and what happened to it ────

  /**
   * Everything still outstanding: sent, not (fully) received, not closed.
   *
   * A transfer that sits here is not a statistic — it is stock the source warehouse has
   * already lost and the destination has never gained. `daysInTransit` is what makes an
   * old one visible before somebody closes it.
   */
  async inTransit(tenantId: string, warehouseId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const open = await tx
        .select()
        .from(stockTransfers)
        .where(
          and(
            eq(stockTransfers.tenantId, tenantId),
            inArray(stockTransfers.status, ['in_transit', 'partially_received']),
            warehouseId ? eq(stockTransfers.fromWarehouseId, warehouseId) : undefined,
          ),
        )
        .orderBy(asc(stockTransfers.sentAt));
      const rows = [];
      for (const transfer of open) {
        const lines = await tx
          .select()
          .from(stockTransferLines)
          .where(
            and(eq(stockTransferLines.tenantId, tenantId), eq(stockTransferLines.transferId, transfer.id)),
          );
        for (const line of lines) {
          const outstanding = new Decimal(line.qty).minus(line.receivedQty).minus(line.closedQty);
          if (outstanding.lte(0)) continue;
          const [item] = await tx
            .select({ sku: items.sku, nameAr: items.nameAr, baseUnitId: items.baseUnitId })
            .from(items)
            .where(eq(items.id, line.itemId));
          const factor = line.unitId
            ? new Decimal(
                (
                  await tx
                    .select({ ratio: itemUnits.ratio })
                    .from(itemUnits)
                    .where(
                      and(
                        eq(itemUnits.tenantId, tenantId),
                        eq(itemUnits.itemId, line.itemId),
                        eq(itemUnits.unitId, line.unitId),
                      ),
                    )
                )[0]?.ratio ?? '1',
              )
            : new Decimal(1);
          rows.push({
            transferId: transfer.id,
            number: transfer.number,
            branchId: transfer.branchId,
            fromWarehouseId: transfer.fromWarehouseId,
            toWarehouseId: transfer.toWarehouseId,
            status: transfer.status,
            sentAt: transfer.sentAt,
            daysInTransit: transfer.sentAt
              ? Math.floor((Date.now() - new Date(transfer.sentAt).getTime()) / 86_400_000)
              : null,
            lineNo: line.lineNo,
            itemId: line.itemId,
            sku: item?.sku ?? null,
            nameAr: item?.nameAr ?? null,
            unitId: line.unitId,
            qty: outstanding.toFixed(4),
            baseQty: outstanding.mul(factor).toFixed(4),
            value: outstanding
              .mul(factor)
              .mul(new Decimal(line.unitCost ?? '0'))
              .toFixed(4),
          });
        }
      }
      return rows;
    });
  }

  /**
   * Closing a transfer settles whatever the destination never received.
   *
   * Two honest endings, and no third one:
   *
   * • `return` — the goods came home. Stock moves back into the **source** warehouse at
   *   the cost it left at (so value is conserved), and the transit asset is cleared:
   *   Dr المخزون / Cr بضاعة تحت التحويل.
   * • `shortage` — the goods are gone. Nothing moves in the stock ledger (the source
   *   already lost them when it sent them); the transit asset is written off instead:
   *   Dr عجز / Cr بضاعة تحت التحويل.
   *
   * Either way بضاعة تحت التحويل ends at zero for this transfer, and `closed_qty`
   * records the part that was settled without a receipt — `received_qty` is never
   * inflated to make a document look complete.
   */
  async closeTransfer(
    tenantId: string,
    transferId: string,
    input: { mode: 'return' | 'shortage'; reason?: string; fiscalPeriodId?: string } = { mode: 'return' },
  ) {
    if (!['return', 'shortage'].includes(input.mode))
      throw new DomainError(
        'TRANSFER_CLOSURE_MODE_INVALID',
        'Closing a transfer needs a mode: return or shortage',
        422,
        {
          field: 'mode',
        },
      );
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const transfer = await this.loadTransfer(tx, tenantId, transferId, { forUpdate: true });
      if (transfer.status === 'closed')
        throw new DomainError('TRANSFER_ALREADY_CLOSED', 'This transfer is already closed', 409);
      if (!['in_transit', 'partially_received'].includes(transfer.status))
        throw new DomainError('TRANSFER_INVALID_STATE', 'Only a transfer on the road can be closed', 409);

      const remainder = transfer.lines
        .map((line) => ({
          line,
          outstanding: new Decimal(line.qty).minus(line.receivedQty).minus(line.closedQty),
        }))
        .filter((row) => row.outstanding.gt(0));
      if (!remainder.length)
        throw new DomainError('TRANSFER_NOTHING_OUTSTANDING', 'This transfer has nothing left to close', 409);

      const branchId =
        transfer.branchId ??
        (
          await tx
            .select({ branchId: warehouses.branchId })
            .from(warehouses)
            .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, transfer.toWarehouseId)))
        )[0]?.branchId;
      if (!branchId)
        throw new DomainError(
          'TRANSFER_BRANCH_REQUIRED',
          'A transfer needs a branch before it can be closed',
          422,
          {
            field: 'branchId',
          },
        );

      // The cost each line left at — a return has to put the same value back, or the
      // inventory account drifts by the difference.
      const sent = await tx
        .select()
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.tenantId, tenantId),
            eq(inventoryTransactions.docId, transferId),
            eq(inventoryTransactions.docType, 'stock_transfer'),
          ),
        );
      const costOf = new Map<string, string>();
      for (const movement of sent)
        costOf.set(movement.lineId ?? `${movement.itemId}`, movement.unitCost ?? '0');

      const movements: InventoryLine[] = [];
      const serialIds: string[] = [];
      let value = new Decimal(0);
      for (const { line, outstanding } of remainder) {
        const factor = line.unitId
          ? new Decimal(
              (
                await tx
                  .select({ ratio: itemUnits.ratio })
                  .from(itemUnits)
                  .where(
                    and(
                      eq(itemUnits.tenantId, tenantId),
                      eq(itemUnits.itemId, line.itemId),
                      eq(itemUnits.unitId, line.unitId),
                    ),
                  )
              )[0]?.ratio ?? '1',
            )
          : new Decimal(1);
        value = value.plus(outstanding.mul(factor).mul(new Decimal(line.unitCost ?? '0')));
        if (input.mode === 'return') {
          movements.push({
            itemId: line.itemId,
            warehouseId: transfer.fromWarehouseId,
            qty: outstanding.toFixed(4),
            unitId: line.unitId ?? undefined,
            unitCost: line.unitCost ?? '0',
            direction: 'in',
            docType: 'stock_transfer_return',
            docId: transferId,
            lineId: newId(),
            lotId: line.lotId ?? undefined,
            costing: 'returnAtOriginalCost',
          });
          serialIds.push(...(line.serialIds ?? []));
        }
      }

      if (movements.length) await this.recordInTx(tx, tenantId, movements, { allowNegative: true });
      if (input.mode === 'return' && serialIds.length) {
        await this.transitionSerialsInTx(
          tx,
          tenantId,
          serialIds,
          ['reserved'],
          'available',
          transfer.fromWarehouseId,
        );
      }

      let closedJournalEntryId: string | undefined;
      if (value.gt(0)) {
        const transitAccount = await this.profileAccount(
          tx,
          tenantId,
          branchId,
          'stock_transfer',
          'stockInTransitAccountId',
        );
        const otherAccount = await this.profileAccount(
          tx,
          tenantId,
          branchId,
          'stock_transfer',
          input.mode === 'return' ? 'inventoryAccountId' : 'inventoryAdjustmentAccountId',
        );
        const fiscalPeriodId =
          input.fiscalPeriodId ??
          (await this.accounting.openPeriodForDateInTx(tx, tenantId, new Date().toISOString().slice(0, 10)));
        const title = input.mode === 'return' ? 'عودة بضاعة إلى مصدرها' : 'عجز بضاعة تحت التحويل';
        const entry = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId,
          fiscalPeriodId,
          date: new Date().toISOString().slice(0, 10),
          description: `إقفال مناقلة ${transfer.number} — ${title}${input.reason ? `: ${input.reason}` : ''}`,
          lines: [
            {
              accountId: otherAccount,
              debit: value.toFixed(4),
              description: input.mode === 'return' ? 'عودة إلى المخزون' : 'عجز البضاعة',
            },
            { accountId: transitAccount, credit: value.toFixed(4), description: 'إقفال بضاعة تحت التحويل' },
          ],
          sourceType: input.mode === 'return' ? 'stock_transfer_return' : 'stock_transfer_shortage',
          sourceId: transferId,
          idempotencyKey: `stock-transfer-close:${transferId}:${input.mode}`,
        });
        closedJournalEntryId = entry?.id;
      }

      for (const { line, outstanding } of remainder) {
        await tx
          .update(stockTransferLines)
          .set({ closedQty: sql`${stockTransferLines.closedQty} + ${outstanding.toFixed(4)}` })
          .where(
            and(
              eq(stockTransferLines.tenantId, tenantId),
              eq(stockTransferLines.transferId, transferId),
              eq(stockTransferLines.lineNo, line.lineNo),
            ),
          );
      }
      await tx
        .update(stockTransfers)
        .set({
          status: 'closed',
          closedAt: new Date(),
          closedJournalEntryId,
          closureMode: input.mode,
          closureReason: input.reason ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, transferId)));

      return {
        transferId,
        number: transfer.number,
        status: 'closed' as const,
        mode: input.mode,
        value: value.toFixed(4),
        returnedQty:
          input.mode === 'return'
            ? remainder.reduce((sum, row) => sum.plus(row.outstanding), new Decimal(0)).toFixed(4)
            : '0.0000',
        journalEntryId: closedJournalEntryId ?? null,
        lines: remainder.map(({ line, outstanding }) => ({
          lineNo: line.lineNo,
          itemId: line.itemId,
          qty: outstanding.toFixed(4),
        })),
      };
    });
  }

  /**
   * Cancelling a draft just stops it. Cancelling an in-transit transfer has to put the
   * goods back: a reverse movement into the source warehouse, a reversal of the send
   * entry, and the serials released — otherwise the stock has simply disappeared.
   */
  async cancelTransfer(tenantId: string, transferId: string, reason?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const transfer = await this.loadTransfer(tx, tenantId, transferId, { forUpdate: true });
      if (['received', 'cancelled'].includes(transfer.status))
        throw new DomainError('TRANSFER_INVALID_STATE', 'Transfer cannot be cancelled', 409);
      if (transfer.status === 'in_transit') {
        const sent = await tx
          .select()
          .from(inventoryTransactions)
          .where(
            and(
              eq(inventoryTransactions.tenantId, tenantId),
              eq(inventoryTransactions.docId, transferId),
              eq(inventoryTransactions.docType, 'stock_transfer'),
            ),
          );
        const mirrors: InventoryLine[] = sent.map((movement) => ({
          itemId: movement.itemId,
          warehouseId: movement.warehouseId,
          qty: movement.qty,
          unitCost: movement.unitCost ?? '0',
          direction: 'in' as const,
          docType: 'stock_transfer_cancel',
          docId: transferId,
          lineId: movement.lineId ?? undefined,
          lotId: movement.lotId ?? undefined,
          costing: 'returnAtOriginalCost' as const,
        }));
        if (mirrors.length) await this.recordInTx(tx, tenantId, mirrors, { allowNegative: true });
        if (transfer.sentJournalEntryId)
          await this.reversalEntry(
            tx,
            tenantId,
            transfer.sentJournalEntryId,
            reason ?? `إلغاء مناقلة ${transfer.number}`,
          );
        const serialIds = transfer.lines.flatMap((line) => line.serialIds ?? []);
        await this.transitionSerialsInTx(
          tx,
          tenantId,
          serialIds,
          ['reserved'],
          'available',
          transfer.fromWarehouseId,
        );
      }
      await tx
        .update(stockTransfers)
        .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, transferId)));
      return { transferId, status: 'cancelled' as const };
    });
  }

  getTransfer(tenantId: string, transferId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.loadTransfer(tx, tenantId, transferId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 05 — سند إدخال / إخراج مخزني · بضاعة أول المدة · مناقلة · جرد وتسوية
  //
  // The desktop saved these documents with `entry = null` and let the accountant
  // repair the ledger by hand (`frmInvInOutput`, `frmInventoryTransfer`). The cloud
  // cannot: sales and purchases already post to the inventory account, so a document
  // that moved quantity without a journal would leave the ledger permanently
  // disagreeing with the stock balance — the exact drift `recomputeBalances` exists
  // to detect. Every document below therefore writes its movements *and* its balanced
  // journal inside one transaction.
  // ─────────────────────────────────────────────────────────────────────────────

  private canOverrideNegative(): boolean {
    const permissions = getRequestContext().tenant?.permissions ?? [];
    return permissions.includes('*') || permissions.includes('inventory.negative.override');
  }

  private async nextNumber(
    tx: DrizzleTx,
    tenantId: string,
    branchId: string,
    docType: string,
    prefix: string,
  ): Promise<string> {
    const allocated = await this.sequences.next({ tenantId, branchId, docType }, tx, { prefix, padding: 6 });
    return allocated.display;
  }

  /** Resolves the branch posting profile and refuses to invent any account. */
  private async profileAccount(
    tx: DrizzleTx,
    tenantId: string,
    branchId: string,
    docType: string,
    key: string,
  ): Promise<string> {
    const profile = await this.profiles.resolvePostProfileInTx(tx, tenantId, branchId, docType);
    const accountId = (profile.mapping as unknown as Record<string, string | null | undefined>)[key];
    if (!accountId) {
      throw new DomainError(
        'INVENTORY_PROFILE_KEY_MISSING',
        `Posting profile has no ${key} — map it in Settings › Posting profiles`,
        422,
        { field: key },
      );
    }
    return accountId;
  }

  /** An account handed to us by a caller must belong to this tenant. */
  private async assertAccount(tx: DrizzleTx, tenantId: string, accountId: string): Promise<string> {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
    if (!row)
      throw new DomainError('INVENTORY_ACCOUNT_INVALID', 'The account does not belong to this tenant', 422, {
        field: 'counterAccountId',
      });
    return row.id;
  }

  /**
   * Only `stock` items move through the stock ledger, and an item that declares it is
   * tracked by lot or by serial must name one — otherwise the traceability the master
   * data promises is a lie the movement silently tells.
   */
  /**
   * 📁 الدفعة من السطر — R5.
   *
   * الديسكتوب لا يطلب من أمين المخزن أن يسجّل الدفعة في شاشةٍ أولاً ثم يعود إلى المستند:
   * يكتب رقم الدفعة وتاريخيها **على السطر**، و`InvoiceOper.cs` L1635 يحفظها في
   * `InvoiceItemDetail`، وL1586–L1590 يضبط تاريخ الانتهاء إن جاء فارغاً. وهذه الدالة تفعل
   * الشيء نفسه: يُذكر `batchNo` ⇒ يُرسَل إلى الدفعة المطابقة على (المستأجر · الصنف · الرقم)،
   * وإن لم تكن مسجَّلة **تُنشأ** بتواريخ السطر. وبذلك لا يبقى «الدفعات» شاشةً تُزار قبل كل
   * إدخال، ويبقى `lot_id` على السطر هو ما تقرأه الحركات في الدفتر.
   *
   * والقواعد الثلاث:
   *
   *   1. دفعةٌ مسجَّلة بتاريخٍ سابق مخالف لتاريخ السطر ⇒ `LOT_EXPIRY_MISMATCH` (409).
   *      الديسكتوب كان يكتب كل سطرٍ كما جاء، فيوجد لدفعةٍ واحدة تاريخان؛ ومنعُ ذلك
   *      يمنع تقرير صلاحيةٍ يكذب. والتواريخ الفارغة تملأ ولا تُخالف: سطرٌ يذكر الرقم
   *      وحده يُكمل تاريخَ الدفعة ولا يمحوه.
   *   2. دفعةٌ على صنفٍ لا يُتتبَّع بالدفعات ⇒ `LOT_NOT_TRACKED` (422): الرفض أصدق من
   *      حفظها في العدم.
   *   3. `lotId` الصريح يبقى مقبولاً — لكن الدفعة يجب أن تكون لهذا الصنف ولهذا المستأجر.
   *
   * وتُستدعى في **إنشاء المستند** لا في ترحيله: السطر يحفظ ما كُتب، والحركة تقرأ `lot_id`.
   */
  private async resolveUploadedLots(
    tx: DrizzleTx,
    tenantId: string,
    lines: Array<{
      itemId: string;
      lotId?: string | null;
      batchNo?: string | null;
      productionDate?: string | null;
      expiryDate?: string | null;
    }>,
  ): Promise<
    Map<
      number,
      { lotId: string | null; batchNo: string | null; productionDate: string | null; expiryDate: string | null }
    >
  > {
    const resolved = new Map<
      number,
      { lotId: string | null; batchNo: string | null; productionDate: string | null; expiryDate: string | null }
    >();
    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    if (itemIds.length === 0) return resolved;
    const itemRows = await tx
      .select({ id: items.id, trackLot: items.trackLot })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), inArray(items.id, itemIds)));
    const trackOf = new Map(itemRows.map((row) => [row.id, row.trackLot]));

    for (const [index, line] of lines.entries()) {
      const batchNo = line.batchNo?.trim() ? line.batchNo.trim() : null;
      const productionDate = line.productionDate?.trim() ? line.productionDate.trim() : null;
      const expiryDate = line.expiryDate?.trim() ? line.expiryDate.trim() : null;
      const tracks = trackOf.get(line.itemId) === true;
      if (!tracks && (batchNo || expiryDate || productionDate))
        throw new DomainError(
          errorCodes.LOT_NOT_TRACKED,
          'هذا الصنف لا يُتتبَّع بالدفعات — لا تكتب له رقم دفعة',
          422,
          { field: 'batchNo', itemId: line.itemId },
        );

      if (!batchNo && !line.lotId) {
        resolved.set(index, { lotId: null, batchNo: null, productionDate: null, expiryDate: null });
        continue;
      }

      let lot:
        | { id: string; lotNo: string; productionDate: string | null; expiryDate: string | null }
        | undefined;
      if (line.lotId) {
        const [found] = await tx
          .select({
            id: itemLots.id,
            lotNo: itemLots.lotNo,
            productionDate: itemLots.productionDate,
            expiryDate: itemLots.expiryDate,
          })
          .from(itemLots)
          .where(
            and(
              eq(itemLots.tenantId, tenantId),
              eq(itemLots.id, line.lotId),
              eq(itemLots.itemId, line.itemId),
              isNull(itemLots.deletedAt),
            ),
          );
        lot = found;
        if (!lot)
          throw new DomainError('LOT_NOT_FOUND', 'The lot was not found for this item', 404, {
            field: 'lotId',
          });
      } else if (batchNo) {
        const [found] = await tx
          .select({
            id: itemLots.id,
            lotNo: itemLots.lotNo,
            productionDate: itemLots.productionDate,
            expiryDate: itemLots.expiryDate,
          })
          .from(itemLots)
          .where(
            and(
              eq(itemLots.tenantId, tenantId),
              eq(itemLots.itemId, line.itemId),
              eq(itemLots.lotNo, batchNo),
              isNull(itemLots.deletedAt),
            ),
          );
        lot = found;
        if (!lot) {
          const [created] = await tx
            .insert(itemLots)
            .values({
              id: newId(),
              tenantId,
              itemId: line.itemId,
              lotNo: batchNo,
              productionDate,
              expiryDate,
              receivedAt: new Date(),
            })
            .returning({
              id: itemLots.id,
              lotNo: itemLots.lotNo,
              productionDate: itemLots.productionDate,
              expiryDate: itemLots.expiryDate,
            });
          lot = created;
        }
      }
      if (!lot) continue;

      // التاريخ المخالف يُرفض؛ والفارغ يُملأ — فالسطر يقول ما على العبوة ولا يناقض ما سُجّل.
      const given = { productionDate, expiryDate };
      const patch: { productionDate?: string; expiryDate?: string } = {};
      if (given.expiryDate && lot.expiryDate && given.expiryDate !== lot.expiryDate)
        throw new DomainError(
          errorCodes.LOT_EXPIRY_MISMATCH,
          `الدفعة ${lot.lotNo} مسجَّلة بانتهاء ${lot.expiryDate} — والسطر يقول ${given.expiryDate}`,
          409,
          { field: 'expiryDate', lotNo: lot.lotNo, recorded: lot.expiryDate, given: given.expiryDate },
        );
      if (given.expiryDate && !lot.expiryDate) patch.expiryDate = given.expiryDate;
      if (given.productionDate && !lot.productionDate) patch.productionDate = given.productionDate;
      if (Object.keys(patch).length) {
        await tx
          .update(itemLots)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(itemLots.tenantId, tenantId), eq(itemLots.id, lot.id)));
        lot = { ...lot, ...patch };
      }

      resolved.set(index, {
        lotId: lot.id,
        // سطرٌ ذكر رقماً (أو صنفٌ يُتتبَّع بالدفعات) يكتب الرقم المسجَّل — وغيره لا نُقحم عليه ما لم يقل.
        batchNo: batchNo || tracks ? lot.lotNo : null,
        productionDate: lot.productionDate,
        expiryDate: lot.expiryDate,
      });
    }
    return resolved;
  }

  private async assertStockable(
    tx: DrizzleTx,
    tenantId: string,
    lines: Array<{
      itemId: string;
      lotId?: string | null;
      serialId?: string | null;
      serialNos?: readonly string[] | null;
    }>,
  ): Promise<
    Map<string, { kind: string; trackLot: boolean; trackSerial: boolean; purchasePrice: string | null }>
  > {
    const ids = [...new Set(lines.map((line) => line.itemId))];
    const rows = await tx
      .select({
        id: items.id,
        kind: items.kind,
        trackLot: items.trackLot,
        trackSerial: items.trackSerial,
        purchasePrice: items.purchasePrice,
      })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), inArray(items.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const line of lines) {
      const item = byId.get(line.itemId);
      if (!item)
        throw new DomainError('INVENTORY_ITEM_NOT_FOUND', 'Item was not found in this tenant', 404, {
          field: 'itemId',
        });
      if (item.kind !== 'stock')
        throw new DomainError(
          'INVENTORY_ITEM_NOT_STOCKED',
          'Only stock items can appear on a stock document',
          422,
          { field: 'itemId' },
        );
      if (item.trackLot && !line.lotId)
        throw new DomainError('INVENTORY_LOT_REQUIRED', 'This item is tracked by lot — choose a lot', 422, {
          field: 'lotId',
        });
      const hasSerialNos =
        Array.isArray(line.serialNos) && line.serialNos.some((value) => String(value).trim().length > 0);
      if (item.trackSerial && !line.serialId && !hasSerialNos)
        throw new DomainError(
          'INVENTORY_SERIAL_REQUIRED',
          'This item is tracked by serial — scan a serial',
          422,
          { field: 'serialId' },
        );
    }
    return byId;
  }

  /** The value the movements actually booked — read back, never recomputed on faith. */
  private async valueOfMovements(
    tx: DrizzleTx,
    tenantId: string,
    docId: string,
    docType?: string,
  ): Promise<Decimal> {
    const txns = await tx
      .select({ totalCost: inventoryTransactions.totalCost })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.tenantId, tenantId),
          eq(inventoryTransactions.docId, docId),
          docType ? eq(inventoryTransactions.docType, docType) : undefined,
        ),
      );
    return txns.reduce((sum, row) => sum.plus(row.totalCost ?? '0'), new Decimal(0));
  }

  private async reversalEntry(
    tx: DrizzleTx,
    tenantId: string,
    entryId: string,
    reason: string,
  ): Promise<string | undefined> {
    const [entry] = await tx
      .select({ status: journalEntries.status })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.id, entryId)));
    /**
     * لا يُعكس ما لم يُرحَّل — مسودةٌ تُلغى بلا عكس، وقيدٌ أُبطل قديماً (بيانات سابقة لهذا
     * الاصطلاح) لا يُلمس. `undefined` تعني «لا عكس لازماً»، لا «فشل صامت».
     */
    if (!entry || entry.status !== 'posted') return undefined;
    /**
     * 🔁 الآلية الموحَّدة — `AccountingService.reverseJournalInTx` هي العكس الرسمي الوحيد في
     * النظام. ما كان هنا نسخة ثانية منه، وكانت **تبطل الأصل وترحّل المرآة معاً**: وكل
     * الأرصدة والتقارير تجمع `status = 'posted'`، فيسقط الأصل من الميزان وتبقى مرآته ⇒
     * ينحرف رصيد الحساب بمقدار العملية الملغاة بعد كل `cancelTransfer` أو إلغاء سند.
     * الاصطلاح المعتمد (منذ الترحيل `0047` وتقرأه `report-catalog.ts ← entryStateScope`):
     * الأصل يبقى `posted`، والمرآة تحمل `reversalOf` وأبعاد السطر كلها، و«لاغي» = قيدٌ
     * يشير إليه عكس. والمرآة وحدها تكفي لأن الأصل وعكسه معاً صفر.
     */
    const reversed = await this.accounting.reverseJournalInTx(tx, tenantId, entryId, {
      reason,
      actorId: getRequestContext().tenant?.userId ?? null,
      // داخل ساغا الإلغاء: إعادة المحاولة ترجع العكس القائم ولا تنشئ ثانياً.
      ifAlreadyReversed: 'reuse',
    });
    return reversed.id;
  }

  // ── الرقم التسلسلي على سطر المستند ──────────────────────────────────────────

  /**
   * Resolves the serial numbers typed on a document line, at posting time.
   *
   * In: the numbers are created (`available`) — the stock is arriving, so the piece is
   * real from now on. Out: they must already exist, belong to the same item, be on the
   * shelf and sit in this warehouse, and are then marked `sold`. Return (R8): the piece
   * comes **back** — it exists as `sold` (this is what a مرتجع بيع is) and goes on the
   * shelf again, which the receipt branch must not do because it would refuse a number
   * that already exists. Either way the line and its numbers are linked in
   * `stock_document_serials`, which is what makes "which document moved this number?"
   * a query instead of a guess.
   */
  private async resolveLineSerials(
    tx: DrizzleTx,
    tenantId: string,
    input: {
      docType: string;
      docId: string;
      lineNo: number;
      itemId: string;
      warehouseId: string;
      lotId?: string | null;
      serialNos?: string[];
      qty: string;
      unitId?: string | null;
      direction: 'in' | 'out';
      /**
       * How the line meets the numbers (R8). Derived from `direction` when omitted, so
       * every existing caller keeps its behaviour: `in` ⇒ receipt, `out` ⇒ issue.
       * A **sale return** is `in` as a movement but `return` as a meeting: the piece
       * was sold by us, so it exists and comes back to the shelf.
       */
      mode?: 'receipt' | 'issue' | 'return';
    },
  ): Promise<string[]> {
    const numbers = (input.serialNos ?? []).map((value) => String(value).trim()).filter(Boolean);
    if (!numbers.length) return [];
    if (new Set(numbers).size !== numbers.length)
      throw new DomainError('SERIAL_DUPLICATE', 'The same serial number appears twice on this line', 422, {
        field: 'serialNos',
      });

    // A line that moves 12 pieces has to carry 12 numbers — the count is the point of
    // serialising the item in the first place.
    const { factor } = await this.resolveUnit(tx, tenantId, {
      itemId: input.itemId,
      unitId: input.unitId ?? undefined,
    } as InventoryLine);
    const baseQty = new Decimal(input.qty).mul(factor);
    if (!baseQty.equals(numbers.length))
      throw new DomainError(
        'SERIAL_COUNT_MISMATCH',
        `This line moves ${baseQty} pieces but carries ${numbers.length} serial numbers`,
        422,
        { field: 'serialNos' },
      );

    let ids: string[] = [];
    const mode = input.mode ?? (input.direction === 'in' ? 'receipt' : 'issue');
    if (mode === 'receipt') {
      const existing = await tx
        .select({ serialNo: itemSerials.serialNo })
        .from(itemSerials)
        .where(
          and(
            eq(itemSerials.tenantId, tenantId),
            isNull(itemSerials.deletedAt),
            inArray(itemSerials.serialNo, numbers),
          ),
        );
      if (existing.length)
        throw new DomainError('SERIAL_DUPLICATE', `The serial ${existing[0]?.serialNo ?? ''} already exists`, 409, {
          field: 'serialNos',
        });
      const created = numbers.map((serialNo) => ({
        id: newId(),
        tenantId,
        itemId: input.itemId,
        serialNo,
        lotId: input.lotId ?? null,
        warehouseId: input.warehouseId,
        status: 'available',
      }));
      await tx.insert(itemSerials).values(created);
      ids = created.map((row) => row.id);
    } else {
      const rows = await tx
        .select()
        .from(itemSerials)
        .where(
          and(
            eq(itemSerials.tenantId, tenantId),
            eq(itemSerials.itemId, input.itemId),
            isNull(itemSerials.deletedAt),
            inArray(itemSerials.serialNo, numbers),
          ),
        );
      if (rows.length !== numbers.length) {
        const found = new Set(rows.map((row) => row.serialNo));
        const missing = numbers.find((serialNo) => !found.has(serialNo));
        throw new DomainError(
          'SERIAL_NOT_FOUND',
          `The serial ${missing ?? ''} does not belong to this item`,
          422,
          { field: 'serialNos' },
        );
      }
      if (mode === 'return') {
        // مرتجع: القطعة موجودة لكنها **مباعة**، وهي تعود إلى الرفّ. ومَن يبيع ما لم
        // يبعه سابقاً مُخطئ — فيُسمَّى الخطأ بالحالات المقبولة لا نتركه يمرّ.
        const notSold = rows.find((row) => row.status !== 'sold');
        if (notSold)
          throw new DomainError(
            'SERIAL_NOT_RETURNABLE',
            `The serial ${notSold.serialNo} is ${notSold.status} and was not sold by this company`,
            422,
            { field: 'serialNos' },
          );
      } else {
        const gone = rows.find((row) => !['available', 'reserved'].includes(row.status));
        if (gone)
          throw new DomainError('SERIAL_INVALID_STATE', `The serial ${gone.serialNo} is no longer on the shelf`, 422, {
            field: 'serialNos',
          });
        const elsewhere = rows.find((row) => row.warehouseId && row.warehouseId !== input.warehouseId);
        if (elsewhere)
          throw new DomainError(
            'SERIAL_WRONG_WAREHOUSE',
            `The serial ${elsewhere.serialNo} is not in this warehouse`,
            422,
            { field: 'serialNos' },
          );
      }
      ids = rows.map((row) => row.id);
      const nextStatus = mode === 'return' ? 'available' : 'sold';
      for (const row of rows) {
        await tx
          .update(itemSerials)
          .set({ status: nextStatus, warehouseId: input.warehouseId, updatedAt: new Date() })
          .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, row.id)));
      }
    }

    await tx.insert(stockDocumentSerials).values(
      ids.map((serialId) => ({
        id: newId(),
        tenantId,
        docType: input.docType,
        docId: input.docId,
        lineNo: input.lineNo,
        itemId: input.itemId,
        serialId,
      })),
    );
    return ids;
  }

  /**
   * Undoes what `resolveLineSerials` did — the numbers a receipt brought in are taken
   * back out (only while they are still sitting where the receipt put them), and the
   * numbers an issue sold are put back on the shelf.
   *
   * `soldAgain` is for a document whose `in` movement was a **return** rather than a
   * receipt (R8): the piece existed before the document and was sold, so voiding the
   * document puts it back to `sold` instead of deleting a number this company still
   * owns. Defaults to the old behaviour (a deleted receipt's numbers are its own).
   */
  private async reverseDocumentSerials(
    tx: DrizzleTx,
    tenantId: string,
    input: { docType: string; docId: string; direction: 'in' | 'out'; soldAgain?: boolean },
  ) {
    const links = await tx
      .select()
      .from(stockDocumentSerials)
      .where(
        and(
          eq(stockDocumentSerials.tenantId, tenantId),
          eq(stockDocumentSerials.docType, input.docType),
          eq(stockDocumentSerials.docId, input.docId),
        ),
      );
    if (!links.length) return;
    const rows = await tx
      .select()
      .from(itemSerials)
      .where(
        and(
          eq(itemSerials.tenantId, tenantId),
          inArray(itemSerials.id, links.map((link) => link.serialId)),
        ),
      );
    for (const row of rows) {
      if (input.direction === 'in' && input.soldAgain) {
        // Came back on this document, went out before it: undoing the document sends
        // the piece out again — the number and its history stay.
        if (row.status === 'available')
          await tx
            .update(itemSerials)
            .set({ status: 'sold', updatedAt: new Date() })
            .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, row.id)));
      } else if (input.direction === 'in') {
        // Created by this document. If somebody has already moved the piece, deleting
        // the number would erase its history; leave it and let the ledger speak.
        if (row.status === 'available')
          await tx
            .update(itemSerials)
            .set({ deletedAt: new Date(), deletedBy: tryGetAuthContext()?.userId })
            .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, row.id)));
      } else if (row.status === 'sold') {
        await tx
          .update(itemSerials)
          .set({ status: 'available', updatedAt: new Date() })
          .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, row.id)));
      }
    }
    await tx
      .delete(stockDocumentSerials)
      .where(
        and(
          eq(stockDocumentSerials.tenantId, tenantId),
          eq(stockDocumentSerials.docType, input.docType),
          eq(stockDocumentSerials.docId, input.docId),
        ),
      );
  }

  /**
   * 🔢 📁 الأرقام التسلسلية والدفعات على **سطور فاتورة** — R8.
   *
   * الديسكتوب يكتب الأرقام الأربعة على سطر الفاتورة نفسها (`Class/InvoiceOper.cs` L1635)،
   * والمستندات المخزنية في السحابة كانت تفعل ذلك وحدها (§12 و§R5)، ففاتورة البيع لا
   * يقول رقمُها التسلسلي أيَّ قطعةٍ خرجت ولا دفعتُها أيَّ عبوةٍ بيعت. هذا المنفذ هو
   * المسار الواحد الذي يمرّ منه المحرّكان (البيع والشراء): يُحسم معهما معاً
   * — الدفعة (تُبحث أو تُنشأ + تُتحقّق تواريخها) والأرقام التسلسلية (تُنشأ في الإدخال،
   * وتُصرف في البيع، **وتعود** في المرتجع) — ثم تُكتب النتيجة على السطر نفسه.
   *
   * ولا شيء هنا يعرف شكل جداول الفواتير: المنفذ يأخذ السطور ويعيد الخريطة، والخدمة
   * المستدعية هي التي تكتب على سطورها (فالوحدة المخزنية لا تستورد وحدة البيع).
   */
  async resolveInvoiceLineNumbers(
    tx: DrizzleTx,
    tenantId: string,
    input: {
      docType: string;
      docId: string;
      warehouseId: string;
      direction: 'in' | 'out';
      mode: 'receipt' | 'issue' | 'return';
      lines: Array<{
        lineNo: number;
        itemId: string;
        qty: string;
        unitId?: string | null;
        lotId?: string | null;
        batchNo?: string | null;
        productionDate?: string | null;
        expiryDate?: string | null;
        serialNos?: string[];
      }>;
    },
  ): Promise<
    Map<
      number,
      {
        lotId: string | null;
        batchNo: string | null;
        productionDate: string | null;
        expiryDate: string | null;
        serialIds: string[];
      }
    >
  > {
    const resolved = new Map<
      number,
      {
        lotId: string | null;
        batchNo: string | null;
        productionDate: string | null;
        expiryDate: string | null;
        serialIds: string[];
      }
    >();
    if (!input.lines.length) return resolved;

    // الدفعة أولاً: الأرقام التسلسلية تُربط بالدفعة (`item_serials.lot_id`)، فحسمُ الرقم
    // قبل الدفعة يكتب رابطاً فارغاً.
    const lots = await this.resolveUploadedLots(tx, tenantId, input.lines);

    for (const [index, line] of input.lines.entries()) {
      let lot = lots.get(index) ?? {
        lotId: null,
        batchNo: null,
        productionDate: null,
        expiryDate: null,
      };
      const serialIds = await this.resolveLineSerials(tx, tenantId, {
        docType: input.docType,
        docId: input.docId,
        lineNo: line.lineNo,
        itemId: line.itemId,
        warehouseId: input.warehouseId,
        lotId: lot.lotId,
        serialNos: line.serialNos,
        qty: line.qty,
        unitId: line.unitId ?? null,
        direction: input.direction,
        mode: input.mode,
      });

      /**
       * القطعة تعرف عبوّتها: سطرٌ كتب أرقاماً تسلسلية ولم يكتب دفعةً يأخذ دفعة الأرقام
       * إذا كانت كلها من عبوّةٍ واحدة. وبدون ذلك يبيع المستودع قطعةً من دفعةٍ منتهية
       * الصلاحية وسطرُ الفاتورة لا يقول أيَّ عبوّةٍ خرجت — وهو نصفُ الفائدة من الأرقام.
       * وتعدد العبوات يسكت: لا نخترع دفعةً لسطرٍ جمع قطعتين من عبوتين.
       */
      if (!lot.lotId && serialIds.length) {
        const rows = await tx
          .select({ lotId: itemSerials.lotId })
          .from(itemSerials)
          .where(and(eq(itemSerials.tenantId, tenantId), inArray(itemSerials.id, serialIds)));
        const lotIds = [...new Set(rows.map((row) => row.lotId).filter((value): value is string => Boolean(value)))];
        const onlyLotId = lotIds.length === 1 ? lotIds[0]! : null;
        if (onlyLotId) {
          const [found] = await tx
            .select({
              id: itemLots.id,
              lotNo: itemLots.lotNo,
              productionDate: itemLots.productionDate,
              expiryDate: itemLots.expiryDate,
            })
            .from(itemLots)
            .where(and(eq(itemLots.tenantId, tenantId), eq(itemLots.id, onlyLotId)));
          if (found) {
            lot = {
              lotId: found.id,
              batchNo: found.lotNo,
              productionDate: found.productionDate,
              expiryDate: found.expiryDate,
            };
            // والرابط يُكتب على الأرقام أيضاً، فيقرأ تقرير الصلاحية قطعةً تعرف عبوّتها.
            await tx
              .update(itemSerials)
              .set({ lotId: found.id, updatedAt: new Date() })
              .where(and(eq(itemSerials.tenantId, tenantId), inArray(itemSerials.id, serialIds)));
          }
        }
      }
      resolved.set(index, { ...lot, serialIds });
    }
    return resolved;
  }

  /**
   * عكس ما فعله `resolveInvoiceLineNumbers` عند إلغاء المستند (R8): أرقام فاتورةٍ بيعٍ
   * تُعاد إلى الرفّ، وأرقام إدخالِ شراءٍ تُسحب (ما دامت مكانها)، وأرقام مرتجعِ بيعٍ
   * تعود **مباعة** كما كانت قبل المرتجع. والروابط تُحذف في الحالات كلها.
   */
  async releaseInvoiceLineNumbers(
    tx: DrizzleTx,
    tenantId: string,
    input: { docType: string; docId: string; direction: 'in' | 'out'; returned?: boolean },
  ) {
    await this.reverseDocumentSerials(tx, tenantId, {
      docType: input.docType,
      docId: input.docId,
      direction: input.direction,
      soldAgain: input.returned === true && input.direction === 'in',
    });
  }

  /**
   * «🔢 التسلسلي:» — بحثٌ بالرقم نفسه، كما في رأس نافذة البيع (`frmInvSale.xaml` L592 ←
   * `SearchBySerialNo` L722): يُدخل الرقم فيجد الصنف وحاله. الديسكتوب كان يحسب الحالة من
   * مجموع حركاته (`stockIn - stockOut`)، والسحابة تقرأ الحالة المحسومة في `item_serials`
   * وتُرفق المستندات التي سافر فيها الرقم، فالإجابة أوسع وأدقّ في الوقت نفسه.
   */
  async lookupSerial(tenantId: string, serialNo: string) {
    const value = serialNo.trim();
    if (!value) throw new DomainError('VALIDATION_FAILED', 'A serial number is required', 400, { field: 'serialNo' });
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [serial] = await tx
        .select()
        .from(itemSerials)
        .where(
          and(
            eq(itemSerials.tenantId, tenantId),
            eq(itemSerials.serialNo, value),
            isNull(itemSerials.deletedAt),
          ),
        );
      if (!serial) return { found: false as const, serialNo: value };
      const [item] = await tx
        .select({ id: items.id, sku: items.sku, nameAr: items.nameAr, kind: items.kind })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.id, serial.itemId)));
      const documents = await tx
        .select()
        .from(stockDocumentSerials)
        .where(
          and(
            eq(stockDocumentSerials.tenantId, tenantId),
            eq(stockDocumentSerials.serialId, serial.id),
          ),
        )
        .orderBy(asc(stockDocumentSerials.createdAt));
      return {
        found: true as const,
        serialNo: serial.serialNo,
        serialId: serial.id,
        status: serial.status,
        warehouseId: serial.warehouseId,
        lotId: serial.lotId,
        item: item ?? null,
        documents,
      };
    });
  }

  /** Which documents has this number travelled through? */
  async serialTrace(tenantId: string, serialId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [serial] = await tx
        .select()
        .from(itemSerials)
        .where(and(eq(itemSerials.tenantId, tenantId), eq(itemSerials.id, serialId), isNull(itemSerials.deletedAt)));
      if (!serial) throw new DomainError('SERIAL_NOT_FOUND', 'The serial was not found', 404);
      const links = await tx
        .select()
        .from(stockDocumentSerials)
        .where(and(eq(stockDocumentSerials.tenantId, tenantId), eq(stockDocumentSerials.serialId, serialId)))
        .orderBy(asc(stockDocumentSerials.createdAt));
      return { serial, documents: links };
    });
  }

  // ── سند إدخال / إخراج مخزني ────────────────────────────────────────────────

  async createVoucher(tenantId: string, input: StockVoucherInput) {
    if (!input.lines.length)
      throw new DomainError('INVENTORY_LINES_REQUIRED', 'At least one stock line is required', 422);
    if (!['stock_in', 'stock_out', 'opening'].includes(input.kind))
      throw new DomainError('INVENTORY_VOUCHER_KIND_INVALID', 'Unknown stock voucher kind', 422, {
        field: 'kind',
      });
    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      // Refused here as well as at posting time: a clerk who scans a service item into
      // a stock voucher should hear it now, not after the document is saved and sent
      // for approval.
      // 📁 R5: batches are resolved (or created) here, on save — the line keeps what the
      // pack says and the movement reads `lot_id`. Resolved before `assertStockable` so a
      // line that names a batch satisfies the lot requirement the same way a picked lot does.
      const lots = await this.resolveUploadedLots(tx, tenantId, input.lines);
      const catalogue = await this.assertStockable(
        tx,
        tenantId,
        input.lines.map((line, index) => ({ ...line, lotId: lots.get(index)?.lotId ?? null })),
      );
      const prefix = input.kind === 'opening' ? 'OP-' : input.kind === 'stock_in' ? 'SIN-' : 'SOU-';
      const number = await this.nextNumber(
        tx,
        tenantId,
        input.branchId,
        `stock_voucher:${input.kind}`,
        prefix,
      );
      const draftTotalCost = input.lines.reduce((sum, line) => {
        const fallbackPrice = catalogue.get(line.itemId)?.purchasePrice ?? '0';
        const unitCost = new Decimal(line.unitCost ?? fallbackPrice ?? 0);
        const qty = new Decimal(line.qty || 0);
        return sum.plus(qty.mul(unitCost));
      }, new Decimal(0));
      const [voucher] = await tx
        .insert(stockVouchers)
        .values({
          id,
          tenantId,
          branchId: input.branchId,
          warehouseId: input.warehouseId,
          kind: input.kind,
          number,
          status: 'draft',
          voucherDate: input.voucherDate ?? new Date().toISOString().slice(0, 10),
          reason: input.reason,
          counterAccountId: input.counterAccountId ?? null,
          totalCost: draftTotalCost.toFixed(4),
          notes: input.notes,
          createdBy: getRequestContext().tenant?.userId,
        })
        .returning();
      for (const line of input.lines) {
        const numbers = (line.serialNos ?? []).map((value) => String(value).trim()).filter(Boolean);
        if (new Set(numbers).size !== numbers.length)
          throw new DomainError(
            'SERIAL_DUPLICATE',
            'The same serial number appears twice on one line',
            422,
            { field: 'serialNos' },
          );
      }
      // 📁 R5: batches are resolved (or created) here, on save — the line keeps what the
      // pack says and the movement reads `lot_id`.
      await tx.insert(stockVoucherLines).values(
        input.lines.map((line, index) => {
          const lot = lots.get(index);
          const fallbackPrice = catalogue.get(line.itemId)?.purchasePrice ?? null;
          const resolvedUnitCost = line.unitCost ?? (input.kind !== 'stock_out' ? fallbackPrice : null);
          const lineCost =
            resolvedUnitCost !== null && resolvedUnitCost !== undefined
              ? new Decimal(line.qty || 0).mul(new Decimal(resolvedUnitCost || 0)).toFixed(4)
              : '0';
          return {
            voucherId: id,
            lineNo: index + 1,
            tenantId,
            itemId: line.itemId,
            qty: line.qty,
            unitId: line.unitId ?? null,
            unitCost: resolvedUnitCost,
            lineCost,
            lotId: lot?.lotId ?? null,
            batchNo: lot?.batchNo ?? null,
            productionDate: lot?.productionDate ?? null,
            expiryDate: lot?.expiryDate ?? null,
            serialId: line.serialId,
            serialNos: (line.serialNos ?? []).map((value) => String(value).trim()).filter(Boolean),
            note: line.note,
          };
        }),
      );
      return { ...voucher, lines: await this.voucherLines(tx, tenantId, id) };
    });
  }

  private async voucherLines(tx: DrizzleTx, tenantId: string, voucherId: string) {
    return tx
      .select()
      .from(stockVoucherLines)
      .where(and(eq(stockVoucherLines.tenantId, tenantId), eq(stockVoucherLines.voucherId, voucherId)))
      .orderBy(asc(stockVoucherLines.lineNo));
  }

  private async getVoucherInTx(tx: DrizzleTx, tenantId: string, id: string) {
    const [voucher] = await tx
      .select()
      .from(stockVouchers)
      .where(and(eq(stockVouchers.tenantId, tenantId), eq(stockVouchers.id, id)));
    if (!voucher) throw new DomainError('INVENTORY_VOUCHER_NOT_FOUND', 'Stock voucher was not found', 404);
    return { ...voucher, lines: await this.voucherLines(tx, tenantId, id) };
  }

  getVoucher(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.getVoucherInTx(tx, tenantId, id));
  }

  listVouchers(tenantId: string, filters: { kind?: string; status?: string; warehouseId?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(stockVouchers)
        .where(
          and(
            eq(stockVouchers.tenantId, tenantId),
            filters.kind ? eq(stockVouchers.kind, filters.kind) : undefined,
            filters.status ? eq(stockVouchers.status, filters.status) : undefined,
            filters.warehouseId ? eq(stockVouchers.warehouseId, filters.warehouseId) : undefined,
          ),
        )
        .orderBy(sql`${stockVouchers.createdAt} DESC`)
        .limit(200);
      if (rows.length === 0) return [];
      const allLines = await tx
        .select()
        .from(stockVoucherLines)
        .where(
          and(
            eq(stockVoucherLines.tenantId, tenantId),
            inArray(
              stockVoucherLines.voucherId,
              rows.map((row) => row.id),
            ),
          ),
        )
        .orderBy(asc(stockVoucherLines.lineNo));
      const linesByVoucher = new Map<string, Array<typeof stockVoucherLines.$inferSelect>>();
      for (const line of allLines) {
        const list = linesByVoucher.get(line.voucherId) ?? [];
        list.push(line);
        linesByVoucher.set(line.voucherId, list);
      }
      return rows.map((row) => ({ ...row, lines: linesByVoucher.get(row.id) ?? [] }));
    });
  }

  /**
   * Posts a stock voucher: moves the stock and writes the balanced journal that keeps
   * the inventory account equal to the stock ledger.
   *
   * | kind       | movement          | journal                                        |
   * |------------|-------------------|------------------------------------------------|
   * | stock_in   | in @ given cost   | Dr المخزون / Cr الحساب المقابل                  |
   * | stock_out  | out @ average     | Dr الحساب المقابل / Cr المخزون                  |
   * | opening    | in @ given cost   | Dr المخزون / Cr بضاعة أول المدة                 |
   */
  async postVoucher(
    tenantId: string,
    id: string,
    options: { fiscalPeriodId?: string; allowNegative?: boolean } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const voucher = await this.getVoucherInTx(tx, tenantId, id);
      // A second post is refused rather than silently ignored: the caller asked for a
      // state change that has already happened, and saying so is safer than implying
      // this call did the work.
      if (voucher.status !== 'draft')
        throw new DomainError('INVENTORY_VOUCHER_INVALID_STATUS', 'Only draft vouchers can be posted', 409);
      if (!voucher.lines.length)
        throw new DomainError('INVENTORY_LINES_REQUIRED', 'At least one stock line is required', 422);
      const allowNegative = options.allowNegative === true && this.canOverrideNegative();

      const catalogue = await this.assertStockable(tx, tenantId, voucher.lines);
      const direction = voucher.kind === 'stock_out' ? 'out' : 'in';
      const balances = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.warehouseId, voucher.warehouseId),
            inArray(stockBalances.itemId, [...catalogue.keys()]),
          ),
        );
      const balanceOf = new Map(balances.map((row) => [row.itemId, row]));

      const movements: InventoryLine[] = voucher.lines.map((line) => {
        const item = catalogue.get(line.itemId);
        const average = balanceOf.get(line.itemId)?.averageCost ?? item?.purchasePrice ?? '0';
        const unitCost =
          direction === 'in'
            ? (line.unitCost ?? (Number(average) > 0 ? average : (item?.purchasePrice ?? '0')))
            : undefined;
        return {
          itemId: line.itemId,
          warehouseId: voucher.warehouseId,
          qty: line.qty,
          unitId: line.unitId ?? undefined,
          unitCost,
          direction: direction as 'in' | 'out',
          docType: voucher.kind === 'opening' ? 'opening' : 'stock_voucher',
          docId: id,
          lineId: newId(),
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          costing: direction === 'in' ? 'inWithCost' : 'outAtAvg',
        };
      });
      await this.recordInTx(tx, tenantId, movements, { allowNegative });

      // 🔢 الأرقام التسلسلية — the pieces this document actually moved, resolved now
      // that the stock has a direction. A line that carries numbers must move exactly
      // as many pieces as it names.
      const docType = voucher.kind === 'opening' ? 'opening' : 'stock_voucher';
      for (const line of voucher.lines) {
        await this.resolveLineSerials(tx, tenantId, {
          docType,
          docId: id,
          lineNo: line.lineNo,
          itemId: line.itemId,
          warehouseId: voucher.warehouseId,
          lotId: line.lotId,
          serialNos: line.serialNos,
          qty: line.qty,
          unitId: line.unitId,
          direction,
        });
      }

      const value = await this.valueOfMovements(tx, tenantId, id);

      const inventoryAccount = await this.profileAccount(
        tx,
        tenantId,
        voucher.branchId,
        'stock_voucher',
        'inventoryAccountId',
      );
      const counterKey =
        voucher.kind === 'opening' ? 'openingBalanceAccountId' : 'inventoryAdjustmentAccountId';
      const counterAccount = voucher.counterAccountId
        ? await this.assertAccount(tx, tenantId, voucher.counterAccountId)
        : await this.profileAccount(tx, tenantId, voucher.branchId, 'stock_voucher', counterKey);

      let journalEntryId: string | undefined;
      if (value.abs().gt(0)) {
        const fiscalPeriodId =
          options.fiscalPeriodId ??
          (await this.accounting.openPeriodForDateInTx(tx, tenantId, voucher.voucherDate));
        const entry = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId: voucher.branchId,
          fiscalPeriodId,
          date: voucher.voucherDate,
          description: `${VOUCHER_KIND_LABELS[voucher.kind] ?? 'سند مخزني'} ${voucher.number}`,
          lines:
            direction === 'in'
              ? [
                  {
                    accountId: inventoryAccount,
                    debit: value.toFixed(4),
                    description: voucher.reason ?? undefined,
                  },
                  {
                    accountId: counterAccount,
                    credit: value.toFixed(4),
                    description: voucher.reason ?? undefined,
                  },
                ]
              : [
                  {
                    accountId: counterAccount,
                    debit: value.toFixed(4),
                    description: voucher.reason ?? undefined,
                  },
                  {
                    accountId: inventoryAccount,
                    credit: value.toFixed(4),
                    description: voucher.reason ?? undefined,
                  },
                ],
          sourceType: 'stock_voucher',
          sourceId: id,
          idempotencyKey: `stock-voucher:${id}`,
        });
        journalEntryId = entry?.id;
      }

      await tx
        .update(stockVouchers)
        .set({
          status: 'posted',
          postedAt: new Date(),
          totalCost: value.toFixed(4),
          journalEntryId: journalEntryId ?? null,
          updatedAt: new Date(),
          createdBy: voucher.createdBy,
        })
        .where(
          and(
            eq(stockVouchers.tenantId, tenantId),
            eq(stockVouchers.id, id),
            eq(stockVouchers.status, 'draft'),
          ),
        );
      if (journalEntryId)
        await tx
          .update(stockVoucherLines)
          .set({ lineCost: sql`${stockVoucherLines.qty} * COALESCE(${stockVoucherLines.unitCost}, 0)` })
          .where(and(eq(stockVoucherLines.tenantId, tenantId), eq(stockVoucherLines.voucherId, id)));
      return this.getVoucherInTx(tx, tenantId, id);
    });
  }

  /** العكس الكامل: حركة معاكسة + قيد عكسي + حالة ملغى. */
  async voidVoucher(tenantId: string, id: string, reason: string) {
    if (!reason.trim())
      throw new DomainError('INVENTORY_VOID_REASON_REQUIRED', 'A void reason is required', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const voucher = await this.getVoucherInTx(tx, tenantId, id);
      if (voucher.status !== 'posted')
        throw new DomainError('INVENTORY_VOUCHER_INVALID_STATUS', 'Only posted vouchers can be voided', 409);
      const movements = await tx
        .select()
        .from(inventoryTransactions)
        .where(and(eq(inventoryTransactions.tenantId, tenantId), eq(inventoryTransactions.docId, id)));
      const mirrors: InventoryLine[] = movements.map((movement) => ({
        itemId: movement.itemId,
        warehouseId: movement.warehouseId,
        qty: movement.qty,
        unitCost: movement.unitCost ?? '0',
        direction: movement.direction === 'out' ? 'in' : 'out',
        docType: 'stock_voucher_void',
        docId: id,
        lineId: movement.lineId ?? undefined,
        lotId: movement.lotId ?? undefined,
        serialId: movement.serialId ?? undefined,
        costing: movement.direction === 'out' ? 'returnAtOriginalCost' : 'outAtOriginalCost',
      }));
      if (mirrors.length) await this.recordInTx(tx, tenantId, mirrors, { allowNegative: true });
      await this.reverseDocumentSerials(tx, tenantId, {
        docType: voucher.kind === 'opening' ? 'opening' : 'stock_voucher',
        docId: id,
        direction: voucher.kind === 'stock_out' ? 'out' : 'in',
      });
      if (voucher.journalEntryId) await this.reversalEntry(tx, tenantId, voucher.journalEntryId, reason);
      await tx
        .update(stockVouchers)
        .set({
          status: 'voided',
          voidedAt: new Date(),
          updatedAt: new Date(),
          notes: [voucher.notes, `إلغاء: ${reason}`].filter(Boolean).join(' · '),
        })
        .where(
          and(
            eq(stockVouchers.tenantId, tenantId),
            eq(stockVouchers.id, id),
            eq(stockVouchers.status, 'posted'),
          ),
        );
      return this.getVoucherInTx(tx, tenantId, id);
    });
  }

  // ── جرد وتسوية (multi-line) ────────────────────────────────────────────────

  async createAdjustment(tenantId: string, input: StockAdjustmentInput) {
    if (!input.lines.length)
      throw new DomainError('INVENTORY_LINES_REQUIRED', 'At least one counted line is required', 422);
    if (!input.reason.trim())
      throw new DomainError('ADJUSTMENT_REASON_REQUIRED', 'A stock count needs a reason', 422, {
        field: 'reason',
      });
    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const lots = await this.resolveUploadedLots(tx, tenantId, input.lines);
      await this.assertStockable(
        tx,
        tenantId,
        input.lines.map((line, index) => ({ ...line, lotId: lots.get(index)?.lotId ?? null })),
      );
      const number = await this.nextNumber(tx, tenantId, input.branchId, 'stock_adjustment', 'ADJ-');
      const [adjustment] = await tx
        .insert(stockAdjustments)
        .values({
          id,
          tenantId,
          branchId: input.branchId,
          warehouseId: input.warehouseId,
          number,
          status: 'draft',
          reason: input.reason,
          createdBy: getRequestContext().tenant?.userId,
        })
        .returning();
      await tx.insert(stockAdjustmentLines).values(
        input.lines.map((line, index) => {
          const lot = lots.get(index);
          return {
            adjustmentId: id,
            lineNo: index + 1,
            tenantId,
            itemId: line.itemId,
            expectedQty: '0',
            countedQty: line.countedQty,
            unitId: line.unitId ?? null,
            unitCost: line.unitCost ?? null,
            lotId: lot?.lotId ?? null,
            batchNo: lot?.batchNo ?? null,
            productionDate: lot?.productionDate ?? null,
            expiryDate: lot?.expiryDate ?? null,
            serialNos: (line.serialNos ?? []).map((value) => String(value).trim()).filter(Boolean),
            note: line.note,
          };
        }),
      );
      return { ...adjustment, lines: await this.adjustmentLines(tx, tenantId, id) };
    });
  }

  private async adjustmentLines(tx: DrizzleTx, tenantId: string, adjustmentId: string) {
    return tx
      .select()
      .from(stockAdjustmentLines)
      .where(
        and(eq(stockAdjustmentLines.tenantId, tenantId), eq(stockAdjustmentLines.adjustmentId, adjustmentId)),
      );
  }

  private async getAdjustmentInTx(tx: DrizzleTx, tenantId: string, id: string) {
    const [adjustment] = await tx
      .select()
      .from(stockAdjustments)
      .where(and(eq(stockAdjustments.tenantId, tenantId), eq(stockAdjustments.id, id)));
    if (!adjustment) throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Stock adjustment was not found', 404);
    return { ...adjustment, lines: await this.adjustmentLines(tx, tenantId, id) };
  }

  getAdjustment(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.getAdjustmentInTx(tx, tenantId, id));
  }

  listAdjustments(tenantId: string, status?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(stockAdjustments)
        .where(
          and(
            eq(stockAdjustments.tenantId, tenantId),
            status ? eq(stockAdjustments.status, status) : undefined,
          ),
        )
        .orderBy(sql`${stockAdjustments.createdAt} DESC`)
        .limit(200);
      if (!rows.length) return [];
      const lines = await tx
        .select()
        .from(stockAdjustmentLines)
        .where(
          and(
            eq(stockAdjustmentLines.tenantId, tenantId),
            inArray(
              stockAdjustmentLines.adjustmentId,
              rows.map((row) => row.id),
            ),
          ),
        );
      return rows.map((row) => ({ ...row, lines: lines.filter((line) => line.adjustmentId === row.id) }));
    });
  }

  /**
   * Posts a counted variance: every line is brought from its book quantity to the
   * counted one, and the net value of the difference is posted against the variance
   * account. An overage credits the variance account (Dr المخزون), a shortage debits
   * it (Cr المخزون) — one balanced entry for the whole count, because a count is one
   * decision, not one decision per line.
   */
  async postAdjustment(
    tenantId: string,
    id: string,
    options: {
      approved?: boolean;
      fiscalPeriodId?: string;
      counterAccountId?: string;
      allowNegative?: boolean;
    } = {},
  ) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const adjustment = await this.getAdjustmentInTx(tx, tenantId, id);
      if (adjustment.status !== 'draft')
        throw new DomainError('ADJUSTMENT_INVALID_STATE', 'Only draft counts can be posted', 409);
      if (!adjustment.lines.length)
        throw new DomainError('INVENTORY_LINES_REQUIRED', 'At least one counted line is required', 422);
      if (options.approved !== true)
        throw new DomainError(
          'ADJUSTMENT_APPROVAL_REQUIRED',
          'Stock adjustments require approval before posting',
          422,
          { field: 'approved' },
        );
      const allowNegative = options.allowNegative === true && this.canOverrideNegative();

      const catalogue = await this.assertStockable(tx, tenantId, adjustment.lines);
      const balances = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.warehouseId, adjustment.warehouseId),
            inArray(stockBalances.itemId, [...catalogue.keys()]),
          ),
        );
      const balanceOf = new Map(balances.map((row) => [row.itemId, row]));

      const movements: InventoryLine[] = [];
      for (const line of adjustment.lines) {
        /**
         * The book quantity is kept in base units; the clerk counts in whatever unit
         * they are holding. The comparison — and the variance that is stored — has to
         * happen in the *counted* unit, so the two sides of the sum mean the same thing.
         */
        const { factor } = await this.resolveUnit(tx, tenantId, {
          itemId: line.itemId,
          warehouseId: adjustment.warehouseId,
          qty: '1',
          direction: 'in',
          docType: 'stock_adjustment',
          docId: id,
          unitId: line.unitId ?? undefined,
        });
        const current = new Decimal(balanceOf.get(line.itemId)?.quantity ?? '0').div(factor);
        const counted = new Decimal(line.countedQty);
        const variance = counted.minus(current);
        if (variance.isZero()) {
          await tx
            .update(stockAdjustmentLines)
            .set({ expectedQty: current.toFixed(4), varianceQty: '0.0000', varianceValue: '0.0000' })
            .where(
              and(
                eq(stockAdjustmentLines.tenantId, tenantId),
                eq(stockAdjustmentLines.adjustmentId, id),
                eq(stockAdjustmentLines.lineNo, line.lineNo),
              ),
            );
          continue;
        }
        const average =
          balanceOf.get(line.itemId)?.averageCost ?? catalogue.get(line.itemId)?.purchasePrice ?? '0';
        const unitCost = line.unitCost ?? average;
        movements.push({
          itemId: line.itemId,
          warehouseId: adjustment.warehouseId,
          qty: variance.abs().toFixed(4),
          unitId: line.unitId ?? undefined,
          unitCost: variance.gt(0) ? unitCost : undefined,
          direction: variance.gt(0) ? 'in' : 'out',
          docType: 'stock_adjustment',
          docId: id,
          lineId: newId(),
          lotId: line.lotId ?? undefined,
          costing: variance.gt(0) ? 'inWithCost' : 'outAtAvg',
        });
        // 🔢 الأرقام التسلسلية — a surplus brings pieces in, a shortage sends them out.
        await this.resolveLineSerials(tx, tenantId, {
          docType: 'stock_adjustment',
          docId: id,
          lineNo: line.lineNo,
          itemId: line.itemId,
          warehouseId: adjustment.warehouseId,
          lotId: line.lotId,
          serialNos: line.serialNos,
          qty: variance.abs().toFixed(4),
          unitId: line.unitId ?? null,
          direction: variance.gt(0) ? 'in' : 'out',
        });
        await tx
          .update(stockAdjustmentLines)
          .set({
            expectedQty: current.toFixed(4),
            varianceQty: variance.toFixed(4),
            varianceValue: variance.abs().mul(unitCost).toFixed(4),
            unitCost,
          })
          .where(
            and(
              eq(stockAdjustmentLines.tenantId, tenantId),
              eq(stockAdjustmentLines.adjustmentId, id),
              eq(stockAdjustmentLines.lineNo, line.lineNo),
            ),
          );
      }
      if (movements.length) await this.recordInTx(tx, tenantId, movements, { allowNegative });

      const lines = await this.adjustmentLines(tx, tenantId, id);
      const net = lines.reduce(
        (sum, row) =>
          sum.plus(
            new Decimal(row.varianceQty ?? '0').gte(0)
              ? (row.varianceValue ?? '0')
              : `-${row.varianceValue ?? '0'}`,
          ),
        new Decimal(0),
      );

      let journalEntryId: string | undefined;
      if (net.abs().gt(0)) {
        const inventoryAccount = await this.profileAccount(
          tx,
          tenantId,
          adjustment.branchId,
          'stock_adjustment',
          'inventoryAccountId',
        );
        const counterAccount = options.counterAccountId
          ? await this.assertAccount(tx, tenantId, options.counterAccountId)
          : await this.profileAccount(
              tx,
              tenantId,
              adjustment.branchId,
              'stock_adjustment',
              'inventoryAdjustmentAccountId',
            );
        const fiscalPeriodId =
          options.fiscalPeriodId ??
          (await this.accounting.openPeriodForDateInTx(tx, tenantId, new Date().toISOString().slice(0, 10)));
        const entry = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId: adjustment.branchId,
          fiscalPeriodId,
          date: new Date().toISOString().slice(0, 10),
          description: `تسوية مخزنية ${adjustment.number} — ${adjustment.reason}`,
          lines: net.gt(0)
            ? [
                { accountId: inventoryAccount, debit: net.toFixed(4), description: 'زيادة جرد' },
                { accountId: counterAccount, credit: net.toFixed(4), description: 'زيادة جرد' },
              ]
            : [
                { accountId: counterAccount, debit: net.abs().toFixed(4), description: 'عجز جرد' },
                { accountId: inventoryAccount, credit: net.abs().toFixed(4), description: 'عجز جرد' },
              ],
          sourceType: 'stock_adjustment',
          sourceId: id,
          idempotencyKey: `stock-adjustment:${id}`,
        });
        journalEntryId = entry?.id;
      }

      await tx
        .update(stockAdjustments)
        .set({
          status: 'posted',
          approvedAt: new Date(),
          approvedBy: getRequestContext().tenant?.userId ?? null,
          journalEntryId: journalEntryId ?? adjustment.journalEntryId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockAdjustments.tenantId, tenantId),
            eq(stockAdjustments.id, id),
            eq(stockAdjustments.status, 'draft'),
          ),
        );
      return this.getAdjustmentInTx(tx, tenantId, id);
    });
  }

  /** Items at or below their reorder point — the desktop's `CalcItemsStockLimits`. */
  async belowMinimum(tenantId: string, warehouseId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ item: items, balance: stockBalances })
        .from(stockBalances)
        .innerJoin(items, eq(items.id, stockBalances.itemId))
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            warehouseId ? eq(stockBalances.warehouseId, warehouseId) : undefined,
            sql`${stockBalances.quantity} <= ${items.minQty}`,
            sql`${items.minQty} > 0`,
            isNull(items.deletedAt),
          ),
        )
        .orderBy(asc(items.nameAr))
        .limit(200);
      return rows.map((row) => ({
        itemId: row.item.id,
        sku: row.item.sku,
        nameAr: row.item.nameAr,
        warehouseId: row.balance.warehouseId,
        quantity: row.balance.quantity,
        minQty: row.item.minQty,
        maxQty: row.item.maxQty,
        shortage: new Decimal(row.item.minQty).minus(row.balance.quantity).toFixed(4),
      }));
    });
  }
  /**
   * Resolves the conversion factor of a movement's unit.
   *
   * A unit is only accepted when the item card defines it (`item_units`): an
   * unconfigured unit would silently move the wrong quantity, and there is no honest
   * way to guess a ratio. The item's own base unit always converts 1:1.
   */
  private async resolveUnit(
    tx: DrizzleTx,
    tenantId: string,
    line: InventoryLine,
  ): Promise<{ factor: Decimal; unitId: string | undefined }> {
    if (!line.unitId) return { factor: new Decimal(1), unitId: undefined };
    const [item] = await tx
      .select({ baseUnitId: items.baseUnitId })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.id, line.itemId)));
    if (item?.baseUnitId === line.unitId) return { factor: new Decimal(1), unitId: line.unitId };
    const [row] = await tx
      .select({ ratio: itemUnits.ratio })
      .from(itemUnits)
      .where(
        and(
          eq(itemUnits.tenantId, tenantId),
          eq(itemUnits.itemId, line.itemId),
          eq(itemUnits.unitId, line.unitId),
        ),
      );
    if (!row)
      throw new DomainError(
        'INVENTORY_UNIT_NOT_ALLOWED',
        'This unit is not defined for the item — add it on the item card first',
        422,
        { field: 'unitId' },
      );
    return { factor: new Decimal(row.ratio), unitId: line.unitId };
  }

  // ── الباركود — resolve a scanned label to an item and a unit ───────────────

  /**
   * One scan, one answer: which item, and (when the label belongs to a unit) in which
   * unit and with what factor. The desktop read three tables for this
   * (`items.barcode`, `ItemBarcodes`, `ItemUnits.barcode`); the cloud asks the same
   * three, in the order a shop would label them.
   */
  async scan(tenantId: string, code: string) {
    const barcode = code.trim();
    if (!barcode) throw new DomainError('BARCODE_REQUIRED', 'Scan or type a barcode', 422, { field: 'code' });
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [extra] = await tx
        .select({ itemId: itemBarcodes.itemId, unitId: itemBarcodes.unitId })
        .from(itemBarcodes)
        .where(and(eq(itemBarcodes.tenantId, tenantId), eq(itemBarcodes.barcode, barcode)));
      const [own] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.barcode, barcode), isNull(items.deletedAt)));
      const [unitOwned] = await tx
        .select({ itemId: itemUnits.itemId, unitId: itemUnits.unitId, ratio: itemUnits.ratio })
        .from(itemUnits)
        .where(and(eq(itemUnits.tenantId, tenantId), eq(itemUnits.barcode, barcode)));

      const itemId = extra?.itemId ?? own?.id ?? unitOwned?.itemId;
      const unitId = extra?.unitId ?? unitOwned?.unitId ?? undefined;
      if (!itemId) throw new DomainError('BARCODE_NOT_FOUND', 'No item carries this barcode', 404);

      const [item] = await tx
        .select({
          id: items.id,
          sku: items.sku,
          nameAr: items.nameAr,
          salePrice: items.salePrice,
          purchasePrice: items.purchasePrice,
          baseUnitId: items.baseUnitId,
          trackLot: items.trackLot,
          trackSerial: items.trackSerial,
        })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId), isNull(items.deletedAt)));
      if (!item) throw new DomainError('BARCODE_NOT_FOUND', 'No item carries this barcode', 404);

      const factor =
        unitId && unitId !== item.baseUnitId
          ? new Decimal(
              (
                await tx
                  .select({ ratio: itemUnits.ratio })
                  .from(itemUnits)
                  .where(
                    and(
                      eq(itemUnits.tenantId, tenantId),
                      eq(itemUnits.itemId, itemId),
                      eq(itemUnits.unitId, unitId),
                    ),
                  )
              )[0]?.ratio ?? '1',
            )
          : new Decimal(1);
      const [unit] = unitId
        ? await tx
            .select({ code: unitsOfMeasure.code, nameAr: unitsOfMeasure.nameAr })
            .from(unitsOfMeasure)
            .where(and(eq(unitsOfMeasure.tenantId, tenantId), eq(unitsOfMeasure.id, unitId)))
        : [];
      return {
        barcode,
        itemId,
        sku: item.sku,
        nameAr: item.nameAr,
        salePrice: item.salePrice,
        purchasePrice: item.purchasePrice,
        trackLot: item.trackLot,
        trackSerial: item.trackSerial,
        unitId: unitId ?? item.baseUnitId,
        unitNameAr: unit?.nameAr ?? null,
        factor: factor.toFixed(6),
        /** `box` · `piece` … whatever the label was attached to. */
        matchedBy: extra ? 'item_barcodes' : own ? 'items.barcode' : 'item_units.barcode',
      };
    });
  }

  // ── تواريخ الصلاحية ────────────────────────────────────────────────────────

  /**
   * Lots that expire within `days` (or that already have), with what is still on the
   * shelf. A lot you cannot find is a lot that quietly becomes waste: this is the
   * report the desktop kept in `frmItems` under expiry, and it is why lots carry an
   * expiry date at all.
   */
  async expiry(tenantId: string, days = 30, warehouseId?: string) {
    const horizon = Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 30;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ lot: itemLots, item: items, balance: stockBalances })
        .from(itemLots)
        .innerJoin(items, eq(items.id, itemLots.itemId))
        .leftJoin(
          stockBalances,
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.itemId, itemLots.itemId),
            warehouseId ? eq(stockBalances.warehouseId, warehouseId) : sql`true`,
          ),
        )
        .where(
          and(
            eq(itemLots.tenantId, tenantId),
            isNull(itemLots.deletedAt),
            sql`${itemLots.expiryDate} IS NOT NULL`,
            sql`${itemLots.expiryDate} <= (CURRENT_DATE + ${horizon}::int)`,
          ),
        )
        .orderBy(asc(itemLots.expiryDate))
        .limit(300);
      return rows.map((row) => {
        const daysLeft = Math.round(
          (new Date(`${row.lot.expiryDate}T00:00:00Z`).getTime() - Date.now()) / 86_400_000,
        );
        return {
          lotId: row.lot.id,
          lotNo: row.lot.lotNo,
          expiryDate: row.lot.expiryDate,
          daysLeft,
          expired: daysLeft < 0,
          itemId: row.item.id,
          sku: row.item.sku,
          nameAr: row.item.nameAr,
          warehouseId: row.balance?.warehouseId ?? null,
          quantity: row.balance?.quantity ?? '0',
        };
      });
    });
  }
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}
