import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  CURRENCY_FILTERS,
  CURRENCY_SORT_COLUMNS,
  buildMeta,
  parseBooleanFilter,
  parseFilters,
  parseSort,
  type CurrencyCreate,
  type CurrencyDto,
  type CurrencyUpdate,
  type ListEnvelope,
  type OrgListQuery,
} from '@erp/contracts';
import {
  cashLocations,
  currencies,
  priceLists,
  tenants,
  withTenantTx,
  type Currency,
  type DatabaseHandle,
  type DrizzleTx,
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
 * Currencies — API_CONTRACT §3, DATABASE_DESIGN §3.
 *
 * Keyed by `(tenant_id, code)`, so the URL segment is the ISO code, not a uuid. Exactly
 * one currency per tenant is `is_base`, enforced by a partial unique index; the base
 * currency is what `resolveFx` triangulates through and what a NULL
 * `cash_locations.currency_code` means.
 */
@Injectable()
export class CurrenciesService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<CurrencyDto>> {
    const filters = parseFilters(query.filter, CURRENCY_FILTERS);
    const sort = parseSort(query.sort, CURRENCY_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(currencies.tenantId, tenantId)];
      const isActive = parseBooleanFilter(filters.isActive);
      if (isActive !== undefined) conditions.push(eq(currencies.isActive, isActive));
      const isBase = parseBooleanFilter(filters.isBase);
      if (isBase !== undefined) conditions.push(eq(currencies.isBase, isBase));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(currencies).where(where);

      const order =
        sort.length > 0 && sort[0]?.column === 'createdAt'
          ? [sort[0].direction === 'desc' ? desc(currencies.createdAt) : asc(currencies.createdAt)]
          : [asc(currencies.code)];

      const rows = await tx
        .select()
        .from(currencies)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toCurrencyDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, code: string): Promise<CurrencyDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toCurrencyDto(await this.mustFind(tx, tenantId, code)),
    );
  }

  async create(tenantId: string, input: CurrencyCreate): Promise<CurrencyDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existingBase] = await tx
        .select({ value: count() })
        .from(currencies)
        .where(and(eq(currencies.tenantId, tenantId), eq(currencies.isBase, true)));

      // The first currency of a tenant is its base: a tenant with money but no base
      // currency cannot value anything.
      const wantsBase = input.isBase === true || (existingBase?.value ?? 0) === 0;
      if (wantsBase) await this.clearBase(tx, tenantId);

      try {
        await tx.insert(currencies).values({
          tenantId,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn ?? null,
          minorUnits: input.minorUnits ?? 2,
          isBase: wantsBase,
          isActive: input.isActive ?? true,
          createdAt: now,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw validationFailed(`Currency '${input.code}' is already enabled`, 'code');
        }
        throw error;
      }

      if (wantsBase) await this.syncTenantBaseCurrency(tx, tenantId, input.code);
      return toCurrencyDto(await this.mustFind(tx, tenantId, input.code));
    });
  }

  async update(tenantId: string, code: string, input: CurrencyUpdate): Promise<CurrencyDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, code);
      assertVersion(existing.version, input.version);

      if (input.isBase === true && !existing.isBase) await this.clearBase(tx, tenantId);
      if (input.isBase === false && existing.isBase) {
        throw validationFailed('Promote another currency to base instead of clearing the flag', 'isBase');
      }
      if (input.isActive === false) {
        if (existing.isBase) throw validationFailed('The base currency cannot be deactivated', 'isActive');
        await this.assertNotInUse(tx, tenantId, existing.code.trim());
      }

      const updates: Record<string, unknown> = {
        updatedAt: now,
        updatedBy: actorUserId,
        version: sql`${currencies.version} + 1`,
      };
      if (input.nameAr !== undefined) updates.nameAr = input.nameAr;
      if (input.nameEn !== undefined) updates.nameEn = input.nameEn;
      if (input.minorUnits !== undefined) updates.minorUnits = input.minorUnits;
      if (input.isBase !== undefined) updates.isBase = input.isBase;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      await tx
        .update(currencies)
        .set(updates)
        .where(and(eq(currencies.tenantId, tenantId), eq(currencies.code, existing.code)));

      if (input.isBase === true) await this.syncTenantBaseCurrency(tx, tenantId, existing.code.trim());
      return toCurrencyDto(await this.mustFind(tx, tenantId, code));
    });
  }

  /** The tenant's base currency code — the pivot `resolveFx` triangulates through. */
  async baseCurrencyOf(tx: DrizzleTx, tenantId: string): Promise<string> {
    const [row] = await tx
      .select({ code: currencies.code })
      .from(currencies)
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.isBase, true)))
      .limit(1);
    if (row) return row.code.trim();

    const [tenantRow] = await tx
      .select({ baseCurrency: tenants.baseCurrency })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return (tenantRow?.baseCurrency ?? 'SAR').trim();
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(tx: DrizzleTx, tenantId: string, code: string): Promise<Currency> {
    const [row] = await tx
      .select()
      .from(currencies)
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.code, code.toUpperCase())))
      .limit(1);
    if (!row) throw notFound('Currency');
    return row;
  }

  private async clearBase(tx: DrizzleTx, tenantId: string): Promise<void> {
    await lockDefaultSwitch(tx, tenantId, 'currencies:base');
    await tx
      .update(currencies)
      .set({ isBase: false })
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.isBase, true)));
  }

  /**
   * `tenants.base_currency` (PHASE_01) and `currencies.is_base` describe the same fact;
   * letting them drift would make every downstream valuation depend on which table the
   * reader happened to pick.
   */
  private async syncTenantBaseCurrency(tx: DrizzleTx, tenantId: string, code: string): Promise<void> {
    await tx.update(tenants).set({ baseCurrency: code }).where(eq(tenants.id, tenantId));
  }

  private async assertNotInUse(tx: DrizzleTx, tenantId: string, code: string): Promise<void> {
    const [cashRow] = await tx
      .select({ value: count() })
      .from(cashLocations)
      .where(and(eq(cashLocations.tenantId, tenantId), eq(cashLocations.currencyCode, code)));
    if ((cashRow?.value ?? 0) > 0) {
      throw validationFailed('A cash location still uses this currency', 'isActive');
    }

    const [listRow] = await tx
      .select({ value: count() })
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.currencyCode, code)));
    if ((listRow?.value ?? 0) > 0) {
      throw validationFailed('A price list still uses this currency', 'isActive');
    }
  }
}

export function toCurrencyDto(row: Currency): CurrencyDto {
  return {
    code: row.code.trim(),
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    minorUnits: row.minorUnits,
    isBase: row.isBase,
    isActive: row.isActive,
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
