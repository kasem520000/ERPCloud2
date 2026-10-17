import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  ALL_PERMISSIONS,
  DomainError,
  canonicalizePermissionCode,
  errorCodes,
  findPermission,
  permissionRegistry,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle } from '@erp/database';
import { baselineRoles } from '@erp/config';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { PasswordService } from '../auth/password.service.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';

import { applyPlanFeaturePacks } from './pack-entitlements.js';

/**
 * Platform (SaaS) control plane — the part the desktop product never had.
 *
 * Everything here reads or writes ACROSS tenants and is therefore only reachable behind
 * `PlatformAdminGuard`. Queries run inside `withPlatformAdminTx`, which binds
 * `app.is_platform_admin` for the transaction so the policies added by migration 0020
 * match; the tenant GUC stays unset, so a bug in a predicate returns nothing rather than
 * the wrong tenant's rows.
 */

export type TenantSummary = {
  id: string;
  code: string;
  name: string;
  status: string;
  baseCurrency: string;
  timezone: string;
  createdAt: string;
  userCount: number;
  branchCount: number;
  subscriptionStatus: string | null;
  planName: string | null;
  planAmount: string | null;
  currentPeriodEnd: string | null;
};

export type CreateTenantInput = {
  code: string;
  name: string;
  baseCurrency?: string;
  timezone?: string;
  countryCode?: string;
  ownerEmail: string;
  ownerFullName: string;
  /** Optional: when omitted the owner is created as `invited` with no password. */
  ownerPassword?: string;
  planId?: string;
};

export type SignupInput = {
  companyName: string;
  code?: string;
  ownerFullName: string;
  ownerEmail: string;
  ownerPassword: string;
  planId?: string;
  phone?: string;
  countryCode?: string;
  baseCurrency?: string;
  timezone?: string;
};

/**
 * Derives a URL-safe tenant code from a company name. Arabic names carry no ASCII, so a
 * short random suffix keeps the code unique and always valid.
 */
function slugifyTenantCode(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base.length >= 2 ? `${base}-${suffix}` : `t-${suffix}`;
}

function assertPlatformAdmin(): void {
  if (!getAuthContext().isPlatformAdmin) {
    throw new DomainError(errorCodes.FORBIDDEN, 'platform-admin plane requires is_platform_admin', 403);
  }
}

