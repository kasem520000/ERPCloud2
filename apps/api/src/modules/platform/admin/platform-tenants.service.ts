import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditActions,
  DomainError,
  errorCodes,
  platformSettingAllowsScope,
  platformSettingDefaultMap,
  platformSettingDefinitions,
  platformSettingsForScope,
  tenantBrandingKeys,
  tenantAuditActions,
  tenantFlagLabels,
  validatePlatformSettingValue,
  type PlatformSettingView,
  type PlatformTenantDetailResponse,
  type PlatformTenantHealthResponse,
  type PlatformTenantMember,
  type PlatformTenantOverview,
  type PlatformTenantPatch,
  type PlatformTenantSubscription,
  type PlatformTenantUsageResponse,
  type TenantBrandingResponse,
  type TenantBrandingUpdate,
  type TenantFlagsResponse,
  type TenantFlagView,
  type TenantNoteView,
  type TenantSettingUpdate,
  type TenantSettingsResponse,
} from '@erp/contracts';
import { tenantSettingsRegistry } from '@erp/config';
import {
  newId,
  platformSettings,
  tenantNotes,
  tenantSettings,
  withPlatformAdminTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { UsageService } from '../../usage/usage.service.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';

/**
 * P-C2 — «العملاء في العمق»: the service behind `/platform/tenants/:id/*`.
 *
 * Four rules, and every method follows them:
 *
 * 1. **Everything runs inside `withPlatformAdminTx`**, so the `platform_admin_plane`
 *    policies apply and the customer's own session can never reach these reads.
 * 2. **Every write is audited with the customer as the row's tenant** — a suspension is
 *    part of *that customer's* history as much as it is part of the platform's. The audit
 *    label is resolved explicitly (`users.full_name`), because an operator has no
 *    membership in the tenant they are acting on (`AuditService.resolveActorLabel` only
 *    knows memberships).
 * 3. **jsonb is read as text and parsed once.** `platform_settings.value` and
 *    `tenant_settings.value` are jsonb, and the mapper re-parses stored *strings* that
 *    look like JSON — the P-C1 defect. Colours and urls are exactly that kind of value.
 * 4. **A tenant that does not exist is a 404 on every route**, including writes; the
 *    queries prove it before any row is touched.
 */

const METRIC_LABELS: Record<string, string> = {
  users: 'المستخدمون',
  branches: 'الفروع',
  invoices_per_month: 'فواتير الشهر',
};

const LIMIT_KEYS = {
  users: 'limits.max_users',
  branches: 'limits.max_branches',
  invoices_per_month: 'limits.max_invoices_per_month',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PlatformTenantsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    /**
     * عدّادٌ واحد لكل الأسطح (P-C5). تُحقن الخدمة مباشرةً — لا عبر الوحدة — لأن الوحدة
     * عالمية أصلاً (`@Global`) ولأن هذا الملف لا يعرف غيرها من `UsageModule`.
     */
    private readonly usageEngine: UsageService,
  ) {}

  // --------------------------------------------------------------------- detail

  /** `GET /platform/tenants/:id` — the card: overview, members, licence history. */
  async detail(tenantId: string): Promise<PlatformTenantDetailResponse> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const { overview, noteCount } = await this.overviewInTx(tx, tenantId);

      const members = await tx.execute(sql`
        SELECT m.id AS membership_id, u.id AS user_id, u.email, u.full_name,
               m.display_name, u.status, m.status AS membership_status, m.kind,
               m.is_owner, u.last_login_at,
               (SELECT count(*) FROM membership_roles mr WHERE mr.membership_id = m.id)::int AS role_count
          FROM memberships m
          JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId} AND m.deleted_at IS NULL
         ORDER BY m.is_owner DESC, m.created_at ASC
         LIMIT 200
      `);

      const subscriptions = await this.subscriptionsInTx(tx, tenantId);

      return {
        tenant: overview,
        members: members.rows.map((row) => this.toMember(row)),
        subscriptions,
        noteCount,
      };
    });
  }

  /**
   * `GET /platform/tenants/:id/usage` — what the customer consumes, and the limit.
   *
   * **P-C5 moved the counting to one engine.** This route used to count three metrics and
   * read three limits by itself; the console's `/usage` grid, the tenant surface and the
   * six enforcement hooks all read `UsageService` — so a second counter here would be a
   * second truth, and the numbers would drift. The route is now a **projection** of the
   * engine's snapshot into the card's shape (all eight metrics, with the state fields the
   * tab shows), plus `invoicesPerDay`: this tab's own chart, which is not one of the eight.
   */
  async usage(tenantId: string): Promise<PlatformTenantUsageResponse> {
    // 404s for an unknown customer inside the engine, exactly as it did before.
    const snapshot = await this.usageEngine.snapshotForPlatform(tenantId);

    const series = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx.execute(sql`
        SELECT d::date AS day, COALESCE(c.n, 0)::int AS count
          FROM generate_series(date_trunc('day', now()) - interval '29 days',
                               date_trunc('day', now()), interval '1 day') d
          LEFT JOIN (
            SELECT date_trunc('day', created_at) AS day, count(*) AS n
              FROM sales_invoices
             WHERE tenant_id = ${tenantId}
               AND created_at >= date_trunc('day', now()) - interval '29 days'
             GROUP BY 1
          ) c ON c.day = d
         ORDER BY d ASC
      `),
    );

    return {
      tenantId,
      metrics: snapshot.metrics.map((metric) => ({
        key: metric.key,
        labelAr: metric.labelAr,
        used: metric.used,
        limit: metric.limit,
        limitSource: metric.limitSource,
        percentUsed: metric.percentUsed,
        // المقاييس الشهرية وحدها لها بداية فترة تُعرض؛ التراكمية واليومية بلا بداية.
        periodStart: metric.period === 'month' ? snapshot.periodStart : null,
        unitAr: metric.unitAr,
        period: metric.period,
        state: metric.state,
        enforced: metric.enforced,
        noticeAr: metric.noticeAr,
        enforcedAtAr: metric.enforcedAtAr,
      })),
      invoicesPerDay: series.rows.map((entry) => ({
        day: String(entry.day).slice(0, 10),
        count: Number(entry.count ?? 0),
      })),
      generatedAt: snapshot.generatedAt,
    };
  }

  /** `GET /platform/tenants/:id/health` — the «الصحة» tab, from real tables only. */
  async health(tenantId: string): Promise<PlatformTenantHealthResponse> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const { overview } = await this.overviewInTx(tx, tenantId);

      const outbox = await tx.execute(sql`
        SELECT status, count(*)::int AS n
          FROM outbox_jobs WHERE tenant_id = ${tenantId} GROUP BY status
      `);
      const counts = { pending: 0, published: 0, dead: 0 } as Record<string, number>;
      for (const entry of outbox.rows) counts[String(entry.status)] = Number(entry.n ?? 0);

      const failures = await tx.execute(sql`
        SELECT max(updated_at) AS last_failure FROM outbox_jobs
         WHERE tenant_id = ${tenantId} AND status = 'dead'
      `);

      const limits = await this.effectiveLimitsInTx(tx, tenantId);
      const usage = await tx.execute(sql`
        SELECT
          (SELECT count(*) FROM memberships m WHERE m.tenant_id = ${tenantId} AND m.deleted_at IS NULL)::int AS users,
          (SELECT count(*) FROM branches b WHERE b.tenant_id = ${tenantId} AND b.deleted_at IS NULL)::int AS branches
      `);
      const usedRow = usage.rows[0] ?? {};

      const findings: PlatformTenantHealthResponse['findings'] = [];
      const periodEnd = overview.subscription?.currentPeriodEnd ?? null;
      const daysToEnd = periodEnd ? Math.ceil((Date.parse(periodEnd) - Date.now()) / DAY_MS) : null;

      let subscriptionState: PlatformTenantHealthResponse['subscriptionState'] = 'none';
      const status = overview.subscription?.status;
      if (status === 'active') subscriptionState = daysToEnd !== null && daysToEnd <= 7 ? 'ending_soon' : 'active';
      else if (status === 'past_due') subscriptionState = 'past_due';
      else if (status === 'canceled') subscriptionState = 'cancelled';

      if (subscriptionState === 'none') findings.push({ severity: 'warn', text: 'لا يوجد اشتراك فعّال لهذا العميل.' });
      if (subscriptionState === 'past_due') findings.push({ severity: 'danger', text: 'الترخيص متأخر السداد.' });
      if (subscriptionState === 'cancelled') findings.push({ severity: 'warn', text: 'الترخيص ملغى.' });
      if (subscriptionState === 'ending_soon')
        findings.push({ severity: 'warn', text: `تنتهي فترة الترخيص خلال ${daysToEnd} يوم.` });
      if ((counts.dead ?? 0) > 0)
        findings.push({ severity: 'danger', text: `${counts.dead} مهمة فشلت نهائياً في الطابور.` });
      if (overview.status === 'suspended') findings.push({ severity: 'warn', text: 'الحساب موقوف.' });
      for (const [key, limitKey] of Object.entries(LIMIT_KEYS) as Array<[keyof typeof LIMIT_KEYS, string]>) {
        const limit = limits[key];
        const used = Number(usedRow[key] ?? 0);
        if (limit.value !== null && used >= limit.value) {
          findings.push({
            severity: 'warn',
            text: `${METRIC_LABELS[key]} بلغ الحدّ (${used} من ${limit.value}) — ${limitKey}.`,
          });
        }
      }
      if (overview.lastActivityAt === null) findings.push({ severity: 'info', text: 'لا نشاط مسجَّل لهذا العميل بعد.' });

      const highest = findings.some((finding) => finding.severity === 'danger')
        ? 'critical'
        : findings.some((finding) => finding.severity === 'warn')
          ? 'attention'
          : 'ok';

      return {
        tenantId,
        status: highest,
        subscriptionState,
        currentPeriodEnd: periodEnd,
        outbox: {
          pending: counts.pending ?? 0,
          published: counts.published ?? 0,
          dead: counts.dead ?? 0,
          lastFailureAt: iso(failures.rows[0]?.last_failure),
        },
        lastActivityAt: overview.lastActivityAt,
        lastLoginAt: overview.lastLoginAt,
        findings,
      };
    });
  }

  // --------------------------------------------------------------------- writes

  /** `PATCH /platform/tenants/:id` — name · code · timezone · currency. */
  async patch(tenantId: string, patch: PlatformTenantPatch): Promise<PlatformTenantOverview> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.assertTenant(tx, tenantId);

      if (patch.code !== undefined && patch.code !== current.code) {
        const clash = await tx.execute(sql`
          SELECT 1 FROM tenants WHERE lower(code) = lower(${patch.code}) AND id <> ${tenantId} LIMIT 1
        `);
        if (clash.rows.length > 0) {
          // A literal code, the way the accounting module does it: `errorCodes` is the
          // shared vocabulary, and a module-specific conflict names itself.
          throw new DomainError('TENANT_CODE_TAKEN', `الرمز «${patch.code}» مستخدم لعميل آخر`, 409, {
            field: 'code',
          });
        }
      }

      // The audit diff names the fields the same way the API does (`baseCurrency`, not
      // `base_currency`), because it is read by humans, not by the mapper.
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const field of ['name', 'code', 'timezone', 'currency'] as const) {
        const value = patch[field];
        if (value === undefined) continue;
        const key = field === 'currency' ? 'baseCurrency' : field;
        before[key] = (current as unknown as Record<string, unknown>)[key];
        after[key] = field === 'currency' ? String(value).toUpperCase() : value;
      }

      await tx.execute(sql`
        UPDATE tenants SET
          name = COALESCE(${patch.name ?? null}, name),
          code = COALESCE(${patch.code ?? null}, code),
          timezone = COALESCE(${patch.timezone ?? null}, timezone),
          base_currency = COALESCE(${patch.currency ? patch.currency.toUpperCase() : null}, base_currency),
          updated_at = now(),
          updated_by = ${auth.userId}
        WHERE id = ${tenantId}
      `);

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: 'update',
        entity: 'tenant',
        entityId: tenantId,
        before,
        after,
        meta: { scope: 'platform_console' },
      });

      return (await this.overviewInTx(tx, tenantId)).overview;
    });
  }

  /** `POST /platform/tenants/:id/status` — suspend/reactivate/archive **with a reason**. */
  async setStatus(
    tenantId: string,
    input: { status: 'active' | 'suspended' | 'archived'; reason: string },
  ): Promise<PlatformTenantOverview> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.assertTenant(tx, tenantId);
      if (current.status === input.status) {
        throw new DomainError('TENANT_STATUS_UNCHANGED', `حالة العميل هي «${input.status}» بالفعل`, 409, {
          field: 'status',
        });
      }

      await tx.execute(sql`
        UPDATE tenants SET status = ${input.status}, updated_at = now(), updated_by = ${auth.userId}
         WHERE id = ${tenantId}
      `);

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: tenantAuditActions.STATUS,
        entity: 'tenant',
        entityId: tenantId,
        before: { status: current.status },
        after: { status: input.status },
        // The reason is the point of the endpoint: a month later «لماذا؟» must be answerable.
        meta: { scope: 'platform_console', reason: input.reason },
      });

      return (await this.overviewInTx(tx, tenantId)).overview;
    });
  }

  /**
   * `POST /platform/tenants/:id/owner/transfer` — move ownership to an existing member.
   *
   * Only one membership per tenant may be the owner (the desktop's notion of «مالك الحساب»),
   * and the target must already belong to the tenant: the console never invites users, it
   * only hands the keys to someone who is already inside.
   */
  async transferOwner(
    tenantId: string,
    input: { membershipId: string; reason: string },
  ): Promise<PlatformTenantOverview> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);

      const target = await tx.execute(sql`
        SELECT m.id, m.is_owner, m.status, u.email, u.full_name
          FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.id = ${input.membershipId} AND m.tenant_id = ${tenantId} AND m.deleted_at IS NULL
         LIMIT 1
      `);
      const targetRow = target.rows[0];
      if (!targetRow) {
        throw new DomainError(errorCodes.NOT_FOUND, 'العضو المطلوب ليس ضمن هذا العميل', 404, {
          field: 'membershipId',
        });
      }
      if (targetRow.is_owner === true) {
        throw new DomainError('TENANT_OWNER_UNCHANGED', 'هذا العضو هو المالك الحالي', 409, {
          field: 'membershipId',
        });
      }
      if (String(targetRow.status) !== 'active') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'لا يمكن نقل الملكية إلى عضو غير نشط', 422, {
          field: 'membershipId',
        });
      }

      const previousOwner = await tx.execute(sql`
        SELECT m.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId} AND m.is_owner AND m.deleted_at IS NULL LIMIT 1
      `);

      await tx.execute(sql`
        UPDATE memberships SET is_owner = false, updated_at = now()
         WHERE tenant_id = ${tenantId} AND is_owner AND deleted_at IS NULL
      `);
      await tx.execute(sql`
        UPDATE memberships SET is_owner = true, updated_at = now() WHERE id = ${input.membershipId}
      `);

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: tenantAuditActions.OWNER_TRANSFER,
        entity: 'membership',
        entityId: input.membershipId,
        before: { ownerMembershipId: previousOwner.rows[0]?.id ?? null, ownerEmail: previousOwner.rows[0]?.email ?? null },
        after: { ownerMembershipId: input.membershipId, ownerEmail: String(targetRow.email) },
        meta: { scope: 'platform_console', reason: input.reason },
      });

      return (await this.overviewInTx(tx, tenantId)).overview;
    });
  }

  // ---------------------------------------------------------------------- notes

  /** `GET /platform/tenants/:id/notes` — newest first. */
  async listNotes(tenantId: string): Promise<{ items: TenantNoteView[]; total: number }> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);
      const rows = await tx
        .select({
          id: tenantNotes.id,
          body: tenantNotes.body,
          authorUserId: tenantNotes.authorUserId,
          authorLabel: tenantNotes.authorLabel,
          createdAt: tenantNotes.createdAt,
        })
        .from(tenantNotes)
        .where(eq(tenantNotes.tenantId, tenantId))
        .orderBy(sql`${tenantNotes.createdAt} DESC`)
        .limit(200);

      return {
        items: rows.map((row) => ({
          id: row.id,
          body: row.body,
          authorUserId: row.authorUserId,
          authorLabel: row.authorLabel,
          createdAt: row.createdAt.toISOString(),
        })),
        total: rows.length,
      };
    });
  }

  /** `POST /platform/tenants/:id/notes` — one note, authored by the operator. */
  async addNote(tenantId: string, input: { body: string }): Promise<TenantNoteView> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);
      const id = newId();
      const authorLabel = await this.actorLabel(tx, auth.userId);

      await tx.insert(tenantNotes).values({
        id,
        tenantId,
        body: input.body,
        authorUserId: auth.userId,
        authorLabel: authorLabel ?? '',
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: auth.userId,
        actorLabel: authorLabel,
        action: tenantAuditActions.NOTE,
        entity: 'tenant_note',
        entityId: id,
        after: { body: input.body },
        meta: { scope: 'platform_console' },
      });

      return {
        id,
        body: input.body,
        authorUserId: auth.userId,
        authorLabel: authorLabel ?? '',
        createdAt: new Date().toISOString(),
      };
    });
  }

  /**
   * `DELETE /platform/tenants/:id/notes/:noteId` — remove a note written by mistake.
   *
   * The plan lists `GET/POST` only; the delete is added because a note is free text typed
   * by a human and «لا يمكن التراجع» is not a defensible rule for a note about a customer.
   * The audit row keeps the body in `before`, so removing a note removes it from the tab,
   * not from the record.
   */
  async deleteNote(tenantId: string, noteId: string): Promise<{ deleted: true; id: string }> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);
      const rows = await tx
        .select({ id: tenantNotes.id, body: tenantNotes.body })
        .from(tenantNotes)
        .where(and(eq(tenantNotes.id, noteId), eq(tenantNotes.tenantId, tenantId)))
        .limit(1);

      if (!rows[0]) {
        throw new DomainError(errorCodes.NOT_FOUND, 'الملاحظة غير موجودة', 404);
      }

      await tx.delete(tenantNotes).where(eq(tenantNotes.id, noteId));

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: auditActions.DELETE,
        entity: 'tenant_note',
        entityId: noteId,
        before: { body: rows[0].body },
        meta: { scope: 'platform_console' },
      });

      return { deleted: true as const, id: noteId };
    });
  }

  // ------------------------------------------------------------------ settings

  /**
   * `GET /platform/tenants/:id/settings` — the tenant-scoped half of the catalogue.
   *
   * Three answers per key, and the screen needs all three: what the customer's own row
   * says (`tenant`), what the platform default says (`platform`), or the catalogue default
   * (`default`). «هل هي موروثة أم متجاوزة؟» is the only question this tab exists to answer.
   */
  async listSettings(tenantId: string): Promise<TenantSettingsResponse> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);
      const rows = await this.readPlatformSettings(tx, tenantId);
      const definitions = platformSettingsForScope('tenant');

      const settings: PlatformSettingView[] = definitions.map((definition) => {
        const tenantRow = rows.get(`${tenantId}:${definition.key}`);
        const platformRow = rows.get(`platform:${definition.key}`);
        const value = tenantRow
          ? (JSON.parse(tenantRow.raw) as PlatformSettingView['value'])
          : platformRow
            ? (JSON.parse(platformRow.raw) as PlatformSettingView['value'])
            : definition.defaultValue;
        const source: PlatformSettingView['source'] = tenantRow ? 'tenant' : platformRow ? 'platform' : 'default';
        return {
          key: definition.key,
          labelAr: definition.labelAr,
          labelEn: definition.labelEn,
          kind: definition.kind,
          helpAr: definition.helpAr,
          value,
          isDefault: source === 'default',
          source,
          updatedAt: (tenantRow ?? platformRow)?.updatedAt?.toISOString() ?? null,
          updatedBy: (tenantRow ?? platformRow)?.updatedBy ?? null,
        };
      });

      return { tenantId, settings };
    });
  }

  /**
   * `PUT /platform/tenants/:id/settings/:key` — write one override for one customer.
   *
   * `value: null` **removes** the override and hands the customer back to the platform
   * default. Without that, "go back to the default" would be impossible to express and an
   * operator would have to guess the current platform value.
   */
  async updateSetting(
    tenantId: string,
    key: string,
    input: TenantSettingUpdate,
  ): Promise<TenantSettingsResponse> {
    const auth = getAuthContext();
    await withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);

      if (!platformSettingAllowsScope(key, 'tenant')) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `المفتاح «${key}» ليس إعداداً لعميل`, 422, {
          field: 'key',
        });
      }

      const definition = platformSettingDefinitions.find((entry) => entry.key === key);
      const rows = await this.readPlatformSettings(tx, tenantId);
      const previousRow = rows.get(`${tenantId}:${key}`);
      const platformRow = rows.get(`platform:${key}`);
      const previousValue = previousRow
        ? (JSON.parse(previousRow.raw) as unknown)
        : platformRow
          ? (JSON.parse(platformRow.raw) as unknown)
          : (platformSettingDefaultMap()[key] ?? null);

      if (input.value === null) {
        await tx
          .delete(platformSettings)
          .where(and(eq(platformSettings.tenantId, tenantId), eq(platformSettings.key, key)));
      } else {
        const validated = validatePlatformSettingValue(key, input.value);
        if (!validated.ok) {
          throw new DomainError(errorCodes.VALIDATION_FAILED, `${key}: ${validated.reason}`, 422, { field: 'value' });
        }

        const existing = await tx
          .select({ id: platformSettings.id, version: platformSettings.version })
          .from(platformSettings)
          .where(and(eq(platformSettings.tenantId, tenantId), eq(platformSettings.key, key)))
          .limit(1);

        if (existing[0]) {
          await tx
            .update(platformSettings)
            .set({
              value: validated.value,
              updatedAt: new Date(),
              updatedBy: auth.userId,
              version: existing[0].version + 1,
            })
            .where(eq(platformSettings.id, existing[0].id));
        } else {
          await tx.insert(platformSettings).values({
            id: newId(),
            tenantId,
            key,
            value: validated.value,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          });
        }
      }

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: tenantAuditActions.SETTING,
        entity: 'tenant_setting',
        entityId: `${tenantId}:${key}`,
        before: { value: previousValue },
        after: { value: input.value },
        meta: { scope: 'tenant', key, kind: definition?.kind ?? 'unknown' },
      });
    });

    return this.listSettings(tenantId);
  }

  // --------------------------------------------------------------------- flags

  /** `GET /platform/tenants/:id/flags` — `feature.*` of the tenant settings registry. */
  async listFlags(tenantId: string): Promise<TenantFlagsResponse> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);
      const stored = await this.readTenantSettings(tx, tenantId, 'feature.%');

      const flags: TenantFlagView[] = tenantSettingsRegistry
        .filter((definition) => definition.key.startsWith('feature.'))
        .map((definition) => {
          const row = stored.get(definition.key);
          const labels = tenantFlagLabels[definition.key];
          return {
            key: definition.key,
            labelAr: labels?.labelAr ?? definition.key,
            labelEn: definition.key.replace('feature.', ''),
            descriptionAr: labels?.descriptionAr ?? definition.description,
            enabled: row ? JSON.parse(row.raw) === true : definition.defaultValue === true,
            isDefault: row === undefined,
            updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
          };
        });

      return { tenantId, flags };
    });
  }

  /** `PUT /platform/tenants/:id/flags` — flip feature packs for one customer. */
  async updateFlags(tenantId: string, values: Record<string, boolean>): Promise<TenantFlagsResponse> {
    const auth = getAuthContext();
    const entries = Object.entries(values);
    if (entries.length === 0) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'لم تُرسَل أي راية', 422);
    }
    for (const [key] of entries) {
      const definition = tenantSettingsRegistry.find((entry) => entry.key === key);
      if (!definition || !key.startsWith('feature.')) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `راية غير معروفة: ${key}`, 422, { field: key });
      }
    }

    await withPlatformAdminTx(this.database.db, async (tx) => {
      await this.assertTenant(tx, tenantId);
      const stored = await this.readTenantSettings(tx, tenantId, 'feature.%');
      const actorLabel = await this.actorLabel(tx, auth.userId);

      for (const [key, enabled] of entries) {
        const definition = tenantSettingsRegistry.find((entry) => entry.key === key);
        const defaultOf = definition?.defaultValue === true;
        const before = stored.get(key);
        const beforeValue = before ? JSON.parse(before.raw) === true : defaultOf;

        // A row is needed only when the requested value *differs* from the registry default.
        // Skip when the stored state already produces what was asked for — and only then:
        // skipping a row that merely repeats the default would leave the «القيمة الافتراضية»
        // claim (`isDefault`) permanently false.
        const shouldHaveRow = enabled !== defaultOf;
        if (beforeValue === enabled && (before !== undefined) === shouldHaveRow) continue;

        // Writing the registry's own default **removes** the row instead of storing a value
        // that equals it: `isDefault` is what the tab prints («القيمة الافتراضية»), and a row
        // that repeats the default would claim the operator chose it. It also keeps the
        // store free of rows that say nothing — the same rule the settings endpoint follows
        // with `value: null`.
        if (!shouldHaveRow) {
          await tx
            .delete(tenantSettings)
            .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, key)));
        } else {
          await tx
            .insert(tenantSettings)
            .values({ tenantId, key, value: enabled, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: [tenantSettings.tenantId, tenantSettings.key],
              set: { value: enabled, updatedAt: new Date() },
            });
        }

        await this.audit.recordInTx(tx, {
          tenantId,
          actorUserId: auth.userId,
          actorLabel,
          action: tenantAuditActions.FLAG,
          entity: 'tenant_flag',
          entityId: `${tenantId}:${key}`,
          before: { enabled: beforeValue },
          after: { enabled },
          meta: { scope: 'tenant', key },
        });
      }
    });

    return this.listFlags(tenantId);
  }

  // ------------------------------------------------------------------ branding

  /**
   * `GET /platform/tenants/:id/branding` — logo · colours · sender name.
   *
   * The three keys are stored in `platform_settings` as rows of *this customer*
   * (`tenant_id = :id`), which is the plan's «الإعدادات» table — not in the tenant settings
   * registry, whose `branding.primary_color` is the tenant's own runtime value. The two are
   * deliberately not merged here: 0066 gives a tenant read access to its own
   * `platform_settings` rows, so the customer's shell can adopt the operator's branding
   * without this part writing to a store the console does not own.
   */
  async readBranding(tenantId: string): Promise<TenantBrandingResponse> {
    const settings = await this.listSettings(tenantId);
    return this.brandingFrom(tenantId, settings);
  }

  /** `PUT /platform/tenants/:id/branding` — the three branding keys, validated as a set. */
  async updateBranding(tenantId: string, patch: TenantBrandingUpdate): Promise<TenantBrandingResponse> {
    const mapping: Array<[keyof TenantBrandingUpdate, string]> = [
      ['primaryColor', tenantBrandingKeys.primaryColor],
      ['logoUrl', tenantBrandingKeys.logoUrl],
      ['senderName', tenantBrandingKeys.senderName],
    ];
    const requested = mapping.filter(([field]) => patch[field] !== undefined);
    if (requested.length === 0) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'لم يُرسَل أي حقل من حقول الهوية', 422);
    }

    for (const [field, key] of requested) {
      const result = validatePlatformSettingValue(key, patch[field]);
      if (!result.ok) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `${key}: ${result.reason}`, 422, { field });
      }
      await this.updateSetting(tenantId, key, { value: result.value });
    }

    return this.readBranding(tenantId);
  }

  // ----------------------------------------------------------------- internals

  private brandingFrom(tenantId: string, settings: TenantSettingsResponse): TenantBrandingResponse {
    const pick = (key: string): { value: string; updatedAt: string | null; updatedBy: string | null } => {
      const row = settings.settings.find((entry) => entry.key === key);
      return {
        value: typeof row?.value === 'string' ? row.value : '',
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    };
    const color = pick(tenantBrandingKeys.primaryColor);
    const logo = pick(tenantBrandingKeys.logoUrl);
    const sender = pick(tenantBrandingKeys.senderName);
    const latest = [color, logo, sender]
      .filter((entry) => entry.updatedAt !== null)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];

    return {
      tenantId,
      primaryColor: color.value,
      logoUrl: logo.value,
      senderName: sender.value,
      updatedAt: latest?.updatedAt ?? null,
      updatedBy: latest?.updatedBy ?? null,
    };
  }

  /** `actors` — the operator has no membership in the customer's tenant. */
  private async actorLabel(tx: DrizzleTx, userId: string): Promise<string | null> {
    const rows = await tx.execute(sql`SELECT full_name FROM users WHERE id = ${userId} LIMIT 1`);
    const label = rows.rows[0]?.full_name;
    return label ? String(label) : null;
  }

  private async assertTenant(tx: DrizzleTx, tenantId: string): Promise<{ id: string; code: string; name: string; status: string }> {
    // A malformed uuid would be a Postgres cast error (500); the guard below turns it into 404.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new DomainError(errorCodes.NOT_FOUND, 'Tenant not found', 404);
    }
    const rows = await tx.execute(sql`
      SELECT id, code, name, status FROM tenants WHERE id = ${tenantId} LIMIT 1
    `);
    const row = rows.rows[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Tenant not found', 404);
    return { id: String(row.id), code: String(row.code), name: String(row.name), status: String(row.status) };
  }

  /** The card's overview — one round trip, and every counter the tab shows. */
  private async overviewInTx(
    tx: DrizzleTx,
    tenantId: string,
  ): Promise<{ overview: PlatformTenantOverview; noteCount: number }> {
    const result = await tx.execute(sql`
      SELECT t.id, t.code, t.name, t.status, t.base_currency, t.timezone, t.locale, t.country_code,
             t.created_at, t.updated_at,
             (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.deleted_at IS NULL)::int AS user_count,
             (SELECT count(*) FROM branches b WHERE b.tenant_id = t.id AND b.deleted_at IS NULL)::int AS branch_count,
             (SELECT count(*) FROM sales_invoices i
               WHERE i.tenant_id = t.id AND i.created_at >= now() - interval '30 days')::int AS invoices_30d,
             (SELECT count(*) FROM sales_invoices i WHERE i.tenant_id = t.id)::int AS invoices_lifetime,
             (SELECT max(a.created_at) FROM audit_log a WHERE a.tenant_id = t.id) AS last_activity_at,
             (SELECT max(u.last_login_at) FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.tenant_id = t.id AND m.deleted_at IS NULL) AS last_login_at,
             (SELECT count(*) FROM tenant_notes n WHERE n.tenant_id = t.id)::int AS note_count
        FROM tenants t WHERE t.id = ${tenantId} LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Tenant not found', 404);

    const owner = await tx.execute(sql`
      SELECT m.id AS membership_id, u.id AS user_id, u.email, m.display_name, m.status, u.last_login_at
        FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ${tenantId} AND m.is_owner AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC LIMIT 1
    `);
    const ownerRow = owner.rows[0];

    const subscriptions = await this.subscriptionsInTx(tx, tenantId);
    const active = subscriptions.find((entry) => entry.status === 'active') ?? subscriptions[0] ?? null;

    const overview: PlatformTenantOverview = {
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      status: String(row.status) as PlatformTenantOverview['status'],
      baseCurrency: String(row.base_currency).trim(),
      timezone: String(row.timezone),
      locale: String(row.locale),
      countryCode: String(row.country_code).trim(),
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      updatedAt: iso(row.updated_at) ?? iso(row.created_at) ?? new Date().toISOString(),
      userCount: Number(row.user_count ?? 0),
      branchCount: Number(row.branch_count ?? 0),
      invoicesLast30Days: Number(row.invoices_30d ?? 0),
      invoicesLifetime: Number(row.invoices_lifetime ?? 0),
      lastActivityAt: iso(row.last_activity_at),
      lastLoginAt: iso(row.last_login_at),
      owner: ownerRow
        ? {
            membershipId: String(ownerRow.membership_id),
            userId: String(ownerRow.user_id),
            email: String(ownerRow.email),
            displayName: String(ownerRow.display_name),
            status: String(ownerRow.status),
            lastLoginAt: iso(ownerRow.last_login_at),
          }
        : null,
      subscription: active,
    };

    return { overview, noteCount: Number(row.note_count ?? 0) };
  }

  private async subscriptionsInTx(tx: DrizzleTx, tenantId: string): Promise<PlatformTenantSubscription[]> {
    const result = await tx.execute(sql`
      SELECT s.id, s.status, s.activated_at, s.current_period_end, s.canceled_at, s.created_at,
             p.code AS plan_code, p.name AS plan_name, p.amount::text AS amount, p.currency, p.interval
        FROM tenant_subscriptions s
        LEFT JOIN billing_plans p ON p.id = s.plan_id
       WHERE s.tenant_id = ${tenantId}
       ORDER BY (s.status = 'active') DESC, s.created_at DESC
       LIMIT 50
    `);
    return result.rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      planCode: row.plan_code ? String(row.plan_code) : null,
      planName: row.plan_name ? String(row.plan_name) : null,
      amount: row.amount ? String(row.amount) : null,
      currency: row.currency ? String(row.currency) : null,
      interval: row.interval ? String(row.interval) : null,
      startedAt: iso(row.activated_at),
      currentPeriodEnd: iso(row.current_period_end),
      cancelledAt: iso(row.canceled_at),
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
    }));
  }

  private toMember(row: Record<string, unknown>): PlatformTenantMember {
    return {
      membershipId: String(row.membership_id),
      userId: String(row.user_id),
      email: String(row.email),
      fullName: String(row.full_name),
      displayName: String(row.display_name),
      status: String(row.status),
      membershipStatus: String(row.membership_status),
      kind: String(row.kind),
      isOwner: row.is_owner === true,
      lastLoginAt: iso(row.last_login_at),
      roleCount: Number(row.role_count ?? 0),
    };
  }

  /**
   * Effective limits: the customer's own row wins, then the platform-wide row, then the
   * catalogue default (which is what P-C1 wrote and P-C2 reads back).
   */
  private async effectiveLimitsInTx(
    tx: DrizzleTx,
    tenantId: string,
  ): Promise<Record<keyof typeof LIMIT_KEYS, { value: number | null; source: 'tenant' | 'platform' | 'default' }>> {
    const rows = await this.readPlatformSettings(tx, tenantId);
    const defaults = platformSettingDefaultMap();
    const result = {} as Record<keyof typeof LIMIT_KEYS, { value: number | null; source: 'tenant' | 'platform' | 'default' }>;

    for (const [metric, key] of Object.entries(LIMIT_KEYS) as Array<[keyof typeof LIMIT_KEYS, string]>) {
      const tenantRow = rows.get(`${tenantId}:${key}`);
      const platformRow = rows.get(`platform:${key}`);
      const source: 'tenant' | 'platform' | 'default' = tenantRow ? 'tenant' : platformRow ? 'platform' : 'default';
      const raw = tenantRow ? tenantRow.raw : platformRow ? platformRow.raw : JSON.stringify(defaults[key] ?? null);
      const parsed = JSON.parse(raw) as unknown;
      result[metric] = { value: parsed === null ? null : Number(parsed), source };
    }
    return result;
  }

  /**
   * Every `platform_settings` row that can answer for this customer — its own rows and the
   * platform-wide ones — read as **text** (see the class docstring, rule 3).
   */
  private async readPlatformSettings(
    tx: DrizzleTx,
    tenantId: string,
  ): Promise<Map<string, { raw: string; updatedAt: Date | null; updatedBy: string | null }>> {
    const rows = await tx
      .select({
        tenantId: platformSettings.tenantId,
        key: platformSettings.key,
        raw: sql<string>`${platformSettings.value}::text`,
        updatedAt: platformSettings.updatedAt,
        updatedBy: platformSettings.updatedBy,
      })
      .from(platformSettings)
      .where(sql`${platformSettings.tenantId} IS NULL OR ${platformSettings.tenantId} = ${tenantId}`);

    return new Map(
      rows.map((row) => [
        `${row.tenantId ?? 'platform'}:${row.key}`,
        { raw: row.raw, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
      ]),
    );
  }

  /** `tenant_settings` rows of a pattern, again as text-then-parse-once. */
  private async readTenantSettings(
    tx: DrizzleTx,
    tenantId: string,
    pattern: string,
  ): Promise<Map<string, { raw: string; updatedAt: Date | null }>> {
    const rows = await tx
      .select({
        key: tenantSettings.key,
        raw: sql<string>`${tenantSettings.value}::text`,
        updatedAt: tenantSettings.updatedAt,
      })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), sql`${tenantSettings.key} LIKE ${pattern}`));

    return new Map(rows.map((row) => [row.key, { raw: row.raw, updatedAt: row.updatedAt ?? null }]));
  }
}

/**
 * A timestamptz column → ISO string, or NULL.
 *
 * Written as a helper because the audit columns (`created_at`/`updated_at` from
 * `baseAuditColumns`) are nullable in the schema, and `new Date('null').toISOString()`
 * throws `RangeError: Invalid time value` — which the HTTP layer would report as a 500 for
 * a tenant whose `updated_at` was simply never set (the demo tenant in a fresh database).
 */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
