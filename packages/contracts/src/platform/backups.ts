import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * P-C10 — «البيانات والاسترجاع» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4): «نسخة تُغادر
 * القاعدة فعلاً، وسياسة احتفاظ، وحقّ نسيان».
 *
 * ثلاثة عقود في ملفٍ واحد لأن الخطة تجمعها في جزءٍ واحد:
 *
 *   1. **النسخة** — تشغيلُ نسخةٍ منطقية للقاعدة كاملةً (أو لمستأجرٍ واحد) إلى ملفٍّ يحمل
 *      بصمة `sha256` وحجمه بالبايت، ثم **التحقّق** بإعادة قراءة الملف من مكانه وحساب
 *      البصمة مرّةً أخرى. «نسخة» بلا ملفٍّ يُقرأ ليست نسخة: لهذا العقد يفصل `bytes` و
 *      `checksum` عن `status`.
 *   2. **الاحتفاظ** — نوافذ زمنية **مكتوبة وقابلة للتعديل**، لكل نافذة ما سيُمسَح عند
 *      تطبيقها (عدداً)، ومعها ثابتٌ لا يتغيّر: `auditHardDeleteAllowed: false`. سجلّ
 *      التدقيق لا يُمحى أبداً — يُؤرشَف بالعمر ولا يُحذف.
 *   3. **طلبات البيانات** — تصديرٌ لبيانات شخصٍ بعينه، وطلبُ محوٍ يُخفي الهوية فعلاً
 *      (`export` / `erase`). والعقد يفصل «ما مُحي» عن «ما بقي بحكم القانون» صراحةً، فلا
 *      تُوعد الشاشة بما لا يفعله الكود.
 */

// ───────────────────────────────────────────────────────────── النسخ

/** نطاق النسخة: المنصّة كاملةً (كل مستأجر في سياقه) أو مستأجرٌ واحد. */
export const platformBackupScopes = ['platform', 'tenant'] as const;
export type PlatformBackupScope = (typeof platformBackupScopes)[number];

export const platformBackupStatuses = ['running', 'succeeded', 'failed'] as const;
export type PlatformBackupStatus = (typeof platformBackupStatuses)[number];

/**
 * أين استقرّ الملف. `object-storage` = MinIO/S3 عبر `ObjectStoragePort` القائم،
 * و`filesystem` = نظام ملفات الخادم حين لا اعتمادات تخزين — والشاشة تقول أيّهما، فلا
 * يُوهم المشغّل أنّ نسخته غادرت الجهاز وهي عليه.
 */
export const platformBackupStores = ['object-storage', 'filesystem'] as const;
export type PlatformBackupStore = (typeof platformBackupStores)[number];

export const platformBackupArtifactKinds = ['platform-dump', 'data-export'] as const;
export type PlatformBackupArtifactKind = (typeof platformBackupArtifactKinds)[number];

export const PLATFORM_BACKUP_FILTERS = ['status', 'scope', 'tenantId', 'store'] as const;
export const PLATFORM_BACKUP_SORTS = ['startedAt', 'bytes', 'durationMs'] as const;

