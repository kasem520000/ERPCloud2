import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit/audit.controller.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { AuditService } from './audit/audit.service.js';
import { FileAttachmentRegistry } from './files/file-attachments.js';
import { FilesController } from './files/files.controller.js';
import { FilesService } from './files/files.service.js';
import { OBJECT_STORAGE, S3ObjectStorage } from './files/object-storage.js';
import { NoopVirusScanner, VIRUS_SCANNER } from './files/virus-scanner.js';
import { IdempotencyStore } from './idempotency/idempotency.store.js';
import { JobHandlerRegistry, PlatformJobHandlers } from './jobs/job-handlers.js';
import { JobsController } from './jobs/jobs.controller.js';
import { OutboxPublisher } from './jobs/outbox.publisher.js';
import { OutboxService } from './jobs/outbox.service.js';
import { QUEUE_PORT, QueueService } from './jobs/queue.service.js';
import { WorkerRunner } from './jobs/worker.runner.js';
import { createMailer, MAILER } from './notifications/mailer.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { NotificationsSubscriber } from './notifications/notifications.subscriber.js';
import { SequencesService } from './sequences/sequences.service.js';

/**
 * Platform services — audit, files, notifications, jobs, sequences, idempotency
 * (PHASE_04). Cross-cutting infrastructure that every business module consumes but that
 * owns no business rules of its own.
 *
 * Ports are bound to their default adapters here and nowhere else, so a deployment (or a
 * test) swaps an implementation by overriding one token:
 *
 * | token            | default          | production                        |
 * | ---------------- | ---------------- | --------------------------------- |
 * | `OBJECT_STORAGE` | `S3ObjectStorage`| S3/MinIO (already real)           |
 * | `MAILER`         | `createMailer()` | console by default, SMTP when MAIL_TRANSPORT=smtp (Round 11)|
 * | `VIRUS_SCANNER`  | `NoopVirusScanner`| ClamAV — PHASE_04 §14 defers     |
 * | `QUEUE_PORT`     | `QueueService`   | same class, Redis configured      |
 *
 * Exports are the surface later phases may use; the controllers are not part of it.
 *
 * `@Global` is deliberate. `modules/platform` (settings) needs `AuditService`, while this
 * module's controllers need the guards and decorators exported by `modules/platform` — a
 * plain `imports:` edge in either direction would be a module cycle. Making the
 * cross-cutting infrastructure global is the standard Nest answer and matches how
 * `DomainEventsModule` is already wired.
 */
@Global()
@Module({
  controllers: [AuditController, FilesController, NotificationsController, JobsController],
  providers: [
    AuditService,
    AuditInterceptor,
    FilesService,
    FileAttachmentRegistry,
    NotificationsService,
    NotificationsSubscriber,
    OutboxService,
    OutboxPublisher,
    JobHandlerRegistry,
    PlatformJobHandlers,
    WorkerRunner,
    SequencesService,
    IdempotencyStore,
    // useFactory, not useClass: the adapter takes an optional config object that Nest
    // would otherwise try to resolve as a dependency.
    { provide: OBJECT_STORAGE, useFactory: () => new S3ObjectStorage() },
    // Factory reads MAIL_TRANSPORT: 'console' logs, 'smtp' delivers via SmtpMailer.
    { provide: MAILER, useFactory: createMailer },
    { provide: VIRUS_SCANNER, useClass: NoopVirusScanner },
    { provide: QUEUE_PORT, useClass: QueueService },
  ],
  exports: [
    AuditService,
    AuditInterceptor,
    FilesService,
    FileAttachmentRegistry,
    NotificationsService,
    OutboxService,
    OutboxPublisher,
    JobHandlerRegistry,
    PlatformJobHandlers,
    WorkerRunner,
    SequencesService,
    IdempotencyStore,
    OBJECT_STORAGE,
    MAILER,
    VIRUS_SCANNER,
    QUEUE_PORT,
  ],
})
export class PlatformServicesModule {}
