import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '@erp/contracts';
import { env } from '@erp/config';

import {
  OutboxPublisher,
  OutboxService,
  PlatformJobHandlers,
  QUEUE_PORT,
  WorkerRunner,
  type JobHandlerRegistry,
  type QueueJob,
  type QueuePort,
} from '../src/modules/platform-services/index.js';
import { JobHandlerRegistry as Registry } from '../src/modules/platform-services/jobs/job-handlers.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Background jobs — PHASE_04 §5.5: queues, transactional outbox, retry/backoff, worker
 * bootstrap. Redis is not available here, so the queue port is a recording fake: the
 * outbox mechanics (claim, publish, mark, retry, dead-letter) are proven for real
 * against PostgreSQL, and the BullMQ hop itself is the part left to a live environment.
 */
class RecordingQueue implements QueuePort {
  readonly driver = 'bullmq' as const;
  readonly published: QueueJob[] = [];
  failOnType: string | undefined;

  isEnabled(): boolean {
    return true;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async publish(job: QueueJob): Promise<void> {
    if (this.failOnType && job.type === this.failOnType) {
      throw new Error('redis unavailable');
    }
    this.published.push(job);
  }

  async close(): Promise<void> {}
}

describe('jobs and outbox (PHASE_04 §5.5)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let outbox: OutboxService;
  let publisher: OutboxPublisher;
  const queue = new RecordingQueue();

  beforeAll(async () => {
    ctx = await createTestApp('jobs', (builder) => builder.overrideProvider(QUEUE_PORT).useValue(queue));
    admin = await createActor(ctx, {
      tenantCode: 'jobs-a',
      email: 'owner@jobs-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    outbox = ctx.app.get(OutboxService);
    publisher = ctx.app.get(OutboxPublisher);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('drains a pending outbox row into the queue exactly once', async () => {
    await outbox.enqueue({
      tenantId: admin.tenantId,
      queue: 'einvoice',
      type: 'einvoice.submit',
      payload: { invoiceId: 'inv-1' },
    });

    const report = await publisher.drainOnce();
    expect(report.published).toBe(1);
    const job = queue.published.find((entry) => entry.type === 'einvoice.submit');
    expect(job?.tenantId).toBe(admin.tenantId);
    expect(job?.payload.invoiceId).toBe('inv-1');
    // The outbox id is the BullMQ dedupe key.
    expect(job?.jobId).toBeTypeOf('string');

    // A second drain finds nothing left to do.
    expect((await publisher.drainOnce()).published).toBe(0);

    const listed = await api(ctx.server, 'get', '/api/v1/jobs/outbox?filter[status]=published', {
      token: admin.token,
    });
    const rows = listed.body.data as Array<{ type: string; attempts: number; processedAt: string | null }>;
    expect(rows.some((row) => row.type === 'einvoice.submit' && row.attempts === 1)).toBe(true);
    expect(rows[0]?.processedAt).toBeTypeOf('string');
  });

  it('retries with backoff and dead-letters after the attempt ceiling', async () => {
    queue.failOnType = 'reports.export';
    await outbox.enqueue({
      tenantId: admin.tenantId,
      queue: 'reports-export',
      type: 'reports.export',
      payload: { reportId: 'r-1' },
    });

    // Each drain must be told "now" is later than the backoff, otherwise the row is
    // not due yet — which is itself the proof that the backoff is being applied.
    const ceiling = env.OUTBOX_MAX_ATTEMPTS;
    let future = new Date();
    for (let attempt = 1; attempt <= ceiling; attempt += 1) {
      const report = await publisher.drainOnce(future);
      expect(report.published).toBe(0);
      expect(attempt < ceiling ? report.retried : report.dead).toBe(1);
      // Not due again until the backoff elapses.
      expect((await publisher.drainOnce(future)).retried).toBe(0);
      future = new Date(future.getTime() + 3_600_000);
    }

    const dead = await api(ctx.server, 'get', '/api/v1/jobs/outbox?filter[status]=dead', {
      token: admin.token,
    });
    const rows = dead.body.data as Array<{ type: string; attempts: number; lastError: string | null }>;
    const row = rows.find((entry) => entry.type === 'reports.export');
    expect(row?.attempts).toBe(env.OUTBOX_MAX_ATTEMPTS);
    expect(row?.lastError).toContain('redis unavailable');

    queue.failOnType = undefined;
  });

  it('refuses to enqueue a payload carrying a secret', async () => {
    await expect(
      outbox.enqueue({
        tenantId: admin.tenantId,
        queue: 'maintenance',
        type: 'demo',
        payload: { config: { apiKey: 'sk-live-123' } },
      }),
    ).rejects.toThrow(/must not carry secrets/);
  });

  it('reports queue health and the tenant backlog', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/jobs/health', { token: admin.token });
    expect(response.status).toBe(200);
    const health = response.body.data as {
      enabled: boolean;
      driver: string;
      queues: string[];
      pending: number;
      dead: number;
    };
    expect(health.queues).toEqual([...QUEUE_NAMES]);
    expect(health.dead).toBeGreaterThanOrEqual(1);
  });

  it('never exposes another tenant outbox', async () => {
    const stranger = await createActor(ctx, {
      tenantCode: 'jobs-b',
      email: 'owner@jobs-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    const response = await api(ctx.server, 'get', '/api/v1/jobs/outbox?limit=100', {
      token: stranger.token,
    });
    expect(response.status).toBe(200);
    expect((response.body.data as unknown[]).length).toBe(0);
  });

  it('registers the platform handlers and dispatches by queue:type', async () => {
    const registry: JobHandlerRegistry = new Registry();
    ctx.app.get(PlatformJobHandlers).registerAll(registry);

    expect(registry.registered()).toEqual([
      'maintenance:files.orphan-gc',
      'maintenance:idempotency.gc',
      'notifications:notification.email',
    ]);

    // The maintenance handlers are safe to run against a live tenant.
    await expect(
      registry.dispatch('maintenance', {
        tenantId: admin.tenantId,
        type: 'files.orphan-gc',
        payload: {},
      }),
    ).resolves.toBe(true);

    // An unknown type is dropped with a warning rather than crashing the worker.
    await expect(
      registry.dispatch('maintenance', { tenantId: admin.tenantId, type: 'nope', payload: {} }),
    ).resolves.toBe(false);
  });

  it('starts and stops the worker runner without Redis', async () => {
    const runner = ctx.app.get(WorkerRunner);
    await runner.start();
    expect(runner.isRunning()).toBe(true);
    await runner.stop();
    expect(runner.isRunning()).toBe(false);
  });
});
