import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import {
  PRICE_LIST_FILTERS,
  PRICE_LIST_ITEM_FILTERS,
  PRICE_LIST_ITEM_SORT_COLUMNS,
  PRICE_LIST_SORT_COLUMNS,
  buildMeta,
  parseBooleanFilter,
  parseFilters,
  parseSort,
  type ListEnvelope,
  type OrgListQuery,
  type PriceListCreate,
  type PriceListDto,
  type PriceListItemDto,
  type PriceListItemUpsert,
  type PriceListUpdate,
} from '@erp/contracts';
import {
  currencies,
  items,
  itemUnits,
  newId,
  priceListItems,
  priceLists,
  unitsOfMeasure,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
  type PriceList,
  type PriceListItem,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import {
  actorStamp,
  assertVersion,
  isUniqueViolation,
  isoOf,
  isoOrNull,
  lockDefaultSwitch,
  notFound,
  validationFailed,
} from '../shared/org-support.js';

/**
 * Price lists and their items — API_CONTRACT §3, DATABASE_DESIGN §5 (legacy
 * `priceTypes` / `Pricing`).
 *
 * PHASE_05 §4 is explicit that `price_list_items.item_id` stays unvalidated until
 * PHASE_06 creates `items`. The rest of the row is fully enforced now — non-negative
 * prices, one row per (item, quantity break), currency must be enabled — so PHASE_06
 * only has to add the reference check, not rebuild the resource.
 */
@Injectable()
export class PriceListsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<PriceListDto>> {
    const filters = parseFilters(query.filter, PRICE_LIST_FILTERS);
    const sort = parseSort(query.sort, PRICE_LIST_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(priceLists.tenantId, tenantId), isNull(priceLists.deletedAt)];
      const isActive = parseBooleanFilter(filters.isActive);
      if (isActive !== undefined) conditions.push(eq(priceLists.isActive, isActive));
      const isDefault = parseBooleanFilter(filters.isDefault);
      if (isDefault !== undefined) conditions.push(eq(priceLists.isDefault, isDefault));
      if (filters.currencyCode) {
        conditions.push(eq(priceLists.currencyCode, filters.currencyCode.toUpperCase()));
      }
      if (query.q) conditions.push(ilike(priceLists.name, `%${query.q}%`));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(priceLists).where(where);

      const order =
        sort.length > 0 && sort[0]?.column === 'createdAt'
          ? [sort[0].direction === 'desc' ? desc(priceLists.createdAt) : asc(priceLists.createdAt)]
          : [asc(priceLists.name)];

      const rows = await tx
        .select()
        .from(priceLists)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toPriceListDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, priceListId: string): Promise<PriceListDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toPriceListDto(await this.mustFind(tx, tenantId, priceListId)),
    );
  }

  async create(tenantId: string, input: PriceListCreate): Promise<PriceListDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await assertCurrencyEnabled(tx, tenantId, input.currencyCode);

      const [existing] = await tx
        .select({ value: count() })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), isNull(priceLists.deletedAt)));

      const wantsDefault = input.isDefault === true || (existing?.value ?? 0) === 0;
      if (wantsDefault) await this.clearDefault(tx, tenantId);

      const priceListId = newId();
      try {
        await tx.insert(priceLists).values({
          id: priceListId,
          tenantId,
          name: input.name,
          currencyCode: input.currencyCode,
          isDefault: wantsDefault,
          isActive: input.isActive ?? true,
          createdAt: now,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw validationFailed(`Price list '${input.name}' already exists`, 'name');
        }
        throw error;
      }

      return toPriceListDto(await this.mustFind(tx, tenantId, priceListId));
    });
  }

  async update(tenantId: string, priceListId: string, input: PriceListUpdate): Promise<PriceListDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, priceListId);
      assertVersion(existing.version, input.version);

      if (input.currencyCode !== undefined && input.currencyCode !== existing.currencyCode.trim()) {
        await assertCurrencyEnabled(tx, tenantId, input.currencyCode);
        const [itemRow] = await tx
          .select({ value: count() })
          .from(priceListItems)
          .where(eq(priceListItems.priceListId, priceListId));
        if ((itemRow?.value ?? 0) > 0) {
          // Re-denominating priced rows would silently change every price on the list.
          throw validationFailed('Empty the price list before changing its currency', 'currencyCode');
        }
      }
      if (input.isDefault === true && !existing.isDefault) await this.clearDefault(tx, tenantId);
      if (input.isDefault === false && existing.isDefault) {
        throw validationFailed(
          'Promote another price list to default instead of clearing the flag',
          'isDefault',
        );
      }
      if (input.isActive === false && existing.isDefault) {
        throw validationFailed('The default price list cannot be deactivated', 'isActive');
      }

      const updates: Record<string, unknown> = {
        updatedAt: now,
        updatedBy: actorUserId,
        version: sql`${priceLists.version} + 1`,
      };
      if (input.name !== undefined) updates.name = input.name;
      if (input.currencyCode !== undefined) updates.currencyCode = input.currencyCode;
      if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      try {
        await tx.update(priceLists).set(updates).where(eq(priceLists.id, priceListId));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw validationFailed(`Price list '${String(input.name)}' already exists`, 'name');
        }
        throw error;
      }

      return toPriceListDto(await this.mustFind(tx, tenantId, priceListId));
    });
  }

  async remove(tenantId: string, priceListId: string): Promise<void> {
    const { actorUserId, now } = actorStamp();

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, priceListId);
      if (existing.isDefault) throw validationFailed('The default price list cannot be deleted', 'id');

      await tx
        .update(priceLists)
        .set({
          deletedAt: now,
          deletedBy: actorUserId,
          isActive: false,
          updatedAt: now,
          updatedBy: actorUserId,
          version: sql`${priceLists.version} + 1`,
        })
        .where(eq(priceLists.id, priceListId));
    });
  }

  // --- items --------------------------------------------------------------------

  async listItems(
    tenantId: string,
    priceListId: string,
    query: OrgListQuery,
  ): Promise<ListEnvelope<PriceListItemDto>> {
    const filters = parseFilters(query.filter, PRICE_LIST_ITEM_FILTERS);
    const sort = parseSort(query.sort, PRICE_LIST_ITEM_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, priceListId);

      const conditions: SQL[] = [
        eq(priceListItems.tenantId, tenantId),
        eq(priceListItems.priceListId, priceListId),
      ];
      if (filters.itemId) conditions.push(eq(priceListItems.itemId, filters.itemId));
      if ((filters as any).unitId) conditions.push(eq(priceListItems.unitId, (filters as any).unitId));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(priceListItems).where(where);

      const order =
        sort.length > 0 && sort[0]?.column === 'createdAt'
          ? [sort[0].direction === 'desc' ? desc(priceListItems.createdAt) : asc(priceListItems.createdAt)]
          : [asc(priceListItems.minQty)];

      const rows = await tx
        .select()
        .from(priceListItems)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toPriceListItemDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  /** Upsert by `(price_list_id, item_id, unit_id, min_qty)` — re-pricing is not a duplicate. R19 adds unit_id. */
  async upsertItem(
    tenantId: string,
    priceListId: string,
    input: PriceListItemUpsert,
  ): Promise<PriceListItemDto> {
    const { actorUserId, now } = actorStamp();
    const minQty = input.minQty ?? '0';

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, priceListId);

      if (input.unitId) {
        await this.assertUnitUsable(tx, tenantId, input.itemId ?? null, input.unitId);
      }

      const [existing] = await tx
        .select()
        .from(priceListItems)
        .where(
          and(
            eq(priceListItems.priceListId, priceListId),
            input.itemId ? eq(priceListItems.itemId, input.itemId) : isNull(priceListItems.itemId),
            input.unitId ? eq(priceListItems.unitId, input.unitId) : isNull(priceListItems.unitId),
            eq(priceListItems.minQty, minQty),
          ),
        )
        .limit(1);

      if (existing) {
        assertVersion(existing.version, input.version);
        await tx
          .update(priceListItems)
          .set({
            unitPrice: input.unitPrice,
            unitId: input.unitId ?? null,
            updatedAt: now,
            updatedBy: actorUserId,
            version: sql`${priceListItems.version} + 1`,
          })
          .where(eq(priceListItems.id, existing.id));
        return toPriceListItemDto(await this.mustFindItem(tx, tenantId, priceListId, existing.id));
      }

      const itemRowId = newId();
      await tx.insert(priceListItems).values({
        id: itemRowId,
        tenantId,
        priceListId,
        itemId: input.itemId ?? null,
        unitId: input.unitId ?? null,
        unitPrice: input.unitPrice,
        minQty,
        createdAt: now,
        createdBy: actorUserId,
      });
      return toPriceListItemDto(await this.mustFindItem(tx, tenantId, priceListId, itemRowId));
    });
  }

  async removeItem(tenantId: string, priceListId: string, itemRowId: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, priceListId);
      await this.mustFindItem(tx, tenantId, priceListId, itemRowId);
      // Hard delete: a price row carries no history of its own (the audit log does).
      await tx.delete(priceListItems).where(eq(priceListItems.id, itemRowId));
    });
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(tx: DrizzleTx, tenantId: string, priceListId: string): Promise<PriceList> {
    const [row] = await tx
      .select()
      .from(priceLists)
      .where(
        and(
          eq(priceLists.id, priceListId),
          eq(priceLists.tenantId, tenantId),
          isNull(priceLists.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound('Price list');
    return row;
  }

  private async mustFindItem(
    tx: DrizzleTx,
    tenantId: string,
    priceListId: string,
    itemRowId: string,
  ): Promise<PriceListItem> {
    const [row] = await tx
      .select()
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.id, itemRowId),
          eq(priceListItems.tenantId, tenantId),
          eq(priceListItems.priceListId, priceListId),
        ),
      )
      .limit(1);
    if (!row) throw notFound('Price list item');
    return row;
  }

  private async assertUnitUsable(
    tx: DrizzleTx,
    tenantId: string,
    itemId: string | null,
    unitId: string,
  ): Promise<void> {
    const [unit] = await tx
      .select({ id: unitsOfMeasure.id })
      .from(unitsOfMeasure)
      .where(and(eq(unitsOfMeasure.id, unitId), eq(unitsOfMeasure.tenantId, tenantId)))
      .limit(1);
    if (!unit) throw validationFailed('Unit not found', 'unitId');

    if (!itemId) return;

    const [item] = await tx
      .select({ baseUnitId: items.baseUnitId })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.tenantId, tenantId)))
      .limit(1);
    if (!item) return; // item FK deferred to P06 — allow if item not yet resolvable

    if (item.baseUnitId === unitId) return;

    const [itemUnit] = await tx
      .select({ unitId: itemUnits.unitId })
      .from(itemUnits)
      .where(and(eq(itemUnits.itemId, itemId), eq(itemUnits.unitId, unitId), eq(itemUnits.tenantId, tenantId)))
      .limit(1);
    if (!itemUnit) {
      throw validationFailed('Unit is not defined for this item', 'unitId');
    }
  }

  private async clearDefault(tx: DrizzleTx, tenantId: string): Promise<void> {
    await lockDefaultSwitch(tx, tenantId, 'price_lists');
    await tx
      .update(priceLists)
      .set({ isDefault: false })
      .where(
        and(
          eq(priceLists.tenantId, tenantId),
          eq(priceLists.isDefault, true),
          isNull(priceLists.deletedAt),
        ),
      );
  }
}

async function assertCurrencyEnabled(tx: DrizzleTx, tenantId: string, code: string): Promise<void> {
  const [row] = await tx
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.tenantId, tenantId), eq(currencies.code, code)))
    .limit(1);
  if (!row) throw validationFailed(`Currency '${code}' is not enabled for this tenant`, 'currencyCode');
}

export function toPriceListDto(row: PriceList): PriceListDto {
  return {
    id: row.id,
    name: row.name,
    currencyCode: row.currencyCode.trim(),
    isDefault: row.isDefault,
    isActive: row.isActive,
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

export function toPriceListItemDto(row: PriceListItem): PriceListItemDto {
  return {
    id: row.id,
    priceListId: row.priceListId,
    itemId: row.itemId,
    unitId: (row as any).unitId ?? null,
    unitPrice: row.unitPrice,
    minQty: row.minQty,
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
