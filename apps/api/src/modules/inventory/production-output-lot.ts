import { and, eq, isNull } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { itemLots, items, type DrizzleTx } from '@erp/database';

/**
 * 🏷️ دفعةُ الناتج (اللوت) في محركَي الإنتاج — the one place that decides which lot the produced
 * quantity belongs to, shared by `WmsBomService.produce` (BOM/`MF-`) and
 * `ProductionOrdersService.complete` (مكوّنات/`MO-`) so the two cannot drift apart.
 *
 * Why it exists: `InventoryService.recordInTx` refuses a movement of a lot-tracked item without a
 * `lot_id` (422 `INVENTORY_LOT_REQUIRED`) — and neither engine passed one, so **producing a
 * lot-tracked item through the official engines was impossible**. The add-on bakery batch worked
 * around it by recording the movement itself with its own lot; once a production batch must have a
 * real source of materials (BOM or components — see `van-sales.service.ts`), the official engines
 * are the ones writing the movement, so they have to honour the lot too.
 *
 * The rules, deliberately narrow:
 *
 *   • the item is **not** lot-tracked ⇒ no lot, `null` (nothing is invented for an item that does
 *     not carry batches);
 *   • the caller named a lot (`lotNo`, e.g. the bakery's own batch number) ⇒ that lot, resolved or
 *     created — the same «resolve-or-create by (tenant, item, lot_no)» the stock documents use, so
 *     one physical batch is one row, never a duplicate per document;
 *   • the caller named none ⇒ the **order's own number** is the lot (`MO-000123`), because an
 *     unnumbered batch of a lot-tracked item is untraceable and refusing the run would be worse;
 *   • a creation date the caller states is written on the lot when the lot has none, and never
 *     overwrites a recorded one (the same convention as `resolveUploadedLots`).
 *
 * Consumption of a lot-tracked **component** is not covered here on purpose: choosing which lot of
 * flour left the shelf is a storekeeper's decision, not something an engine may invent, so it stays
 * refused by `recordInTx` with its own clear message.
 */
export type OutputLotInput = {
  /** رقم الدفعة كما يسمّيها المنتج (رقم دفعة المخبز مثلاً) — وإلا رقم الأمر. */
  lotNo?: string | null;
  /** 📅 تاريخ الإنتاج — يُكتب على الدفعة إن لم يكن لها تاريخ. */
  productionDate?: string | null;
} | null;

export async function resolveOutputLotInTx(
  tx: DrizzleTx,
  tenantId: string,
  input: { itemId: string; lot?: OutputLotInput; orderNumber?: string | null },
): Promise<string | null> {
  const [item] = await tx
    .select({ trackLot: items.trackLot })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.id, input.itemId)));
  if (!item || item.trackLot !== true) return null;

  const lotNo =
    String(input.lot?.lotNo ?? '').trim() || String(input.orderNumber ?? '').trim();
  if (!lotNo)
    throw new DomainError(
      'PRODUCTION_OUTPUT_LOT_REQUIRED',
      'الصنف الناتج يُتتبَّع بالدفعات ولا يوجد رقم دفعة لهذا الأمر — أدخل رقم الدفعة',
      422,
      { field: 'outputLotNo', itemId: input.itemId },
    );

  const productionDate = String(input.lot?.productionDate ?? '').trim() || null;

  const [existing] = await tx
    .select({ id: itemLots.id, productionDate: itemLots.productionDate })
    .from(itemLots)
    .where(
      and(
        eq(itemLots.tenantId, tenantId),
        eq(itemLots.itemId, input.itemId),
        eq(itemLots.lotNo, lotNo),
        isNull(itemLots.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    // التاريخ يُكمَّل ولا يُخالَف: دفعةٌ مسجَّلة بتاريخٍ لا تُمحى ولا تُناقَض.
    if (productionDate && !existing.productionDate) {
      await tx
        .update(itemLots)
        .set({ productionDate, updatedAt: new Date() })
        .where(and(eq(itemLots.tenantId, tenantId), eq(itemLots.id, existing.id)));
    }
    return existing.id;
  }

  const id = newId();
  await tx.insert(itemLots).values({
    id,
    tenantId,
    itemId: input.itemId,
    lotNo,
    productionDate,
    receivedAt: new Date(),
  });
  return id;
}
