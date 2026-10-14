import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

import { fileStatusSchema } from './files.js';

/**
 * P-C9 — «العمليات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4): تشغيل الخدمة يومياً من
 * شاشةٍ واحدة.
 *
 * ثلاثة أسئلة في ملفٍ واحد لأن الخطة تجمعها في جزءٍ واحد:
 *
 *   1. **ما الذي تعطّل؟** — صفوف `outbox_jobs`: النوع والحالة والمحاولات والخطأ، مع فعلين
 *      لا قراءةً فقط: **إعادة** محاولةٍ ميتة و**إلغاء** مهمّةٍ لن تُنفَّذ. والفعلان يكتبان
 *      صفّ تدقيق بسببٍ مكتوب — لأن «من أعاد تشغيل طابور الفواتير في تلك الليلة؟» سؤالٌ يُسأل.
 *   2. **هل الخدمة بخير؟** — مجسّات التشغيل (قاعدة · Redis · تخزين · بريد · طابور · عاملٌ
 *      يستهلك) بجانب أرقام الطلب (العدد · نسبة الخطأ · p95) وعمر التشغيل. والمجسّ لا يقول
 *      «سليم» عمّا لم يُهيَّأ أصلاً: التخزين بلا اعتمادات حالته `not_configured` لا `up`.
 *   3. **ما الملفات التي عندنا، وأيٌّ منها نظيف؟** — مدير ملفاتٍ عابر للمستأجرين. وحُكم
 *      «هل فُحص هذا الملف؟» **موجود أصلاً** في مسار التدقيق (`meta.scan` يكتبه
 *      `FilesService.finalize` عبر منفذ `VirusScanner`)، فالمدير يعرضه ولا يخترع عموداً
 *      ثانياً. ومتى ما أُضيف ماسحٌ حقيقي ظهر حكمه في نفس العمود بلا تغيير في الشاشة.
 *
 * **ولا `payload` في أي صفّ**: أسماءُ الحقول تُعرض (`payloadKeys`) والقيم لا. حمولة المهمّة
 * تخصّ عميلاً بعينه، وقارئ لوحة المنصة لا يحتاج بيانات عميلٍ ليقرّر «أُعيد المحاولة».
 */

// ───────────────────────────────────────────────────────────── الطابور والمهام

/** حالات `outbox_jobs` كما هي في الجدول — لا حالة سادسة تُخترع في العقد. */
export const platformJobStatuses = ['pending', 'published', 'dead'] as const;
export type PlatformJobStatus = (typeof platformJobStatuses)[number];

export const PLATFORM_JOB_FILTERS = ['status', 'queue', 'type', 'tenantId'] as const;
export const PLATFORM_JOB_SORTS = ['createdAt', 'runAt'] as const;

export const platformJobQuerySchema = paginationQuerySchema.extend({
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type PlatformJobQueryDto = z.infer<typeof platformJobQuerySchema>;

export const platformJobRowSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string().nullable(),
  queue: z.string(),
  type: z.string(),
  status: z.enum(platformJobStatuses),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  /** موعد الاستحقاق: مهمّةٌ مجدولة تُثبت جدولتها بوقتها لا بحالتها. */
  runAt: z.string(),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
  /** أسماء حقول الحمولة فقط — القيم لا تُعرض على اللوحة (انظر رأس الملف). */
  payloadKeys: z.array(z.string()),
});
export type PlatformJobRow = z.infer<typeof platformJobRowSchema>;

/**
 * فعلٌ على مهمّة (`retry` و`cancel`): **سببٌ إلزامي**.
 *
 * الفعلان يغيّران ما سيراه العميل لاحقاً (فاتورةٌ تُصدَر أو لا)، فلا يُقبل فعلٌ بلا كلمةٍ
 * تُفسّره في مسار التدقيق.
 */
