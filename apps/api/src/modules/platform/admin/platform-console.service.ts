import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  findPlatformSettingDefinition,
  platformSettingAllowsScope,
  platformSettingsForScope,
  platformSettingDefaultMap,
  validatePlatformSettingValue,
  auditActions,
  parseFilters,
  type PlatformAuditEntry,
  type PlatformAuditQueryDto,
  type PlatformSettingView,
  type PlatformSettingsResponse,
  type PlatformTenantSearchResult,
} from '@erp/contracts';
import {
  auditLog,
  newId,
  outboxJobs,
  platformSettings,
  tenants,
  withPlatformAdminTx,
  type DatabaseHandle,
} from '@erp/database';
import { env } from '@erp/config';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';

/**
 * P-C1 — the console's own service: cross-tenant audit, platform settings and the Ctrl+K
 * tenant lookup.
 *
 * Three rules it never breaks:
 *
 * 1. **Every read runs inside `withPlatformAdminTx`** so the `platform_admin_plane`
 *    policies added by migration 0066 apply. The tenant GUC stays unset, so a predicate
 *    that forgets a tenant still returns rows from every tenant rather than silently the
 *    wrong one — the elevation is the point here, and the guard has already proved it.
 * 2. **Settings are validated against the shared catalogue** (`@erp/contracts`), so the
 *    screen and the API cannot disagree about what a key accepts.
 * 3. **Every write is audited** with a real before/after diff and the operator as actor —
 *    the platform settings are the one place where a mistake affects every customer.
 */

/** `NODE_ENV` → the badge the console shows. Labels are the Arabic names of the phases. */
const ENVIRONMENT_LABELS: Record<string, string> = {
  development: 'تطوير',
  test: 'اختبار',
  production: 'إنتاج',
};

