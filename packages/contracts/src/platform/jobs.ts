import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * Background-processing contract — TARGET_ARCHITECTURE §6.
 *
 * The queue names are frozen: "BullMQ queues: `einvoice`, `notifications`,
 * `reports-export`, `migration`, `maintenance`". Producers reference this list rather
 * than string literals so a typo is a compile error.
 */

export const QUEUE_NAMES = [
  'einvoice',
  'notifications',
  'reports-export',
  'migration',
  'maintenance',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/** `outbox_jobs.status` — DATABASE_DESIGN §4. */
export const outboxStatusSchema = z.enum(['pending', 'published', 'dead']);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const outboxJobDtoSchema = z.object({
  id: uuidSchema,
  queue: z.enum(QUEUE_NAMES),
  type: z.string(),
  status: outboxStatusSchema,
  attempts: z.number().int(),
  runAt: z.string(),
  processedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});

export type OutboxJobDto = z.infer<typeof outboxJobDtoSchema>;

export const OUTBOX_FILTERS = ['status', 'queue', 'type'] as const;
export const OUTBOX_SORT_COLUMNS = ['createdAt', 'runAt'] as const;

export const outboxListQuerySchema = paginationQuerySchema.extend({
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

export type OutboxListQueryDto = z.infer<typeof outboxListQuerySchema>;

export const queueHealthDtoSchema = z.object({
  /** False when `REDIS_URL` is unset — the outbox still accumulates work safely. */
  enabled: z.boolean(),
  driver: z.enum(['bullmq', 'inert']),
  queues: z.array(z.enum(QUEUE_NAMES)),
  pending: z.number().int(),
  dead: z.number().int(),
});

export type QueueHealthDto = z.infer<typeof queueHealthDtoSchema>;

/** Job types Phase 04 owns. Later phases add their own under their queue. */
export const jobTypes = {
  NOTIFICATION_EMAIL: 'notification.email',
  // P-C6 — تسليم رسالة من `email_messages`: يُخزَّن في الطابور، ويُعاد بتراجعٍ أسّي.
  EMAIL_SEND: 'email.send',
  // P-C7 — نشر إعلانٍ مجدول في وقته: يبقى المسح في `list` شبكةَ أمانٍ لمن لا عامل له.
  ANNOUNCEMENT_PUBLISH: 'announcement.publish',
  // P-M5 — نشر صفحةٍ مجدولة في وقتها. وُضع في طابور «الصيانة» لا «الإشعارات»: أسماء
  // الطوابير الخمسة مجمّدة في TARGET_ARCHITECTURE §6، ونشر صفحةٍ ليس تسليم رسالة.
  CONTENT_PUBLISH: 'content.publish',
  // P-C12 المؤجَّل — التقرير الأسبوعي (بقالب P-C6): تقريرُ المنصة إلى بريد المشغّلين،
  // فلا يخصّ عميلاً واحداً. وطابور «الصيانة» لأن تسليمه ليس رسالة عميلٍ عاجلة.
  REPORT_WEEKLY: 'report.weekly',
  // P-M7 — دفعةُ إرسال حملة: تفتح صفوف الرسائل دفعةً بعد دفعة فلا يقف طلبٌ طويلاً على
  // آلاف المستلمين، وتُعيد جدولة نفسها للبقيّة. وطابور «الصيانة» لأن الإرسال المجدول
  // ليس رسالةَ عميلٍ عاجلة (تماماً كما `content.publish` و`report.weekly`).
  CAMPAIGN_SEND: 'campaign.send',
  // Future enhancement 02 — first-page purchase-invoice OCR. It uses the existing
  // `maintenance` queue so the frozen queue contract does not grow a sixth queue.
  OCR_PROCESS: 'ocr.process',
  FILES_ORPHAN_GC: 'files.orphan-gc',
  IDEMPOTENCY_GC: 'idempotency.gc',
  // Future enhancement 03 — order imports and stock pushes share the existing maintenance queue.
  ECOMMERCE_IMPORT: 'ecommerce.import',
  ECOMMERCE_STOCK: 'ecommerce.stock',
  // Future enhancement 08 — daily assistant suggestions. Same frozen maintenance queue.
  AI_SUGGEST: 'ai.suggest',
} as const;

export type JobType = (typeof jobTypes)[keyof typeof jobTypes];