export const platformJobActionSchema = z
  .object({
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type PlatformJobAction = z.infer<typeof platformJobActionSchema>;

/**
 * ما يفعله الفعلان — مكتوباً هنا لأن الشاشة والاختبار والسكربت تشتقّ منه:
 *
 * - **إعادة** (`retry`): تعود الصفّ `pending`، وتُصفَّر المحاولات، ويُمسح الخطأ، ويصير
 *   `runAt` الآن. صفٌّ ميت (أو معلَّق) يعود إلى الطابور بلا فقدان تاريخه — التاريخ في التدقيق.
 * - **إلغاء** (`cancel`): يصير الصفّ `dead` بـ`processedAt` وسببٍ في `lastError`، فلا
 *   يستهلكه الناشر. ولا حالة `cancelled` جديدة: الجدول يعرف ثلاث حالات، وإضافة رابعة تكسر
 *   `OUTBOX_FILTERS` ومسارات القراءة كلها مقابل تمييزٍ يحمله نصّ السبب.
 */
export const platformJobActions = {
  retry: { status: 'pending', clearsAttempts: true, clearsError: true },
  cancel: { status: 'dead', clearsAttempts: false, clearsError: false },
} as const;

/**
 * نبض العامل — «هل يوجد من يستهلك الطابور أصلاً؟».
 *
 * `WORKER=0` حالةٌ مشروعة في التطوير (ولا شيء يُفقد: الصفوف تبقى `pending`)، لكنها
 * **حادثةٌ في الإنتاج**. فالحقل يفرّق بين «لا عامل» و«عاملٌ لا يعمل»: الأول تكوينٌ مصرَّح،
 * والثاني `degraded`.
 */
export const workerHeartbeatSchema = z.object({
  running: z.boolean(),
  enabled: z.boolean(),
  oldestPendingAgeSeconds: z.number().int().min(0).nullable(),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

// ───────────────────────────────────────────────────────────── صحة الخدمة

export const healthProbeNames = ['database', 'redis', 'storage', 'email', 'queue', 'worker'] as const;
export type HealthProbeName = (typeof healthProbeNames)[number];

/** `not_configured` ليست `down`: الأولى قرارُ نشر، والثانية عطل. */
export const healthProbeStatuses = ['up', 'degraded', 'down', 'not_configured'] as const;
export type HealthProbeStatus = (typeof healthProbeStatuses)[number];

export const healthProbeSchema = z.object({
  name: z.enum(healthProbeNames),
  status: z.enum(healthProbeStatuses),
  detail: z.string(),
  /** زمن استجابة المجسّ نفسه — `null` لمن لا استجابة له (تكوينٌ غائب). */
  latencyMs: z.number().min(0).nullable(),
});
export type HealthProbe = z.infer<typeof healthProbeSchema>;

export const platformHealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checkedAt: z.string(),
  startedAt: z.string(),
  uptimeSeconds: z.number().int().min(0),
  /** لافتة الحادث: مصدرها `platform.maintenance*` في إعدادات المنصة — لا نصٌّ في الشاشة. */
  incident: z.object({
    active: z.boolean(),
    message: z.string().nullable(),
  }),
  requests: z.object({
    count: z.number().int().min(0),
    errors: z.number().int().min(0),
    /** 0..1 — يُحسب من عدّادات العملية نفسها (5xx)، ويُقرأ كما هو. */
    errorRate: z.number().min(0).max(1),
    /** من مصفوفة القياس ذات الدلاء — لا تقدير. */
    p95Ms: z.number().min(0),
  }),
  backlog: z.object({
    pending: z.number().int().min(0),
    published: z.number().int().min(0),
    dead: z.number().int().min(0),
    oldestPendingAgeSeconds: z.number().int().min(0).nullable(),
  }),
  probes: z.array(healthProbeSchema),
});
export type PlatformHealth = z.infer<typeof platformHealthSchema>;

// ───────────────────────────────────────────────────────────── مدير الملفات

export const platformFileScanVerdicts = ['clean', 'infected', 'skipped'] as const;
export type PlatformFileScanVerdict = (typeof platformFileScanVerdicts)[number];

export const PLATFORM_FILE_FILTERS = ['status', 'tenantId', 'entity', 'scan'] as const;

export const platformFileScanSchema = z.object({
  verdict: z.enum(platformFileScanVerdicts),
  scanner: z.string(),
  detail: z.string().nullable(),
  /** وقت الفحص — يُقرأ من صفّ التدقيق لا من عمودٍ لا وجود له. */
  recordedAt: z.string(),
});
export type PlatformFileScan = z.infer<typeof platformFileScanSchema>;

export const platformFileRowSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string().nullable(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().min(0),
  status: fileStatusSchema,
  entity: z.string().nullable(),
  entityId: z.string().nullable(),
  uploadedByLabel: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  /** `null` = لم يُفحص بعد (لا «نظيف»). الشاشة تقول ذلك بالحرف. */
  scan: platformFileScanSchema.nullable(),
});
export type PlatformFileRow = z.infer<typeof platformFileRowSchema>;

export const platformFileQuerySchema = paginationQuerySchema.extend({
  /** بحثٌ في اسم الملف (جزءٌ من الاسم، بلا حساسية لحالة الأحرف). */
  q: z.string().trim().max(120).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type PlatformFileQueryDto = z.infer<typeof platformFileQuerySchema>;

/** فعلٌ على ملف: حجرٌ (إزالة) أو فحصٌ الآن — كلاهما بسببٍ مكتوب. */
export const platformFileActionSchema = z
  .object({
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type PlatformFileAction = z.infer<typeof platformFileActionSchema>;

/** نتيجة `POST /platform/files/:id/scan` — حكم الماسح كما خرج، وبلا تجميل. */
export const platformFileScanResultSchema = z.object({
  fileId: uuidSchema,
  verdict: z.enum(platformFileScanVerdicts),
  scanner: z.string(),
  detail: z.string().nullable(),
  scannedAt: z.string(),
});
export type PlatformFileScanResult = z.infer<typeof platformFileScanResultSchema>;

// ───────────────────────────────────────────────────────────── التدقيق

/** أفعال P-C9 في مسار التدقيق — أربعة، كلٌّ منها يغيّر ما سيراه الناس. */
export const operationsAuditActions = {
  jobRetry: 'platform.job.retry',
  jobCancel: 'platform.job.cancel',
  fileScan: 'platform.file.scan',
  filePurge: 'platform.file.purge',
} as const;