@Injectable()
export class PlatformConsoleService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  /** The deployment the API is running as — shown next to the console title. */
  environment(): { name: string; labelAr: string } {
    const name = env.NODE_ENV;
    return { name, labelAr: ENVIRONMENT_LABELS[name] ?? name };
  }

  // ------------------------------------------------------------------- settings

  /**
   * `GET /platform/settings` — the catalogue joined with whatever has been written.
   *
   * A key with no row is *not* missing: it reports its catalogue default with
   * `isDefault: true`, so the screen shows the value the platform actually uses.
   */
  async listSettings(): Promise<PlatformSettingsResponse> {
    const rows = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .select({
          key: platformSettings.key,
          // Read the JSON **text** and parse it here, once.
          //
          // Reading the column directly is not safe for this table: the driver hands jsonb
          // back already parsed, and Drizzle's `jsonb` mapper parses a *string* value again,
          // so a stored string that happens to be valid JSON comes back as the wrong type —
          // `'920000000'` as a number, `'true'` as a boolean, `'{"x":1}'` as an object. A
          // phone number, a domain or a prefix is exactly that kind of value, and silently
          // changing its type would write nonsense into the screens and into API clients.
          raw: sql<string>`${platformSettings.value}::text`,
          updatedAt: platformSettings.updatedAt,
          updatedBy: platformSettings.updatedBy,
        })
        .from(platformSettings)
        .where(isNull(platformSettings.tenantId))
        .orderBy(asc(platformSettings.key)),
    );

    const stored = new Map(rows.map((row) => [row.key, row]));
    // Platform-scope keys only. The catalogue is shared with the tenant card
    // (`GET /platform/tenants/:id/settings`), and keys declared `['tenant']` — the three
    // `branding.*` keys P-C2 added — must not appear as writable platform-wide values.
    const settings: PlatformSettingView[] = platformSettingsForScope('platform').map((definition) => {
      const row = stored.get(definition.key);
      return {
        key: definition.key,
        labelAr: definition.labelAr,
        labelEn: definition.labelEn,
        kind: definition.kind,
        // الخيارات والحدود من الكتالوج نفسه — لا تُخترع في الشاشة ولا تُترك للتخمين.
        ...(definition.options ? { options: [...definition.options] } : {}),
        ...(definition.optionLabels ? { optionLabels: [...definition.optionLabels] } : {}),
        ...(definition.min !== undefined ? { min: definition.min } : {}),
        ...(definition.max !== undefined ? { max: definition.max } : {}),
        helpAr: definition.helpAr,
        value: row ? (JSON.parse(row.raw) as PlatformSettingView['value']) : definition.defaultValue,
        isDefault: row === undefined,
        // A platform-scoped read can only answer from the platform row or the catalogue:
        // `tenant` appears on `GET /platform/tenants/:id/settings` (P-C2).
        source: row === undefined ? 'default' : 'platform',
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        updatedBy: row?.updatedBy ?? null,
      };
    });

    return { settings, environment: this.environment() };
  }

  /**
   * `PUT /platform/settings` — upsert the keys the operator sent.
   *
   * One transaction for the whole batch and one audit row per key: a maintenance switch
   * that was flipped has to be readable as a *change*, and a generic "updated settings"
   * row would lose which key and which value.
   */
  async updateSettings(values: Record<string, unknown>): Promise<PlatformSettingsResponse> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'No settings were supplied', 422);
    }

    // Validate everything *before* opening the transaction: a bad key in a batch must not
    // leave the good half written.
    const validated = entries.map(([key, value]) => {
      const definition = findPlatformSettingDefinition(key);
      if (!definition) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `Unknown platform setting: ${key}`, 422, {
          field: key,
        });
      }
      if (!platformSettingAllowsScope(key, 'platform')) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `المفتاح «${key}» ليس إعداداً للمنصّة`, 422, {
          field: key,
        });
      }
      const result = validatePlatformSettingValue(key, value);
      if (!result.ok) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `${key}: ${result.reason}`, 422, {
          field: key,
        });
      }
      return { key, value: result.value };
    });

    const auth = getAuthContext();
    const defaults = platformSettingDefaultMap();

    await withPlatformAdminTx(this.database.db, async (tx) => {
      for (const entry of validated) {
        const before = await tx
          .select({
            id: platformSettings.id,
            version: platformSettings.version,
            // Same reason as `listSettings`: the raw text is the only faithful read.
            raw: sql<string>`${platformSettings.value}::text`,
          })
          .from(platformSettings)
          .where(and(isNull(platformSettings.tenantId), eq(platformSettings.key, entry.key)))
          .limit(1);
        const previous = before[0];

        if (previous) {
          await tx
            .update(platformSettings)
            .set({
              value: entry.value,
              updatedAt: new Date(),
              updatedBy: auth.userId,
              version: previous.version + 1,
            })
            .where(eq(platformSettings.id, previous.id));
        } else {
          await tx.insert(platformSettings).values({
            id: newId(),
            tenantId: null,
            key: entry.key,
            value: entry.value,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          });
        }

        await this.audit.recordInTx(tx, {
          // NULL tenant: a platform-wide setting is not any one customer's row.
          tenantId: null,
          actorUserId: auth.userId,
          action: auditActions.UPDATE,
          entity: 'platform_settings',
          entityId: entry.key,
          before: { value: previous ? JSON.parse(previous.raw) : defaults[entry.key] },
          after: { value: entry.value },
          meta: { scope: 'platform' },
        });
      }
    });

    return this.listSettings();
  }

  // ---------------------------------------------------------------------- audit

  /**
   * `GET /platform/audit` — the cross-tenant trail (`console.audit.view`).
   *
   * This is the endpoint the previous console pretended to have: `/audit` used to read
   * `GET /audit-log`, which is tenant-scoped, so an operator saw the *platform tenant's*
   * own rows and nothing else (INCOMPLETE_INVENTORY §4.2).
   *
   * Each row carries its customer's code and name, because "who did what" is useless in a
   * control plane without "for whom".
   */
  async listAudit(query: PlatformAuditQueryDto): Promise<{
    items: PlatformAuditEntry[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const filters = parseFilters(query.filter, [
      'tenantId',
      'actorUserId',
      'action',
      'entity',
      'entityId',
      'from',
      'to',
    ] as const);

    const conditions: SQL[] = [];
    if (filters.tenantId) conditions.push(eq(auditLog.tenantId, filters.tenantId));
    if (filters.actorUserId) conditions.push(eq(auditLog.actorUserId, filters.actorUserId));
    if (filters.action) conditions.push(eq(auditLog.action, filters.action));
    if (filters.entity) conditions.push(eq(auditLog.entity, filters.entity));
    if (filters.entityId) conditions.push(eq(auditLog.entityId, filters.entityId));
    if (filters.from) conditions.push(gte(auditLog.createdAt, parseDate(filters.from, 'from')));
    if (filters.to) conditions.push(lte(auditLog.createdAt, parseDate(filters.to, 'to')));

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const totalRow = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(where);

      const rows = await tx
        .select({
          id: auditLog.id,
          tenantId: auditLog.tenantId,
          tenantCode: tenants.code,
          tenantName: tenants.name,
          actorUserId: auditLog.actorUserId,
          actorLabel: auditLog.actorLabel,
          action: auditLog.action,
          entity: auditLog.entity,
          entityId: auditLog.entityId,
          before: auditLog.before,
          after: auditLog.after,
          meta: auditLog.meta,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(tenants, eq(tenants.id, auditLog.tenantId))
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return {
        items: rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          tenantCode: row.tenantCode ?? null,
          tenantName: row.tenantName ?? null,
          actorUserId: row.actorUserId,
          actorLabel: row.actorLabel,
          action: row.action,
          entity: row.entity,
          entityId: row.entityId,
          before: row.before ?? null,
          after: row.after ?? null,
          meta: (row.meta ?? {}) as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        })),
        total: totalRow[0]?.value ?? 0,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  // --------------------------------------------------------------------- jobs

  /**
   * `GET /platform/jobs/outbox` — the queue, across every customer.
   *
   * The console has shown a «المهام والطوابير» page since the 2026-09 separation, but it
   * read `GET /jobs/outbox`, which is tenant-scoped: an operator saw the *platform
   * tenant's* outbox — always `[]` — while `console.jobs.view` was one of the ten codes
   * declared and unused (INCOMPLETE_INVENTORY §4.2). The plan's P-C1 endpoint list does not
   * include this route; it is added because P-C1 is also «ترميم الصلاحيات», and a sidebar
   * item that opens a lying page is not repaired by a permission.
   *
   * Read-only on purpose: retrying and draining jobs is P-C9 (العمليات).
   */
  async listOutbox(query: { limit: number; offset: number; status?: string }): Promise<{
    items: Array<{
      id: string;
      tenantId: string;
      tenantCode: string | null;
      queue: string;
      type: string;
      status: string;
      attempts: number;
      lastError: string | null;
      createdAt: string;
      /**
       * P-C7: موعد التنفيذ. مهمّةُ نشرٍ مجدولة لا معنى لصفّها بلا وقتها — والعمود قائم
       * في الجدول أصلاً، فإظهاره يجعل «مجدولة» في شاشة الإعلانات قابلةً للتحقّق من الطابور.
       */
      runAt: string;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const status = query.status && query.status.length > 0 ? query.status : null;
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const where = status ? eq(outboxJobs.status, status) : undefined;

      const totalRow = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(outboxJobs)
        .where(where);

      const rows = await tx
        .select({
          id: outboxJobs.id,
          tenantId: outboxJobs.tenantId,
          tenantCode: tenants.code,
          queue: outboxJobs.queue,
          type: outboxJobs.type,
          status: outboxJobs.status,
          attempts: outboxJobs.attempts,
          lastError: outboxJobs.lastError,
          createdAt: outboxJobs.createdAt,
          runAt: outboxJobs.runAt,
        })
        .from(outboxJobs)
        .leftJoin(tenants, eq(tenants.id, outboxJobs.tenantId))
        .where(where)
        .orderBy(desc(outboxJobs.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return {
        items: rows.map((row) => ({
          ...row,
          lastError: row.lastError ?? null,
          createdAt: row.createdAt.toISOString(),
          runAt: row.runAt.toISOString(),
        })),
        total: totalRow[0]?.value ?? 0,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  // ------------------------------------------------------------------- omnibox

  /**
   * `GET /platform/tenants/search?q=` — the Ctrl+K provider.
   *
   * Search only. It answers with the three fields a palette row can render and never with
   * the tenant's financial state, so the cheapest console permission
   * (`console.tenants.view`) is enough to hold it.
   */
  async searchTenants(term: string): Promise<PlatformTenantSearchResult[]> {
    const pattern = `%${term.trim()}%`;
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({
          id: tenants.id,
          code: tenants.code,
          name: tenants.name,
          status: tenants.status,
        })
        .from(tenants)
        .where(or(ilike(tenants.code, pattern), ilike(tenants.name, pattern)))
        .orderBy(asc(tenants.name))
        .limit(10);
      return rows;
    });
  }
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, `filter[${field}] must be an ISO-8601 date`, 400, {
      field: `filter[${field}]`,
    });
  }
  return parsed;
}
