import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  WAREHOUSE_FILTERS,
  WAREHOUSE_SORT_COLUMNS,
  buildMeta,
  parseBooleanFilter,
  parseFilters,
  parseSort,
  type ListEnvelope,
  type OrgListQuery,
  type WarehouseCreate,
  type WarehouseDto,
  type WarehouseUpdate,
} from '@erp/contracts';
import {
  branches,
  newId,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
  type Warehouse,
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
  visibleBranchIds,
  visibleRoleScopeIds,
} from '../shared/org-support.js';

/**
 * Warehouses — API_CONTRACT §3, DATABASE_DESIGN §5 (legacy `Stocks`).
 *
 * Same default/soft-delete/branch-scope rules as branches. `inventoryAccountId` is
 * accepted as a uuid and **not** checked against the chart of accounts: `accounts`
 * arrives in PHASE_07, which adds both the FK and the postable-account rule
 * (`ValidatedAtRuntime: P07`, PHASE_05 §4).
 */
@Injectable()
export class WarehousesService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<WarehouseDto>> {
    const filters = parseFilters(query.filter, WAREHOUSE_FILTERS);
    const sort = parseSort(query.sort, WAREHOUSE_SORT_COLUMNS);
    const scoped = visibleBranchIds();
    const scopedWarehouses = visibleRoleScopeIds('warehouse');

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(warehouses.tenantId, tenantId), isNull(warehouses.deletedAt)];

      const isActive = parseBooleanFilter(filters.isActive);
      if (isActive !== undefined) conditions.push(eq(warehouses.isActive, isActive));
      const isDefault = parseBooleanFilter(filters.isDefault);
      if (isDefault !== undefined) conditions.push(eq(warehouses.isDefault, isDefault));
      if (filters.branchId) conditions.push(eq(warehouses.branchId, filters.branchId));
      if (scoped) {
        conditions.push(scoped.length > 0 ? inArray(warehouses.branchId, scoped) : sql`false`);
      }
      if (scopedWarehouses) {
        conditions.push(
          scopedWarehouses.length > 0 ? inArray(warehouses.id, scopedWarehouses) : sql`false`,
        );
      }
      if (query.q) {
        const pattern = `%${query.q}%`;
        const search = or(ilike(warehouses.code, pattern), ilike(warehouses.name, pattern));
        if (search) conditions.push(search);
      }

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(warehouses).where(where);

      const order =
        sort.length > 0
          ? sort.map((clause) => {
              const column =
                clause.column === 'code'
                  ? warehouses.code
                  : clause.column === 'name'
                    ? warehouses.name
                    : warehouses.createdAt;
              return clause.direction === 'desc' ? sql`${column} DESC` : sql`${column} ASC`;
            })
          : [sql`${warehouses.code} ASC`];

      const rows = await tx
        .select()
        .from(warehouses)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toWarehouseDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, warehouseId: string): Promise<WarehouseDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toWarehouseDto(await this.mustFind(tx, tenantId, warehouseId)),
    );
  }

  async create(tenantId: string, input: WarehouseCreate): Promise<WarehouseDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await assertBranchUsable(tx, tenantId, input.branchId);
      await this.assertCodeAvailable(tx, tenantId, input.code);

      const [existing] = await tx
        .select({ value: count() })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenantId), isNull(warehouses.deletedAt)));

      const wantsDefault = input.isDefault === true || (existing?.value ?? 0) === 0;
      if (wantsDefault) await this.clearDefault(tx, tenantId);

      const warehouseId = newId();
      try {
        await tx.insert(warehouses).values({
          id: warehouseId,
          tenantId,
          branchId: input.branchId,
          code: input.code,
          name: input.name,
          inventoryAccountId: input.inventoryAccountId ?? null,
          isDefault: wantsDefault,
          isActive: input.isActive ?? true,
          createdAt: now,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw validationFailed(`Warehouse code '${input.code}' already exists`, 'code');
        }
        throw error;
      }

      return toWarehouseDto(await this.mustFind(tx, tenantId, warehouseId));
    });
  }

  async update(tenantId: string, warehouseId: string, input: WarehouseUpdate): Promise<WarehouseDto> {
    const { actorUserId, now } = actorStamp();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, warehouseId);
      assertVersion(existing.version, input.version);

      if (input.branchId !== undefined && input.branchId !== existing.branchId) {
        await assertBranchUsable(tx, tenantId, input.branchId);
      }
      if (input.isDefault === true && !existing.isDefault) await this.clearDefault(tx, tenantId);
      if (input.isDefault === false && existing.isDefault) {
        throw validationFailed(
          'Promote another warehouse to default instead of clearing the flag',
          'isDefault',
        );
      }
      if (input.isActive === false && existing.isDefault) {
        throw validationFailed('The default warehouse cannot be deactivated', 'isActive');
      }

      const updates: Record<string, unknown> = {
        updatedAt: now,
        updatedBy: actorUserId,
        version: sql`${warehouses.version} + 1`,
      };
      if (input.branchId !== undefined) updates.branchId = input.branchId;
      if (input.name !== undefined) updates.name = input.name;
      if (input.inventoryAccountId !== undefined) updates.inventoryAccountId = input.inventoryAccountId;
      if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      await tx.update(warehouses).set(updates).where(eq(warehouses.id, warehouseId));
      return toWarehouseDto(await this.mustFind(tx, tenantId, warehouseId));
    });
  }

  async remove(tenantId: string, warehouseId: string): Promise<void> {
    const { actorUserId, now } = actorStamp();

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, warehouseId);
      if (existing.isDefault) throw validationFailed('The default warehouse cannot be deleted', 'id');

      await tx
        .update(warehouses)
        .set({
          deletedAt: now,
          deletedBy: actorUserId,
          isActive: false,
          updatedAt: now,
          updatedBy: actorUserId,
          version: sql`${warehouses.version} + 1`,
        })
        .where(eq(warehouses.id, warehouseId));
    });
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(tx: DrizzleTx, tenantId: string, warehouseId: string): Promise<Warehouse> {
    const [row] = await tx
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.id, warehouseId),
          eq(warehouses.tenantId, tenantId),
          isNull(warehouses.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound('Warehouse');

    const scoped = visibleBranchIds();
    if (scoped && !scoped.includes(row.branchId)) throw notFound('Warehouse');
    const scopedWarehouses = visibleRoleScopeIds('warehouse');
    if (scopedWarehouses && !scopedWarehouses.includes(row.id)) throw notFound('Warehouse');
    return row;
  }

  private async assertCodeAvailable(tx: DrizzleTx, tenantId: string, code: string): Promise<void> {
    const [duplicate] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(
        and(eq(warehouses.tenantId, tenantId), eq(warehouses.code, code), isNull(warehouses.deletedAt)),
      )
      .limit(1);
    if (duplicate) throw validationFailed(`Warehouse code '${code}' already exists`, 'code');
  }

  private async clearDefault(tx: DrizzleTx, tenantId: string): Promise<void> {
    await lockDefaultSwitch(tx, tenantId, 'warehouses');
    await tx
      .update(warehouses)
      .set({ isDefault: false })
      .where(
        and(
          eq(warehouses.tenantId, tenantId),
          eq(warehouses.isDefault, true),
          isNull(warehouses.deletedAt),
        ),
      );
  }
}

/**
 * A branch reference must exist, be live and be inside the caller's scope. A foreign or
 * out-of-scope branch is a 404 on the *reference*, not a 403 — the caller must not learn
 * that the id exists (MULTI_TENANCY §7.1, and the isolation harness asserts it).
 */
export async function assertBranchUsable(
  tx: DrizzleTx,
  tenantId: string,
  branchId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId), isNull(branches.deletedAt)))
    .limit(1);
  if (!row) throw notFound('Branch');

  const scoped = visibleBranchIds();
  if (scoped && !scoped.includes(branchId)) throw notFound('Branch');
}

export function toWarehouseDto(row: Warehouse): WarehouseDto {
  return {
    id: row.id,
    branchId: row.branchId,
    code: row.code,
    name: row.name,
    inventoryAccountId: row.inventoryAccountId,
    isDefault: row.isDefault,
    isActive: row.isActive,
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
