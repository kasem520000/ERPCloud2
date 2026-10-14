import { Inject, Injectable, Logger } from '@nestjs/common';
import { jobTypes, type QueueName } from '@erp/contracts';

import { FilesService } from '../files/files.service.js';
import { MAILER, type MailerPort } from '../notifications/mailer.js';
import { IdempotencyStore } from '../idempotency/idempotency.store.js';

/**
 * Job handler registry — the worker's routing table.
 *
 * A handler is looked up by `queue:type`, receives the tenant it belongs to and must be
 * **idempotent** (TARGET_ARCHITECTURE §6: "Idempotent consumers; jobs carry `tenant_id`
 * and re-apply RLS context inside the worker"). Later phases register their own handlers
 * from their module bootstrap instead of editing this file.
 */

export type JobContext = {
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
};

export type JobHandler = (context: JobContext) => Promise<void>;

@Injectable()
export class JobHandlerRegistry {
  private readonly logger = new Logger(JobHandlerRegistry.name);
  private readonly handlers = new Map<string, JobHandler>();

  register(queue: QueueName, type: string, handler: JobHandler): void {
    this.handlers.set(`${queue}:${type}`, handler);
  }

  handlerFor(queue: QueueName, type: string): JobHandler | undefined {
    return this.handlers.get(`${queue}:${type}`);
  }

  registered(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(queue: QueueName, context: JobContext): Promise<boolean> {
    const handler = this.handlerFor(queue, context.type);
    if (!handler) {
      this.logger.warn({ queue, type: context.type }, 'no handler registered for job; dropping');
      return false;
    }
    await handler(context);
    return true;
  }
}

/**
 * The handlers Phase 04 owns. Registered by `WorkerRunner` on start, and directly
 * callable from tests (which is how the orphan collector is covered without Redis).
 */
@Injectable()
export class PlatformJobHandlers {
  private readonly logger = new Logger(PlatformJobHandlers.name);

  constructor(
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyStore,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  registerAll(registry: JobHandlerRegistry): void {
    registry.register('notifications', jobTypes.NOTIFICATION_EMAIL, (context) =>
      this.sendNotificationEmail(context),
    );
    registry.register('maintenance', jobTypes.FILES_ORPHAN_GC, (context) => this.collectOrphans(context));
    registry.register('maintenance', jobTypes.IDEMPOTENCY_GC, () => this.purgeIdempotencyKeys());
  }

  async sendNotificationEmail(context: JobContext): Promise<void> {
    const to = typeof context.payload.email === 'string' ? context.payload.email : undefined;
    if (!to) {
      this.logger.warn({ tenantId: context.tenantId }, 'notification email job without a recipient');
      return;
    }
    await this.mailer.send({
      to,
      subject: String(context.payload.subject ?? 'Notification'),
      text: String(context.payload.text ?? ''),
      tenantId: context.tenantId,
    });
  }

  /** PHASE_04 §4 — "orphan GC job stub registered". */
  async collectOrphans(context: JobContext): Promise<void> {
    const collected = await this.files.collectOrphans(context.tenantId);
    this.logger.log({ tenantId: context.tenantId, collected }, 'orphan file collection finished');
  }

  async purgeIdempotencyKeys(): Promise<void> {
    const purged = await this.idempotency.purgeExpired();
    this.logger.log({ purged }, 'expired idempotency keys purged');
  }
}
