import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  BRANCH_FILTERS,
  BRANCH_SORT_COLUMNS,
  buildMeta,
  parseFilters,
  parseSort,
  parseBooleanFilter,
  type BranchCreate,
  type BranchDto,
  type BranchUpdate,
  type ListEnvelope,
  type OrgListQuery,
} from '@erp/contracts';
import {
  branches,
  cashLocations,
  documentSequences,
  newId,
  warehouses,
  withTenantTx,
  type Branch,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { UsageService } from '../../usage/index.js';
import {
  actorStamp,
  assertVersion,
  isUniqueViolation,
  isoOf,
  isoOrNull,
  lockDefaultSwitch,
  notFound,
  validationFailed,
  visibleBranchIds,
} from '../shared/org-support.js';

/**
 * Branches — API_CONTRACT §3, DATABASE_DESIGN §5.
 *
 * Three invariants live here and are tested as such (PHASE_05 §9):
 *
 * 1. **One default per tenant.** Enforced by a partial unique index, serialised by an
 *    advisory lock, and never left empty: the first branch a tenant gets is the default,
 *    and the default can only move, not disappear.
 * 2. **Codes are unique per tenant among live rows** — a soft-deleted branch releases
 *    its code.
 * 3. **A branch is only soft-deletable when nothing depends on it**: warehouses, cash
 *    locations and document sequences all point at it, and orphaning them would corrupt
 *    numbering and stock long after the delete.
 */
@Injectable()
export class BranchesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly usage: UsageService,
  ) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<BranchDto>> {
    const filters = parseFilters(query.filter, BRANCH_FILTERS);
    const sort = parseSort(query.sort, BRANCH_SORT_COLUMNS);
    const scoped = visibleBranchIds();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(branches.tenantId, tenantId), isNull(branches.deletedAt)];

      const isActive = parseBooleanFilter(filters.isActive);
      if (isActive !== undefined) conditions.push(eq(branches.isActive, isActive));
      const isDefault = parseBooleanFilter(filters.isDefault);
      if (isDefault !== undefined) conditions.push(eq(branches.isDefault, isDefault));
      if (scoped) {
        // An empty scope must match nothing, not everything.
        conditions.push(scoped.length > 0 ? inArray(branches.id, scoped) : sql`false`);
      }
      if (query.q) {
        const pattern = `%${query.q}%`;
        const search = or(
          ilike(branches.code, pattern),
          ilike(branches.nameAr, pattern),
          ilike(branches.nameEn, pattern),
        );
        if (search) conditions.push(search);
      }

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(branches).where(where);

      const order =
        sort.length > 0
          ? sort.map((clause) => {
              const column =
                clause.column === 'code'
                  ? branches.code
                  : clause.column === 'nameAr'
                    ? branches.nameAr
                    : branches.createdAt;
              return clause.direction === 'desc' ? sql`${column} DESC` : sql`${column} ASC`;
            })
          : [sql`${branches.code} ASC`];

      const rows = await tx
        .select()
        .from(branches)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toBranchDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, branchId: string): Promise<BranchDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toBranchDto(await this.mustFind(tx, tenantId, branchId)),
    );
  }

  async create(tenantId: string, input: BranchCreate): Promise<BranchDto> {
    const { actorUserId, now } = actorStamp();
    // P-C5: الفروع مقياسٌ محدود — والحدّ يُطبَّق قبل الكتابة لا بعدها.
    await this.usage.assertWithinLimit(tenantId, 'branches');

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertCodeAvailable(tx, tenantId, input.code);

      const [existing] = await tx
        .select({ value: count() })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), isNull(branches.deletedAt)));

      // A tenant without a default branch is a tenant whose documents cannot be
      // numbered, so the first branch is always the default.
      const isFirst = (existing?.value ?? 0) === 0;
      const wantsDefault = input.isDefault === true || isFirst;
      if (wantsDefault) await this.clearDefault(tx, tenantId);

      const branchId = newId();
      try {
        await tx.insert(branches).values({
          id: branchId,
          tenantId,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn ?? null,
          address: input.address ?? null,
          phone: input.phone ?? null,
          mobile: input.mobile ?? null,
          email: input.email ?? null,
          isDefault: wantsDefault,
          isActive: input.isActive ?? true,
          createdAt: now,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw validationFailed(`Branch code '${input.code}' already exists`, 'code');
        }
        throw error;
      }

      return toBranchDto(await this.mustFind(tx, tenantId, branchId));
    });
  }

  async update(tenantId: string, branchId: string, input: BranchUpdate): Promise<BranchDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, branchId);
      assertVersion(existing.version, input.version);

      if (input.isDefault === true && !existing.isDefault) {
        await this.clearDefault(tx, tenantId);
      }
      if (input.isDefault === false && existing.isDefault) {
        throw validationFailed(
          'Promote another branch to default instead of clearing the flag',
          'isDefault',
        );
      }
      if (input.isActive === false && existing.isDefault) {
        throw validationFailed('The default branch cannot be deactivated', 'isActive');
      }

      const updates: Record<string, unknown> = {
        updatedAt: now,
        updatedBy: actorUserId,
        version: sql`${branches.version} + 1`,
      };
      if (input.nameAr !== undefined) updates.nameAr = input.nameAr;
      if (input.nameEn !== undefined) updates.nameEn = input.nameEn;
      if (input.address !== undefined) updates.address = input.address;
      if (input.phone !== undefined) updates.phone = input.phone;
      if (input.mobile !== undefined) updates.mobile = input.mobile;
      if (input.email !== undefined) updates.email = input.email;
      if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      await tx.update(branches).set(updates).where(eq(branches.id, branchId));
      return toBranchDto(await this.mustFind(tx, tenantId, branchId));
    });
  }

  /** Soft delete (PROJECT_CONTRACT §5) — the row stays for history and legacy mapping. */
  async remove(tenantId: string, branchId: string): Promise<void> {
    const { actorUserId, now } = actorStamp();

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, branchId);
      if (existing.isDefault) {
        throw validationFailed('The default branch cannot be deleted', 'id');
      }
      await this.assertNoDependents(tx, tenantId, branchId);

      await tx
        .update(branches)
        .set({
          deletedAt: now,
          deletedBy: actorUserId,
          isActive: false,
          updatedAt: now,
          updatedBy: actorUserId,
          version: sql`${branches.version} + 1`,
        })
        .where(eq(branches.id, branchId));
    });
  }

  /** Shared by the other organization services: "does this branch exist for me?" */
  async assertExists(tx: DrizzleTx, tenantId: string, branchId: string): Promise<void> {
    await this.mustFind(tx, tenantId, branchId);
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(tx: DrizzleTx, tenantId: string, branchId: string): Promise<Branch> {
    const [row] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId), isNull(branches.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Branch');

    const scoped = visibleBranchIds();
    if (scoped && !scoped.includes(row.id)) throw notFound('Branch');
    return row;
  }

  private async assertCodeAvailable(tx: DrizzleTx, tenantId: string, code: string): Promise<void> {
    const [duplicate] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.code, code), isNull(branches.deletedAt)))
      .limit(1);
    if (duplicate) throw validationFailed(`Branch code '${code}' already exists`, 'code');
  }

  private async clearDefault(tx: DrizzleTx, tenantId: string): Promise<void> {
    await lockDefaultSwitch(tx, tenantId, 'branches');
    await tx
      .update(branches)
      .set({ isDefault: false })
      .where(
        and(eq(branches.tenantId, tenantId), eq(branches.isDefault, true), isNull(branches.deletedAt)),
      );
  }

  private async assertNoDependents(tx: DrizzleTx, tenantId: string, branchId: string): Promise<void> {
    const [warehouseRow] = await tx
      .select({ value: count() })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, tenantId),
          eq(warehouses.branchId, branchId),
          isNull(warehouses.deletedAt),
        ),
      );
    if ((warehouseRow?.value ?? 0) > 0) {
      throw validationFailed('Delete or move the branch warehouses first', 'id');
    }

    const [cashRow] = await tx
      .select({ value: count() })
      .from(cashLocations)
      .where(
        and(
          eq(cashLocations.tenantId, tenantId),
          eq(cashLocations.branchId, branchId),
          isNull(cashLocations.deletedAt),
        ),
      );
    if ((cashRow?.value ?? 0) > 0) {
      throw validationFailed('Delete or move the branch cash locations first', 'id');
    }

    const [sequenceRow] = await tx
      .select({ value: count() })
      .from(documentSequences)
      .where(and(eq(documentSequences.tenantId, tenantId), eq(documentSequences.branchId, branchId)));
    if ((sequenceRow?.value ?? 0) > 0) {
      throw validationFailed('The branch already owns document numbering and cannot be deleted', 'id');
    }
  }
}

export function toBranchDto(row: Branch): BranchDto {
  return {
    id: row.id,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    address: (row.address ?? null) as BranchDto['address'],
    phone: row.phone,
    mobile: row.mobile,
    email: row.email,
    isDefault: row.isDefault,
    isActive: row.isActive,
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
