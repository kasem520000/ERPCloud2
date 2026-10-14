import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import {
  AUDIT_FILTERS,
  AUDIT_SORT_COLUMNS,
  buildMeta,
  DomainError,
  errorCodes,
  parseFilters,
  parseSort,
  type AuditEntryDto,
  type ListEnvelope,
  type PaginationQuery,
} from '@erp/contracts';
import {
  auditLog,
  memberships,
  newId,
  withTenantTx,
  withTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

import { redactAuditPayload } from './audit-redaction.js';

/**
 * Audit service — SECURITY_ARCHITECTURE §10 ("Mutating endpoint ⇒ audit_log row (entity
 * diff, actor, ip, ua, trace)"), DATABASE_DESIGN §4.
 *
 * Two ways in:
 *
 * - `AuditInterceptor` records the generic mutation of every write endpoint;
 * - a service calls `record()` / `recordInTx()` when it can supply a real `before`/`after`
 *   diff or a domain-specific action name. `recordInTx()` joins the caller's business
 *   transaction, so "the row was written **and** audited" is atomic.
 *
 * The table is append-only at the privilege level (`REVOKE UPDATE, DELETE … FROM
 * erp_api`), so nothing here ever updates a row.
 */

export type AuditEntryInput = {
  /** NULL/omitted = platform-plane event (e.g. a login that never reached a tenant). */
  tenantId?: string | null;
  actorUserId?: string | null;
  actorLabel?: string | null;
  /** Resolves `actorLabel` from the membership when the caller did not supply one. */
  membershipId?: string | null;
  /** `create | update | delete | auth.login | …` or a module verb. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

export type AuditListQuery = PaginationQuery & {
  filter?: Record<string, unknown>;
  sort?: string;
};

const LABEL_CACHE_TTL_MS = 60_000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly labelCache = new Map<string, { label: string | null; cachedAt: number }>();

  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /**
   * Persists one audit row on its own transaction.
   *
   * Auditing must never break the request that is being audited: a failure here is
   * logged and swallowed. The immutability guarantee lives in the database, not in this
   * call path.
   */
  async record(entry: AuditEntryInput): Promise<string | undefined> {
    try {
      if (entry.tenantId) {
        return await withTenantTx(this.database.db, entry.tenantId, (tx) => this.recordInTx(tx, entry));
      }
      return await withTx(this.database.db, (tx) => this.recordInTx(tx, entry));
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          action: entry.action,
          entity: entry.entity,
        },
        'failed to write audit_log row',
      );
      return undefined;
    }
  }

  /** Same, inside an existing transaction — use this from a business unit of work. */
  async recordInTx(tx: DrizzleTx, entry: AuditEntryInput): Promise<string> {
    const id = newId();
    const actorLabel = entry.actorLabel ?? (await this.resolveActorLabel(tx, entry));
    const meta = {
      ...(entry.meta ?? {}),
      ...(entry.membershipId ? { membershipId: entry.membershipId } : {}),
    };

    await tx.insert(auditLog).values({
      id,
      tenantId: entry.tenantId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorLabel,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: entry.before === undefined ? null : redactAuditPayload(entry.before),
      after: entry.after === undefined ? null : redactAuditPayload(entry.after),
      meta: (redactAuditPayload(meta) ?? {}) as Record<string, unknown>,
    });
    return id;
  }

  /**
   * `memberships.display_name` of the actor, cached for 60 s.
   *
   * TARGET_ARCHITECTURE §7 allows caching lookups for 60 s; the alternative is either an
   * extra join on every mutation or an audit trail that shows raw uuids to a human
   * reviewer. The read runs inside the caller's transaction, so it is RLS-scoped like
   * everything else.
   */
  private async resolveActorLabel(tx: DrizzleTx, entry: AuditEntryInput): Promise<string | null> {
    if (!entry.membershipId || !entry.tenantId) return null;

    const cached = this.labelCache.get(entry.membershipId);
    if (cached && Date.now() - cached.cachedAt < LABEL_CACHE_TTL_MS) return cached.label;

    const [row] = await tx
      .select({ displayName: memberships.displayName })
      .from(memberships)
      .where(eq(memberships.id, entry.membershipId))
      .limit(1);

    const label = row?.displayName ?? null;
    this.labelCache.set(entry.membershipId, { label, cachedAt: Date.now() });
    return label;
  }

  /** `GET /audit-log` — API_CONTRACT §2, `platform.audit.view`. */
  async list(tenantId: string, query: AuditListQuery): Promise<ListEnvelope<AuditEntryDto>> {
    const filters = parseFilters(query.filter, AUDIT_FILTERS);
    const sort = parseSort(query.sort, AUDIT_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: (SQL | undefined)[] = [eq(auditLog.tenantId, tenantId)];
      if (filters.entity) conditions.push(eq(auditLog.entity, filters.entity));
      if (filters.entityId) conditions.push(eq(auditLog.entityId, filters.entityId));
      if (filters.action) conditions.push(eq(auditLog.action, filters.action));
      if (filters.actorUserId) conditions.push(eq(auditLog.actorUserId, filters.actorUserId));
      if (filters.from) conditions.push(gte(auditLog.createdAt, parseDateFilter(filters.from, 'from')));
      if (filters.to) conditions.push(lte(auditLog.createdAt, parseDateFilter(filters.to, 'to')));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(auditLog).where(where);

      const ascending = sort.some((clause) => clause.direction === 'asc');
      const rows = await tx
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(ascending ? sql`${auditLog.createdAt} ASC` : desc(auditLog.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return {
        data: rows.map((row) => toAuditDto(row)),
        meta: buildMeta(totalRow?.value ?? 0, query),
      };
    });
  }
}

function parseDateFilter(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, `filter[${field}] must be an ISO-8601 date`, 400, {
      field: `filter[${field}]`,
    });
  }
  return parsed;
}

type AuditRow = typeof auditLog.$inferSelect;

export function toAuditDto(row: AuditRow): AuditEntryDto {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorLabel: row.actorLabel,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    before: row.before ?? null,
    after: row.after ?? null,
    meta: (row.meta ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}