export const platformBackupQuerySchema = paginationQuerySchema.extend({
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type PlatformBackupQueryDto = z.infer<typeof platformBackupQuerySchema>;

export const platformBackupRunSchema = z
  .object({
    scope: z.enum(platformBackupScopes).default('platform'),
    /** مطلوبٌ مع `scope: 'tenant'` — ومرفوضٌ معه الغياب بـ422 لا بصمت. */
    tenantId: uuidSchema.optional(),
    note: z.string().trim().min(3).max(500).optional(),
  })
  .refine((value) => value.scope !== 'tenant' || value.tenantId !== undefined, {
    message: 'tenantId is required when scope is "tenant"',
    path: ['tenantId'],
  });
export type PlatformBackupRunInput = z.infer<typeof platformBackupRunSchema>;

/**
 * صفُّ نسخةٍ كما يُقرأ من القاعدة. `bytes` و`checksum` يأتيان من الملف بعد كتابته
 * فعلاً (قراءةٌ من المكان الذي استقرّ فيه)، لا من تقديرٍ في الطلب — ولذلك يقبلان `null`
 * لنسخةٍ فشلت قبل أن تُكتب.
 */
export const platformBackupRowSchema = z.object({
  id: uuidSchema,
  scope: z.enum(platformBackupScopes),
  tenantId: uuidSchema.nullable(),
  tenantCode: z.string().nullable(),
  status: z.enum(platformBackupStatuses),
  store: z.enum(platformBackupStores).nullable(),
  note: z.string().nullable(),
  failureReason: z.string().nullable(),
  tables: z.number().int().min(0),
  rows: z.number().int().min(0),
  tenants: z.number().int().min(0),
  bytes: z.number().int().min(0).nullable(),
  checksum: z.string().nullable(),
  encryption: z.string().nullable(),
  objectKey: z.string().nullable(),
  artifactId: uuidSchema.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  verifiedAt: z.string().nullable(),
  prunedAt: z.string().nullable(),
  requestedBy: uuidSchema.nullable(),
  requestedByLabel: z.string().nullable(),
});
export type PlatformBackupRow = z.infer<typeof platformBackupRowSchema>;

/** جدولٌ واحد كما عدّه التحقّق من داخل الملف — لا كما وعد به الطلب. */
export const platformBackupTableCountSchema = z.object({
  table: z.string(),
  rows: z.number().int().min(0),
});
export type PlatformBackupTableCount = z.infer<typeof platformBackupTableCountSchema>;

export const platformBackupVerifyResultSchema = z.object({
  jobId: uuidSchema,
  verified: z.boolean(),
  /** البصمة كما هي في الصفّ مقابل البصمة المحسوبة الآن من البايتات المخزّنة. */
  checksum: z.object({
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    matches: z.boolean(),
  }),
  bytes: z.number().int().min(0).nullable(),
  encryption: z.string().nullable(),
  format: z.string().nullable(),
  lines: z.number().int().min(0),
  tables: z.array(platformBackupTableCountSchema),
  tenants: z.array(z.string()),
  totalRows: z.number().int().min(0),
  /** `true` إذا نقص سطر الذيل أو اختلفت عدّاداته عن المحتوى. */
  truncated: z.boolean(),
  restore: z.object({
    mode: z.literal('dry_run'),
    tables: z.number().int().min(0),
    rows: z.number().int().min(0),
    /** جداول في النسخة لم تعد موجودة في القاعدة — انحرافُ مخطّط يمنع الاستعادة. */
    missingTables: z.array(z.string()),
    verdict: z.enum(['ready', 'drifted', 'unreadable']),
  }),
  verifiedAt: z.string(),
  detail: z.string().nullable(),
});
export type PlatformBackupVerifyResult = z.infer<typeof platformBackupVerifyResultSchema>;

/** رابط تنزيلٍ موقّع قصير العمر — نفس نمط `download-token.ts` في الملفات. */
export const platformBackupDownloadSchema = z.object({
  jobId: uuidSchema,
  name: z.string(),
  url: z.string(),
  expiresAt: z.string(),
  bytes: z.number().int().min(0).nullable(),
  checksum: z.string().nullable(),
});
export type PlatformBackupDownload = z.infer<typeof platformBackupDownloadSchema>;

// ───────────────────────────────────────────────────────────── الاحتفاظ

export const retentionTargets = ['artifacts', 'idempotency', 'outbox', 'files'] as const;
export type RetentionTarget = (typeof retentionTargets)[number];

/**
 * سياسة الاحتفاظ. الحدود ليست زخرفة: نافذةٌ أقصر من أسبوع تُفني مفاتيح idempotency قبل أن
 * تنتهي مهلتها (24 ساعة), ونافذةُ تدقيقٍ أقصر من 90 يوماً تخالف سياسة المنصّة نفسها.
 */
export const platformRetentionPolicySchema = z.object({
  /** كم يبقى سجلّ التدقيق قبل أن يصير قابلاً للأرشفة (ولا يُحذف). */
  auditArchiveDays: z.number().int().min(90).max(3650),
  idempotencyPurgeDays: z.number().int().min(7).max(365),
  outboxPurgeDays: z.number().int().min(7).max(365),
  fileOrphanPurgeDays: z.number().int().min(1).max(90),
  artifactRetentionDays: z.number().int().min(1).max(365),
});
export type PlatformRetentionPolicy = z.infer<typeof platformRetentionPolicySchema>;

/** القيم الافتراضية — هي نفسها التي كانت مثبّتة في `computeRetentionPlan` قبل أن تُكتب. */
export const defaultPlatformRetentionPolicy: PlatformRetentionPolicy = {
  auditArchiveDays: 365,
  idempotencyPurgeDays: 30,
  outboxPurgeDays: 90,
  fileOrphanPurgeDays: 2,
  artifactRetentionDays: 30,
};

export const platformRetentionSchema = z.object({
  policy: platformRetentionPolicySchema,
  defaults: platformRetentionPolicySchema,
  updatedAt: z.string().nullable(),
  updatedBy: uuidSchema.nullable(),
  /** ما سيُمسَح الآن لو طُبِّقت السياسة — عدُّه القاعدة لا الشاشة. */
  purges: z.object({
    idempotencyExpired: z.number().int().min(0),
    outboxPurgeable: z.number().int().min(0),
    fileOrphans: z.number().int().min(0),
    artifactsExpired: z.number().int().min(0),
    auditArchivable: z.number().int().min(0),
  }),
  /** ثابتٌ مُعلَن: سجلّ التدقيق يُؤرشَف ولا يُمحى (`REVOKE UPDATE, DELETE` في القاعدة). */
  auditHardDeleteAllowed: z.literal(false),
  computedAt: z.string(),
});
export type PlatformRetention = z.infer<typeof platformRetentionSchema>;

export const platformRetentionUpdateSchema = platformRetentionPolicySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No retention windows were supplied' });
export type PlatformRetentionUpdate = z.infer<typeof platformRetentionUpdateSchema>;

export const platformRetentionApplySchema = z.object({
  /** `dry_run` افتراضاً: من أراد المسح يقولها صراحةً. */
  mode: z.enum(['dry_run', 'apply']).default('dry_run'),
  targets: z.array(z.enum(retentionTargets)).min(1).optional(),
  reason: z.string().trim().min(5).max(500),
});
export type PlatformRetentionApplyInput = z.infer<typeof platformRetentionApplySchema>;

export const platformRetentionApplyResultSchema = z.object({
  mode: z.enum(['dry_run', 'apply']),
  policy: platformRetentionPolicySchema,
  results: z.array(
    z.object({
      target: z.enum(retentionTargets),
      /** صفوفٌ مطابقة للنافذة: في `dry_run` هي العدّ، وفي `apply` ما مُسح فعلاً. */
      rows: z.number().int().min(0),
      objectsRemoved: z.number().int().min(0),
      skipped: z.string().nullable(),
    }),
  ),
  auditId: uuidSchema.nullable(),
  appliedAt: z.string(),
});
export type PlatformRetentionApplyResult = z.infer<typeof platformRetentionApplyResultSchema>;

// ───────────────────────────────────────────────────────────── طلبات البيانات

export const platformDataRequestKinds = ['export', 'erase'] as const;
export type PlatformDataRequestKind = (typeof platformDataRequestKinds)[number];

export const platformDataRequestStatuses = [
  'pending',
  'approved',
  'rejected',
  'completed',
  'cancelled',
] as const;
export type PlatformDataRequestStatus = (typeof platformDataRequestStatuses)[number];

export const PLATFORM_DATA_REQUEST_FILTERS = ['kind', 'status', 'tenantId'] as const;
export const PLATFORM_DATA_REQUEST_SORTS = ['createdAt', 'updatedAt'] as const;

export const platformDataRequestQuerySchema = paginationQuerySchema.extend({
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type PlatformDataRequestQueryDto = z.infer<typeof platformDataRequestQuerySchema>;

export const platformDataRequestCreateSchema = z.object({
  kind: z.enum(platformDataRequestKinds),
  tenantId: uuidSchema,
  subjectEmail: z.string().trim().email().max(200),
  note: z.string().trim().min(3).max(500).optional(),
});
export type PlatformDataRequestCreateInput = z.infer<typeof platformDataRequestCreateSchema>;

export const platformDataRequestDecideSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(5).max(500),
});
export type PlatformDataRequestDecideInput = z.infer<typeof platformDataRequestDecideSchema>;

export const platformDataRequestExecuteSchema = z.object({
  /**
   * المحو يحتاج تأكيداً بكتابة **البريد نفسه** — لا `confirm: true`: الفعل لا رجعة فيه،
   * والتأكيد يجب أن يكلف شيئاً. ويُقاس في الخدمة لا في الشاشة.
   */
  confirm: z.string().trim().max(200).optional(),
  reason: z.string().trim().min(5).max(500).optional(),
});
export type PlatformDataRequestExecuteInput = z.infer<typeof platformDataRequestExecuteSchema>;

export const platformDataRequestRowSchema = z.object({
  id: uuidSchema,
  kind: z.enum(platformDataRequestKinds),
  status: z.enum(platformDataRequestStatuses),
  tenantId: uuidSchema,
  tenantCode: z.string().nullable(),
  subjectEmail: z.string(),
  subjectUserId: uuidSchema.nullable(),
  note: z.string().nullable(),
  decisionNote: z.string().nullable(),
  decidedBy: uuidSchema.nullable(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  /** نتيجة التنفيذ: تصديرٌ ⇒ ملفٌّ وبصمته، ومحوٌ ⇒ ما أُخفي وما بقي. */
  result: z
    .object({
      artifactId: uuidSchema.nullable(),
      bytes: z.number().int().min(0).nullable(),
      checksum: z.string().nullable(),
      store: z.enum(platformBackupStores).nullable(),
      tables: z.number().int().min(0).nullable(),
      rows: z.number().int().min(0).nullable(),
      /** حقول `users` التي أُخفيت فعلاً — بالأسماء، لأن المشغّل يسأل «ماذا محوت؟». */
      anonymisedFields: z.array(z.string()).nullable(),
      anonymisedUsers: z.number().int().min(0).nullable(),
      /**
       * العضويات المسحوبة. والجدول لا يعرف حالة `revoked` (`active|invited|suspended`
       * منذ الترحيل 0000)، فالسحب يُنفَّذ بـ`suspended` — ولا يُوسَّع قيدُ جدولٍ قائم من
       * أجل تسمية. والاسم هنا يصف الفعل الذي جرى: العضوية لم تعد فعّالة.
       */
      suspendedMemberships: z.number().int().min(0).nullable(),
      /** الجلسات المُبطلة: `refresh_tokens.revoked_at` هو العمود الذي يحمل هذا المعنى. */
      revokedSessions: z.number().int().min(0).nullable(),
      /** ما بقي بحكم القانون: صفوف التدقيق التي تذكر الذات — تُعدّ ولا تُمحى. */
      retainedAuditRows: z.number().int().min(0).nullable(),
      subjectRef: z.string().nullable(),
    })
    .nullable(),
  requestedBy: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type PlatformDataRequestRow = z.infer<typeof platformDataRequestRowSchema>;

export const platformDataRequestExportSchema = z.object({
  requestId: uuidSchema,
  subjectRef: z.string(),
  artifactId: uuidSchema,
  objectKey: z.string(),
  store: z.enum(platformBackupStores),
  bytes: z.number().int().min(0),
  checksum: z.string(),
  tables: z.array(platformBackupTableCountSchema),
  totalRows: z.number().int().min(0),
  downloadUrl: z.string(),
  expiresAt: z.string(),
});
export type PlatformDataRequestExport = z.infer<typeof platformDataRequestExportSchema>;

export const platformDataRequestEraseResultSchema = z.object({
  requestId: uuidSchema,
  subjectRef: z.string(),
  subjectUserId: uuidSchema.nullable(),
  anonymisedFields: z.array(z.string()),
  anonymisedUsers: z.number().int().min(0),
  suspendedMemberships: z.number().int().min(0),
  revokedSessions: z.number().int().min(0),
  retainedAuditRows: z.number().int().min(0),
  executedAt: z.string(),
});
export type PlatformDataRequestEraseResult = z.infer<typeof platformDataRequestEraseResultSchema>;

// ───────────────────────────────────────────────────────────── التدقيق

/** أفعال P-C10 في مسار التدقيق — كلٌّ منها إمّا يمسح بايتات أو يُخفي هوية. */
export const backupAuditActions = {
  run: 'platform.backup.run',
  verify: 'platform.backup.verify',
  download: 'platform.backup.download',
  retentionUpdate: 'platform.retention.update',
  retentionApply: 'platform.retention.apply',
  dataRequestCreate: 'platform.data-request.create',
  dataRequestDecide: 'platform.data-request.decide',
  dataRequestExport: 'platform.data-request.export',
  dataRequestErase: 'platform.data-request.erase',
} as const;
