import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  findPlatformRole,
  operatorAuditActions,
  platformDirectoryUserSchema,
  platformPermissionsForRoles,
  platformRoleCatalog,
  platformRoleMatrixEntrySchema,
  platformSessionViewSchema,
  type PlatformDirectoryUser,
  type PlatformOperatorInvite,
  type PlatformRoleMatrixEntry,
  type PlatformRolePermissionsResponse,
  type PlatformSessionView,
  type PlatformUserDetailResponse,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { PasswordService } from '../auth/password.service.js';
import { PlatformRolePermissionsService } from '../identity/platform-role-permissions.service.js';

/**
 * P-C3 — «الهوية والوصول على المنصة»: مَن يدير المنصّة، وبأي دور، وبأي جلسة.
 *
 * القواعد التي تتبعها كل دالة هنا:
 *
 * 1. **كل شيء داخل `withPlatformAdminTx`** — القراءة والكتابة عبر المستأجرين لا تكون إلا
 *    على مستوى المنصة (`platform_admin_plane`).
 * 2. **جلسة = عائلة دوران** لا صفًّا: `refresh_tokens` يُبدَّل عند كل تجديد ويُبقي `family`،
 *    فالعائلة هي «الجهاز»، وهي وحدها ما يُبطل. (`:id` في المسار هو `family`.)
 * 3. **الفعل على إنسان يحمل سببًا مكتوبًا** حين يكون مضرًّا أو كاشفًا لحماية: إبطال جلسة،
 *    وإعادة تعيين 2FA، وكتابة مصفوفة الأدوار. المنح/السحب يكتفي بالتدقيق بلا سبب.
 * 4. **لا نخترع كلمة مرور**: الدعوة بلا `temporaryPassword` تُنشئ حسابًا `invited` بلا كلمة
 *    مرور (نفس دلالة دعوة مالك المنشأة في `POST /platform/tenants`)، ويُقال ذلك صراحةً في
 *    الردّ بدل إيهام المشغّل بأن الحساب جاهز للدخول.
 */
