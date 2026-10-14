import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  CASH_LOCATION_FILTERS,
  CASH_LOCATION_SORT_COLUMNS,
  bankDetailsSchema,
  buildMeta,
  maskIban,
  parseBooleanFilter,
  parseFilters,
  parseSort,
  type CashLocationBalanceDto,
  type CashLocationCreate,
  type CashLocationDto,
  type CashLocationUpdate,
  type ListEnvelope,
  type OrgListQuery,
} from '@erp/contracts';
import {
  cashLocationBalances,
  cashLocationCustodians,
  cashLocations,
  currencies,
  employees,
  newId,
  tenants,
  withTenantTx,
  type CashLocation,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { getRequestContext, markRequestAudited } from '../../../request-context/request-context.js';
import { AuditService } from '../../platform-services/index.js';
import { assertBranchUsable } from '../warehouses/warehouses.service.js';
import {
  actorStamp,
  assertVersion,
  isoOf,
  isoOrNull,
  lockDefaultSwitch,
  notFound,
  validationFailed,
  visibleBranchIds,
  visibleRoleScopeIds,
} from '../shared/org-support.js';

/**
 * Cash locations — API_CONTRACT §3, DATABASE_DESIGN §5.
 *
 * `Safes` + `Banks` + `treasury` unified behind `kind` (DOMAIN_MODEL §3). Two rules go
 * beyond the usual master-data CRUD:
 *
 * - **Bank data is sensitive** (SECURITY_ARCHITECTURE §5). The IBAN is masked in list
 *   responses and only the single-row read returns it in full.
 * - **Every change is audited with a real before/after** (PHASE_05 §8), written inside
 *   the same transaction as the change itself, so "changed" and "audited" cannot come
 *   apart. The interceptor is told to stand down for the request.
 */
@Injectable()
export class CashLocationsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<CashLocationDto>> {
    const filters = parseFilters(query.filter, CASH_LOCATION_FILTERS);
    const sort = parseSort(query.sort, CASH_LOCATION_SORT_COLUMNS);
    const scoped = visibleBranchIds();
    const scopedCashLocations = visibleRoleScopeIds('cash_location');

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(cashLocations.tenantId, tenantId), isNull(cashLocations.deletedAt)];

      const isActive = parseBooleanFilter(filters.isActive);
      if (isActive !== undefined) conditions.push(eq(cashLocations.isActive, isActive));
      const isDefault = parseBooleanFilter(filters.isDefault);
      if (isDefault !== undefined) conditions.push(eq(cashLocations.isDefault, isDefault));
      if (filters.branchId) conditions.push(eq(cashLocations.branchId, filters.branchId));
      if (filters.kind) conditions.push(eq(cashLocations.kind, filters.kind));
      if (scoped) {
        conditions.push(scoped.length > 0 ? inArray(cashLocations.branchId, scoped) : sql`false`);
      }
      if (scopedCashLocations) {
        conditions.push(
          scopedCashLocations.length > 0 ? inArray(cashLocations.id, scopedCashLocations) : sql`false`,
        );
      }
      if (query.q) conditions.push(ilike(cashLocations.name, `%${query.q}%`));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(cashLocations).where(where);

      const order =
        sort.length > 0
          ? sort.map((clause) => {
              const column =
                clause.column === 'kind'
                  ? cashLocations.kind
                  : clause.column === 'name'
                    ? cashLocations.name
                    : cashLocations.createdAt;
              return clause.direction === 'desc' ? sql`${column} DESC` : sql`${column} ASC`;
            })
          : [sql`${cashLocations.name} ASC`];

      const rows = await tx
        .select()
        .from(cashLocations)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      const custodians = await custodianIdsByLocation(tx, tenantId, rows.map((row) => row.id));
      return {
        data: rows.map((row) =>
          toCashLocationDto(row, { maskBankDetails: true, custodianIds: custodians.get(row.id) ?? [] }),
        ),
        meta: buildMeta(totalRow?.value ?? 0, query),
      };
    });
  }

  async read(tenantId: string, cashLocationId: string): Promise<CashLocationDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = await this.mustFind(tx, tenantId, cashLocationId);
      const custodians = await custodianIdsByLocation(tx, tenantId, [row.id]);
      return toCashLocationDto(row, { custodianIds: custodians.get(row.id) ?? [] });
    });
  }

  async listBalances(tenantId: string, cashLocationId: string): Promise<CashLocationBalanceDto[]> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, cashLocationId);
      const rows = await tx
        .select()
        .from(cashLocationBalances)
        .where(
          and(
            eq(cashLocationBalances.tenantId, tenantId),
            eq(cashLocationBalances.cashLocationId, cashLocationId),
          ),
        )
        .orderBy(asc(cashLocationBalances.currencyCode));

      return rows.map((row) => ({
        cashLocationId: row.cashLocationId,
        currencyCode: row.currencyCode.trim(),
        balance: row.balance,
        updatedAt: isoOrNull(row.updatedAt),
      }));
    });
  }

  async create(tenantId: string, input: CashLocationCreate): Promise<CashLocationDto> {
    const { actorUserId, now } = actorStamp();
    assertBankBlock(input.kind, input.bank ?? null);

    const created = await withTenantTx(this.database.db, tenantId, async (tx) => {
      await assertBranchUsable(tx, tenantId, input.branchId);
      const currencyCode = await resolveCurrency(tx, tenantId, input.currencyCode ?? null);

      const [existing] = await tx
        .select({ value: count() })
        .from(cashLocations)
        .where(
          and(
            eq(cashLocations.tenantId, tenantId),
            eq(cashLocations.kind, input.kind),
            isNull(cashLocations.deletedAt),
          ),
        );

      const wantsDefault = input.isDefault === true || (existing?.value ?? 0) === 0;
      if (wantsDefault) await this.clearDefault(tx, tenantId, input.kind);

      const cashLocationId = newId();
      await tx.insert(cashLocations).values({
        id: cashLocationId,
        tenantId,
        branchId: input.branchId,
        kind: input.kind,
        name: input.name,
        accountId: input.accountId ?? null,
        currencyCode: input.currencyCode ?? null,
        isDefault: wantsDefault,
        bank: input.bank ?? null,
        changeInPos: input.changeInPos ?? false,
        isActive: input.isActive ?? true,
        notes: input.notes ?? null,
        createdAt: now,
        createdBy: actorUserId,
      });

      // Seeds the balance row at zero — PHASE_12 writes it, a report reconciles it.
      await tx
        .insert(cashLocationBalances)
        .values({ tenantId, cashLocationId, currencyCode, balance: '0' })
        .onConflictDoNothing();

      await this.replaceCustodians(tx, tenantId, cashLocationId, input.kind, input.custodianIds);
      const row = await this.mustFind(tx, tenantId, cashLocationId);
      await this.recordAudit(tx, tenantId, 'create', row, null);
      const custodians = await custodianIdsByLocation(tx, tenantId, [row.id]);
      return toCashLocationDto(row, { custodianIds: custodians.get(row.id) ?? [] });
    });

    markRequestAudited();
    return created;
  }

  async update(
    tenantId: string,
    cashLocationId: string,
    input: CashLocationUpdate,
  ): Promise<CashLocationDto> {
    const { actorUserId, now } = actorStamp();

    const updated = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, cashLocationId);
      assertVersion(existing.version, input.version);
      if (input.bank !== undefined) assertBankBlock(existing.kind, input.bank);

      if (input.branchId !== undefined && input.branchId !== existing.branchId) {
        await assertBranchUsable(tx, tenantId, input.branchId);
      }
      if (input.isDefault === true && !existing.isDefault) {
        await this.clearDefault(tx, tenantId, existing.kind);
      }
      if (input.isDefault === false && existing.isDefault) {
        throw validationFailed(
          'Promote another cash location to default instead of clearing the flag',
          'isDefault',
        );
      }
      if (input.isActive === false && existing.isDefault) {
        throw validationFailed('The default cash location cannot be deactivated', 'isActive');
      }

      const updates: Record<string, unknown> = {
        updatedAt: now,
        updatedBy: actorUserId,
        version: sql`${cashLocations.version} + 1`,
      };
      if (input.branchId !== undefined) updates.branchId = input.branchId;
      if (input.name !== undefined) updates.name = input.name;
      if (input.accountId !== undefined) updates.accountId = input.accountId;
      if (input.currencyCode !== undefined) updates.currencyCode = input.currencyCode;
      if (input.bank !== undefined) updates.bank = input.bank;
      if (input.changeInPos !== undefined) updates.changeInPos = input.changeInPos;
      if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
      if (input.isActive !== undefined) updates.isActive = input.isActive;
      if (input.notes !== undefined) updates.notes = input.notes;

      await tx.update(cashLocations).set(updates).where(eq(cashLocations.id, cashLocationId));

      if (input.currencyCode !== undefined) {
        const currencyCode = await resolveCurrency(tx, tenantId, input.currencyCode);
        await tx
          .insert(cashLocationBalances)
          .values({ tenantId, cashLocationId, currencyCode, balance: '0' })
          .onConflictDoNothing();
      }

      if (input.custodianIds !== undefined) {
        await this.replaceCustodians(tx, tenantId, cashLocationId, existing.kind, input.custodianIds);
      }
      const row = await this.mustFind(tx, tenantId, cashLocationId);
      await this.recordAudit(tx, tenantId, 'update', row, existing);
      const custodians = await custodianIdsByLocation(tx, tenantId, [row.id]);
      return toCashLocationDto(row, { custodianIds: custodians.get(row.id) ?? [] });
    });

    markRequestAudited();
    return updated;
  }

  async remove(tenantId: string, cashLocationId: string): Promise<void> {
    const { actorUserId, now } = actorStamp();

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, cashLocationId);
      if (existing.isDefault) {
        throw validationFailed('The default cash location cannot be deleted', 'id');
      }

      await tx
        .update(cashLocations)
        .set({
          deletedAt: now,
          deletedBy: actorUserId,
          isActive: false,
          updatedAt: now,
          updatedBy: actorUserId,
          version: sql`${cashLocations.version} + 1`,
        })
        .where(eq(cashLocations.id, cashLocationId));

      const row = await tx
        .select()
        .from(cashLocations)
        .where(eq(cashLocations.id, cashLocationId))
        .limit(1);
      await this.recordAudit(tx, tenantId, 'delete', row[0] ?? existing, existing);
    });

    markRequestAudited();
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(tx: DrizzleTx, tenantId: string, cashLocationId: string): Promise<CashLocation> {
    const [row] = await tx
      .select()
      .from(cashLocations)
      .where(
        and(
          eq(cashLocations.id, cashLocationId),
          eq(cashLocations.tenantId, tenantId),
          isNull(cashLocations.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound('Cash location');

    const scoped = visibleBranchIds();
    if (scoped && !scoped.includes(row.branchId)) throw notFound('Cash location');
    const scopedCashLocations = visibleRoleScopeIds('cash_location');
    if (scopedCashLocations && !scopedCashLocations.includes(row.id)) throw notFound('Cash location');
    return row;
  }

  /**
   * 👤 مسئولي الصندوق — `frmTreasury.xaml.cs:222` saves the treasury and re-inserts
   * `Stock_Emps` in one transaction, and refuses a الصندوق with no مسئول at all
   * («يجب اختيار موظف مسئول»). Same rule, same transaction, one difference: the desktop
   * deletes first and inserts after, which for a moment leaves the box unowned. Here the
   * employees are validated *before* anything is written, so a typo cannot strip a safe
   * of its custodians on the way to failing.
   */
  private async replaceCustodians(
    tx: DrizzleTx,
    tenantId: string,
    cashLocationId: string,
    kind: string,
    custodianIds: string[] | undefined,
  ): Promise<void> {
    const requested = custodianIds ?? [];
    if (kind === 'safe' && custodianIds !== undefined && requested.length === 0) {
      throw validationFailed('يجب اختيار موظف مسئول — a safe needs a responsible employee', 'custodianIds');
    }
    if (!requested.length) return;

    const unique = Array.from(new Set(requested));
    const rows = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(eq(employees.tenantId, tenantId), inArray(employees.id, unique), isNull(employees.deletedAt)),
      );
    if (rows.length !== unique.length) {
      const known = new Set(rows.map((row) => row.id));
      const missing = unique.find((id) => !known.has(id));
      throw validationFailed(`Employee ${missing} does not belong to this tenant`, 'custodianIds');
    }

    await tx
      .delete(cashLocationCustodians)
      .where(
        and(
          eq(cashLocationCustodians.tenantId, tenantId),
          eq(cashLocationCustodians.cashLocationId, cashLocationId),
        ),
      );
    await tx.insert(cashLocationCustodians).values(
      unique.map((employeeId) => ({
        id: newId(),
        tenantId,
        cashLocationId,
        employeeId,
        createdBy: actorStamp().actorUserId,
      })),
    );
  }

  private async clearDefault(tx: DrizzleTx, tenantId: string, kind: string): Promise<void> {
    await lockDefaultSwitch(tx, tenantId, `cash_locations:${kind}`);
    await tx
      .update(cashLocations)
      .set({ isDefault: false })
      .where(
        and(
          eq(cashLocations.tenantId, tenantId),
          eq(cashLocations.kind, kind),
          eq(cashLocations.isDefault, true),
          isNull(cashLocations.deletedAt),
        ),
      );
  }

  private async recordAudit(
    tx: DrizzleTx,
    tenantId: string,
    action: string,
    after: CashLocation,
    before: CashLocation | null,
  ): Promise<void> {
    const context = getRequestContext();
    await this.audit.recordInTx(tx, {
      tenantId,
      actorUserId: context.auth?.userId ?? null,
      membershipId: context.auth?.membershipId ?? null,
      action,
      entity: 'cash_location',
      entityId: after.id,
      before: before ? auditView(before) : null,
      after: action === 'delete' ? null : auditView(after),
      meta: { traceId: context.traceId ?? null },
    });
  }
}

/**
 * The audit projection of a cash location. The bank block is reduced to its masked IBAN:
 * an audit row is read by more people than the record itself, and SECURITY_ARCHITECTURE
 * §5 does not stop applying because the data moved into `audit_log`.
 */
function auditView(row: CashLocation): Record<string, unknown> {
  const bank = row.bank as { iban?: string; bankName?: string } | null;
  return {
    branchId: row.branchId,
    kind: row.kind,
    name: row.name,
    accountId: row.accountId,
    currencyCode: row.currencyCode?.trim() ?? null,
    isDefault: row.isDefault,
    changeInPos: row.changeInPos,
    isActive: row.isActive,
    /** 👤 مسئولي الصندوق are audited by the treasury write itself, not by this projection. */
    bank: bank ? { bankName: bank.bankName ?? null, iban: bank.iban ? maskIban(bank.iban) : null } : null,
    notes: row.notes ?? null,
  };
}

function assertBankBlock(kind: string, bank: unknown): void {
  if (kind === 'safe') {
    if (bank !== null && bank !== undefined) {
      throw validationFailed('A safe cannot carry bank details', 'bank');
    }
    return;
  }
  if (bank === null || bank === undefined) {
    throw validationFailed('A bank cash location requires the bank block', 'bank');
  }
  const parsed = bankDetailsSchema.safeParse(bank);
  if (!parsed.success) {
    throw validationFailed(parsed.error.issues[0]?.message ?? 'Invalid bank details', 'bank');
  }
}

/** NULL currency means "the tenant's base currency" (DATABASE_DESIGN §5). */
async function resolveCurrency(
  tx: DrizzleTx,
  tenantId: string,
  currencyCode: string | null,
): Promise<string> {
  if (currencyCode) {
    const [row] = await tx
      .select({ code: currencies.code })
      .from(currencies)
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.code, currencyCode)))
      .limit(1);
    if (!row) throw validationFailed(`Currency '${currencyCode}' is not enabled for this tenant`, 'currencyCode');
    return row.code.trim();
  }

  const [tenantRow] = await tx
    .select({ baseCurrency: tenants.baseCurrency })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return (tenantRow?.baseCurrency ?? 'SAR').trim();
}

