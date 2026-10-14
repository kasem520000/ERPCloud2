import { Inject, Injectable, Logger } from '@nestjs/common';
import { env } from '@erp/config';
import { jobTypes, QUEUE_NAMES, type QueueName } from '@erp/contracts';
import { tenants, withTx, type DatabaseHandle } from '@erp/database';
import type { Worker } from 'bullmq';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

import { JobHandlerRegistry, PlatformJobHandlers } from './job-handlers.js';
import { OutboxPublisher } from './outbox.publisher.js';
import { QUEUE_PORT, QueueService, type QueuePort } from './queue.service.js';

/**
 * Worker runtime — PHASE_04 §5.5: "BullMQ setup: queues named einvoice, notifications,
 * reports-export, migration, maintenance; worker health logging; outbox publisher with
 * retry/backoff".
 *
 * The same image runs the API and the worker (`WORKER=1`), which is what keeps the
 * handler code, the schema and the DI graph identical in both roles. `start()` is safe
 * to call without Redis: the outbox loop and the health log still run, and the BullMQ
 * consumers are simply not created — so `pnpm dev` on a laptop behaves like production
 * minus the last hop.
 */
@Injectable()
export class WorkerRunner {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly workers: Worker[] = [];
  private outboxTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    private readonly registry: JobHandlerRegistry,
    private readonly handlers: PlatformJobHandlers,
    private readonly publisher: OutboxPublisher,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.handlers.registerAll(this.registry);
    this.logger.log({ handlers: this.registry.registered() }, 'job handlers registered');

    if (this.queue.isEnabled() && this.queue instanceof QueueService) {
      await this.startConsumers(this.queue);
      await this.scheduleMaintenance();
    } else {
      this.logger.warn('REDIS_URL is not configured; running outbox-only (no queue consumers)');
    }

    this.outboxTimer = setInterval(() => {
      void this.publisher.drainOnce().catch((error: unknown) => {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'outbox drain failed',
        );
      });
    }, env.OUTBOX_POLL_INTERVAL_MS);
    this.outboxTimer.unref?.();

    this.healthTimer = setInterval(() => this.logHealth(), env.WORKER_HEALTH_LOG_INTERVAL_MS);
    this.healthTimer.unref?.();

    this.logHealth();
  }

  private async startConsumers(queue: QueueService): Promise<void> {
    const { Worker: BullWorker } = await import('bullmq');
    for (const name of QUEUE_NAMES) {
      const worker = new BullWorker(
        name,
        async (job) => {
          const data = (job.data ?? {}) as { tenantId?: string; type?: string } & Record<string, unknown>;
          if (!data.tenantId) {
            this.logger.error({ queue: name, jobId: job.id }, 'job without tenantId; refusing to run');
            return;
          }
          // TARGET_ARCHITECTURE §6: the worker re-applies the tenant context itself —
          // every handler goes through withTenantTx, exactly like an HTTP request.
          await this.registry.dispatch(name as QueueName, {
            tenantId: data.tenantId,
            type: data.type ?? job.name,
            payload: data,
          });
        },
        { prefix: env.JOB_QUEUE_PREFIX, connection: queue.redisConnection() },
      );

      worker.on('failed', (job, error) => {
        this.logger.error({ queue: name, jobId: job?.id, err: error.message }, 'job failed');
      });
      this.workers.push(worker);
    }
    this.logger.log({ queues: [...QUEUE_NAMES] }, 'queue consumers started');
  }

  /** Recurring maintenance: orphan-file collection and idempotency-key expiry. */
  private async scheduleMaintenance(): Promise<void> {
    const tenantIds = await withTx(this.database.db, async (tx) =>
      (await tx.select({ id: tenants.id }).from(tenants)).map((row) => row.id),
    );

    for (const tenantId of tenantIds) {
      await this.queue.publish({
        queue: 'maintenance',
        type: jobTypes.FILES_ORPHAN_GC,
        tenantId,
        payload: { scheduled: true },
        jobId: `files-orphan-gc-${tenantId}-${new Date().toISOString().slice(0, 13)}`,
      });
      await this.queue.publish({
        queue: 'maintenance',
        type: jobTypes.AI_SUGGEST,
        tenantId,
        payload: { scheduled: true },
        jobId: `ai-suggest-${tenantId}-${new Date().toISOString().slice(0, 10)}`,
      });
    }
    await this.queue.publish({
      queue: 'maintenance',
      type: jobTypes.IDEMPOTENCY_GC,
      tenantId: tenantIds[0] ?? '00000000-0000-0000-0000-000000000000',
      payload: { scheduled: true },
      jobId: `idempotency-gc-${new Date().toISOString().slice(0, 13)}`,
    });
  }

  private logHealth(): void {
    this.logger.log(
      {
        role: 'worker',
        driver: this.queue.driver,
        consumers: this.workers.length,
        queues: [...QUEUE_NAMES],
        pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      },
      'worker health',
    );
  }

  async stop(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.outboxTimer = undefined;
    this.healthTimer = undefined;

    for (const worker of this.workers) {
      await worker.close();
    }
    this.workers.length = 0;
    await this.queue.close();
    this.running = false;
  }
}
