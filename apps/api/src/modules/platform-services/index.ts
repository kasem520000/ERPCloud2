/**
 * Public API of the platform-services module (TARGET_ARCHITECTURE §4.1).
 *
 * Business modules added in later phases consume audit, files, notifications, jobs and
 * sequences **only** through this file; `eslint-plugin-boundaries` blocks the deep paths.
 */
export { PlatformServicesModule } from './platform-services.module.js';

export { AuditService } from './audit/audit.service.js';
export type { AuditEntryInput, AuditListQuery } from './audit/audit.service.js';
export { AuditInterceptor } from './audit/audit.interceptor.js';
export { redactAuditPayload, isSensitiveKey, REDACTED_MARKER } from './audit/audit-redaction.js';

export { FilesService } from './files/files.service.js';
export { FileAttachmentRegistry } from './files/file-attachments.js';
export type { AttachmentValidator } from './files/file-attachments.js';
export { OBJECT_STORAGE, S3ObjectStorage } from './files/object-storage.js';
export type { ObjectStoragePort, PresignedUrl } from './files/object-storage.js';
export { VIRUS_SCANNER, NoopVirusScanner } from './files/virus-scanner.js';
export type { VirusScannerPort, ScanVerdict } from './files/virus-scanner.js';

export { NotificationsService } from './notifications/notifications.service.js';
export type { NotificationInput } from './notifications/notifications.service.js';
export { MAILER, ConsoleMailer, SmtpMailer, createMailer, smtpOptionsFromEnv } from './notifications/mailer.js';
export type { MailerPort, MailMessage, SmtpOptions } from './notifications/mailer.js';

export { OutboxService } from './jobs/outbox.service.js';
export { OutboxPublisher } from './jobs/outbox.publisher.js';
export { QUEUE_PORT, QueueService, assertNoSecretsInPayload } from './jobs/queue.service.js';
export type { QueueJob, QueuePort } from './jobs/queue.service.js';
export { JobHandlerRegistry, PlatformJobHandlers } from './jobs/job-handlers.js';
export type { JobContext, JobHandler } from './jobs/job-handlers.js';
export { WorkerRunner } from './jobs/worker.runner.js';

export { SequencesService } from './sequences/sequences.service.js';
export type { SequenceScope, SequenceOptions } from './sequences/sequences.service.js';

export { IdempotencyStore, hashRequestPayload } from './idempotency/idempotency.store.js';
