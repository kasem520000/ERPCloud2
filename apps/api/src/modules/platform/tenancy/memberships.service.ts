import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  MEMBERSHIP_FILTERS,
  MEMBERSHIP_SORT_COLUMNS,
  buildMeta,
  errorCodes,
  parseFilters,
  parseSort,
  type ListEnvelope,
  type MembershipCreate,
  type MembershipDto,
  type MembershipUpdate,
  type PaginationQuery,
} from '@erp/contracts';
import {
  membershipRoleScopes,
  membershipRoles,
  memberships,
  newId,
  roles,
  users,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { UsageService } from '../../usage/index.js';
import { toMembershipDto } from '../mappers.js';

export type MembershipListQuery = PaginationQuery & {
  filter?: Record<string, unknown>;
  q?: string;
  sort?: string;
};

/** `GET/POST /memberships`, `PATCH/DELETE /memberships/{id}` — API_CONTRACT §2. */
@Injectable()
export class MembershipsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly usage: UsageService,
  ) {}

  async assignableRoles(tenantId: string): Promise<Array<{ id: string; name: string; isSystem: boolean }>> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      tx
        .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem })
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), isNull(roles.deletedAt)))
        .orderBy(roles.name),
    );
  }

  async list(tenantId: string, query: MembershipListQuery): Promise<ListEnvelope<MembershipDto>> {
    const filters = parseFilters(query.filter, MEMBERSHIP_FILTERS);
    const sort = parseSort(query.sort, MEMBERSHIP_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: (SQL | undefined)[] = [
        eq(memberships.tenantId, tenantId),
        isNull(memberships.deletedAt),
      ];
      if (filters.status) conditions.push(eq(memberships.status, filters.status));
      if (filters.roleId) {
        conditions.push(
          sql`${memberships.id} IN (SELECT membership_id FROM membership_roles WHERE role_id = ${filters.roleId}::uuid)`,
        );
      }
      if (query.q) {
        const pattern = `%${query.q}%`;
        conditions.push(
          or(
            ilike(memberships.displayName, pattern),
            sql`${memberships.userId} IN (SELECT id FROM users WHERE email ILIKE ${pattern})`,
          ),
        );
      }
      const where = and(...conditions);

      const [totalRow] = await tx
        .select({ value: count() })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(where);

      const order =
        sort.length > 0
          ? sort.map((clause) =>
              clause.column === 'displayName'
                ? clause.direction === 'desc'
                  ? sql`${memberships.displayName} DESC`
                  : sql`${memberships.displayName} ASC`
                : clause.direction === 'desc'
                  ? sql`${memberships.createdAt} DESC`
                  : sql`${memberships.createdAt} ASC`,
            )
          : [sql`${memberships.createdAt} ASC`];

      const rows = await tx
        .select({
          id: memberships.id,
          tenantId: memberships.tenantId,
          displayName: memberships.displayName,
          status: memberships.status,
          isOwner: memberships.isOwner,
          branchScope: memberships.branchScope,
          kind: memberships.kind,
          maxDiscountPct: memberships.maxDiscountPct,
          maxDiscountAmount: memberships.maxDiscountAmount,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      const tenantRow = await tx.execute(sql`SELECT code, name FROM tenants WHERE id = ${tenantId}::uuid`);
      const tenantInfo = (tenantRow as unknown as { rows: Array<{ code: string; name: string }> }).rows[0];

      // Sequential on purpose: a transaction owns a single connection, and issuing
      // concurrent queries on it is deprecated in `pg` (and unsafe in pg@9).
      const data: MembershipDto[] = [];
      for (const row of rows) {
        data.push(
          await toMembershipDto(tx, {
            id: row.id,
            tenantId: row.tenantId,
            tenantCode: tenantInfo?.code ?? '',
            tenantName: tenantInfo?.name ?? '',
            displayName: row.displayName,
            status: row.status,
            isOwner: row.isOwner,
            branchScope: row.branchScope,
            kind: row.kind,
            maxDiscountPct: row.maxDiscountPct,
            maxDiscountAmount: row.maxDiscountAmount,
          }),
        );
      }

      return { data, meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  /**
   * Invite by e-mail (PHASE_03 §5.5). The user record is created without a password and
   * flagged `must_change_password`; the invitation e-mail itself is a notification and
   * therefore lands in PHASE_04. A membership for an already-provisioned user is
   * activated immediately.
   */
  async create(tenantId: string, actorUserId: string, input: MembershipCreate): Promise<MembershipDto> {
    // P-C5: المستخدمون مقياسٌ محدود.
    await this.usage.assertWithinLimit(tenantId, 'users');
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existingUsers = await tx
        .select({ id: users.id, fullName: users.fullName, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);

      let userId: string;
      let fullName: string;
      if (existingUsers[0]) {
        userId = existingUsers[0].id;
        fullName = existingUsers[0].fullName;
      } else {
        userId = newId();
        fullName = input.fullName ?? input.email.split('@')[0] ?? 'Invited user';
        await tx.insert(users).values({
          id: userId,
          email: input.email,
          fullName,
          status: 'invited',
          passwordHash: null,
          mustChangePassword: true,
          createdAt: new Date(),
          createdBy: actorUserId,
        });
      }

      const duplicate = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, userId),
            isNull(memberships.deletedAt),
          ),
        )
        .limit(1);
      if (duplicate[0]) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'This user already has a membership in the tenant',
          400,
          { field: 'email' },
        );
      }

      const roleIds = await this.assertRolesExist(tx, input.roleIds);
      await this.assertNoOwnerRoleGrant(tx, tenantId, roleIds);

      const membershipId = newId();
      const isProvisioned = Boolean(existingUsers[0]?.passwordHash);
      await tx.insert(memberships).values({
        id: membershipId,
        tenantId,
        userId,
        displayName: input.displayName ?? fullName,
        branchScope: input.branchScope ?? null,
        maxDiscountPct: input.maxDiscountPct ?? null,
        maxDiscountAmount: input.maxDiscountAmount ?? null,
        status: isProvisioned ? 'active' : 'invited',
        isOwner: false,
        createdAt: new Date(),
        createdBy: actorUserId,
      });

      for (const roleId of roleIds) {
        await tx.insert(membershipRoles).values({ membershipId, roleId });
      }

      return this.readOne(tx, membershipId);
    });
  }

  async update(
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    input: MembershipUpdate,
  ): Promise<MembershipDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, membershipId);

      if (input.status && existing.isOwner && input.status !== 'active') {
        await this.assertNotLastOwner(tx, tenantId, membershipId);
      }
      if (input.roleIds) {
        const roleIds = await this.assertRolesExist(tx, input.roleIds);
        // AUD-02 — أدوار عضويّة المالك لا تُدار من هنا: القائمة الحالية تحوي دور المالك
        // نفسه، فتُرفض إعادة التشكيل (وكذلك أي محاولة لمنح دور المالك لعضو آخر).
        // الفحص الموسَّع ضروري: منع *منح* دور المالك لا يكفي، لأن إعادة تشكيل أدوار
        // العضويّة المالكة إلى [دورٍ مخصّص] **تنزع** دور المالك وتترك العضوية بلا
        // تحكّم كامل (أو تعيد توزيعه بصمت). الملكية تُنقل من مسار المنصّة المخصّص فقط.
        if (existing.isOwner) {
          throw new DomainError(
            errorCodes.OWNER_ROLE_NOT_ASSIGNABLE,
            'Roles of the owner membership are managed through the platform ownership-transfer flow',
            422,
            { field: 'roleIds' },
          );
        }
        await this.assertNoOwnerRoleGrant(tx, tenantId, roleIds);
        await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membershipId));
        for (const roleId of roleIds) {
          await tx.insert(membershipRoles).values({ membershipId, roleId });
        }
        // Drop scope rows of roles the membership no longer holds: a dangling scope
        // must never silently re-apply if the role is re-granted later.
        await tx
          .delete(membershipRoleScopes)
          .where(
            and(
              eq(membershipRoleScopes.membershipId, membershipId),
              sql`${membershipRoleScopes.roleId} NOT IN (${sql.join(
                roleIds.map((roleId) => sql`${roleId}::uuid`),
                sql`, `,
              )})`,
            ),
          );
      }

      const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: actorUserId };
      if (input.displayName !== undefined) updates.displayName = input.displayName;
      if (input.branchScope !== undefined) updates.branchScope = input.branchScope;
      if (input.status !== undefined) updates.status = input.status;
      // R1 — حدّ الخصم: `null` يُكتب صراحةً فلا يبقى حدٌّ قديم على عضوية أُفرغ حقله.
      if (input.maxDiscountPct !== undefined) updates.maxDiscountPct = input.maxDiscountPct;
      if (input.maxDiscountAmount !== undefined) updates.maxDiscountAmount = input.maxDiscountAmount;
      updates.version = sql`${memberships.version} + 1`;

      await tx.update(memberships).set(updates).where(eq(memberships.id, membershipId));
      return this.readOne(tx, membershipId);
    });
  }

  async remove(tenantId: string, actorUserId: string, membershipId: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, membershipId);
      if (existing.isOwner) {
        await this.assertNotLastOwner(tx, tenantId, membershipId);
      }
      await tx
        .update(memberships)
        .set({
          deletedAt: new Date(),
          deletedBy: actorUserId,
          status: 'suspended',
          updatedAt: new Date(),
          updatedBy: actorUserId,
        })
        .where(eq(memberships.id, membershipId));
    });
  }

  /** Isolation harness helper: reads a membership inside the caller's tenant only. */
  async read(tenantId: string, membershipId: string): Promise<MembershipDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => this.readOne(tx, membershipId));
  }

  /**
   * Per-role scope restrictions (2026-09 RBAC reorganisation).
   * Replace-all semantics: the submitted list becomes the membership's scopes.
   * Every scope must reference a role the membership actually holds.
   */
  async replaceScopes(
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    scopes: ReadonlyArray<{ roleId: string; scopeType: string; scopeId: string }>,
  ): Promise<MembershipDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, membershipId);
      const held = await tx
        .select({ roleId: membershipRoles.roleId })
        .from(membershipRoles)
        .where(eq(membershipRoles.membershipId, membershipId));
      const heldIds = new Set(held.map((row) => row.roleId));
      for (const scope of scopes) {
        if (!heldIds.has(scope.roleId)) {
          throw new DomainError(
            errorCodes.VALIDATION_FAILED,
            'Scopes can only restrict roles the membership holds',
            422,
            { field: 'scopes' },
          );
        }
      }
      await tx.delete(membershipRoleScopes).where(eq(membershipRoleScopes.membershipId, membershipId));
      for (const scope of scopes) {
        await tx.insert(membershipRoleScopes).values({
          membershipId,
          roleId: scope.roleId,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          createdAt: new Date(),
          createdBy: actorUserId,
        });
      }
      return this.readOne(tx, membershipId);
    });
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(tx: DrizzleTx, tenantId: string, membershipId: string) {
    const rows = await tx
      .select({
        id: memberships.id,
        isOwner: memberships.isOwner,
        tenantId: memberships.tenantId,
        tenantCode: sql<string>`''`,
        tenantName: sql<string>`''`,
        displayName: memberships.displayName,
        status: memberships.status,
        branchScope: memberships.branchScope,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenantId, tenantId),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      // A row belonging to another tenant is indistinguishable from a missing row
      // (MULTI_TENANCY §7.1: cross-tenant read must be a 404).
      throw new DomainError(errorCodes.NOT_FOUND, 'Membership not found', 404);
    }
    return row;
  }

  private async readOne(tx: DrizzleTx, membershipId: string): Promise<MembershipDto> {
    const rows = await tx
      .select({
        id: memberships.id,
        tenantId: memberships.tenantId,
        tenantCode: sql<string>`(SELECT code FROM tenants WHERE id = ${memberships.tenantId})`,
        tenantName: sql<string>`(SELECT name FROM tenants WHERE id = ${memberships.tenantId})`,
        displayName: memberships.displayName,
        status: memberships.status,
        isOwner: memberships.isOwner,
        branchScope: memberships.branchScope,
        kind: memberships.kind,
        maxDiscountPct: memberships.maxDiscountPct,
        maxDiscountAmount: memberships.maxDiscountAmount,
      })
      .from(memberships)
      // A soft-deleted membership must read as missing, exactly like a foreign tenant's
      // row (MULTI_TENANCY §7.1).
      .where(and(eq(memberships.id, membershipId), isNull(memberships.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new DomainError(errorCodes.NOT_FOUND, 'Membership not found', 404);
    }
    return toMembershipDto(tx, row);
  }

  /**
   * AUD-02 — دور المالك (`owner`) لا يُمنح ولا يُعاد تشكيله من مسارات إدارة العضويّات.
   *
   * `MembershipsService.create()/update()` كانت تتحقق من **وجود** الأدوار فقط، ودور
   * المالك يحمل كل الصلاحيات (`*` في البذرة، وكل الرموز الكنسية في مسار إنشاء العميل)،
   * فكان حامل `tenant.membership.manage` يستطيع أن يمنح نفسه أو غيره تحكّماً كاملاً
   * على المنشأة — أي تجاوزاً كاملاً لسقف صلاحياته. نقل الملكية له مسار مستقلّ مصرّح
   * به ومدقّق في لوحة المنصّة (`POST /platform/tenants/:id/owner/transfer`).
   *
   * يُعرَّف دور المالك تعريفين معاً حتى لا يعتمد الحارس على اسمٍ قابل للتغيير:
   *   1. دور نظامي (`is_system`) اسمه `Owner` — الشكل الذي تُنشئه البذرة وأدوار الأساس؛
   *   2. أي دور تحمله عضويّةٌ `is_owner = true` فعلاً — فالعضويّة المالكة هي مصدر الحقيقة.
   */
  private async assertNoOwnerRoleGrant(
    tx: DrizzleTx,
    tenantId: string,
    roleIds: readonly string[],
  ): Promise<void> {
    if (roleIds.length === 0) return;

    const granted = await tx
      .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem })
      .from(roles)
      .where(
        and(
          inArray(roles.id, [...roleIds]),
          eq(roles.tenantId, tenantId),
          isNull(roles.deletedAt),
        ),
      );

    const heldByOwner = await tx
      .select({ roleId: membershipRoles.roleId })
      .from(membershipRoles)
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.isOwner, true),
          isNull(memberships.deletedAt),
        ),
      );
    const ownerRoleIds = new Set(heldByOwner.map((row) => row.roleId));

    const offending = granted.filter(
      (role) => ownerRoleIds.has(role.id) || (role.isSystem && role.name.toLowerCase() === 'owner'),
    );
    if (offending.length > 0) {
      throw new DomainError(
        errorCodes.OWNER_ROLE_NOT_ASSIGNABLE,
        'The owner role is managed through the platform ownership-transfer flow, not here',
        422,
        { field: 'roleIds' },
      );
    }
  }

  private async assertRolesExist(tx: DrizzleTx, roleIds: readonly string[]): Promise<string[]> {
    const found = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(inArray(roles.id, [...roleIds]), isNull(roles.deletedAt)));
    if (found.length !== roleIds.length) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'One or more roles do not exist in this tenant',
        422,
        { field: 'roleIds' },
      );
    }
    return found.map((row) => row.id);
  }

  private async assertNotLastOwner(tx: DrizzleTx, tenantId: string, membershipId: string): Promise<void> {
    const [row] = await tx
      .select({ value: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.isOwner, true),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      );
    if ((row?.value ?? 0) <= 1) {
      void membershipId;
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'A tenant must keep at least one active owner membership',
        422,
        { field: 'status' },
      );
    }
  }
}
