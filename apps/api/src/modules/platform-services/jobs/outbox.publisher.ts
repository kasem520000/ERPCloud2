import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { env } from '@erp/config';
import type { QueueName } from '@erp/contracts';
import { outboxJobs, tenants, withTenantTx, withTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

import { QUEUE_PORT, type QueuePort } from './queue.service.js';

/**
 * Outbox publisher — drains `outbox_jobs` into BullMQ with retry/backoff
 * (PHASE_04 §5.5, TARGET_ARCHITECTURE §6).
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. **No BYPASSRLS.** `outbox_jobs` is tenant-scoped, and PROJECT_CONTRACT §13.4 allows
 *    only the migrator and the platform-admin plane to bypass RLS. The publisher
 *    therefore iterates active tenants and drains each one under its own
 *    `app.tenant_id`. That costs one query per tenant per poll and buys "the worker can
 *    never read across tenants either".
 * 2. **Claim and publish in the same transaction.** Rows are selected
 *    `FOR UPDATE SKIP LOCKED`, published, then marked — so a second replica skips the
 *    locked rows instead of double-publishing, and a crash mid-publish rolls back to
 *    `pending` (at-least-once, which is why consumers must be idempotent).
 */

export type DrainReport = {
  scannedTenants: number;
  published: number;
  retried: number;
  dead: number;
};

type DueRow = {
  id: string;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

/** Exponential, capped at one hour: `2s, 4s, 8s … 3600s`. */
export function backoffDelayMs(attempts: number, baseMs = env.OUTBOX_BACKOFF_BASE_MS): number {
  const capped = Math.min(attempts, 16);
  return Math.min(baseMs * 2 ** capped, 3_600_000);
}

@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  async drainOnce(now = new Date()): Promise<DrainReport> {
    const report: DrainReport = { scannedTenants: 0, published: 0, retried: 0, dead: 0 };
    if (!this.queue.isEnabled()) {
      // Nothing is lost: rows stay `pending` until a queue is configured.
      this.logger.debug('queue driver is inert; outbox drain skipped');
      return report;
    }

    for (const tenantId of await this.activeTenantIds()) {
      report.scannedTenants += 1;
      const tenantReport = await this.drainTenant(tenantId, now);
      report.published += tenantReport.published;
      report.retried += tenantReport.retried;
      report.dead += tenantReport.dead;
    }
    return report;
  }

  async drainTenant(
    tenantId: string,
    now = new Date(),
  ): Promise<{ published: number; retried: number; dead: number }> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT id, queue, type, payload, attempts
        FROM outbox_jobs
        WHERE tenant_id = ${tenantId} AND status = 'pending' AND run_at <= ${now}
        ORDER BY run_at ASC
        LIMIT ${env.OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `);
      const due = rowsOf<DueRow>(result);

      let published = 0;
      let retried = 0;
      let dead = 0;

      for (const row of due) {
        try {
          await this.queue.publish({
            queue: row.queue as QueueName,
            type: row.type,
            tenantId,
            payload: row.payload ?? {},
            // The outbox id is the dedupe key: a redelivered row is the same BullMQ job.
            jobId: row.id,
          });
          await tx
            .update(outboxJobs)
            .set({
              status: 'published',
              processedAt: new Date(),
              attempts: row.attempts + 1,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(outboxJobs.id, row.id));
          published += 1;
        } catch (error) {
          const attempts = row.attempts + 1;
          const exhausted = attempts >= env.OUTBOX_MAX_ATTEMPTS;
          await tx
            .update(outboxJobs)
            .set({
              status: exhausted ? 'dead' : 'pending',
              attempts,
              runAt: new Date(now.getTime() + backoffDelayMs(attempts)),
              lastError: truncateError(error),
              updatedAt: new Date(),
            })
            .where(eq(outboxJobs.id, row.id));

          if (exhausted) {
            dead += 1;
            this.logger.error({ jobId: row.id, tenantId, attempts }, 'outbox job exhausted its attempts');
          } else {
            retried += 1;
            this.logger.warn({ jobId: row.id, tenantId, attempts }, 'outbox publish failed; will retry');
          }
        }
      }

      return { published, retried, dead };
    });
  }

  /** `tenants` is a platform table (no RLS), so this read needs no tenant context. */
  private async activeTenantIds(): Promise<string[]> {
    return withTx(this.database.db, async (tx) => {
      const rows = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
      return rows.map((row) => row.id);
    });
  }
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);
}