@Injectable()
export class PlatformIdentityService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly rolePermissions: PlatformRolePermissionsService,
  ) {}

  // ------------------------------------------------------------------ directory

  /** `GET /platform/users` — دليل واحد يخدم الدعوة والبحث وبطاقة المستخدم. */
  async list(search?: string): Promise<PlatformDirectoryUser[]> {
    const like = search && search.trim().length > 0 ? `%${search.trim().toLowerCase()}%` : null;

    const rows = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx.execute(sql`
        SELECT u.id, u.email, u.full_name, u.status, u.is_platform_admin, u.must_change_password,
               u.mfa_enabled, u.last_login_at, u.created_at,
               (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id AND m.deleted_at IS NULL)::int AS membership_count,
               COALESCE((
                 SELECT jsonb_agg(pm.role_code ORDER BY pm.role_code)
                   FROM platform_memberships pm
                  WHERE pm.user_id = u.id AND pm.revoked_at IS NULL
               ), '[]'::jsonb) AS platform_roles,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', t.id, 'code', t.code, 'name', t.name, 'status', t.status,
                          'isOwner', m.is_owner) ORDER BY t.name)
                   FROM memberships m
                   JOIN tenants t ON t.id = m.tenant_id
                  WHERE m.user_id = u.id AND m.deleted_at IS NULL
               ), '[]'::jsonb) AS tenants,
               (SELECT COUNT(DISTINCT rt.family) FROM refresh_tokens rt
                 WHERE rt.user_id = u.id AND rt.revoked_at IS NULL AND rt.expires_at > now())::int
                 AS active_session_count
          FROM users u
         WHERE (${like}::text IS NULL OR lower(u.email) LIKE ${like} OR lower(u.full_name) LIKE ${like})
         ORDER BY u.created_at DESC
         LIMIT 500
      `),
    );

    return rows.rows.map((row) =>
      platformDirectoryUserSchema.parse({
        id: String(row.id),
        email: String(row.email),
        fullName: String(row.full_name),
        status: String(row.status),
        isPlatformAdmin: Boolean(row.is_platform_admin),
        mustChangePassword: Boolean(row.must_change_password),
        mfaEnabled: Boolean(row.mfa_enabled),
        lastLoginAt: iso(row.last_login_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        membershipCount: Number(row.membership_count ?? 0),
        platformRoles: (row.platform_roles as string[]) ?? [],
        tenants: (row.tenants as PlatformDirectoryUser['tenants']) ?? [],
        activeSessionCount: Number(row.active_session_count ?? 0),
      }),
    );
  }

  // ------------------------------------------------------------------ the card

  /** `GET /platform/users/:id` — هو، وأدواره (فعّالة ومسحوبة)، وعضوياته، وجلساته. */
  async detail(userId: string): Promise<PlatformUserDetailResponse> {
    assertUuid(userId);

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const usersRows = await tx.execute(sql`
        SELECT id, email, phone, full_name, status, is_platform_admin, must_change_password,
               mfa_enabled, (mfa_secret_enc IS NOT NULL) AS mfa_enrolled,
               last_login_at, locked_until, created_at, updated_at
          FROM users WHERE id = ${userId}
      `);
      const row = usersRows.rows[0];
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المستخدم غير موجود', 404);

      const roleRows = await tx.execute(sql`
        SELECT role_code, revoked_at FROM platform_memberships
         WHERE user_id = ${userId} ORDER BY role_code, granted_at
      `);
      const activeRoles = roleRows.rows.filter((entry) => entry.revoked_at === null).map((entry) => String(entry.role_code));
      const revokedRoles = roleRows.rows.filter((entry) => entry.revoked_at !== null).map((entry) => String(entry.role_code));

      const memberRows = await tx.execute(sql`
        SELECT m.id, m.tenant_id, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status,
               m.display_name, m.status, m.is_owner, m.created_at
          FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ${userId} AND m.deleted_at IS NULL
         ORDER BY m.created_at
      `);

      const sessions = await this.sessionsInTx(tx, { userId });

      return {
        user: {
          id: String(row.id),
          email: String(row.email),
          phone: (row.phone as string | null) ?? null,
          fullName: String(row.full_name),
          status: String(row.status),
          isPlatformAdmin: Boolean(row.is_platform_admin),
          mustChangePassword: Boolean(row.must_change_password),
          mfaEnabled: Boolean(row.mfa_enabled),
          mfaEnrolled: Boolean(row.mfa_enrolled),
          lastLoginAt: iso(row.last_login_at),
          lockedUntil: iso(row.locked_until),
          createdAt: iso(row.created_at) ?? new Date().toISOString(),
          updatedAt: iso(row.updated_at),
        },
        platformRoles: activeRoles,
        revokedPlatformRoles: revokedRoles,
        memberships: memberRows.rows.map((member) => ({
          id: String(member.id),
          tenantId: String(member.tenant_id),
          tenantCode: String(member.tenant_code),
          tenantName: String(member.tenant_name),
          tenantStatus: String(member.tenant_status),
          displayName: String(member.display_name),
          status: String(member.status),
          isOwner: Boolean(member.is_owner),
          createdAt: iso(member.created_at) ?? new Date().toISOString(),
        })),
        sessions,
      };
    });
  }

  // ------------------------------------------------------------------ sessions

  /** عائلة دوران واحدة — تُستعمل من البطاقة (`userId`) ومن مسار الجلسة (`family`). */
  private async sessionsInTx(
    tx: DrizzleTx,
    filter: { userId?: string; family?: string },
  ): Promise<PlatformSessionView[]> {
    const rows = await tx.execute(sql`
      SELECT rt.family, rt.user_id, u.email, u.full_name,
             (array_agg(rt.tenant_id ORDER BY rt.created_at DESC))[1] AS tenant_id,
             (array_agg(t.code ORDER BY rt.created_at DESC))[1] AS tenant_code,
             (array_agg(rt.ip ORDER BY rt.created_at DESC))[1] AS ip,
             (array_agg(rt.user_agent ORDER BY rt.created_at DESC))[1] AS user_agent,
             min(rt.created_at) AS created_at,
             max(rt.created_at) AS last_seen_at,
             max(rt.expires_at) AS expires_at,
             CASE WHEN count(*) FILTER (WHERE rt.revoked_at IS NULL) = 0 THEN max(rt.revoked_at) END AS revoked_at,
             count(*)::int AS rotation_count
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        LEFT JOIN tenants t ON t.id = rt.tenant_id
       WHERE (${filter.userId ?? null}::uuid IS NULL OR rt.user_id = ${filter.userId ?? null})
         AND (${filter.family ?? null}::uuid IS NULL OR rt.family = ${filter.family ?? null})
       GROUP BY rt.family, rt.user_id, u.email, u.full_name
       ORDER BY max(rt.created_at) DESC
       LIMIT 200
    `);

    return rows.rows.map((row) =>
      platformSessionViewSchema.parse({
        id: String(row.family),
        userId: String(row.user_id),
        userEmail: String(row.email),
        userFullName: String(row.full_name),
        tenantId: row.tenant_id ? String(row.tenant_id) : null,
        tenantCode: row.tenant_code ? String(row.tenant_code) : null,
        ip: row.ip ? String(row.ip) : null,
        userAgent: row.user_agent ? String(row.user_agent) : null,
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        lastSeenAt: iso(row.last_seen_at) ?? new Date().toISOString(),
        expiresAt: iso(row.expires_at) ?? new Date().toISOString(),
        revokedAt: iso(row.revoked_at),
        revoked: row.revoked_at !== null,
        rotationCount: Number(row.rotation_count ?? 0),
      }),
    );
  }

  /** `GET /platform/sessions/:id` — الجلسة بعائلتها. */
  async session(sessionId: string): Promise<PlatformSessionView> {
    assertUuid(sessionId);
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await this.sessionsInTx(tx, { family: sessionId });
      const session = rows[0];
      if (!session) throw new DomainError(errorCodes.NOT_FOUND, 'الجلسة غير موجودة', 404);
      return session;
    });
  }

  /**
   * `DELETE /platform/sessions/:id` — إبطال العائلة كلها.
   *
   * إبطال عائلة بعينها لا «كل جلسات المستخدم»: المشغّل يرى الأجهزة بأعمدتها (الآيبي والجهاز
   * وآخر ظهور) فيختار. ولو أراد الكل، فذلك تكرارٌ للفعل لا فعلٌ ثانٍ.
   */
  async revokeSession(sessionId: string, reason: string): Promise<PlatformSessionView> {
    assertUuid(sessionId);
    const auth = getAuthContext();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await this.sessionsInTx(tx, { family: sessionId });
      const session = rows[0];
      if (!session) throw new DomainError(errorCodes.NOT_FOUND, 'الجلسة غير موجودة', 404);

      const updated = await tx.execute(sql`
        UPDATE refresh_tokens SET revoked_at = now()
         WHERE family = ${sessionId} AND revoked_at IS NULL
        RETURNING id
      `);

      await this.audit.recordInTx(tx, {
        tenantId: session.tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: operatorAuditActions.SESSION_REVOKE,
        entity: 'refresh_token_family',
        entityId: sessionId,
        before: { revoked: false, rotations: session.rotationCount, lastSeenAt: session.lastSeenAt },
        after: { revoked: true, revokedRows: updated.rows.length, userId: session.userId },
        meta: { scope: 'platform_console', reason },
      });

      const after = await this.sessionsInTx(tx, { family: sessionId });
      return after[0] ?? { ...session, revoked: true, revokedAt: new Date().toISOString() };
    });
  }

  // ------------------------------------------------------------------ invite

  /**
   * `POST /platform/operators/invite` — إنشاء/إعادة استخدام حساب، ومنحه دور المنصة.
   *
   * - حساب موجود بنفس البريد يُعاد استعماله (لا مستخدمَين ببريد واحد) — ويُكتَب ذلك في الردّ.
   * - الدور يُمنح بنفس دلالة `POST /platform/users/:id/roles` (إحياء صفٍّ مسحوب لا تكراره).
   * - `active` فقط عند وصول كلمة مرور مؤقّتة؛ وإلا فالحساب `invited` بلا كلمة مرور.
   */
  async inviteOperator(input: PlatformOperatorInvite): Promise<PlatformDirectoryUser> {
    const auth = getAuthContext();
    const role = findPlatformRole(input.roleCode);
    if (!role) {
      // Same split as the rest of this surface: a well-formed body naming a role that does not
      // exist is `422`, not `400` (see the grant route this console has answered since P-C1).
      throw new DomainError(errorCodes.VALIDATION_FAILED, `دور منصة غير معروف: ${input.roleCode}`, 422, {
        field: 'roleCode',
      });
    }
    const roleName = role.nameAr;

    if (input.temporaryPassword) {
      this.passwords.assertPolicy(input.temporaryPassword, { email: input.email });
    }
    const passwordHash = input.temporaryPassword
      ? await this.passwords.hash(input.temporaryPassword)
      : undefined;

    const userId = await withPlatformAdminTx(this.database.db, async (tx) => {
      const existing = await tx.execute(sql`SELECT id, status FROM users WHERE email = ${input.email} LIMIT 1`);
      const found = existing.rows[0];

      let id: string;
      let action = 'invited';
      if (found) {
        id = String(found.id);
        action = 'reused';
        if (passwordHash) {
          await tx.execute(sql`
            UPDATE users SET password_hash = ${passwordHash}, status = 'active',
                             must_change_password = true, password_changed_at = now(),
                             updated_at = now(), updated_by = ${auth.userId}
             WHERE id = ${id}
          `);
        }
      } else {
        id = newId();
        await tx.execute(sql`
          INSERT INTO users (id, email, full_name, status, password_hash, must_change_password, created_by)
          VALUES (${id}, ${input.email}, ${input.fullName}, ${passwordHash ? 'active' : 'invited'},
                  ${passwordHash ?? null}, true, ${auth.userId})
        `);
      }

      const granted = await tx.execute(sql`
        INSERT INTO platform_memberships (id, user_id, role_code, granted_by)
        VALUES (${newId()}, ${id}, ${input.roleCode}, ${auth.userId})
        ON CONFLICT (user_id, role_code)
          DO UPDATE SET revoked_at = NULL, granted_at = now(), granted_by = ${auth.userId}
        RETURNING id
      `);

      // A platform role opens `/platform/*` but cannot produce a token on its own:
      // `POST /auth/login` always signs *into* a tenant, so the operator needs a home
      // membership. That home is the operations tenant the seed creates under
      // `PLATFORM_TENANT_CODE` (default `platform`); we attach it here so «دعوة مشغّل»
      // ends with a person who can actually sign in. No tenant role is granted — the
      // console is reached through `console.*`, not through tenant permissions.
      const homeTenant = await this.attachHomeTenant(tx, {
        userId: id,
        fullName: input.fullName,
        actorUserId: auth.userId,
      });

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: operatorAuditActions.INVITE,
        entity: 'platform_operator',
        entityId: id,
        after: {
          email: input.email,
          fullName: input.fullName,
          roleCode: input.roleCode,
          status: passwordHash ? 'active' : 'invited',
          account: action,
          // Both doors leave the account owing a change: `invited` because it has no password
          // yet, and `active` because the password the administrator typed is temporary —
          // `POST /auth/change-password` is what clears the flag.
          mustChangePassword: true,
          homeTenant,
        },
        meta: {
          scope: 'platform_console',
          ...(input.reason ? { reason: input.reason } : {}),
          roleName,
          grantRowId: String(granted.rows[0]?.id ?? ''),
        },
      });

      return id;
    });

    const directory = await this.list(input.email);
    const created = directory.find((entry) => entry.id === userId);
    if (!created) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة الحساب بعد الدعوة', 500);
    return created;
  }

  // ------------------------------------------------------------------ roles

  /** `GET /platform/roles` — المصفوفة: ما ينصّ عليه الفهرس، وما هو فعّال، ومن يحمل الدور. */
  async roleMatrix(): Promise<PlatformRoleMatrixEntry[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const overrides = await this.rolePermissions.readInTx(tx);
      const counts = await tx.execute(sql`
        SELECT role_code, COUNT(*)::int AS holder_count
          FROM platform_memberships WHERE revoked_at IS NULL GROUP BY role_code
      `);
      const holders = new Map(counts.rows.map((row) => [String(row.role_code), Number(row.holder_count ?? 0)]));

      return platformRoleCatalog.map((role) => {
        const effective = platformPermissionsForRoles([role.code], overrides);
        return platformRoleMatrixEntrySchema.parse({
          code: role.code,
          name: role.nameEn,
          nameAr: role.nameAr,
          description: role.description,
          catalogPermissions: [...role.permissions],
          permissions: effective,
          overridden: Object.prototype.hasOwnProperty.call(overrides, role.code),
          holderCount: holders.get(role.code) ?? 0,
        });
      });
    });
  }

  /** `PUT /platform/roles/:code/permissions` — كتابة مجموعة الدور كاملة بسبب، ثم تدقيقها. */
  async setRolePermissions(
    roleCode: string,
    permissions: readonly string[],
    reason: string,
  ): Promise<PlatformRolePermissionsResponse> {
    if (!findPlatformRole(roleCode)) {
      throw new DomainError(errorCodes.NOT_FOUND, `دور منصة غير معروف: ${roleCode}`, 404);
    }
    const auth = getAuthContext();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const catalogue = [...(findPlatformRole(roleCode)?.permissions ?? [])];
      const before = await this.rolePermissions.readInTx(tx);
      const beforeEffective = platformPermissionsForRoles([roleCode], before);

      const result = await this.rolePermissions.writeInTx(tx, roleCode, permissions, auth.userId);

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: operatorAuditActions.PERMISSIONS_UPDATE,
        entity: 'platform_role',
        entityId: roleCode,
        before: { permissions: beforeEffective, overridden: Object.prototype.hasOwnProperty.call(before, roleCode) },
        after: { permissions: result.effective, overridden: result.overridden },
        meta: {
          scope: 'platform_console',
          reason,
          // القائمتان لا تكفيان بعد شهر: الفرق هو ما يُقرأ.
          ...this.rolePermissions.diffFor(roleCode, result.effective),
          catalogue: catalogue.length,
        },
      });

      return {
        roleCode,
        permissions: result.effective,
        catalogPermissions: catalogue,
        overridden: result.overridden,
      };
    });
  }

  // ------------------------------------------------------------------ roles on a user

  /** `POST /platform/users/:id/roles` — منح دور (مع تدقيق، وسبب اختياري). */
  async grantRole(userId: string, roleCode: string, reason?: string) {
    assertUuid(userId);
    if (!findPlatformRole(roleCode)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, `دور منصة غير معروف: ${roleCode}`, 422, {
        field: 'roleCode',
      });
    }
    const auth = getAuthContext();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const user = await tx.execute(sql`SELECT id, email FROM users WHERE id = ${userId} LIMIT 1`);
      const row = user.rows[0];
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المستخدم غير موجود', 404);

      const granted = await tx.execute(sql`
        INSERT INTO platform_memberships (id, user_id, role_code, granted_by)
        VALUES (${newId()}, ${userId}, ${roleCode}, ${auth.userId})
        ON CONFLICT (user_id, role_code)
          DO UPDATE SET revoked_at = NULL, granted_at = now(), granted_by = ${auth.userId}
        RETURNING id, role_code, granted_at
      `);

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: operatorAuditActions.ROLE_GRANT,
        entity: 'platform_membership',
        entityId: userId,
        after: { roleCode, email: String(row.email) },
        meta: { scope: 'platform_console', ...(reason ? { reason } : {}) },
      });

      return {
        id: String(granted.rows[0]?.id),
        userId,
        roleCode,
        grantedAt: iso(granted.rows[0]?.granted_at),
      };
    });
  }

  /** `DELETE /platform/users/:id/roles/:roleCode` — سحب دور. */
  async revokeRole(userId: string, roleCode: string, reason?: string) {
    assertUuid(userId);
    const auth = getAuthContext();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const revoked = await tx.execute(sql`
        UPDATE platform_memberships SET revoked_at = now()
         WHERE user_id = ${userId} AND role_code = ${roleCode} AND revoked_at IS NULL
        RETURNING id, user_id, role_code, revoked_at
      `);
      if (revoked.rows.length === 0) {
        throw new DomainError(errorCodes.NOT_FOUND, 'لا يوجد منح فعّال لهذا الدور', 404);
      }

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: operatorAuditActions.ROLE_REVOKE,
        entity: 'platform_membership',
        entityId: userId,
        before: { roleCode, revoked: false },
        after: { roleCode, revoked: true },
        meta: { scope: 'platform_console', ...(reason ? { reason } : {}) },
      });

      return {
        id: String(revoked.rows[0]?.id),
        userId,
        roleCode,
        revokedAt: iso(revoked.rows[0]?.revoked_at),
      };
    });
  }

  // ------------------------------------------------------------------ 2FA

  /** `POST /platform/users/:id/mfa/reset` — إبطال 2FA بيد المشغّل، وبسبب مكتوب. */
  async resetMfa(userId: string, reason: string) {
    assertUuid(userId);
    const auth = getAuthContext();

    const detail = await this.detail(userId);
    const { hadMfa } = await this.mfa.resetForAdmin(userId);

    await withPlatformAdminTx(this.database.db, async (tx) => {
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: operatorAuditActions.MFA_RESET,
        entity: 'platform_operator',
        entityId: userId,
        before: { mfaEnabled: detail.user.mfaEnabled, enrolled: detail.user.mfaEnrolled },
        after: { mfaEnabled: false, enrolled: false, hadMfa },
        meta: { scope: 'platform_console', reason, email: detail.user.email },
      });
    });

    return { userId, hadMfa, mfaEnabled: false, mfaEnrolled: false };
  }

  // ------------------------------------------------------------------ helpers

  /**
   * «وطن» المشغّل: المنشأة التي يدخل منها إلى المنصة.
   *
   * `POST /auth/login` يسجّل الدخول **إلى منشأة** دائمًا، ومنح دور منصة لا يكفي للحصول على
   * رمز. المنشأة القياسية للمشغّلين ينشئها البذرة بـ`PLATFORM_TENANT_CODE` (افتراضًا
   * `platform`)، فنربط الحساب المدعوّ بها بعضوية بلا أدوار: الرؤية تأتي من `platform_*`
   * لا من صلاحيات المنشأة. وإن لم تكن المنشأة موجودة (تثبيت بلا بذرة) تُنجَح الدعوة كما
   * هي ويبقى الربط مهمّة `PATCH /platform/tenants/:id/...` لاحقًا — لا نُنشئ منشأة سرًّا.
   */
  private async attachHomeTenant(
    tx: DrizzleTx,
    input: { userId: string; fullName: string; actorUserId: string },
  ): Promise<{ code: string; attached: boolean } | null> {
    const code = process.env.PLATFORM_TENANT_CODE?.trim() || 'platform';
    const found = await tx.execute(sql`SELECT id FROM tenants WHERE code = ${code} LIMIT 1`);
    const tenantId = found.rows[0]?.id;
    if (!tenantId) return { code, attached: false };

    // No `app.tenant_id` juggling: `memberships` carries a `platform_admin_plane` policy
    // (migration 0020) that admits the control plane for any tenant, and `withPlatformAdminTx`
    // already turned that plane on — the same door `PATCH /platform/tenants/:id` uses.
    await tx.execute(sql`
      INSERT INTO memberships (id, tenant_id, user_id, display_name, status, is_owner, kind, created_by)
      VALUES (${newId()}, ${String(tenantId)}, ${input.userId}, ${input.fullName}, 'active', false, 'staff',
              ${input.actorUserId})
      ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL
        DO UPDATE SET status = 'active', updated_at = now(), updated_by = ${input.actorUserId}
    `);
    return { code, attached: true };
  }

  /** اسم الفاعل: المشغّل ليس عضوًا في المنشأة التي يعمل عليها، فالعضوية لا تعرفه. */
  private async actorLabel(tx: DrizzleTx, userId: string | undefined): Promise<string> {
    if (!userId) return 'النظام';
    const rows = await tx.execute(sql`SELECT full_name FROM users WHERE id = ${userId} LIMIT 1`);
    return String(rows.rows[0]?.full_name ?? 'مدير المنصة');
  }
}

// -------------------------------------------------------------------- helpers

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'معرّف غير صالح', 400, { field: 'id' });
  }
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