@Injectable()
export class PlatformAdminService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- overview

  async overview() {
    assertPlatformAdmin();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const tenants = await tx.execute(sql`
        SELECT
          COUNT(*)::int                                              AS total,
          COUNT(*) FILTER (WHERE status = 'active')::int             AS active,
          COUNT(*) FILTER (WHERE status = 'suspended')::int          AS suspended,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d
        FROM tenants
        WHERE lower(code) NOT IN ('platform', 'platform-ops')
      `);
      const subscriptions = await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int    AS active,
          COUNT(*) FILTER (WHERE status = 'past_due')::int  AS past_due,
          COUNT(*) FILTER (WHERE status = 'canceled')::int  AS canceled,
          COALESCE(SUM(p.amount) FILTER (WHERE s.status = 'active' AND p.interval = 'month'), 0)::text AS mrr
        FROM tenant_subscriptions s
        JOIN billing_plans p ON p.id = s.plan_id
      `);
      const pending = await tx.execute(sql`SELECT COUNT(*)::int AS pending FROM activation_requests WHERE status = 'pending'`);
      const users = await tx.execute(sql`
        SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'active')::int AS active FROM users
      `);

      return {
        tenants: tenants.rows[0] ?? { total: 0, active: 0, suspended: 0, new_30d: 0 },
        subscriptions: subscriptions.rows[0] ?? { active: 0, past_due: 0, canceled: 0, mrr: '0' },
        pendingActivations: (pending.rows[0]?.pending as number) ?? 0,
        users: users.rows[0] ?? { total: 0, active: 0 },
      };
    });
  }

  // ----------------------------------------------------------------- tenants

  async listTenants(search?: string, status?: string): Promise<TenantSummary[]> {
    assertPlatformAdmin();
    const like = search && search.trim().length > 0 ? `%${search.trim().toLowerCase()}%` : null;
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          t.id, t.code, t.name, t.status, t.base_currency, t.timezone, t.created_at,
          (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id AND m.deleted_at IS NULL)::int AS user_count,
          (SELECT COUNT(*) FROM branches b WHERE b.tenant_id = t.id AND b.deleted_at IS NULL)::int   AS branch_count,
          s.status                AS subscription_status,
          p.name                  AS plan_name,
          p.amount::text          AS plan_amount,
          s.current_period_end
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT * FROM tenant_subscriptions ts
          WHERE ts.tenant_id = t.id
          ORDER BY (ts.status = 'active') DESC, ts.created_at DESC
          LIMIT 1
        ) s ON true
        LEFT JOIN billing_plans p ON p.id = s.plan_id
        WHERE lower(t.code) NOT IN ('platform', 'platform-ops')
          AND (${like}::text IS NULL OR lower(t.code) LIKE ${like} OR lower(t.name) LIKE ${like})
          AND (${status ?? null}::text IS NULL OR t.status = ${status ?? null})
        ORDER BY t.created_at DESC
        LIMIT 500
      `);

      return result.rows.map((row) => ({
        id: String(row.id),
        code: String(row.code),
        name: String(row.name),
        status: String(row.status),
        baseCurrency: String(row.base_currency),
        timezone: String(row.timezone),
        createdAt: String(row.created_at),
        userCount: Number(row.user_count ?? 0),
        branchCount: Number(row.branch_count ?? 0),
        subscriptionStatus: row.subscription_status ? String(row.subscription_status) : null,
        planName: row.plan_name ? String(row.plan_name) : null,
        planAmount: row.plan_amount ? String(row.plan_amount) : null,
        currentPeriodEnd: row.current_period_end ? String(row.current_period_end) : null,
      }));
    });
  }

  /**
   * Creates a customer: tenant row, owner user, owner membership, the baseline role set
   * and — so the tenant is immediately usable — its default branch/warehouse/safe are
   * provisioned by the caller through `OrgProvisioningService`.
   */
  async createTenant(input: CreateTenantInput) {
    assertPlatformAdmin();
    return this.provisionTenant(input, { subscription: 'active' });
  }

  /**
   * Self-service signup — the نافذة الاشتراك the product was missing.
   *
   * Public on purpose (rate limited at the controller). A prospect creates the tenant and
   * the owner account themselves and can log in immediately, but the tenant starts WITHOUT
   * a licence: a pending `activation_requests` row is filed instead, and the platform
   * operator approves it from /platform/activation-requests. Nothing here can touch an
   * existing tenant: the code is rejected when taken and every write is inside the same
   * transaction, so a failure leaves no half-provisioned tenant behind.
   */
  async signup(input: SignupInput) {
    const name = input.companyName.trim();
    if (name.length < 2) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Company name is required', 422);
    }
    if (!input.ownerPassword) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'A password is required to sign up', 422);
    }

    const code = (input.code?.trim() || slugifyTenantCode(name)).toLowerCase();

    return this.provisionTenant(
      {
        code,
        name,
        baseCurrency: input.baseCurrency,
        timezone: input.timezone,
        countryCode: input.countryCode,
        ownerEmail: input.ownerEmail,
        ownerFullName: input.ownerFullName,
        ownerPassword: input.ownerPassword,
        planId: input.planId,
      },
      { subscription: 'requested' },
    );
  }

  /**
   * إنشاء ملف — a second company file created from inside an existing one.
   *
   * Deliberately provisioned like a self-service signup rather than like a console
   * action: the new file exists and its creator can log into it immediately, but it
   * starts **unlicensed** with a pending activation request. A tenant permission must
   * never be able to mint licensed tenants, or the subscription is decorative.
   */
  async provisionCompanyFile(input: CreateTenantInput) {
    return this.provisionTenant(input, { subscription: 'requested' });
  }

  /** Shared provisioning path: console-created tenants and self-service signups. */
  private async provisionTenant(
    input: CreateTenantInput,
    options: { subscription: 'active' | 'requested' },
  ) {
    const code = input.code.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(code)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Tenant code must be 2–63 lowercase letters, digits or dashes', 422);
    }

    let passwordHash: string | undefined;
    if (input.ownerPassword) {
      this.passwords.assertPolicy(input.ownerPassword, { email: input.ownerEmail });
      passwordHash = await this.passwords.hash(input.ownerPassword);
    }

    const tenantId = newId();
    const userId = newId();
    const membershipId = newId();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const existing = await tx.execute(sql`SELECT id FROM tenants WHERE code = ${code}`);
      if (existing.rows.length > 0) {
        throw new DomainError(errorCodes.VERSION_CONFLICT, `Tenant code "${code}" is already taken`, 409);
      }

      await tx.execute(sql`
        INSERT INTO tenants (id, code, name, status, base_currency, timezone, country_code)
        VALUES (${tenantId}, ${code}, ${input.name.trim()}, 'active',
                ${input.baseCurrency ?? 'SAR'}, ${input.timezone ?? 'Asia/Riyadh'}, ${input.countryCode ?? 'SA'})
      `);

      // The tenant-scoped inserts below are governed by the canonical isolation policy,
      // so bind the new tenant for the rest of this transaction.
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);

      const userRow = await tx.execute(sql`
        INSERT INTO users (id, email, full_name, status, password_hash, must_change_password, password_changed_at)
        VALUES (${userId}, ${input.ownerEmail.trim().toLowerCase()}, ${input.ownerFullName.trim()},
                ${passwordHash ? 'active' : 'invited'}, ${passwordHash ?? null}, ${!passwordHash},
                ${passwordHash ? sql`now()` : sql`NULL`})
        ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
        RETURNING id
      `);
      const ownerUserId = String(userRow.rows[0]?.id ?? userId);

      await tx.execute(sql`
        INSERT INTO memberships (id, tenant_id, user_id, display_name, status, is_owner)
        VALUES (${membershipId}, ${tenantId}, ${ownerUserId}, ${input.ownerFullName.trim()}, 'active', true)
      `);

      // Baseline roles + permissions, identical to the seed path.
      for (const role of baselineRoles) {
        const roleId = newId();
        await tx.execute(sql`
          INSERT INTO roles (id, tenant_id, name, is_system, description)
          VALUES (${roleId}, ${tenantId}, ${role.name}, ${role.isSystem}, ${role.description})
        `);
        // `*` expands to canonical tenant codes only — never deprecated spellings
        // (deduped by construction) and never `console.*` (not in this registry).
        const codes = role.permissions.includes(ALL_PERMISSIONS)
          ? permissionRegistry.filter((entry) => !entry.deprecated).map((entry) => entry.code)
          : [
              ...new Set(
                role.permissions
                  .map((permission) => canonicalizePermissionCode(permission))
                  .filter((code) => findPermission(code) && !code.startsWith('console.')),
              ),
            ];
        for (const permission of codes) {
          await tx.execute(sql`
            INSERT INTO role_permissions (role_id, permission_code) VALUES (${roleId}, ${permission})
            ON CONFLICT DO NOTHING
          `);
        }
        if (role.code === 'owner') {
          await tx.execute(sql`
            INSERT INTO membership_roles (membership_id, role_id) VALUES (${membershipId}, ${roleId})
            ON CONFLICT DO NOTHING
          `);
          for (const scopeType of ['branch', 'warehouse', 'cash_location'] as const) {
            await tx.execute(sql`
              INSERT INTO membership_role_scopes (membership_id, role_id, scope_type, scope_id)
              VALUES (${membershipId}, ${roleId}, ${scopeType}, '00000000-0000-0000-0000-000000000000'::uuid)
              ON CONFLICT DO NOTHING
            `);
          }
        }
      }

      // A console-created tenant is licensed on the spot; a self-service signup only files
      // a request, so no prospect can grant themselves a licence.
      if (input.planId && options.subscription === 'active') {
        await tx.execute(sql`
          INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status, provider, activated_at, current_period_start)
          VALUES (${newId()}, ${tenantId}, ${input.planId}, 'active', 'manual', now(), now())
        `);
      }

      let activationRequestId: string | null = null;
      if (options.subscription === 'requested') {
        activationRequestId = newId();
        await tx.execute(sql`
          INSERT INTO activation_requests (id, tenant_id, requested_by, plan_id, status, notes)
          VALUES (${activationRequestId}, ${tenantId}, ${ownerUserId}, ${input.planId ?? null}, 'pending',
                  ${'Self-service signup'})
        `);
      }

      return {
        tenantId,
        tenantCode: code,
        ownerUserId,
        membershipId,
        ownerStatus: passwordHash ? 'active' : 'invited',
        subscriptionStatus: options.subscription === 'active' && input.planId ? 'active' : 'pending',
        activationRequestId,
      };
    });
  }

  // `setTenantStatus` was removed with its route: P-C2's `POST /platform/tenants/:id/status`
  // (`PlatformTenantsService.setStatus`) supersedes it — it demands a reason, refuses a
  // no-op transition, and writes an audit row in the customer's own trail.

  // Plans and licences (P-C4) moved to `PlatformBillingService`. What stayed here is the
  // activation queue: a *request* a customer made, which is a conversation, not a document.

  // ----------------------------------------------------------------- activation queue

  async listActivationRequests(status = 'pending') {
    assertPlatformAdmin();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        SELECT r.id, r.tenant_id, r.plan_id, r.status, r.notes, r.created_at,
               t.code AS tenant_code, t.name AS tenant_name,
               p.name AS plan_name, p.amount::text, p.currency,
               u.email AS requested_by_email
        FROM activation_requests r
        JOIN tenants t ON t.id = r.tenant_id
        LEFT JOIN billing_plans p ON p.id = r.plan_id
        LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.status = ${status}
        ORDER BY r.created_at ASC
        LIMIT 500
      `);
      return result.rows;
    });
  }

  async reviewActivation(requestId: string, approve: boolean, notes?: string) {
    assertPlatformAdmin();
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE activation_requests
        SET status = ${approve ? 'approved' : 'rejected'}, reviewed_by = ${auth.userId},
            reviewed_at = now(), notes = COALESCE(${notes ?? null}, notes), updated_at = now()
        WHERE id = ${requestId} AND status = 'pending'
        RETURNING id, tenant_id, plan_id, status
      `);
      const request = result.rows[0];
      if (!request) throw new DomainError(errorCodes.NOT_FOUND, 'Pending activation request was not found', 404);

      if (approve && request.plan_id) {
        // Approving is what P-C4's `POST /platform/subscriptions` does by hand, so it obeys the
        // same rule: **one live licence per customer**. The predicate is the live set of 0068
        // (`trialing` · `active` · `past_due` · `paused`) — without `trialing` and `paused` the
        // partial unique index would turn a second approval into a database error.
        await tx.execute(sql`
          UPDATE tenant_subscriptions
             SET status = 'canceled', canceled_at = now(),
                 canceled_reason = 'استُبدل بترخيص جديد', updated_at = now()
           WHERE tenant_id = ${String(request.tenant_id)}
             AND status = ANY(ARRAY['trialing', 'active', 'past_due', 'paused'])
        `);
        await tx.execute(sql`
          INSERT INTO tenant_subscriptions
            (id, tenant_id, plan_id, status, provider, activated_at, current_period_start, current_period_end)
          VALUES (${newId()}, ${String(request.tenant_id)}, ${String(request.plan_id)}, 'active', 'manual', now(), now(),
                  now() + interval '12 months')
        `);
        await tx.execute(sql`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = ${String(request.tenant_id)}`);
        // M7 — الموافقة على الطلب تفتح حزم الباقة فوراً: العميل دخل من نافذة الاشتراك
        // ليشتغل، لا لينتظر تقليب المشغّل للرايات بيده. فتحٌ تراكمي مع سجلّ تدقيق لكل حزمة.
        const planRows = await tx.execute(sql`SELECT code FROM billing_plans WHERE id = ${String(request.plan_id)} LIMIT 1`);
        const actorRows = await tx.execute(sql`SELECT full_name FROM users WHERE id = ${auth.userId} LIMIT 1`);
        await applyPlanFeaturePacks(tx, this.audit, {
          tenantId: String(request.tenant_id),
          planId: String(request.plan_id),
          planCode: String(planRows.rows[0]?.code ?? request.plan_id),
          actorUserId: auth.userId,
          actorLabel: String(actorRows.rows[0]?.full_name ?? 'مدير المنصة'),
        });
      }

      return request;
    });
  }
}