/** 👤 مسئولي الصندوق of many boxes at once — one query, so a list of 50 costs two. */
async function custodianIdsByLocation(
  tx: DrizzleTx,
  tenantId: string,
  cashLocationIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!cashLocationIds.length) return map;
  const rows = await tx
    .select({
      cashLocationId: cashLocationCustodians.cashLocationId,
      employeeId: cashLocationCustodians.employeeId,
    })
    .from(cashLocationCustodians)
    .where(
      and(
        eq(cashLocationCustodians.tenantId, tenantId),
        inArray(cashLocationCustodians.cashLocationId, cashLocationIds),
      ),
    )
    .orderBy(asc(cashLocationCustodians.createdAt));
  for (const row of rows) {
    const list = map.get(row.cashLocationId) ?? [];
    list.push(row.employeeId);
    map.set(row.cashLocationId, list);
  }
  return map;
}

export function toCashLocationDto(
  row: CashLocation,
  options: { maskBankDetails?: boolean; custodianIds?: string[] } = {},
): CashLocationDto {
  const bank = (row.bank ?? null) as CashLocationDto['bank'];
  const projected =
    bank && options.maskBankDetails && bank.iban ? { ...bank, iban: maskIban(bank.iban) } : bank;

  return {
    id: row.id,
    branchId: row.branchId,
    kind: row.kind as CashLocationDto['kind'],
    name: row.name,
    accountId: row.accountId,
    currencyCode: row.currencyCode?.trim() ?? null,
    isDefault: row.isDefault,
    bank: projected,
    changeInPos: row.changeInPos,
    isActive: row.isActive,
    notes: row.notes ?? null,
    custodianIds: options.custodianIds ?? [],
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
