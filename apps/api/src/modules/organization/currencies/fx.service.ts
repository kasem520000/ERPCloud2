import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, count, desc, eq, lte, sql, type SQL } from 'drizzle-orm';
import {
  FX_RATE_FILTERS,
  FX_RATE_SORT_COLUMNS,
  buildMeta,
  parseFilters,
  parseSort,
  type FxRateCreate,
  type FxRateDto,
  type FxRateUpdate,
  type FxResolutionDto,
  type ListEnvelope,
  type OrgListQuery,
} from '@erp/contracts';
import {
  currencies,
  fxRates,
  newId,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
  type FxRate,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import {
  actorStamp,
  assertVersion,
  isUniqueViolation,
  isoOf,
  isoOrNull,
  notFound,
  validationFailed,
} from '../shared/org-support.js';

import { CurrenciesService } from './currencies.service.js';

/**
 * FX rates — API_CONTRACT §3, DATABASE_DESIGN §3 (legacy `Currency_Lastprice`).
 *
 * `fx_rates` is a journal: one row per `(pair, effective_from)`, never overwritten in
 * place when a new day's rate arrives. `resolveFx` therefore reads the newest row **on
 * or before** the requested date, which is what makes a back-dated document value itself
 * with the rate that was true then (ACCOUNTING_ARCHITECTURE §6).
 *
 * Arithmetic goes through `decimal.js` (ADR-006): an inverse or triangulated rate is a
 * division, and doing that in IEEE doubles is precisely the bug the money rules exist to
 * prevent.
 */

/** 30 significant digits is far more than `numeric(20,10)` needs; the result is rounded once. */
const FxDecimal = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export const FX_SCALE = 10;

/** One leg of a resolution: a decimal-string factor and the date it became effective. */
type FxLeg = { factor: string; effectiveFrom: string };

/**
 * `1 / value`, rounded once to the stored scale. Exported because it is the arithmetic
 * an inverse quote depends on, and it is worth testing without a database.
 */
export function invertRate(value: string): string {
  return normalise(new FxDecimal(1).div(value));
}

/**
 * Full-precision reciprocal, used for an *intermediate* triangulation leg. Rounding the
 * leg to the stored scale first and then multiplying would round twice and drift by a
 * few units in the last place, which is precisely the class of error ADR-006 exists to
 * prevent — so the intermediate keeps its digits and only the answer is rounded.
 */
function rawInvert(value: string): string {
  return new FxDecimal(1).div(value).toFixed();
}

/** `first × second` — the triangulation step, rounded once at the end. */
export function combineRates(first: string, second: string): string {
  return normalise(new FxDecimal(first).mul(second));
}

export type FxResolution = FxResolutionDto;

@Injectable()
export class FxService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly currenciesService: CurrenciesService,
  ) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<FxRateDto>> {
    const filters = parseFilters(query.filter, FX_RATE_FILTERS);
    const sort = parseSort(query.sort, FX_RATE_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(fxRates.tenantId, tenantId)];
      if (filters.fromCode) conditions.push(eq(fxRates.fromCode, filters.fromCode.toUpperCase()));
      if (filters.toCode) conditions.push(eq(fxRates.toCode, filters.toCode.toUpperCase()));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(fxRates).where(where);

      const order =
        sort.length > 0 && sort[0]
          ? [
              sort[0].column === 'createdAt'
                ? sort[0].direction === 'desc'
                  ? desc(fxRates.createdAt)
                  : asc(fxRates.createdAt)
                : sort[0].direction === 'desc'
                  ? desc(fxRates.effectiveFrom)
                  : asc(fxRates.effectiveFrom),
            ]
          : [desc(fxRates.effectiveFrom)];

      const rows = await tx
        .select()
        .from(fxRates)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toFxRateDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, fxRateId: string): Promise<FxRateDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toFxRateDto(await this.mustFind(tx, tenantId, fxRateId)),
    );
  }

  async create(tenantId: string, input: FxRateCreate): Promise<FxRateDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertCurrencyEnabled(tx, tenantId, input.fromCode, 'fromCode');
      await this.assertCurrencyEnabled(tx, tenantId, input.toCode, 'toCode');

      const fxRateId = newId();
      try {
        await tx.insert(fxRates).values({
          id: fxRateId,
          tenantId,
          fromCode: input.fromCode,
          toCode: input.toCode,
          rate: input.rate,
          effectiveFrom: input.effectiveFrom,
          createdAt: now,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw validationFailed(
            `A rate for ${input.fromCode}→${input.toCode} on ${input.effectiveFrom} already exists`,
            'effectiveFrom',
          );
        }
        throw error;
      }

      return toFxRateDto(await this.mustFind(tx, tenantId, fxRateId));
    });
  }

  /** Only the rate is mutable: changing the pair or the date would rewrite history. */
  async update(tenantId: string, fxRateId: string, input: FxRateUpdate): Promise<FxRateDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, fxRateId);
      assertVersion(existing.version, input.version);

      const updates: Record<string, unknown> = {
        updatedAt: now,
        updatedBy: actorUserId,
        version: sql`${fxRates.version} + 1`,
      };
      if (input.rate !== undefined) updates.rate = input.rate;

      await tx.update(fxRates).set(updates).where(eq(fxRates.id, fxRateId));
      return toFxRateDto(await this.mustFind(tx, tenantId, fxRateId));
    });
  }

  async remove(tenantId: string, fxRateId: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, fxRateId);
      // Hard delete: `fx_rates` is reference data with no soft-delete columns
      // (DATABASE_DESIGN §3) — a wrong rate must leave no trace that could be resolved.
      await tx.delete(fxRates).where(eq(fxRates.id, fxRateId));
    });
  }

  /**
   * `resolveFx(tenantId, from, to, date)` — PHASE_05 §5.4.
   *
   * Resolution order, most trustworthy first:
   *   1. `identity`      — same currency, rate 1;
   *   2. `direct`        — a stored `from→to` row;
   *   3. `inverse`       — a stored `to→from` row, inverted;
   *   4. `triangulated`  — `from→base` × `base→to`, each leg direct or inverse.
   *
   * The answer always says which rung answered, because "1.0000" from an identity and
   * "1.0000" from a stale table mean very different things to an accountant.
   */
  async resolveFx(tenantId: string, from: string, to: string, on?: string): Promise<FxResolution> {
    return withTenantTx(this.database.db, tenantId, (tx) => this.resolveFxInTx(tx, tenantId, from, to, on));
  }

  async resolveFxInTx(
    tx: DrizzleTx,
    tenantId: string,
    from: string,
    to: string,
    on?: string,
  ): Promise<FxResolution> {
    const fromCode = from.toUpperCase();
    const toCode = to.toUpperCase();
    const asOf = on ?? new Date().toISOString().slice(0, 10);

    if (fromCode === toCode) {
      return {
        fromCode,
        toCode,
        rate: '1',
        source: 'identity',
        effectiveFrom: null,
        via: null,
      };
    }

    const direct = await this.findLeg(tx, tenantId, fromCode, toCode, asOf);
    if (direct) {
      return {
        fromCode,
        toCode,
        rate: normalise(new FxDecimal(direct.factor)),
        source: 'direct',
        effectiveFrom: direct.effectiveFrom,
        via: null,
      };
    }

    const inverse = await this.findLeg(tx, tenantId, toCode, fromCode, asOf);
    if (inverse) {
      return {
        fromCode,
        toCode,
        rate: invertRate(inverse.factor),
        source: 'inverse',
        effectiveFrom: inverse.effectiveFrom,
        via: null,
      };
    }

    const base = await this.currenciesService.baseCurrencyOf(tx, tenantId);
    if (base !== fromCode && base !== toCode) {
      const first = await this.findAnyLeg(tx, tenantId, fromCode, base, asOf);
      const second = await this.findAnyLeg(tx, tenantId, base, toCode, asOf);
      if (first && second) {
        return {
          fromCode,
          toCode,
          rate: combineRates(first.factor, second.factor),
          source: 'triangulated',
          // The older of the two legs: a triangulated rate is only as fresh as its
          // staler half.
          effectiveFrom:
            first.effectiveFrom < second.effectiveFrom ? first.effectiveFrom : second.effectiveFrom,
          via: base,
        };
      }
    }

    throw validationFailed(
      `No FX rate available for ${fromCode}→${toCode} on ${asOf}`,
      'from',
      422,
    );
  }

  // --- internals ---------------------------------------------------------------

  /** Newest stored rate for the exact pair, on or before `asOf`. */
  private async findLeg(
    tx: DrizzleTx,
    tenantId: string,
    fromCode: string,
    toCode: string,
    asOf: string,
  ): Promise<FxLeg | undefined> {
    const [row] = await tx
      .select({ rate: fxRates.rate, effectiveFrom: fxRates.effectiveFrom })
      .from(fxRates)
      .where(
        and(
          eq(fxRates.tenantId, tenantId),
          eq(fxRates.fromCode, fromCode),
          eq(fxRates.toCode, toCode),
          lte(fxRates.effectiveFrom, asOf),
        ),
      )
      .orderBy(desc(fxRates.effectiveFrom))
      .limit(1);

    if (!row) return undefined;
    return { factor: row.rate, effectiveFrom: row.effectiveFrom };
  }

  /** A leg in either stored direction, inverted when necessary. */
  private async findAnyLeg(
    tx: DrizzleTx,
    tenantId: string,
    fromCode: string,
    toCode: string,
    asOf: string,
  ): Promise<FxLeg | undefined> {
    const straight = await this.findLeg(tx, tenantId, fromCode, toCode, asOf);
    if (straight) return straight;

    const flipped = await this.findLeg(tx, tenantId, toCode, fromCode, asOf);
    if (!flipped) return undefined;
    return { factor: rawInvert(flipped.factor), effectiveFrom: flipped.effectiveFrom };
  }

  private async mustFind(tx: DrizzleTx, tenantId: string, fxRateId: string): Promise<FxRate> {
    const [row] = await tx
      .select()
      .from(fxRates)
      .where(and(eq(fxRates.id, fxRateId), eq(fxRates.tenantId, tenantId)))
      .limit(1);
    if (!row) throw notFound('FX rate');
    return row;
  }

  private async assertCurrencyEnabled(
    tx: DrizzleTx,
    tenantId: string,
    code: string,
    field: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ code: currencies.code })
      .from(currencies)
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.code, code)))
      .limit(1);
    if (!row) throw validationFailed(`Currency '${code}' is not enabled for this tenant`, field);
  }
}

/** `numeric(20,10)` with trailing zeros trimmed — one canonical string per value. */
function normalise(value: Decimal): string {
  return value.toDecimalPlaces(FX_SCALE, Decimal.ROUND_HALF_UP).toFixed();
}

export function toFxRateDto(row: FxRate): FxRateDto {
  return {
    id: row.id,
    fromCode: row.fromCode.trim(),
    toCode: row.toCode.trim(),
    rate: row.rate,
    effectiveFrom: row.effectiveFrom,
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
