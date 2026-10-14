import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  ROLE_FILTERS,
  ROLE_SORT_COLUMNS,
  buildMeta,
  canonicalizePermissionCode,
  errorCodes,
  isConsolePermissionCode,
  parseFilters,
  parseSort,
  permissionRegistry,
  type ListEnvelope,
  type PaginationQuery,
  type RoleCreate,
  type RoleDetailDto,
  type RoleUpdate,
} from '@erp/contracts';
import {
  newId,
  permissions,
  rolePermissions,
  roles,
  withTenantTx,
  withTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { getTenantContext } from '../context/tenant-context.js';
import { DATABASE_HANDLE } from '../../../database/database.module.js';

export type RoleListQuery = PaginationQuery & {
  filter?: Record<string, unknown>;
  sort?: string;
};

/** `GET/POST /roles`, `PUT /roles/{id}`, `POST /roles/{id}/permissions` — API_CONTRACT §2. */
@Injectable()
export class RolesService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string, query: RoleListQuery): Promise<ListEnvelope<RoleDetailDto>> {
    const filters = parseFilters(query.filter, ROLE_FILTERS);
    const sort = parseSort(query.sort, ROLE_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: (SQL | undefined)[] = [eq(roles.tenantId, tenantId), isNull(roles.deletedAt)];
      if (filters.isSystem !== undefined) {
        conditions.push(eq(roles.isSystem, filters.isSystem === 'true'));
      }
      const where = and(...conditions);

      const [totalRow] = await tx.select({ value: count() }).from(roles).where(where);

      const order =
        sort.length > 0
          ? sort.map((clause) =>
              clause.column === 'name'
                ? clause.direction === 'desc'
                  ? sql`${roles.name} DESC`
                  : sql`${roles.name} ASC`
                : clause.direction === 'desc'
                  ? sql`${roles.createdAt} DESC`
                  : sql`${roles.createdAt} ASC`,
            )
          : [sql`${roles.name} ASC`];

      const rows = await tx
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
        })
        .from(roles)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      // Sequential on purpose: a transaction owns a single connection, and issuing
      // concurrent queries on it is deprecated in `pg` (and unsafe in pg@9).
      const data: RoleDetailDto[] = [];
      for (const row of rows) {
        data.push(await this.toDetail(tx, row));
      }
      return { data, meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async create(tenantId: string, actorUserId: string, input: RoleCreate): Promise<RoleDetailDto> {
    const codes = await this.assertPermissionsExist(input.permissionCodes);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertNameAvailable(tx, tenantId, input.name);
      const id = newId();
      await tx.insert(roles).values({
        id,
        tenantId,
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
        createdAt: new Date(),
        createdBy: actorUserId,
      });
      await this.replacePermissionRows(tx, id, codes);
      return this.readOne(tx, id);
    });
  }

  async update(
    tenantId: string,
    actorUserId: string,
    roleId: string,
    input: RoleUpdate,
  ): Promise<RoleDetailDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, roleId);

      if (input.name !== undefined) {
        if (existing.isSystem) {
          throw new DomainError(errorCodes.VALIDATION_FAILED, 'System role names are immutable', 422, {
            field: 'name',
          });
        }
        if (input.name !== existing.name) {
          await this.assertNameAvailable(tx, tenantId, input.name);
        }
      }

      const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: actorUserId };
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) updates.description = input.description;
      updates.version = sql`${roles.version} + 1`;
      await tx.update(roles).set(updates).where(eq(roles.id, roleId));

      if (input.permissionCodes) {
        this.assertPermissionsMutable(existing);
        await this.replacePermissionRows(
          tx,
          roleId,
          await this.assertPermissionsExist(input.permissionCodes),
        );
      }

      return this.readOne(tx, roleId);
    });
  }

  async replacePermissions(
    tenantId: string,
    actorUserId: string,
    roleId: string,
    permissionCodes: readonly string[],
  ): Promise<RoleDetailDto> {
    const codes = await this.assertPermissionsExist(permissionCodes);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      this.assertPermissionsMutable(await this.mustFind(tx, tenantId, roleId));
      await this.replacePermissionRows(tx, roleId, codes);
      await tx
        .update(roles)
        .set({ updatedAt: new Date(), updatedBy: actorUserId, version: sql`${roles.version} + 1` })
        .where(eq(roles.id, roleId));
      return this.readOne(tx, roleId);
    });
  }

  /** Isolation harness helper. */
  async read(tenantId: string, roleId: string): Promise<RoleDetailDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => this.readOne(tx, roleId));
  }

  // --- internals ---------------------------------------------------------------

  private async assertPermissionsExist(codes: readonly string[]): Promise<string[]> {
    // The planes are disjoint: platform-console (`console.*`) permissions are granted
    // only through `platform_memberships`, never through a tenant role — not even the
    // tenant owner's. See docs/architecture-rbac/03-roles-permissions-matrix.md.
    const consoleCodes = [...new Set(codes)].filter((code) => isConsolePermissionCode(code));
    if (consoleCodes.length > 0) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `Platform permissions cannot be granted to a tenant role: ${consoleCodes.join(', ')}`,
        422,
        { field: 'permissionCodes' },
      );
    }
    // Normalise legacy `platform.*` spellings to canonical `tenant.*` on write, so the
    // database converges on the canonical namespace (reads accept both spellings).
    const canonical = [...new Set(codes.map((code) => canonicalizePermissionCode(code)))];
    if (canonical.length === 0) return [];
    const registryMap = new Map(permissionRegistry.map((entry) => [entry.code, entry]));
    const found = await withTx(this.database.db, async (tx) => {
      const existing = await tx
        .select({ code: permissions.code })
        .from(permissions)
        .where(inArray(permissions.code, [...canonical]));
      const existingSet = new Set(existing.map((row) => row.code));
      const missingFromDb = canonical.filter((code) => !existingSet.has(code) && registryMap.has(code));
      for (const code of missingFromDb) {
        const spec = registryMap.get(code)!;
        await tx
          .insert(permissions)
          .values({
            code: spec.code,
            module: spec.module,
            description: spec.description,
          })
          .onConflictDoNothing();
        existingSet.add(code);
      }
      return [...existingSet];
    });
    if (found.length !== canonical.length) {
      const known = new Set(found);
      const unknown = canonical.filter((code) => !known.has(code));
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `Unknown permission code(s): ${unknown.join(', ')}`,
        422,
        { field: 'permissionCodes' },
      );
    }
    return canonical;
  }

  private async replacePermissionRows(
    tx: DrizzleTx,
    roleId: string,
    codes: readonly string[],
  ): Promise<void> {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    for (const code of codes) {
      await tx.insert(rolePermissions).values({ roleId, permissionCode: code });
    }
  }

  /**
   * AUD-02 — صفوف صلاحيات دور «المالك» (`Owner`) محمية دائماً، وكذلك سائر الأدوار
   * النظامية (`Accountant` · `Cashier`) لغير مالك الحساب (`!getTenantContext().isOwner`)،
   * حتى لا يستغلّ حامل `tenant.role.manage` غير المالك صلاحيته لترقية دور نظامي. أمّا
   * مالك الحساب نفسه فيستطيع ضبط صلاحيات المحاسب والكاشير والأدوار المخصّصة من شاشة
   * الأدوار والصلاحيات.
   */
  private assertPermissionsMutable(role: { name: string; isSystem: boolean }): void {
    const isOwnerRole = role.name.trim().toLowerCase() === 'owner';
    if (isOwnerRole || (role.isSystem && !getTenantContext().isOwner)) {
      throw new DomainError(
        errorCodes.SYSTEM_ROLE_PERMISSIONS_IMMUTABLE,
        `Permissions of the system role '${role.name}' cannot be changed`,
        422,
        { field: 'permissionCodes' },
      );
    }
  }

  private async assertNameAvailable(tx: DrizzleTx, tenantId: string, name: string): Promise<void> {
    const existing = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.name, name), isNull(roles.deletedAt)))
      .limit(1);
    if (existing[0]) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, `Role '${name}' already exists`, 422, {
        field: 'name',
      });
    }
  }

  private async mustFind(tx: DrizzleTx, tenantId: string, roleId: string) {
    const rows = await tx
      .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId), isNull(roles.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new DomainError(errorCodes.NOT_FOUND, 'Role not found', 404);
    }
    return row;
  }

  private async readOne(tx: DrizzleTx, roleId: string): Promise<RoleDetailDto> {
    const rows = await tx
      .select({ id: roles.id, name: roles.name, description: roles.description, isSystem: roles.isSystem })
      .from(roles)
      // Soft-deleted roles read as missing (MULTI_TENANCY §7.1).
      .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
      .limit(1);
    const role = rows[0];
    if (!role) {
      throw new DomainError(errorCodes.NOT_FOUND, 'Role not found', 404);
    }
    return this.toDetail(tx, role);
  }

  private async toDetail(
    tx: DrizzleTx,
    role: { id: string; name: string; description: string | null; isSystem: boolean },
  ): Promise<RoleDetailDto> {
    const rows = await tx
      .select({ code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role.id))
      .orderBy(rolePermissions.permissionCode);

    return {
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissionCodes: rows.map((entry) => entry.code),
    };
  }
}
