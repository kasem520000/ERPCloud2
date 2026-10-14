import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  backupAuditActions,
  buildMeta,
  defaultPlatformRetentionPolicy,
  DomainError,
  errorCodes,
  parseFilters,
  parseSort,
  platformRetentionPolicySchema,
  type ListEnvelope,
  type PlatformBackupQueryDto,
  type PlatformBackupRow,
  type PlatformBackupRunInput,
  type PlatformBackupVerifyResult,
  type PlatformDataRequestCreateInput,
  type PlatformDataRequestDecideInput,
  type PlatformDataRequestEraseResult,
  type PlatformDataRequestExecuteInput,
  type PlatformDataRequestExport,
  type PlatformDataRequestQueryDto,
  type PlatformDataRequestRow,
  type PlatformRetention,
  type PlatformRetentionApplyInput,
  type PlatformRetentionApplyResult,
  type PlatformRetentionPolicy,
  type RetentionTarget,
} from '@erp/contracts';
import { env } from '@erp/config';
import {
  backupArtifacts,
  backupJobs,
  dataRequests,
  files,
  newId,
  tenants,
  users,
  withPlatformAdminTx,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { platformActorLabel } from '../email/actor-label.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { signDownloadToken } from '../platform-services/files/download-token.js';

import {
  openArtifact,
  ARTIFACT_STORE_FS,
  ARTIFACT_STORE_S3,
  type ArtifactStorePort,
} from './artifact-store.js';
import {
  encodeChunk,
  encodeFooter,
  encodeHeader,
  loadDumpCatalog,
  MAX_DUMP_BYTES,
  MAX_DUMP_ROWS,
  parseDump,
  readTableSql,
  ROWS_PER_CHUNK,
  type DumpCatalog,
  type DumpTable,
} from './backup-dump.js';

/**
 * P-C10 — «البيانات والاسترجاع»: نسخةٌ تُغادر القاعدة، وسياسةُ احتفاظٍ تُنفَّذ، وحقُّ نسيان.
 *
 * ثلاث قواعد تحكم هذا الملف:
 *
 *   1. **النسخة تُقاس من الملف، لا من الطلب.** بعد الكتابة تُقرأ البايتات من المخزن
 *      ويُحسب حجمها وبصمتها (`sha256` للنصّ الصريح) وتُسجَّل. و`verify` يعيد القراءة
 *      والفكّ والحساب، فملفٌّ تغيّر بايتٌ فيه يفشل بوسمٍ وسببٍ لا بابتسامة.
 *   2. **الاحتفاظ يُنفَّذ لا يُوصف.** النوافذ القابلة للتعديل (`retention.policy` في
 *      `platform_settings`) لها آثارٌ حقيقية: حذف ملفات النسخ المنتهية، ومسح مفاتيح
 *      `idempotency` المنتهية، ومهامّ الطابور المنتهية، والملفات اليتيمة — **ولا يُمحى
 *      سجلّ التدقيق أبداً**: يُعدّ القابلُ للأرشفة ويُترك مكانه (القاعدة تمنع UPDATE/DELETE
 *      عليه أصلاً).
 *   3. **حقّ النسيان يُنفَّذ على الهوية الحيّة.** طلب `erase` يُخفي حقول `users` ويسحب
 *      العضويات ويُلغي الجلسات ويُبقي صفوف التدقيق **ويقول كم بقي** — فمحوُ سجلّ «من فعل
 *      ماذا» يمحو الحقوق نفسها، وهذا ما يقوله `retainedAuditRows` في النتيجة لا في هامش.
 */

/** حقول `users` التي تُخفى عند المحو — بالأسماء، فتقرأها الشاشة والتقرير. */
export const ERASED_USER_FIELDS = [
  'email',
  'phone',
  'full_name',
  'password_hash',
  'mfa_secret_enc',
  'mfa_enabled',
  'failed_login_attempts',
  'locked_until',
  'status',
] as const;

const ERASED_NAME = 'Erased user';

@Injectable()
export class PlatformBackupsService {
  private readonly logger = new Logger(PlatformBackupsService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(ARTIFACT_STORE_S3) private readonly s3: ArtifactStorePort,
    @Inject(ARTIFACT_STORE_FS) private readonly filesystem: ArtifactStorePort,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────── النسخ

  /**
   * الوجهة المختارة الآن: التخزين إن كان مُهيّأً، وإلا نظام الملفات — والصفّ يقول أيّهما.
   * والفشل في التخزين **لا يُعاد توجيهه** إلى القرص بصمت: من طلب نسخةً في S3 يعرف أنها
   * لم تصل، وهي قاعدة `store` في العقد.
   */
  private store(): ArtifactStorePort {
    if (env.BACKUP_STORE === 'filesystem') return this.filesystem;
    if (env.BACKUP_STORE === 's3') return this.s3;
    return this.s3.isConfigured() ? this.s3 : this.filesystem;
  }

  async listBackups(query: PlatformBackupQueryDto): Promise<ListEnvelope<PlatformBackupRow>> {
    const filters = parseFilters(query.filter, ['status', 'scope', 'tenantId', 'store'] as const);
    const [sort] = parseSort(query.sort, ['startedAt', 'bytes', 'durationMs'] as const);
    const orderBy = !sort
      ? desc(backupJobs.startedAt)
      : sort.column === 'bytes' && sort.direction === 'asc'
        ? sql`${backupArtifacts.bytes} asc nulls last`
        : sort.column === 'bytes'
          ? sql`${backupArtifacts.bytes} desc nulls last`
          : sort.column === 'durationMs' && sort.direction === 'asc'
            ? sql`${backupJobs.durationMs} asc nulls last`
            : sort.column === 'durationMs'
              ? sql`${backupJobs.durationMs} desc nulls last`
              : sort.direction === 'asc'
                ? sql`${backupJobs.startedAt} asc`
                : desc(backupJobs.startedAt);

    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(backupJobs.status, this.assertStatus(filters.status)));
    if (filters.scope) conditions.push(eq(backupJobs.scope, this.assertScope(filters.scope)));
    if (filters.tenantId) conditions.push(eq(backupJobs.tenantId, filters.tenantId));
    if (filters.store) conditions.push(eq(backupArtifacts.store, this.assertStore(filters.store)));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const totalRow = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(backupJobs)
        .leftJoin(backupArtifacts, eq(backupArtifacts.id, backupJobs.artifactId))
        .where(where);
      const rows = await tx
        .select({
          job: backupJobs,
          tenantCode: tenants.code,
          artifact: backupArtifacts,
          requestedByLabel: users.fullName,
        })
        .from(backupJobs)
        .leftJoin(tenants, eq(tenants.id, backupJobs.tenantId))
        .leftJoin(backupArtifacts, eq(backupArtifacts.id, backupJobs.artifactId))
        .leftJoin(users, eq(users.id, backupJobs.requestedBy))
        .where(where)
        .orderBy(orderBy)
        .limit(query.limit)
        .offset(query.offset);

      return {
        data: rows.map((row) => this.toBackupRow(row)),
        meta: buildMeta(totalRow[0]?.value ?? 0, query),
      };
    });
  }

  /**
   * `POST /platform/backups/run` — النسخة الفعلية.
   *
   * الترتيب مقصود: صفّ المحاولة يُكتب **قبل** القراءة (`running`)، فمحاولةٌ ماتت في
   * منتصفها تترك أثراً لا فراغاً. ثم تُقرأ الجداول من الكتالوج، ثم يُكتب الملف، ثم تُقرأ
   * بايتاته من المخزن وتُقاس، ثم يُغلق الصفّ.
   */
  async runBackup(input: PlatformBackupRunInput, actorUserId: string): Promise<PlatformBackupRow> {
    const jobId = newId();
    const startedAt = new Date();
    const tenantId = input.scope === 'tenant' ? (input.tenantId ?? null) : null;
    const store = this.store();

    // التحقّق من المستأجر **قبل** كتابة صفّ المحاولة: `backup_jobs.tenant_id` مفتاحٌ أجنبي،
    // فمعرّفٌ لا وجود له كان سيُسقط الإدراج بخطأ قاعدةٍ (500) بدل أن يُجيب 404.
    if (tenantId) {
      const exists = await withPlatformAdminTx(this.database.db, async (tx) => {
        const rows = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        return rows.length > 0;
      });
      if (!exists) {
        throw new DomainError(errorCodes.NOT_FOUND, 'No such tenant', 404, { tenantId });
      }
    }

    await withPlatformAdminTx(this.database.db, (tx) =>
      tx.insert(backupJobs).values({
        id: jobId,
        scope: input.scope,
        tenantId,
        status: 'running',
        note: input.note ?? null,
        startedAt,
        requestedBy: actorUserId,
      }),
    );

    try {
      const dump = await this.collectDump({
        scope: input.scope,
        tenantId,
        createdAt: startedAt.toISOString(),
      });
      const bytes = Buffer.from(dump.body, 'utf8');
      if (bytes.byteLength > MAX_DUMP_BYTES) {
        throw new DomainError(
          'BACKUP_TOO_LARGE',
          `The dump is ${Math.round(bytes.byteLength / 1024 / 1024)} MiB, above the ${Math.round(
            MAX_DUMP_BYTES / 1024 / 1024,
          )} MiB ceiling — a truncated backup is worse than none`,
          422,
        );
      }

      const stored = await store.put(this.buildObjectKey('platform-dump', jobId, startedAt), bytes);
      const artifactId = newId();
      const finishedAt = new Date();

      await withPlatformAdminTx(this.database.db, async (tx) => {
        await tx.insert(backupArtifacts).values({
          id: artifactId,
          kind: 'platform-dump',
          store: stored.store,
          objectKey: stored.objectKey,
          format: stored.format,
          encryption: stored.encryption,
          iv: stored.iv,
          bytes: stored.bytes,
          checksum: stored.checksum,
          tables: dump.tables,
          rows: dump.rows,
          createdBy: actorUserId,
        });
        await tx
          .update(backupJobs)
          .set({
            status: 'succeeded',
            artifactId,
            tables: dump.tables,
            rows: dump.rows,
            tenants: dump.tenants.length,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          })
          .where(eq(backupJobs.id, jobId));
      });

      await this.audit.record({
        actorUserId,
        action: backupAuditActions.run,
        entity: 'backup_jobs',
        entityId: jobId,
        after: {
          scope: input.scope,
          tenantId,
          store: stored.store,
          bytes: stored.bytes,
          checksum: stored.checksum,
          tables: dump.tables,
          rows: dump.rows,
        },
        meta: { note: input.note ?? null },
      });

      return withPlatformAdminTx(this.database.db, (tx) => this.loadJob(tx, jobId));
    } catch (error) {
      const reason = error instanceof DomainError ? error.message : String(error);
      const finishedAt = new Date();
      await withPlatformAdminTx(this.database.db, (tx) =>
        tx
          .update(backupJobs)
          .set({
            status: 'failed',
            failureReason: reason,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          })
          .where(eq(backupJobs.id, jobId)),
      );
      // نسخةٌ فشلت تُسجَّل كذلك في التدقيق: الفشل الصامت أسوأ من الفشل.
      await this.audit.record({
        actorUserId,
        action: backupAuditActions.run,
        entity: 'backup_jobs',
        entityId: jobId,
        after: { scope: input.scope, status: 'failed' },
        meta: { failureReason: reason },
      });
      this.logger.warn({ jobId, err: reason }, 'backup run failed');
      return withPlatformAdminTx(this.database.db, (tx) => this.loadJob(tx, jobId));
    }
  }

  /**
   * قراءة الجداول وبناء الملف.
   *
   * وكل قراءةٍ في سياقها: جداول المنصّة في `withPlatformAdminTx` (وهي القراءة العابرة التي
   * تأذن بها سياسة مستوى المنصّة)، وجداول المستأجر داخل `withTenantTx(tenantId)` فتُقيَّد
   * بـ`app.tenant_id` كما تُقيَّد أي قراءةٍ في التطبيق.
   */
  private async collectDump(input: {
    scope: 'platform' | 'tenant';
    tenantId: string | null;
    createdAt: string;
  }): Promise<{ body: string; tables: number; rows: number; tenants: string[] }> {
    const catalog = await withPlatformAdminTx(this.database.db, (tx) => loadDumpCatalog(tx));
    const tenantRows =
      input.scope === 'tenant' && input.tenantId
        ? [{ id: input.tenantId }]
        : await withPlatformAdminTx(this.database.db, (tx) =>
            tx.select({ id: tenants.id }).from(tenants).orderBy(tenants.code),
          );

    const counts: Record<string, number> = {};
    const tenantsSeen = new Set<string>();
    const lines: string[] = [];
    let totalRows = 0;

    const pushRows = (table: string, tenantId: string | null, rows: unknown[]) => {
      if (rows.length === 0) return;
      counts[table] = (counts[table] ?? 0) + rows.length;
      totalRows += rows.length;
      if (tenantId) tenantsSeen.add(tenantId);
      lines.push(...chunks(table, tenantId, rows));
      if (totalRows > MAX_DUMP_ROWS) {
        throw new DomainError(
          'BACKUP_TOO_LARGE',
          `The dump passed ${MAX_DUMP_ROWS} rows — a truncated backup is worse than none`,
          422,
        );
      }
    };

    const plan = this.dumpPlan(catalog, input.scope);

    // 1. جداول المنصّة: مرّةً واحدة في سياق المنصّة (وفي نسخة المستأجر: المقيَّدة بمستأجره).
    for (const table of plan.platformTables) {
      const rows = await withPlatformAdminTx(this.database.db, async (tx) => {
        const result = await tx.execute(
          readTableSql(table.table, input.scope === 'tenant' ? input.tenantId : null, table.hasTenantColumn),
        );
        return (result.rows as unknown as Array<{ row: unknown }>).map((entry) => entry.row);
      });
      pushRows(table.table, input.scope === 'tenant' ? input.tenantId : null, rows);
    }

    // 2. جداول المستأجرين: كلٌّ في سياقه.
    for (const tenant of tenantRows) {
      for (const table of plan.tenantTables) {
        const rows = await withTenantTx(this.database.db, tenant.id, async (tx) => {
          const result = await tx.execute(readTableSql(table.table, tenant.id, table.hasTenantColumn));
          return (result.rows as unknown as Array<{ row: unknown }>).map((entry) => entry.row);
        });
        pushRows(table.table, tenant.id, rows);
      }
    }

    lines.unshift(
      encodeHeader({
        scope: input.scope,
        tenantId: input.tenantId,
        createdAt: input.createdAt,
        tables: plan.platformTables.length + plan.tenantTables.length,
      }),
    );
    lines.push(
      encodeFooter({
        tables: counts,
        totalRows,
        tenants: [...tenantsSeen].sort(),
        skippedTables: plan.skippedTables,
        complete: true,
      }),
    );

    return {
      body: lines.join(''),
      tables: Object.keys(counts).length,
      rows: totalRows,
      tenants: [...tenantsSeen],
    };
  }

  /**
   * خطة القراءة: دالّةٌ صغيرة قابلة للقراءة بدل شرطٍ مُركَّبٍ داخل الحلقة.
   *
   * وفي نسخة المستأجر يبقى من جداول المنصّة ما يحمل عمود مستأجر (سجلّ تدقيق العميل
   * ورسائله مثلاً) — وهي صفوفه، ولا تُقرأ كلّها من أجله. والمُسقَط يُسجَّل في ذيل الملف
   * (`skippedTables`) فلا يبدو الملف كاملاً وهو ليس كذلك.
   */
  private dumpPlan(
    catalog: DumpCatalog,
    scope: 'platform' | 'tenant',
  ): { platformTables: DumpTable[]; tenantTables: DumpTable[]; skippedTables: string[] } {
    if (scope === 'platform') return { ...catalog, skippedTables: [] };
    const platformTables = catalog.platformTables.filter(
      (table) => table.hasTenantColumn || table.table === 'users',
    );
    const kept = new Set(platformTables.map((table) => table.table));
    return {
      platformTables,
      tenantTables: catalog.tenantTables,
      // الأسماء تُسجَّل من فرق الخطة لا من داخل الحلقة: نسخةُ مستأجرٍ تُسقط جداول المنصّة
      // كلّها (tenants · permissions · billing_plans · …) ويجب أن يقول الملف ذلك بنفسه —
      // نسخةٌ تبدو كاملةً وهي ناقصة أخطر من نسخةٍ تقول ما أسقطته.
      skippedTables: catalog.platformTables.map((table) => table.table).filter((table) => !kept.has(table)),
    };
  }

  /** `POST /platform/backups/:id/verify` — إعادة قراءة الملف ومقارنة بصمته. */
  async verifyBackup(jobId: string, actorUserId: string): Promise<PlatformBackupVerifyResult> {
    const artifact = await withPlatformAdminTx(this.database.db, async (tx) => {
      const job = await this.loadJob(tx, jobId);
      if (!job.artifactId) return undefined;
      const rows = await tx
        .select()
        .from(backupArtifacts)
        .where(eq(backupArtifacts.id, job.artifactId))
        .limit(1);
      return rows[0];
    });

    if (!artifact) {
      throw new DomainError('BACKUP_ARTIFACT_MISSING', 'This run has no artifact to verify', 404, { jobId });
    }

    const verifiedAt = new Date();
    const result = await this.readAndJudge(jobId, artifact);

    await withPlatformAdminTx(this.database.db, (tx) =>
      tx
        .update(backupJobs)
        .set({ verifiedAt, verifiedChecksum: result.checksum.actual })
        .where(eq(backupJobs.id, jobId)),
    );
    await this.audit.record({
      actorUserId,
      action: backupAuditActions.verify,
      entity: 'backup_jobs',
      entityId: jobId,
      after: {
        verified: result.verified,
        matches: result.checksum.matches,
        truncated: result.truncated,
        verdict: result.restore.verdict,
      },
    });
    return { ...result, verifiedAt: verifiedAt.toISOString() };
  }

  /**
   * القلب: فكّ الملف، حساب بصمته، تحليل أسطره، ثم «استعادة تجريبية» — وهي هنا **مقارنةُ
   * جداول النسخة بكتالوج القاعدة الحيّ**: نسخةٌ تشير إلى جدولٍ أُعيدت تسميته لا تُستعاد،
   * وهي أقوى ما يمكن التحقّق منه بلا كتابة. أمّا الكتابة فوق بياناتٍ حيّة فتحتاج نافذة
   * صيانة وقراراً منفصلاً، وهي خارج هذا الجزء صراحةً (تقرير P-C10 §4).
   */
  private async readAndJudge(
    jobId: string,
    artifact: typeof backupArtifacts.$inferSelect,
  ): Promise<Omit<PlatformBackupVerifyResult, 'verifiedAt'>> {
    let stored: Buffer;
    let plaintext: Buffer;
    try {
      const owner = artifact.store === 'object-storage' ? this.s3 : this.filesystem;
      stored = await owner.get(artifact.objectKey);
      plaintext = openArtifact(stored);
    } catch (error) {
      return {
        jobId,
        verified: false,
        checksum: { expected: artifact.checksum, actual: null, matches: false },
        bytes: artifact.bytes,
        encryption: null,
        format: null,
        lines: 0,
        tables: [],
        tenants: [],
        totalRows: 0,
        truncated: true,
        restore: { mode: 'dry_run', tables: 0, rows: 0, missingTables: [], verdict: 'unreadable' },
        detail: error instanceof DomainError ? error.message : String(error),
      };
    }

    const actual = createHash('sha256').update(plaintext).digest('hex');
    const parsed = parseDump(plaintext.toString('utf8'));
    const liveTables = await this.liveTableNames();
    const missingTables = parsed.tables.map((entry) => entry.table).filter((table) => !liveTables.has(table));

    return {
      jobId,
      verified: parsed.complete && actual === artifact.checksum && stored.byteLength === artifact.bytes,
      checksum: { expected: artifact.checksum, actual, matches: actual === artifact.checksum },
      bytes: stored.byteLength,
      encryption: artifact.encryption,
      format: parsed.format,
      lines: parsed.lines,
      tables: parsed.tables,
      tenants: parsed.tenants,
      totalRows: parsed.totalRows,
      truncated: parsed.truncated,
      restore: {
        mode: 'dry_run',
        tables: parsed.tables.length,
        rows: parsed.totalRows,
        missingTables,
        verdict: !parsed.complete ? 'unreadable' : missingTables.length > 0 ? 'drifted' : 'ready',
      },
      detail: parsed.detail,
    };
  }

  private async liveTableNames(): Promise<Set<string>> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        SELECT c.relname AS table_name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `);
      return new Set((result.rows as unknown as Array<{ table_name: string }>).map((row) => row.table_name));
    });
  }

  /** `GET /platform/backups/:id/download` — رابطٌ موقّع قصير العمر، بنفس نمط الملفات. */
  async downloadUrl(
    jobId: string,
    actorUserId: string,
    basePath = '/api/v1',
  ): Promise<{ url: string; name: string; expiresAt: string; bytes: number; checksum: string }> {
    const artifact = await this.requireArtifact(jobId);

    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + env.FILES_DOWNLOAD_URL_TTL_SECONDS;
    const signature = signDownloadToken({
      fileId: jobId,
      tenantId: 'platform-backup',
      expiresAtEpochSeconds,
    });

    await this.audit.record({
      actorUserId,
      action: backupAuditActions.download,
      entity: 'backup_jobs',
      entityId: jobId,
      meta: { objectKey: artifact.objectKey, bytes: artifact.bytes },
    });

    return {
      url: `${basePath}/platform/backups/${jobId}/content?expires=${expiresAtEpochSeconds}&signature=${signature}`,
      name: `${jobId}.ndjson`,
      expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
      bytes: artifact.bytes,
      checksum: artifact.checksum,
    };
  }

  /** `GET /platform/backups/:id/content` — البايتات المفكوكة، والرمز هو التصريح. */
  async artifactContent(jobId: string): Promise<{ body: Buffer; name: string }> {
    const artifact = await this.requireArtifact(jobId);
    const owner = artifact.store === 'object-storage' ? this.s3 : this.filesystem;
    const stored = await owner.get(artifact.objectKey);
    return { body: openArtifact(stored), name: `${jobId}.ndjson` };
  }

  private async requireArtifact(jobId: string): Promise<typeof backupArtifacts.$inferSelect> {
    const artifact = await withPlatformAdminTx(this.database.db, async (tx) => {
      const job = await this.loadJob(tx, jobId);
      if (!job.artifactId) return undefined;
      const rows = await tx
        .select()
        .from(backupArtifacts)
        .where(eq(backupArtifacts.id, job.artifactId))
        .limit(1);
      if (rows[0]?.prunedAt) {
        throw new DomainError(
          'BACKUP_ARTIFACT_PRUNED',
          'The retention policy has already removed this artifact',
          410,
          { jobId },
        );
      }
      return rows[0];
    });
    if (!artifact) {
      throw new DomainError('BACKUP_ARTIFACT_MISSING', 'This run has no artifact to download', 404, {
        jobId,
      });
    }
    return artifact;
  }

  // ─────────────────────────────────────────────────────────── الاحتفاظ

  /** السياسة الفعّالة (من الإعدادات أو الافتراضية) ومعها ما ستُمسحه الآن. */
  async retention(): Promise<PlatformRetention> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const policy = await this.readPolicy(tx);
      const purges = await this.countPurges(tx, policy);
      const meta = await tx.execute(sql`
        SELECT updated_at, updated_by FROM platform_settings
        WHERE tenant_id IS NULL AND key = 'retention.policy'
        LIMIT 1
      `);
      const row = meta.rows[0] as { updated_at: unknown; updated_by: string | null } | undefined;
      return {
        policy,
        defaults: defaultPlatformRetentionPolicy,
        updatedAt: iso(row?.updated_at ?? null),
        updatedBy: row?.updated_by ?? null,
        purges,
        auditHardDeleteAllowed: false,
        computedAt: new Date().toISOString(),
      };
    });
  }

  async updateRetention(
    patch: Partial<PlatformRetentionPolicy>,
    actorUserId: string,
  ): Promise<PlatformRetention> {
    const current = await withPlatformAdminTx(this.database.db, (tx) => this.readPolicy(tx));
    const merged = platformRetentionPolicySchema.parse({ ...current, ...patch });
    const label = await withPlatformAdminTx(this.database.db, (tx) => platformActorLabel(tx, actorUserId));

    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO platform_settings (id, tenant_id, key, value, version, created_at, updated_at, updated_by)
        VALUES (${newId()}, NULL, 'retention.policy', ${JSON.stringify(merged)}::jsonb, 1, now(), now(), ${actorUserId})
        ON CONFLICT (tenant_id, key) DO UPDATE
          SET value = EXCLUDED.value,
              version = platform_settings.version + 1,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by
      `);
    });
    await this.audit.record({
      actorUserId,
      actorLabel: label,
      action: backupAuditActions.retentionUpdate,
      entity: 'platform_settings',
      entityId: 'retention.policy',
      before: current,
      after: merged,
    });
    return this.retention();
  }

  /**
   * `POST /platform/retention/apply` — والنافذة تُنفَّذ فعلاً.
   *
   * الوضع التجريبي يقيس ما سيمسحه، و`apply` يمسح — وفي الحالتين يُكتب صفّ تدقيق، لأن
   * «من نفّذ سياسة الاحتفاظ ومتى» سؤالٌ يُسأل بعد أن تختفي الصفوف.
   */
  async applyRetention(
    input: PlatformRetentionApplyInput,
    actorUserId: string,
  ): Promise<PlatformRetentionApplyResult> {
    const targets = input.targets ?? (['artifacts', 'idempotency', 'outbox', 'files'] as RetentionTarget[]);
    const policy = await withPlatformAdminTx(this.database.db, (tx) => this.readPolicy(tx));
    const store = this.store();
    const results: PlatformRetentionApplyResult['results'] = [];

    for (const target of targets) {
      if (target === 'artifacts') {
        const expired = await withPlatformAdminTx(this.database.db, async (tx) =>
          tx
            .select({
              id: backupArtifacts.id,
              objectKey: backupArtifacts.objectKey,
              store: backupArtifacts.store,
            })
            .from(backupArtifacts)
            .where(
              and(
                isNull(backupArtifacts.prunedAt),
                sql`${backupArtifacts.createdAt} < now() - ${`${policy.artifactRetentionDays} days`}::interval`,
              ),
            )
            .limit(500),
        );
        let removed = 0;
        if (input.mode === 'apply' && expired.length > 0) {
          for (const artifact of expired) {
            const owner = artifact.store === 'object-storage' ? this.s3 : this.filesystem;
            if (await owner.remove(artifact.objectKey)) removed += 1;
          }
          await withPlatformAdminTx(this.database.db, (tx) =>
            tx
              .update(backupArtifacts)
              .set({ prunedAt: new Date() })
              .where(
                inArray(
                  backupArtifacts.id,
                  expired.map((artifact) => artifact.id),
                ),
              ),
          );
        }
        results.push({
          target,
          rows: input.mode === 'apply' ? removed : expired.length,
          objectsRemoved: input.mode === 'apply' ? removed : 0,
          skipped: null,
        });
        continue;
      }

      if (target === 'idempotency') {
        const window = `${policy.idempotencyPurgeDays} days`;
        results.push({
          target,
          rows:
            input.mode === 'apply'
              ? await this.deleteWindow(appliesIdempotency(window))
              : await this.countWindow(countsIdempotency(window)),
          objectsRemoved: 0,
          skipped: null,
        });
        continue;
      }

      if (target === 'outbox') {
        const window = `${policy.outboxPurgeDays} days`;
        results.push({
          target,
          rows:
            input.mode === 'apply'
              ? await this.deleteWindow(appliesOutbox(window))
              : await this.countWindow(countsOutbox(window)),
          objectsRemoved: 0,
          skipped: null,
        });
        continue;
      }

      // `files`: ملفٌ رُفع ولم يُنهَ أقدم من النافذة — صفٌّ يتيم في المخزن وفي الجدول.
      const orphans = await withPlatformAdminTx(this.database.db, async (tx) =>
        tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(files)
          .where(
            and(
              eq(files.status, 'pending'),
              sql`${files.createdAt} < now() - ${`${policy.fileOrphanPurgeDays} days`}::interval`,
            ),
          )
          .limit(500),
      );
      let prunedObjects = 0;
      if (input.mode === 'apply' && orphans.length > 0) {
        for (const orphan of orphans) {
          if (await store.remove(orphan.objectKey)) prunedObjects += 1;
        }
        await withPlatformAdminTx(this.database.db, (tx) =>
          tx
            .update(files)
            .set({ status: 'deleted', deletedAt: new Date() })
            .where(
              inArray(
                files.id,
                orphans.map((orphan) => orphan.id),
              ),
            ),
        );
      }
      results.push({
        target,
        rows: orphans.length,
        objectsRemoved: input.mode === 'apply' ? prunedObjects : 0,
        skipped: null,
      });
    }

    const label = await withPlatformAdminTx(this.database.db, (tx) => platformActorLabel(tx, actorUserId));
    const auditId = await this.audit.record({
      actorUserId,
      actorLabel: label,
      action: backupAuditActions.retentionApply,
      entity: 'platform_settings',
      entityId: 'retention.policy',
      after: { mode: input.mode, targets, results },
      meta: { reason: input.reason, policy },
    });

    return {
      mode: input.mode,
      policy,
      results,
      auditId: auditId ?? null,
      appliedAt: new Date().toISOString(),
    };
  }

  private async countWindow(statement: SQL): Promise<number> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(statement);
      return Number((result.rows[0] as { value: number } | undefined)?.value ?? 0);
    });
  }

  private async deleteWindow(statement: SQL): Promise<number> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(statement);
      return result.rowCount ?? 0;
    });
  }

  private async readPolicy(tx: DrizzleTx): Promise<PlatformRetentionPolicy> {
    const result = await tx.execute(sql`
      SELECT value::text AS raw FROM platform_settings
      WHERE tenant_id IS NULL AND key = 'retention.policy'
      LIMIT 1
    `);
    const raw = (result.rows[0] as { raw: string } | undefined)?.raw;
    if (!raw) return defaultPlatformRetentionPolicy;
    const parsed = platformRetentionPolicySchema.safeParse(JSON.parse(raw));
    // سياسةٌ مخالفة للعقد تُستبدل بالافتراضية — لا تُطبَّق نافذةٌ مجهولة.
    return parsed.success ? parsed.data : defaultPlatformRetentionPolicy;
  }

  private async countPurges(tx: DrizzleTx, policy: PlatformRetentionPolicy) {
    const result = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM idempotency_keys
          WHERE created_at < now() - ${`${policy.idempotencyPurgeDays} days`}::interval) AS idempotency_expired,
        (SELECT count(*)::int FROM outbox_jobs
          WHERE status IN ('published', 'dead')
            AND created_at < now() - ${`${policy.outboxPurgeDays} days`}::interval) AS outbox_purgeable,
        (SELECT count(*)::int FROM files
          WHERE status = 'pending'
            AND created_at < now() - ${`${policy.fileOrphanPurgeDays} days`}::interval) AS file_orphans,
        (SELECT count(*)::int FROM backup_artifacts
          WHERE pruned_at IS NULL
            AND created_at < now() - ${`${policy.artifactRetentionDays} days`}::interval) AS artifacts_expired,
        (SELECT count(*)::int FROM audit_log
          WHERE created_at < now() - ${`${policy.auditArchiveDays} days`}::interval) AS audit_archivable
    `);
    const row = (result.rows[0] ?? {}) as Record<string, number>;
    return {
      idempotencyExpired: Number(row.idempotency_expired ?? 0),
      outboxPurgeable: Number(row.outbox_purgeable ?? 0),
      fileOrphans: Number(row.file_orphans ?? 0),
      artifactsExpired: Number(row.artifacts_expired ?? 0),
      auditArchivable: Number(row.audit_archivable ?? 0),
    };
  }

  // ─────────────────────────────────────────────────────────── طلبات البيانات

  async listDataRequests(query: PlatformDataRequestQueryDto): Promise<ListEnvelope<PlatformDataRequestRow>> {
    const filters = parseFilters(query.filter, ['kind', 'status', 'tenantId'] as const);
    const conditions: SQL[] = [];
    if (filters.kind) conditions.push(eq(dataRequests.kind, this.assertKind(filters.kind)));
    if (filters.status) conditions.push(eq(dataRequests.status, this.assertRequestStatus(filters.status)));
    if (filters.tenantId) conditions.push(eq(dataRequests.tenantId, filters.tenantId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [sort] = parseSort(query.sort, ['createdAt', 'updatedAt'] as const);
    const orderBy =
      sort?.column === 'updatedAt'
        ? sort.direction === 'asc'
          ? sql`${dataRequests.updatedAt} asc nulls last`
          : sql`${dataRequests.updatedAt} desc nulls last`
        : desc(dataRequests.createdAt);

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const totalRow = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(dataRequests)
        .where(where);
      const rows = await tx
        .select({ request: dataRequests, tenantCode: tenants.code })
        .from(dataRequests)
        .leftJoin(tenants, eq(tenants.id, dataRequests.tenantId))
        .where(where)
        .orderBy(orderBy)
        .limit(query.limit)
        .offset(query.offset);
      return {
        data: rows.map((row) => this.toRequestRow(row.request, row.tenantCode ?? null)),
        meta: buildMeta(totalRow[0]?.value ?? 0, query),
      };
    });
  }

  async createDataRequest(
    input: PlatformDataRequestCreateInput,
    actorUserId: string,
  ): Promise<PlatformDataRequestRow> {
    const tenant = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ id: tenants.id, code: tenants.code })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      return rows[0];
    });
    if (!tenant) {
      throw new DomainError(errorCodes.NOT_FOUND, 'No such tenant', 404, { tenantId: input.tenantId });
    }

    const id = newId();
    await withPlatformAdminTx(this.database.db, (tx) =>
      tx.insert(dataRequests).values({
        id,
        kind: input.kind,
        status: 'pending',
        tenantId: input.tenantId,
        subjectEmail: input.subjectEmail.toLowerCase(),
        note: input.note ?? null,
        requestedBy: actorUserId,
      }),
    );

    await this.audit.record({
      actorUserId,
      action: backupAuditActions.dataRequestCreate,
      entity: 'data_requests',
      entityId: id,
      after: { kind: input.kind, tenantId: input.tenantId, subjectEmail: input.subjectEmail.toLowerCase() },
    });
    return this.toRequestRow(await this.loadRequest(id), tenant.code);
  }

  async decideDataRequest(
    id: string,
    input: PlatformDataRequestDecideInput,
    actorUserId: string,
  ): Promise<PlatformDataRequestRow> {
    const existing = await this.loadRequest(id);
    if (existing.status !== 'pending') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `This request was already ${existing.status}`,
        422,
        {
          status: existing.status,
        },
      );
    }
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const decidedAt = new Date();
    await withPlatformAdminTx(this.database.db, (tx) =>
      tx
        .update(dataRequests)
        .set({ status, decisionNote: input.reason, decidedBy: actorUserId, decidedAt, updatedAt: decidedAt })
        .where(eq(dataRequests.id, id)),
    );
    await this.audit.record({
      actorUserId,
      action: backupAuditActions.dataRequestDecide,
      entity: 'data_requests',
      entityId: id,
      before: { status: existing.status },
      after: { status, note: input.reason },
    });
    return this.toRequestRow(await this.loadRequest(id), null);
  }

  /**
   * التنفيذ: تصديرٌ ينتج ملفاً موقّعاً، أو محوٌ يُخفي الهوية.
   *
   * والشرطان لا يُتفاوَض عليهما: الطلب يجب أن يكون `approved`، والمحو يجب أن يُؤكَّد
   * بكتابة البريد نفسه — لأن المحو لا رجعة فيه، والتأكيد يجب أن يكلّف شيئاً.
   */
  async executeDataRequest(
    id: string,
    input: PlatformDataRequestExecuteInput,
    actorUserId: string,
    basePath = '/api/v1',
  ): Promise<{ export: PlatformDataRequestExport } | { erased: PlatformDataRequestEraseResult }> {
    const request = await this.loadRequest(id);
    if (request.status !== 'approved') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'A request must be approved before it can be executed',
        422,
        { status: request.status },
      );
    }

    const subject = await this.resolveSubject(request.tenantId, request.subjectEmail);

    if (request.kind === 'export') {
      const result = await this.runExport(
        request.id,
        request.tenantId,
        request.subjectEmail,
        subject.userId,
        actorUserId,
        basePath,
      );
      return { export: { ...result, requestId: request.id } };
    }

    if ((input.confirm ?? '').trim().toLowerCase() !== request.subjectEmail.toLowerCase()) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'Erasing a subject requires `confirm` to repeat the subject e-mail exactly',
        422,
        { field: 'confirm' },
      );
    }
    return { erased: await this.eraseSubject(request, subject.userId, actorUserId) };
  }

  /** الصفّ الذي يخصّ الذات: البريد في هذا المستأجر — والقرار يحمل مرجعاً ثابتاً له. */
  private async resolveSubject(
    tenantId: string,
    email: string,
  ): Promise<{ userId: string | null; subjectRef: string }> {
    const result = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT u.id
        FROM users u
        JOIN memberships m ON m.user_id = u.id
        WHERE m.tenant_id = ${tenantId} AND lower(u.email::text) = ${email.toLowerCase()}
        LIMIT 1
      `),
    );
    const row = result.rows[0] as { id: string } | undefined;
    return { userId: row?.id ?? null, subjectRef: subjectReference(email, row?.id ?? null) };
  }

  private async runExport(
    requestId: string,
    tenantId: string,
    subjectEmail: string,
    userId: string | null,
    actorUserId: string,
    basePath: string,
  ): Promise<Omit<PlatformDataRequestExport, 'requestId'>> {
    const subjectRef = subjectReference(subjectEmail, userId);
    const sections = await this.collectSubjectData(tenantId, subjectEmail, userId);
    const now = new Date();
    const lines: string[] = [
      `${JSON.stringify({
        kind: 'erp-data-export',
        version: 1,
        tenantId,
        subjectRef,
        subjectEmail,
        createdAt: now.toISOString(),
      })}\n`,
    ];
    for (const section of sections) {
      lines.push(...chunks(section.table, null, section.rows));
    }
    const totalRows = sections.reduce((sum, section) => sum + section.rows.length, 0);
    lines.push(
      `${JSON.stringify({
        kind: 'footer',
        tables: Object.fromEntries(sections.map((section) => [section.table, section.rows.length])),
        totalRows,
        complete: true,
      })}\n`,
    );

    const stored = await this.store().put(
      this.buildObjectKey('data-export', requestId, now),
      Buffer.from(lines.join(''), 'utf8'),
    );
    const artifactId = newId();
    const tables = sections.map((section) => ({ table: section.table, rows: section.rows.length }));
    const result = {
      artifactId,
      bytes: stored.bytes,
      checksum: stored.checksum,
      store: stored.store,
      tables: tables.length,
      rows: totalRows,
      anonymisedFields: null,
      anonymisedUsers: null,
      suspendedMemberships: null,
      revokedSessions: null,
      retainedAuditRows: null,
      subjectRef,
    };

    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.insert(backupArtifacts).values({
        id: artifactId,
        kind: 'data-export',
        store: stored.store,
        objectKey: stored.objectKey,
        format: stored.format,
        encryption: stored.encryption,
        iv: stored.iv,
        bytes: stored.bytes,
        checksum: stored.checksum,
        tables: tables.length,
        rows: totalRows,
        createdBy: actorUserId,
      });
      await tx
        .update(dataRequests)
        .set({ status: 'completed', executedAt: now, updatedAt: now, subjectUserId: userId, result })
        .where(eq(dataRequests.id, requestId));
    });

    await this.audit.record({
      actorUserId,
      action: backupAuditActions.dataRequestExport,
      entity: 'data_requests',
      entityId: requestId,
      after: {
        subjectRef,
        objectKey: stored.objectKey,
        bytes: stored.bytes,
        checksum: stored.checksum,
        rows: totalRows,
      },
    });

    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + env.FILES_DOWNLOAD_URL_TTL_SECONDS;
    const signature = signDownloadToken({
      fileId: artifactId,
      tenantId: 'data-export',
      expiresAtEpochSeconds,
    });

    return {
      subjectRef,
      artifactId,
      objectKey: stored.objectKey,
      store: stored.store,
      bytes: stored.bytes,
      checksum: stored.checksum,
      tables,
      totalRows,
      downloadUrl:
        `${basePath}/platform/data-requests/exports/${artifactId}` +
        `?expires=${expiresAtEpochSeconds}&signature=${signature}`,
      expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
    };
  }

  /** تنزيل ملف تصديرٍ برمزه الموقّع — يُستدعى من مسارٍ بلا رمز حامل، فالرمز هو التصريح. */
  async exportContent(artifactId: string): Promise<{ body: Buffer; name: string }> {
    const artifact = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.select().from(backupArtifacts).where(eq(backupArtifacts.id, artifactId)).limit(1);
      return rows[0];
    });
    if (!artifact || artifact.kind !== 'data-export') {
      throw new DomainError(errorCodes.NOT_FOUND, 'No such data export', 404, { artifactId });
    }
    if (artifact.prunedAt) {
      throw new DomainError('BACKUP_ARTIFACT_PRUNED', 'The retention policy has removed this export', 410, {
        artifactId,
      });
    }
    const owner = artifact.store === 'object-storage' ? this.s3 : this.filesystem;
    const stored = await owner.get(artifact.objectKey);
    return { body: openArtifact(stored), name: `${artifactId}.ndjson` };
  }

  /**
   * المحو: يُخفى ما يُخفي، ويُعدّ ما بقي.
   *
   * ولا يُحذف صفّ `users` (المفاتيح الأجنبية لمستندات العميل تشير إليه، وحذفه يكسر دفاتره)،
   * ولا تُمحى `audit_log` (القاعدة تمنع UPDATE/DELETE عليها أصلاً). ما يحدث هو ما يوصف:
   * هويةٌ أُخفيت، وعضوياتٌ سُحبت، وجلساتٌ أُلغيت، **وعددُ صفوف التدقيق الباقية يُقال**.
   */
  private async eraseSubject(
    request: { id: string; tenantId: string; subjectEmail: string },
    userId: string | null,
    actorUserId: string,
  ): Promise<PlatformDataRequestEraseResult> {
    const executedAt = new Date();
    const subjectRef = subjectReference(request.subjectEmail, userId);
    const anonymisedEmail = `erased+${createHash('sha256').update(subjectRef).digest('hex').slice(0, 12)}@erased.invalid`;
    let anonymisedUsers = 0;
    let suspendedMemberships = 0;
    let revokedSessions = 0;
    let retainedAuditRows = 0;
    const tenantCode = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ code: tenants.code })
        .from(tenants)
        .where(eq(tenants.id, request.tenantId))
        .limit(1);
      return rows[0]?.code ?? null;
    });

    if (userId) {
      revokedSessions = await withPlatformAdminTx(this.database.db, async (tx) => {
        const result = await tx.execute(sql`
          UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = ${userId} AND revoked_at IS NULL
        `);
        return result.rowCount ?? 0;
      });

      /**
       * العضوية تُسحب في سياق المستأجر (السياسة تُقيّد الصفّ بمنشأته) — لا في مستوى عابر.
       * والحالة `suspended` لا `revoked`: قيد الجدول منذ الترحيل 0000 يقبل ثلاث حالات
       * (`active|invited|suspended`)، وتوسيعُ قيدٍ قائم لتسميةٍ أجمل ليس عملاً لهذا الجزء.
       * والمعنى محفوظ: العضوية لم تعد فعّالة، والحدث مكتوبٌ في الإيصال.
       */
      suspendedMemberships = await withTenantTx(this.database.db, request.tenantId, async (tx) => {
        const result = await tx.execute(sql`
          UPDATE memberships SET status = 'suspended', updated_at = now()
          WHERE tenant_id = ${request.tenantId} AND user_id = ${userId} AND status <> 'suspended'
        `);
        return result.rowCount ?? 0;
      });

      anonymisedUsers = await withPlatformAdminTx(this.database.db, async (tx) => {
        const result = await tx.execute(sql`
          UPDATE users SET
            email = ${anonymisedEmail},
            phone = NULL,
            full_name = ${ERASED_NAME},
            password_hash = NULL,
            mfa_secret_enc = NULL,
            mfa_enabled = false,
            failed_login_attempts = 0,
            locked_until = NULL,
            status = 'suspended',
            updated_at = now()
          WHERE id = ${userId} AND lower(email::text) = ${request.subjectEmail.toLowerCase()}
        `);
        return result.rowCount ?? 0;
      });

      retainedAuditRows = await withPlatformAdminTx(this.database.db, async (tx) => {
        const result = await tx.execute(sql`
          SELECT count(*)::int AS value FROM audit_log
          WHERE actor_user_id = ${userId}
        `);
        return Number((result.rows[0] as { value: number } | undefined)?.value ?? 0);
      });
    } else {
      retainedAuditRows = await withPlatformAdminTx(this.database.db, async (tx) => {
        const result = await tx.execute(sql`
          SELECT count(*)::int AS value FROM audit_log
          WHERE tenant_id = ${request.tenantId} AND actor_label = ${request.subjectEmail}
        `);
        return Number((result.rows[0] as { value: number } | undefined)?.value ?? 0);
      });
    }

    const outcome = {
      anonymisedFields: [...ERASED_USER_FIELDS],
      anonymisedUsers,
      suspendedMemberships,
      revokedSessions,
      retainedAuditRows,
      subjectRef,
    };

    await withPlatformAdminTx(this.database.db, (tx) =>
      tx
        .update(dataRequests)
        .set({
          status: 'completed',
          executedAt,
          updatedAt: executedAt,
          subjectUserId: userId,
          result: {
            artifactId: null,
            bytes: null,
            checksum: null,
            store: null,
            tables: null,
            rows: null,
            ...outcome,
          },
        })
        .where(eq(dataRequests.id, request.id)),
    );

    /**
     * الإيصال يحمل البريد المطلوب — وهو آخر مكانٍ يظهر فيه بعد المحو، **عمداً**: طلبُ محوٍ
     * لا يُعرف عمّن كان لا يُدقَّق، ولا يُدافَع عنه.
     */
    await this.audit.record({
      actorUserId,
      action: backupAuditActions.dataRequestErase,
      entity: 'data_requests',
      entityId: request.id,
      before: { subjectEmail: request.subjectEmail, userId },
      after: { anonymisedEmail, ...outcome },
      meta: { tenantCode },
    });

    return {
      requestId: request.id,
      subjectUserId: userId,
      ...outcome,
      executedAt: executedAt.toISOString(),
    };
  }

  /** ما يُصدَّر عن الذات: ملفّه وعضويته، وسجلّ ما فعله، ورسائل البريد باسمه. */
  private async collectSubjectData(
    tenantId: string,
    email: string,
    userId: string | null,
  ): Promise<Array<{ table: string; rows: unknown[] }>> {
    const subject = userId ?? '00000000-0000-0000-0000-000000000000';
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const profile = await tx.execute(sql`
        SELECT u.id, u.email::text AS email, u.full_name, u.phone, u.status, u.created_at, u.last_login_at,
               m.id AS membership_id, m.tenant_id, m.status AS membership_status, m.display_name
        FROM users u
        LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ${tenantId}
        WHERE u.id = ${subject} OR lower(u.email::text) = ${email.toLowerCase()}
      `);
      const audit = await tx.execute(sql`
        SELECT id, created_at, action, entity, entity_id, actor_label
        FROM audit_log
        WHERE actor_user_id = ${subject}
        ORDER BY created_at DESC
        LIMIT 1000
      `);
      const mail = await tx.execute(sql`
        SELECT id, created_at, event, subject, status
        FROM email_messages
        WHERE tenant_id = ${tenantId} AND to_email = ${email.toLowerCase()}
        ORDER BY created_at DESC
        LIMIT 1000
      `);
      return [
        { table: 'users', rows: profile.rows as unknown[] },
        { table: 'audit_log', rows: audit.rows as unknown[] },
        { table: 'email_messages', rows: mail.rows as unknown[] },
      ];
    });
  }

  private async loadRequest(id: string): Promise<typeof dataRequests.$inferSelect> {
    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.select().from(dataRequests).where(eq(dataRequests.id, id)).limit(1);
      return rows[0];
    });
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'No such data request', 404, { id });
    return row;
  }

  private async loadJob(tx: DrizzleTx, jobId: string): Promise<PlatformBackupRow> {
    const rows = await tx
      .select({
        job: backupJobs,
        tenantCode: tenants.code,
        artifact: backupArtifacts,
        requestedByLabel: users.fullName,
      })
      .from(backupJobs)
      .leftJoin(tenants, eq(tenants.id, backupJobs.tenantId))
      .leftJoin(backupArtifacts, eq(backupArtifacts.id, backupJobs.artifactId))
      .leftJoin(users, eq(users.id, backupJobs.requestedBy))
      .where(eq(backupJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'No such backup run', 404, { jobId });
    return this.toBackupRow(row);
  }

  private toBackupRow(row: {
    job: typeof backupJobs.$inferSelect;
    tenantCode: string | null;
    artifact: typeof backupArtifacts.$inferSelect | null;
    requestedByLabel: string | null;
  }): PlatformBackupRow {
    return {
      id: row.job.id,
      scope: row.job.scope === 'tenant' ? 'tenant' : 'platform',
      tenantId: row.job.tenantId ?? null,
      tenantCode: row.tenantCode ?? null,
      status:
        row.job.status === 'succeeded' ? 'succeeded' : row.job.status === 'failed' ? 'failed' : 'running',
      store: row.artifact
        ? row.artifact.store === 'object-storage'
          ? 'object-storage'
          : 'filesystem'
        : null,
      note: row.job.note ?? null,
      failureReason: row.job.failureReason ?? null,
      tables: row.job.tables,
      rows: row.job.rows,
      tenants: row.job.tenants,
      bytes: row.artifact?.bytes ?? null,
      checksum: row.artifact?.checksum ?? null,
      encryption: row.artifact?.encryption ?? null,
      objectKey: row.artifact?.objectKey ?? null,
      artifactId: row.artifact?.id ?? null,
      startedAt: iso(row.job.startedAt) ?? new Date(0).toISOString(),
      finishedAt: iso(row.job.finishedAt),
      durationMs: row.job.durationMs ?? null,
      verifiedAt: iso(row.job.verifiedAt),
      prunedAt: iso(row.artifact?.prunedAt ?? null),
      requestedBy: row.job.requestedBy ?? null,
      requestedByLabel: row.requestedByLabel ?? null,
    };
  }

  private toRequestRow(
    row: typeof dataRequests.$inferSelect,
    tenantCode: string | null,
  ): PlatformDataRequestRow {
    const result = (row.result ?? {}) as Record<string, unknown>;
    const num = (key: string) => (typeof result[key] === 'number' ? (result[key] as number) : null);
    const text = (key: string) => (typeof result[key] === 'string' ? (result[key] as string) : null);
    const list = (key: string) => (Array.isArray(result[key]) ? (result[key] as string[]) : null);
    return {
      id: row.id,
      kind: row.kind === 'erase' ? 'erase' : 'export',
      status: this.asRequestStatus(row.status),
      tenantId: row.tenantId,
      tenantCode,
      subjectEmail: row.subjectEmail,
      subjectUserId: row.subjectUserId ?? null,
      note: row.note ?? null,
      decisionNote: row.decisionNote ?? null,
      decidedBy: row.decidedBy ?? null,
      decidedAt: iso(row.decidedAt),
      executedAt: iso(row.executedAt),
      result:
        Object.keys(result).length === 0
          ? null
          : {
              artifactId: text('artifactId'),
              bytes: num('bytes'),
              checksum: text('checksum'),
              store:
                result.store === 'object-storage'
                  ? 'object-storage'
                  : result.store === 'filesystem'
                    ? 'filesystem'
                    : null,
              tables: num('tables'),
              rows: num('rows'),
              anonymisedFields: list('anonymisedFields'),
              anonymisedUsers: num('anonymisedUsers'),
              suspendedMemberships: num('suspendedMemberships'),
              revokedSessions: num('revokedSessions'),
              retainedAuditRows: num('retainedAuditRows'),
              subjectRef: text('subjectRef'),
            },
      requestedBy: row.requestedBy ?? null,
      createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
      updatedAt: iso(row.updatedAt),
    };
  }

  private buildObjectKey(kind: string, id: string, now: Date): string {
    return `backups/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${kind}-${id}.dump.enc`;
  }

  private assertStatus(value: string): 'running' | 'succeeded' | 'failed' {
    if (value === 'running' || value === 'succeeded' || value === 'failed') return value;
    throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported backup status: ${value}`, 400, {
      field: 'filter[status]',
    });
  }

  private assertScope(value: string): 'platform' | 'tenant' {
    if (value === 'platform' || value === 'tenant') return value;
    throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported backup scope: ${value}`, 400, {
      field: 'filter[scope]',
    });
  }

  private assertStore(value: string): 'object-storage' | 'filesystem' {
    if (value === 'object-storage' || value === 'filesystem') return value;
    throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported artifact store: ${value}`, 400, {
      field: 'filter[store]',
    });
  }

  private assertKind(value: string): 'export' | 'erase' {
    if (value === 'export' || value === 'erase') return value;
    throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported request kind: ${value}`, 400, {
      field: 'filter[kind]',
    });
  }

  private assertRequestStatus(value: string): PlatformDataRequestRow['status'] {
    if (['pending', 'approved', 'rejected', 'completed', 'cancelled'].includes(value)) {
      return value as PlatformDataRequestRow['status'];
    }
    throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported request status: ${value}`, 400, {
      field: 'filter[status]',
    });
  }

  private asRequestStatus(value: string): PlatformDataRequestRow['status'] {
    return (
      ['pending', 'approved', 'rejected', 'completed', 'cancelled'].includes(value) ? value : 'pending'
    ) as PlatformDataRequestRow['status'];
  }
}

/** تقسيم صفوفٍ إلى دفعاتٍ لا يتجاوز سطرُها ما تحتمله العين والمحرّر. */
function chunks(table: string, tenantId: string | null, rows: unknown[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < rows.length; index += ROWS_PER_CHUNK) {
    lines.push(encodeChunk(table, tenantId, rows.slice(index, index + ROWS_PER_CHUNK)));
  }
  return lines;
}

function countsIdempotency(window: string): SQL {
  return sql`SELECT count(*)::int AS value FROM idempotency_keys WHERE created_at < now() - ${window}::interval`;
}

function appliesIdempotency(window: string): SQL {
  return sql`DELETE FROM idempotency_keys WHERE created_at < now() - ${window}::interval`;
}

function countsOutbox(window: string): SQL {
  return sql`SELECT count(*)::int AS value FROM outbox_jobs
             WHERE status IN ('published', 'dead') AND created_at < now() - ${window}::interval`;
}

function appliesOutbox(window: string): SQL {
  return sql`DELETE FROM outbox_jobs
             WHERE status IN ('published', 'dead') AND created_at < now() - ${window}::interval`;
}

/** مرجعٌ ثابت للذات لا يتغيّر بالمحو: `sha256(lower(email)|userId)` مقطوعةً لاثني عشر حرفاً. */
export function subjectReference(email: string, userId: string | null): string {
  return `sub_${createHash('sha256')
    .update(`${email.toLowerCase()}|${userId ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 12)}`;
}

/** تواقيت `tx.execute` تصل نصّاً بصيغة postgres — تُطبَّع هنا، وإلا `RangeError: Invalid time value`. */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (text.length === 0) return null;
  const normalised = text.includes('T') ? text : text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
