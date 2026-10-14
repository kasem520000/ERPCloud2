import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  buildMeta,
  isQueueName,
  OUTBOX_FILTERS,
  OUTBOX_SORT_COLUMNS,
  parseFilters,
  parseSort,
  type ListEnvelope,
  type OutboxJobDto,
  type PaginationQuery,
  type QueueName,
} from '@erp/contracts';
import { newId, outboxJobs, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

import { assertNoSecretsInPayload } from './queue.service.js';

/**
 * Transactional outbox — PHASE_04 §4: "outbox table as transactional handoff (service
 * writes outbox row in business tx; publisher drains to Redis)".
 *
 * The rule for every later module: **never** publish to a queue from inside a business
 * transaction. Call `enqueueInTx(tx, …)` — if the transaction rolls back, the job
 * disappears with it; if it commits, the job is guaranteed to be delivered at least once
 * by `OutboxPublisher`.
 */

export type OutboxEnqueueInput = {
  tenantId: string;
  queue: QueueName;
  type: string;
  payload?: Record<string, unknown>;
  /** Delay the first attempt (defaults to "as soon as the publisher gets to it"). */
  runAt?: Date;
};

export type OutboxListQuery = PaginationQuery & {
  filter?: Record<string, unknown>;
  sort?: string;
};

@Injectable()
export class OutboxService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /** Writes the handoff row inside the caller's business transaction. */
  async enqueueInTx(tx: DrizzleTx, input: OutboxEnqueueInput): Promise<string> {
    if (!isQueueName(input.queue)) {
      throw new Error(`Unknown queue '${input.queue}' (TARGET_ARCHITECTURE §6 freezes the list)`);
    }
    const payload = input.payload ?? {};
    assertNoSecretsInPayload(payload);

    const id = newId();
    await tx.insert(outboxJobs).values({
      id,
      tenantId: input.tenantId,
      queue: input.queue,
      type: input.type,
      payload,
      status: 'pending',
      runAt: input.runAt ?? new Date(),
    });
    return id;
  }

  /** Convenience for callers that have no transaction of their own. */
  async enqueue(input: OutboxEnqueueInput): Promise<string> {
    return withTenantTx(this.database.db, input.tenantId, (tx) => this.enqueueInTx(tx, input));
  }

  /** `GET /jobs/outbox` — `platform.job.view`. */
  async list(tenantId: string, query: OutboxListQuery): Promise<ListEnvelope<OutboxJobDto>> {
    const filters = parseFilters(query.filter, OUTBOX_FILTERS);
    const sort = parseSort(query.sort, OUTBOX_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: (SQL | undefined)[] = [eq(outboxJobs.tenantId, tenantId)];
      if (filters.status) conditions.push(eq(outboxJobs.status, filters.status));
      if (filters.queue) conditions.push(eq(outboxJobs.queue, filters.queue));
      if (filters.type) conditions.push(eq(outboxJobs.type, filters.type));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(outboxJobs).where(where);

      const ascending = sort[0]?.direction === 'asc';
      const rows = await tx
        .select()
        .from(outboxJobs)
        .where(where)
        .orderBy(ascending ? sql`${outboxJobs.createdAt} ASC` : desc(outboxJobs.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toOutboxDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async counts(tenantId: string): Promise<{ pending: number; dead: number }> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ status: outboxJobs.status, value: count() })
        .from(outboxJobs)
        .where(eq(outboxJobs.tenantId, tenantId))
        .groupBy(outboxJobs.status);

      const byStatus = new Map(rows.map((row) => [row.status, row.value]));
      return { pending: byStatus.get('pending') ?? 0, dead: byStatus.get('dead') ?? 0 };
    });
  }
}

type OutboxRow = typeof outboxJobs.$inferSelect;

export function toOutboxDto(row: OutboxRow): OutboxJobDto {
  return {
    id: row.id,
    queue: row.queue as OutboxJobDto['queue'],
    type: row.type,
    status: row.status as OutboxJobDto['status'],
    attempts: row.attempts,
    runAt: row.runAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}
