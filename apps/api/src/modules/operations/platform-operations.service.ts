import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  buildMeta,
  errorCodes,
  DomainError,
  operationsAuditActions,
  parseFilters,
  parseSort,
  type HealthProbe,
  type ListEnvelope,
  type PlatformFileQueryDto,
  type PlatformFileRow,
  type PlatformFileScanResult,
  type PlatformHealth,
  type PlatformJobQueryDto,
  type PlatformJobRow,
  type WorkerHeartbeat,
} from '@erp/contracts';
import { env } from '@erp/config';
import {
  files,
  outboxJobs,
  platformSettings,
  tenants,
  withPlatformAdminTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { MetricsService } from '../../ops/metrics.service.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { OBJECT_STORAGE, type ObjectStoragePort } from '../platform-services/files/object-storage.js';
import { VIRUS_SCANNER, type VirusScannerPort } from '../platform-services/files/virus-scanner.js';
import { QUEUE_PORT, type QueuePort } from '../platform-services/jobs/queue.service.js';

/** `filter[status]` — ثلاث حالات، كما في الجدول؛ وأي شيء غيرها 400 لا صفرُ نتائج. */
const JOB_STATUSES = ['pending', 'published', 'dead'] as const;
const FILE_STATUSES = ['pending', 'ready', 'deleted'] as const;
/** `filter[scan]` — القيم المحسوبة، وفيها `none` لمن لم يُفحص (الغياب ليس حكماً). */
const SCAN_FILTERS = ['clean', 'infected', 'skipped', 'none'] as const;

/**
 * P-C9 — «العمليات»: الطابور وصحة الخدمة ومدير الملفات.
 *
 * القاعدة التي تحكم هذا الملف: **ما يُعرض مقيَّسٌ من مصدره، لا مُعادٌ تركيبه**. حالات
 * الطابور من `outbox_jobs`, والأخطاء من عدّاد الوسيط, والـp95 من دلاء `MetricsService`,
 * وحكم الفحص من صفّ التدقيق الذي كتبه `FilesService` لحظة التهيئة. والشاشة تقرأ ولا تحسب،
 * فلا يمكن أن تقول «كل شيء سليم» بينما الصفوف تقول غير ذلك.
 *
 * وإجراءان بحدودٍ مكتوبة:
 *
 *   - **`retry`** يعيد صفّاً (معلَّقاً أو ميتاً) إلى `pending` ببلا محاولاتٍ ولا خطأ، وبوقت
 *     استحقاقٍ الآن. ولا يُمسّ `published`: مهمّةٌ نُفِّذت إعادتها تنفيذٌ ثانٍ، وهذا قرار
 *     ناشرها لا قرار قارئ الطابور.
 *   - **`cancel`** يوسم الصفّ `dead` بخطأٍ يحمل السبب. ولا حالة `cancelled` رابعة: الجدول
 *     يعرف ثلاث حالات، و`OUTBOX_FILTERS` مبنيّ عليها، والتمييز يحمله نصّ السبب.
 *   - **`scan`** يشغّل الماسح المربوط (وهو `NoopVirusScanner` اليوم) **ويسجّل حكمه** ولا
 *     يكذب: النتيجة `skipped` تُعرض `skipped`. وقرار «لا ماسحَ مُهيّأ» لا يُترجَم إلى «نظيف».
 *   - **`DELETE /platform/files/:id`** حجرٌ لا محو: الصفّ يصير `deleted`، والميتاداتا تبقى
 *     (وحذف الصفوف غير ممنوع على `erp_api`، فالحجر يُنفَّذ ولا يُوعَد فقط).
 */
@Injectable()
export class PlatformOperationsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScannerPort,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────── الطابور

  async listJobs(query: PlatformJobQueryDto): Promise<ListEnvelope<PlatformJobRow>> {
    const filters = parseFilters(query.filter, ['status', 'queue', 'type', 'tenantId'] as const);
    const [sort] = parseSort(query.sort, ['createdAt', 'runAt'] as const);
    const orderBy = sort
      ? sort.direction === 'asc'
        ? asc(sort.column === 'runAt' ? outboxJobs.runAt : outboxJobs.createdAt)
        : desc(sort.column === 'runAt' ? outboxJobs.runAt : outboxJobs.createdAt)
      : desc(outboxJobs.createdAt);

    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(outboxJobs.status, this.assertJobStatus(filters.status)));
    if (filters.queue) conditions.push(eq(outboxJobs.queue, filters.queue));
    if (filters.type) conditions.push(eq(outboxJobs.type, filters.type));
    if (filters.tenantId) conditions.push(eq(outboxJobs.tenantId, filters.tenantId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const totalRow = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(outboxJobs)
        .where(where);
      const rows = await tx
        .select({
          id: outboxJobs.id,
          tenantId: outboxJobs.tenantId,
          tenantCode: tenants.code,
          queue: outboxJobs.queue,
          type: outboxJobs.type,
          status: outboxJobs.status,
          attempts: outboxJobs.attempts,
          lastError: outboxJobs.lastError,
          runAt: outboxJobs.runAt,
          processedAt: outboxJobs.processedAt,
          createdAt: outboxJobs.createdAt,
          payload: outboxJobs.payload,
        })
        .from(outboxJobs)
        .leftJoin(tenants, eq(tenants.id, outboxJobs.tenantId))
        .where(where)
        .orderBy(orderBy)
        .limit(query.limit)
        .offset(query.offset);

      return {
        data: rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          tenantCode: row.tenantCode ?? null,
          queue: row.queue,
          type: row.type,
          status: this.asJobStatus(row.status),
          attempts: row.attempts,
          lastError: row.lastError ?? null,
          runAt: row.runAt.toISOString(),
          processedAt: row.processedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          // أسماء الحقول فقط: القيم تخصّ عميلاً بعينه ولا يحتاجها قرار «أُعيد المحاولة».
          payloadKeys: Object.keys(row.payload ?? {}),
        })),
        meta: buildMeta(totalRow[0]?.value ?? 0, query),
      };
    });
  }

  /** `POST /platform/jobs/:id/retry` — صفٌّ معلَّق أو ميت يعود إلى الطابور بلا تاريخه. */
  async retryJob(jobId: string, reason: string, actorUserId: string): Promise<PlatformJobRow> {
    return this.mutateJob(jobId, reason, actorUserId, {
      action: operationsAuditActions.jobRetry,
      apply: (tx) =>
        tx
          .update(outboxJobs)
          .set({ status: 'pending', attempts: 0, lastError: null, runAt: new Date(), processedAt: null })
          .where(eq(outboxJobs.id, jobId)),
      describe: () => ({ status: 'pending' as const, clearedAttempts: true }),
    });
  }

  /** `POST /platform/jobs/:id/cancel` — ما لن يُنفَّذ يوسم `dead` بسببه، فلا يستهلكه الناشر. */
  async cancelJob(jobId: string, reason: string, actorUserId: string): Promise<PlatformJobRow> {
    return this.mutateJob(jobId, reason, actorUserId, {
      action: operationsAuditActions.jobCancel,
      apply: (tx) =>
        tx
          .update(outboxJobs)
          .set({ status: 'dead', processedAt: new Date(), lastError: `أُلغيت من لوحة المنصة: ${reason}` })
          .where(eq(outboxJobs.id, jobId)),
      describe: () => ({ status: 'dead' as const, clearedAttempts: false }),
    });
  }

  /**
   * قلب الفعلين: يقرأ الصفّ بـ`FOR UPDATE` (فعلان متزامنان لا يتسابقان)، ثم يكتب ويسجّل —
   * كلّه في معاملةٍ واحدة. ولا يُعاد صفٌّ `published`: تنفيذُ مهمّةٍ نُفِّذت مرّةً ثانية
   * قرارُ ناشرها لا قرار لوحة المنصة.
   */
  private async mutateJob(
    jobId: string,
    reason: string,
    actorUserId: string,
    effect: {
      action: string;
      apply: (tx: DrizzleTx) => Promise<unknown>;
      describe: () => { status: 'pending' | 'dead'; clearedAttempts: boolean };
    },
  ): Promise<PlatformJobRow> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const locked = await tx.execute(
        sql`SELECT id, tenant_id, status FROM outbox_jobs WHERE id = ${jobId}::uuid FOR UPDATE`,
      );
      const rows = (locked as unknown as { rows?: Array<{ tenant_id: string; status: string }> }).rows ?? [];
      const current = rows[0];
      if (!current) {
        throw new DomainError(errorCodes.NOT_FOUND, `No job with id ${jobId}`, 404, { field: 'id' });
      }
      if (current.status === 'published') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'A published job already ran; re-running it is the publisher’s decision, not the console’s',
          422,
          { field: 'status' },
        );
      }
      if (effect.action === operationsAuditActions.jobRetry && current.status === 'pending') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'The job is already pending', 422, {
          field: 'status',
        });
      }

      const before = await this.loadJobRow(tx, jobId);
      await effect.apply(tx);
      const after = await this.loadJobRow(tx, jobId);

      await this.audit.recordInTx(tx, {
        tenantId: current.tenant_id,
        actorUserId,
        membershipId: null,
        action: effect.action,
        entity: 'outbox_jobs',
        entityId: jobId,
        before,
        after,
        meta: { reason, ...effect.describe() },
      });

      return after;
    });
  }

  private async loadJobRow(tx: DrizzleTx, jobId: string): Promise<PlatformJobRow> {
    const [row] = await tx
      .select({
        id: outboxJobs.id,
        tenantId: outboxJobs.tenantId,
        tenantCode: tenants.code,
        queue: outboxJobs.queue,
        type: outboxJobs.type,
        status: outboxJobs.status,
        attempts: outboxJobs.attempts,
        lastError: outboxJobs.lastError,
        runAt: outboxJobs.runAt,
        processedAt: outboxJobs.processedAt,
        createdAt: outboxJobs.createdAt,
        payload: outboxJobs.payload,
      })
      .from(outboxJobs)
      .leftJoin(tenants, eq(tenants.id, outboxJobs.tenantId))
      .where(eq(outboxJobs.id, jobId))
      .limit(1);
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, `No job with id ${jobId}`, 404, { field: 'id' });
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantCode: row.tenantCode ?? null,
      queue: row.queue,
      type: row.type,
      status: this.asJobStatus(row.status),
      attempts: row.attempts,
      lastError: row.lastError ?? null,
      runAt: row.runAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      payloadKeys: Object.keys(row.payload ?? {}),
    };
  }

  /**
   * نبض العامل — مقروءاً من الطابور لا من الشاشة: أقدم صفٍّ معلَّق هو المحك. طابورٌ فيه
   * معلَّقات قديمة **بلا عامل** عطلٌ، وطابورٌ فارغ بلا عامل ليس عطلاً.
   */
  async workerHeartbeat(): Promise<WorkerHeartbeat> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const [row] = await tx
        .select({
          oldest: sql<string | null>`min(${outboxJobs.runAt})::text`,
        })
        .from(outboxJobs)
        .where(eq(outboxJobs.status, 'pending'));
      const oldest = row?.oldest ? new Date(this.iso(row.oldest)) : null;
      return {
        running: env.WORKER,
        enabled: this.queue.isEnabled(),
        oldestPendingAgeSeconds: oldest
          ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000))
          : null,
      };
    });
  }

  // ─────────────────────────────────────────────────────────── الصحة

  /**
   * `GET /platform/health/detailed` — كل مجسٍّ يُقاس لحظته، والنتيجة الإجمالية أسوأ حالة.
   *
   * و**`not_configured` ليست `down`**: تخزينٌ بلا اعتماداتٍ قرارُ نشر (يُطوَّر بلا S3)،
   * وRedis بلا `REDIS_URL` كذلك — والوحيد الذي لا يُتسامح معه هو قاعدةُ البيانات.
   */
  async health(): Promise<PlatformHealth> {
    const probes: HealthProbe[] = [];
    const worker = await this.workerHeartbeat();
    const backlog = await this.backlog();

    probes.push(await this.probeDatabase());
    probes.push(this.probeRedis());
    probes.push(this.probeStorage());
    probes.push(await this.probeEmail());
    probes.push(this.probeQueue(worker, backlog));
    probes.push({
      name: 'worker',
      status: worker.running ? 'up' : backlog.pending > 0 ? 'degraded' : 'not_configured',
      detail: worker.running
        ? worker.oldestPendingAgeSeconds === null
          ? 'العامل يعمل ولا صفوف معلَّقة'
          : `العامل يعمل — أقدم معلَّقة قبل ${worker.oldestPendingAgeSeconds} ثانية`
        : backlog.pending > 0
          ? `لا عامل يعمل و${backlog.pending} مهمّة معلَّقة لن تُنفَّذ`
          : 'لا عامل يعمل ولا صفوف معلَّقة (WORKER=0)',
      latencyMs: null,
    });

    const requests = this.metrics.requestSummary();
    const incident = await this.incident();

    return {
      status: this.rollUp(probes),
      checkedAt: new Date().toISOString(),
      startedAt: new Date(this.metrics.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.metrics.startedAt) / 1000),
      incident,
      requests,
      backlog,
      probes,
    } as PlatformHealth;
  }

  private async probeDatabase(): Promise<HealthProbe> {
    const started = performance.now();
    try {
      await this.database.db.execute(sql`SELECT 1`);
      return {
        name: 'database',
        status: 'up',
        detail: 'اتصال القراءة والكتابة سليم',
        latencyMs: round2(performance.now() - started),
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'down',
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: round2(performance.now() - started),
      };
    }
  }

  private probeRedis(): HealthProbe {
    const configured = Boolean(env.REDIS_URL);
    return {
      name: 'redis',
      status: !configured ? 'not_configured' : this.queue.isEnabled() ? 'up' : 'degraded',
      detail: !configured
        ? 'REDIS_URL غير مضبوط — الطابور في الذاكرة والصفوف تبقى معلَّقة'
        : this.queue.isEnabled()
          ? `سائق الطابور: ${this.queue.driver}`
          : 'JOBS_ENABLED=false — الطابور معطَّل بقرار تكوين',
      latencyMs: null,
    };
  }

  private probeStorage(): HealthProbe {
    return {
      name: 'storage',
      status: this.storage.isConfigured() ? 'up' : 'not_configured',
      detail: this.storage.isConfigured()
        ? `الدفعة: ${this.storage.bucket}`
        : 'لا اعتمادات تخزين كائنات — الرفع المباشر معطَّل (الميتاداتا تبقى سليمة)',
      latencyMs: null,
    };
  }

  /** البريد: المزوّد والإعداد الفعّال — «هل يوجد من يتكلّم؟» يُجاب من الحالة لا من الظنّ. */
  private async probeEmail(): Promise<HealthProbe> {
    try {
      const [row] = await withPlatformAdminTx(this.database.db, async (tx) =>
        tx
          .select({ raw: sql<string>`${platformSettings.value}::text` })
          .from(platformSettings)
          .where(and(isNull(platformSettings.tenantId), eq(platformSettings.key, 'email.provider')))
          .limit(1),
      );
      const provider = row?.raw ? (JSON.parse(row.raw) as string) : 'console';
      return {
        name: 'email',
        status: provider === 'smtp' ? 'up' : 'degraded',
        detail:
          provider === 'smtp'
            ? 'المزوّد SMTP — الرسائل تخرج فعلاً'
            : 'المزوّد console — الرسائل تُسجَّل ولا تُرسل (مقصود في التطوير)',
        latencyMs: null,
      };
    } catch (error) {
      return {
        name: 'email',
        status: 'degraded',
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: null,
      };
    }
  }

  private probeQueue(worker: WorkerHeartbeat, backlog: PlatformHealth['backlog']): HealthProbe {
    return {
      name: 'queue',
      status: backlog.dead > 0 ? 'degraded' : worker.enabled ? 'up' : 'not_configured',
      detail:
        backlog.dead > 0
          ? `${backlog.dead} مهمّة ميتة تحتاج قراراً`
          : worker.enabled
            ? `${backlog.pending} معلَّقة · ${backlog.published} نُفِّذت`
            : 'الطابور معطَّل — الصفوف تتراكم في القاعدة بلا خسارة',
      latencyMs: null,
    };
  }

  private async backlog(): Promise<PlatformHealth['backlog']> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const [counts] = await tx
        .select({
          pending: sql<number>`count(*) filter (where ${outboxJobs.status} = 'pending')::int`,
          published: sql<number>`count(*) filter (where ${outboxJobs.status} = 'published')::int`,
          dead: sql<number>`count(*) filter (where ${outboxJobs.status} = 'dead')::int`,
          oldest: sql<
            string | null
          >`min(${outboxJobs.runAt}) filter (where ${outboxJobs.status} = 'pending')::text`,
        })
        .from(outboxJobs);
      const oldest = counts?.oldest ? new Date(this.iso(counts.oldest)) : null;
      return {
        pending: counts?.pending ?? 0,
        published: counts?.published ?? 0,
        dead: counts?.dead ?? 0,
        oldestPendingAgeSeconds: oldest
          ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000))
          : null,
      };
    });
  }

  /** لافتة الحادث من `platform.maintenance*` — مصدرها الإعدادات لا نصٌّ في الشاشة. */
  private async incident(): Promise<PlatformHealth['incident']> {
    const rows = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .select({ key: platformSettings.key, raw: sql<string>`${platformSettings.value}::text` })
        .from(platformSettings)
        .where(
          and(
            isNull(platformSettings.tenantId),
            sql`${platformSettings.key} in ('platform.maintenance', 'platform.maintenance_message')`,
          ),
        ),
    );
    const value = new Map(rows.map((row) => [row.key, row.raw]));
    const raw = value.get('platform.maintenance');
    const active = raw === undefined ? false : JSON.parse(raw) === true;
    const messageRaw = value.get('platform.maintenance_message');
    const message = messageRaw === undefined ? null : asText(JSON.parse(messageRaw));
    return { active, message: active ? message : null };
  }

  private rollUp(probes: HealthProbe[]): 'ok' | 'degraded' | 'down' {
    if (probes.some((probe) => probe.status === 'down')) return 'down';
    if (probes.some((probe) => probe.status === 'degraded')) return 'degraded';
    return 'ok';
  }

  // ─────────────────────────────────────────────────────────── الملفات

  /**
   * `GET /platform/files` — مدير الملفات عبر المستأجرين.
   *
   * حكم الفحص يُقرأ من **مسار التدقيق** (`audit_log` حيث `entity='files'` و`meta.scan`
   * موجود) لا من عمودٍ ثانٍ يوازيه ويفارقه. وهذا يجعل عمود الشاشة صادقاً تلقائياً: ما كتبه
   * مسار الرفع هو ما يُعرض، ومتى رُبط ماسحٌ حقيقي ظهر حكمه في نفس المكان.
   */
  async listFiles(query: PlatformFileQueryDto): Promise<ListEnvelope<PlatformFileRow>> {
    const filters = parseFilters(query.filter, ['status', 'tenantId', 'entity', 'scan'] as const);
    const scan = filters.scan ? this.assertEnum(filters.scan, SCAN_FILTERS, 'filter[scan]') : undefined;
    const status = filters.status
      ? this.assertEnum(filters.status, FILE_STATUSES, 'filter[status]')
      : undefined;
    const search = query.q ? `%${query.q}%` : null;

    // استعلامٌ خام واحد: الانضمام المؤجَّل لحكم الفحص (`DISTINCT ON`) لا يُعبَّر عنه بمُخطِّط
    // drizzle بلا جدولٍ وهمي، ومن يرغب في قراءة العمود يقرؤه هنا مباشرةً.
    //
    // و`audit_log.entity_id` **نصٌّ** لا uuid (الجدول يعمّ كل الكيانات)، فالمطابقة
    // `f.id::text = s.entity_id` — بدونها يرفض postgres المقارنة بـ«العامل غير موجود»
    // ويصل الخطأ إلى المستخدم 500 بلا معنى.
    const where = sql`
      where 1 = 1
        ${status ? sql`and f.status = ${status}` : sql``}
        ${filters.tenantId ? sql`and f.tenant_id = ${filters.tenantId}::uuid` : sql``}
        ${filters.entity ? sql`and f.entity = ${filters.entity}` : sql``}
        ${search ? sql`and f.name ilike ${search}` : sql``}
        ${scan === 'none' ? sql`and s.verdict is null` : sql``}
        ${scan && scan !== 'none' ? sql`and s.verdict = ${scan}` : sql``}
    `;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (await tx.execute(sql`
        select
          f.id, f.tenant_id, t.code as tenant_code, f.name, f.mime, f.size_bytes, f.status,
          f.entity, f.entity_id, coalesce(u.full_name, u.email) as uploaded_by_label,
          f.created_at, f.deleted_at,
          s.verdict as scan_verdict, s.scanner as scan_scanner, s.detail as scan_detail,
          s.recorded_at as scan_at,
          count(*) over () as total
        from files f
        left join (
          select distinct on (entity_id)
            entity_id,
            meta->'scan'->>'status'  as verdict,
            meta->'scan'->>'scanner' as scanner,
            meta->'scan'->>'detail'  as detail,
            created_at               as recorded_at
          from audit_log
          where entity = 'files' and meta ? 'scan'
          order by entity_id, created_at desc
        ) s on s.entity_id = f.id::text
        left join tenants t on t.id = f.tenant_id
        left join users u on u.id = f.uploaded_by
        ${where}
        order by f.created_at desc
        limit ${query.limit} offset ${query.offset}
      `)) as unknown as { rows?: Array<Record<string, unknown>> };
      const list = rows.rows ?? [];

      return {
        data: list.map((row) => this.toFileRow(row)),
        meta: buildMeta(Number(list[0]?.total ?? 0), query),
      };
    });
  }

  /** تحويل صفٍّ خام إلى عقد `platformFileRowSchema` — تواقيت نصّية تُطبَّع هنا. */
  private toFileRow(row: Record<string, unknown>): PlatformFileRow {
    const verdict = row.scan_verdict ? String(row.scan_verdict) : null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      tenantCode: row.tenant_code === null || row.tenant_code === undefined ? null : String(row.tenant_code),
      name: String(row.name),
      mime: String(row.mime),
      sizeBytes: Number(row.size_bytes),
      status: this.asFileStatus(String(row.status)),
      entity: row.entity === null || row.entity === undefined ? null : String(row.entity),
      entityId: row.entity_id === null || row.entity_id === undefined ? null : String(row.entity_id),
      uploadedByLabel:
        row.uploaded_by_label === null || row.uploaded_by_label === undefined
          ? null
          : String(row.uploaded_by_label),
      createdAt: this.iso(row.created_at),
      deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : this.iso(row.deleted_at),
      scan:
        verdict === null
          ? null
          : {
              verdict: verdict as 'clean' | 'infected' | 'skipped',
              scanner:
                row.scan_scanner === null || row.scan_scanner === undefined
                  ? 'unknown'
                  : String(row.scan_scanner),
              detail:
                row.scan_detail === null || row.scan_detail === undefined ? null : String(row.scan_detail),
              recordedAt: this.iso(row.scan_at),
            },
    };
  }

  /** `POST /platform/files/:id/scan` — يفحص بحكم الماسح المربوط ويكتب حكمه في التدقيق. */
  async scanFile(fileId: string, actorUserId: string): Promise<PlatformFileScanResult> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const [row] = await tx
        .select({
          id: files.id,
          tenantId: files.tenantId,
          objectKey: files.objectKey,
          mime: files.mime,
          sizeBytes: files.sizeBytes,
        })
        .from(files)
        .where(eq(files.id, fileId))
        .limit(1);
      if (!row)
        throw new DomainError(errorCodes.NOT_FOUND, `No file with id ${fileId}`, 404, { field: 'id' });

      const verdict = await this.scanner.scan(row.objectKey, row.mime, Number(row.sizeBytes));
      const scannedAt = new Date();

      await this.audit.recordInTx(tx, {
        tenantId: row.tenantId,
        actorUserId,
        membershipId: null,
        action: operationsAuditActions.fileScan,
        entity: 'files',
        entityId: row.id,
        before: null,
        after: null,
        meta: { scan: verdict, scannedAt: scannedAt.toISOString(), source: 'platform_console' },
      });

      return {
        fileId: row.id,
        verdict: verdict.status,
        scanner: verdict.scanner,
        detail: verdict.detail ?? null,
        scannedAt: scannedAt.toISOString(),
      };
    });
  }

  /**
   * `DELETE /platform/files/:id` — **حجرٌ لا محو**: الصفّ يصير `deleted` بنفس مسار حذف
   * العميل (`status='deleted'` + `deleted_at`)، والميتاداتا تبقى دليلاً. وحذف الصفوف ممنوع
   * على `erp_api` أصلاً، فالوعد والتنفيذ واحد.
   */
  async purgeFile(fileId: string, reason: string, actorUserId: string): Promise<PlatformFileRow> {
    const result = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [current] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
      if (!current)
        throw new DomainError(errorCodes.NOT_FOUND, `No file with id ${fileId}`, 404, { field: 'id' });
      if (current.status === 'deleted') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'The file is already quarantined', 422, {
          field: 'status',
        });
      }

      const [updated] = await tx
        .update(files)
        .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date(), updatedBy: actorUserId })
        .where(eq(files.id, fileId))
        .returning();

      await this.audit.recordInTx(tx, {
        tenantId: current.tenantId,
        actorUserId,
        membershipId: null,
        action: operationsAuditActions.filePurge,
        entity: 'files',
        entityId: fileId,
        before: { status: current.status },
        after: { status: 'deleted' },
        // الميتاداتا تبقى **بلا محو** — وهذا ما يجعل «لماذا حُجر؟» قابلًا للسؤال بعد سنة.
        meta: { reason, objectKeyRetained: true },
      });

      return updated ?? current;
    });

    return {
      id: result.id,
      tenantId: result.tenantId,
      tenantCode: null,
      name: result.name,
      mime: result.mime,
      sizeBytes: Number(result.sizeBytes),
      status: this.asFileStatus(result.status),
      entity: result.entity ?? null,
      entityId: result.entityId ?? null,
      uploadedByLabel: null,
      createdAt: result.createdAt.toISOString(),
      deletedAt: result.deletedAt?.toISOString() ?? null,
      scan: null,
    };
  }

  // ─────────────────────────────────────────────────────────── مساعدات

  /**
   * قيمةٌ من عمودٍ خام (قد تكون `Date` أو نصّاً) إلى ISO-8601 صالح دائماً.
   *
   * والطباعة هنا ليست تفصيلاً: `tx.execute` يعود بـ`timestamptz` **نصّاً** بصيغة postgres
   * (`2026-09-17 13:51:09.259+00`) — المسافة تفصل التاريخ عن الوقت، والإزاحة ساعتان بلا
   * دقائق. و`new Date` يرفض الاثنين فيرمي `RangeError: Invalid time value` ⇒ 500 بلا معنى
   * للمستخدم. فالتطبيع: مسافة ← `T`، وإزاحة `+HH` ← `+HH:00`، والغياب ← `Z`.
   */
  private iso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    const text = String(value ?? '').trim();
    if (text.length === 0) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'Expected a timestamp, received an empty value',
        500,
      );
    }
    const normalised = text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    const parsed = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalised) ? normalised : `${normalised}Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, `Unparsable timestamp: ${text}`, 500);
    }
    return parsed.toISOString();
  }

  private assertJobStatus(value: string) {
    return this.assertEnum(value, JOB_STATUSES, 'filter[status]');
  }

  private assertEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
    if (!allowed.includes(value as T)) {
      throw new DomainError(
        errorCodes.FILTER_NOT_ALLOWED,
        `${field} must be one of: ${allowed.join(', ')}`,
        400,
        { field },
      );
    }
    return value as T;
  }

  private asJobStatus(value: string): 'pending' | 'published' | 'dead' {
    return this.assertEnum(value, JOB_STATUSES, 'status');
  }

  private asFileStatus(value: string): 'pending' | 'ready' | 'deleted' {
    return this.assertEnum(value, FILE_STATUSES, 'status');
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** القيمة المحفوظة في `platform_settings` قد تكون نصّاً أو رقماً — يُقرأ ما فيها بلا تحويل. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}
