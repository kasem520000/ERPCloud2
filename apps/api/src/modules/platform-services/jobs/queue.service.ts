import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { env } from '@erp/config';
import { isQueueName, type QueueName } from '@erp/contracts';
import type { Queue } from 'bullmq';

import { isSensitiveKey } from '../audit/audit-redaction.js';

/**
 * Queue port + BullMQ adapter — TARGET_ARCHITECTURE §6.
 *
 * Producers never talk to Redis directly and never even talk to *this* class in a
 * business transaction: they write an `outbox_jobs` row, and `OutboxPublisher` calls
 * `publish()` afterwards. That is what makes "the invoice was posted" and "the e-invoice
 * job exists" a single atomic fact.
 *
 * When `REDIS_URL` is unset (or `JOBS_ENABLED=false`) the adapter degrades to `inert`:
 * `publish()` records the job in memory and logs it, the outbox is left `pending`, and
 * nothing is lost. Tests and a laptop without Redis therefore exercise the same code
 * path as production up to the last hop.
 */

export type QueueJob = {
  queue: QueueName;
  type: string;
  tenantId: string;
  payload: Record<string, unknown>;
  /** Stable id — BullMQ deduplicates on it, which makes a redelivered outbox row safe. */
  jobId?: string;
};

export interface QueuePort {
  readonly driver: 'bullmq' | 'inert';
  isEnabled(): boolean;
  /**
   * هل الطابور **حيّ** فعلاً؟ `isEnabled()` تقول «مُعلَن» (JOBS_ENABLED + REDIS_URL)،
   * وهذا يقول «يُسمع على منفذه». الفرق يهمّ المجدولات: بيئةٌ فيها REDIS_URL بلا خادم
   * تظنّ أن عاملاً سيستهلك مهامّها فلا تعمل شيئاً — وهي وحدها الحاضرة.
   */
  ping(): Promise<boolean>;
  publish(job: QueueJob): Promise<void>;
  close(): Promise<void>;
}

export const QUEUE_PORT = 'ERP_QUEUE_PORT';

/** SECURITY_ARCHITECTURE §8/§9: "queue payloads carry no secrets". Enforced, not hoped. */
export function assertNoSecretsInPayload(payload: Record<string, unknown>, path = 'payload'): void {
  for (const [key, value] of Object.entries(payload)) {
    if (isSensitiveKey(key)) {
      throw new Error(`Refusing to enqueue ${path}.${key}: queue payloads must not carry secrets`);
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      assertNoSecretsInPayload(value as Record<string, unknown>, `${path}.${key}`);
    }
  }
}

@Injectable()
export class QueueService implements QueuePort, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();
  private connection: { host: string; port: number; password?: string; username?: string } | undefined;
  /** Last jobs seen while inert — surfaced by `GET /jobs/health` and used by tests. */
  private readonly inertJobs: QueueJob[] = [];

  get driver(): 'bullmq' | 'inert' {
    return this.isEnabled() ? 'bullmq' : 'inert';
  }

  isEnabled(): boolean {
    return env.JOBS_ENABLED && Boolean(env.REDIS_URL);
  }

  /**
   * فحص «يسمع أم لا» بفتح مقبسٍ واحد وإغلاقه — لا أمر Redis ولا تحميل مُشغّل: أرخص من
   * `PING` وأصدق من `isEnabled()`، ولا يعلق أبداً (مهلةٌ صريحة).
   */
  async ping(timeoutMs = 1_000): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const { host, port } = this.redisConnection();
    const net = await import('node:net');
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (answer: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(answer);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  recentInertJobs(): readonly QueueJob[] {
    return this.inertJobs;
  }

  async publish(job: QueueJob): Promise<void> {
    if (!isQueueName(job.queue)) {
      throw new Error(`Unknown queue '${job.queue}' (TARGET_ARCHITECTURE §6 freezes the list)`);
    }
    assertNoSecretsInPayload(job.payload);

    if (!this.isEnabled()) {
      this.inertJobs.push(job);
      if (this.inertJobs.length > 100) this.inertJobs.shift();
      this.logger.debug({ queue: job.queue, type: job.type }, 'queue disabled; job recorded in memory');
      return;
    }

    const queue = await this.queueFor(job.queue);
    await queue.add(
      job.type,
      { tenantId: job.tenantId, type: job.type, ...job.payload },
      {
        jobId: job.jobId,
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
        attempts: 3,
        backoff: { type: 'exponential', delay: env.OUTBOX_BACKOFF_BASE_MS },
      },
    );
  }

  /**
   * BullMQ is imported lazily so that a deployment without Redis — and the whole test
   * suite — never loads the driver or opens a socket.
   */
  private async queueFor(name: QueueName): Promise<Queue> {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const { Queue: BullQueue } = await import('bullmq');
    const queue = new BullQueue(name, {
      prefix: env.JOB_QUEUE_PREFIX,
      connection: this.redisConnection(),
    });
    this.queues.set(name, queue);
    return queue;
  }

  redisConnection(): { host: string; port: number; password?: string; username?: string } {
    if (this.connection) return this.connection;
    const url = new URL(env.REDIS_URL ?? 'redis://localhost:6379');
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    };
    return this.connection;
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
