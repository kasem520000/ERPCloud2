import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  buildMeta,
  DomainError,
  errorCodes,
  FILE_FILTERS,
  FILE_SORT_COLUMNS,
  parseFilters,
  parseSort,
  type FileDownloadResponse,
  type FileDto,
  type FileFinalizeRequest,
  type FilePresignRequest,
  type FilePresignResponse,
  type ListEnvelope,
  type PaginationQuery,
} from '@erp/contracts';
import { env } from '@erp/config';
import { files, newId, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { UsageService } from '../../usage/index.js';
import { AuditService } from '../audit/audit.service.js';

import { isExpired, signDownloadToken, verifyDownloadToken } from './download-token.js';
import { FileAttachmentRegistry } from './file-attachments.js';
import { OBJECT_STORAGE, type ObjectStoragePort } from './object-storage.js';
import { VIRUS_SCANNER, type VirusScannerPort } from './virus-scanner.js';

/**
 * Files service — API_CONTRACT §2, DATABASE_DESIGN §4, TARGET_ARCHITECTURE §8.
 *
 * ```
 * POST /files/presign  → files row (pending) + pre-signed PUT   (bytes never touch us)
 * client PUT           → object storage
 * POST /files/{id}/finalize → ready + optional entity attachment (validated hook)
 * GET  /files/{id}/download → short-lived app-signed URL
 * GET  /files/{id}/content  → verifies the signature, redirects to storage
 * ```
 *
 * Guards applied before a URL is ever minted: mime allow-list, size ceiling, tenant
 * ownership (RLS + explicit predicate) and a per-tenant object-key prefix, so one
 * tenant's key can never address another tenant's object.
 */

export type FileListQuery = PaginationQuery & {
  filter?: Record<string, unknown>;
  sort?: string;
  q?: string;
};

export type FileContentTarget = {
  url: string;
  expiresAt: Date;
  fileName: string;
  mime: string;
};

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScannerPort,
    private readonly attachments: FileAttachmentRegistry,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
  ) {}

  /** `POST /files/presign` — `platform.file.upload`. */
  async presign(
    tenantId: string,
    actorUserId: string,
    input: FilePresignRequest,
  ): Promise<FilePresignResponse> {
    this.assertMimeAllowed(input.mime);
    this.assertSizeAllowed(input.sizeBytes);
    // P-C5: التخزين مقياسٌ محدود — يُحتسب بالطلب المرفوع (م.ب صاعدةً)، فالرفض يقع قبل التوقيع.
    await this.usage.assertWithinLimit(tenantId, 'storage_mb', Math.max(1, Math.ceil(input.sizeBytes / 1048576)));
    if (input.entity) this.assertEntityRegistered(input.entity, input.entityId);

    const fileId = newId();
    const objectKey = buildObjectKey(tenantId, fileId, input.name);
    const presigned = this.storage.presignUpload(objectKey, input.mime);

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.insert(files).values({
        id: fileId,
        tenantId,
        bucket: this.storage.bucket,
        objectKey,
        name: input.name,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        status: 'pending',
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        uploadedBy: actorUserId,
        createdBy: actorUserId,
      });
    });

    return {
      fileId,
      uploadUrl: presigned.url,
      objectKey,
      requiredHeaders: presigned.requiredHeaders,
      expiresAt: presigned.expiresAt.toISOString(),
    };
  }

  /** `POST /files/{id}/finalize` — flips `pending` → `ready` and attaches the entity. */
  async finalize(
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    fileId: string,
    input: FileFinalizeRequest,
  ): Promise<FileDto> {
    const row = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.loadOwned(tx, tenantId, fileId);
      if (current.status === 'ready' && !input.entity && !input.checksum) {
        return current;
      }

      const entity = input.entity ?? current.entity;
      const entityId = input.entityId ?? current.entityId;
      if (entity) {
        this.assertEntityRegistered(entity, entityId ?? undefined);
        const validator = this.attachments.validatorFor(entity);
        const exists = await validator?.(tx, tenantId, entityId as string);
        if (!exists) {
          throw new DomainError(
            errorCodes.VALIDATION_FAILED,
            `No ${entity} with id ${String(entityId)} exists in this tenant`,
            422,
            { field: 'entityId' },
          );
        }
      }

      const [updated] = await tx
        .update(files)
        .set({
          status: 'ready',
          checksum: input.checksum ?? current.checksum,
          entity: entity ?? null,
          entityId: entityId ?? null,
          updatedAt: new Date(),
          updatedBy: actorUserId,
          version: current.version + 1,
        })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
        .returning();

      const next = updated ?? current;

      // The scan verdict is part of the file's history, not of its row: the port is
      // deliberately a no-op in Phase 04 (TARGET_ARCHITECTURE §8).
      const verdict = await this.scanner.scan(next.objectKey, next.mime, next.sizeBytes);

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId,
        membershipId,
        action: 'update',
        entity: 'files',
        entityId: fileId,
        before: toFileDto(current),
        after: toFileDto(next),
        meta: { scan: verdict },
      });

      return next;
    });

    return toFileDto(row);
  }

  async read(tenantId: string, fileId: string): Promise<FileDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toFileDto(await this.loadOwned(tx, tenantId, fileId)),
    );
  }

  async list(tenantId: string, query: FileListQuery): Promise<ListEnvelope<FileDto>> {
    const filters = parseFilters(query.filter, FILE_FILTERS);
    const sort = parseSort(query.sort, FILE_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: (SQL | undefined)[] = [eq(files.tenantId, tenantId), isNull(files.deletedAt)];
      if (filters.status) conditions.push(eq(files.status, filters.status));
      if (filters.entity) conditions.push(eq(files.entity, filters.entity));
      if (filters.entityId) conditions.push(eq(files.entityId, filters.entityId));
      if (query.q) conditions.push(sql`${files.name} ILIKE ${`%${query.q}%`}`);

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(files).where(where);

      const ascending = sort[0]?.direction === 'asc';
      const rows = await tx
        .select()
        .from(files)
        .where(where)
        .orderBy(ascending ? sql`${files.createdAt} ASC` : desc(files.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map((row) => toFileDto(row)), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  /** `GET /files/{id}/download` — mints the app-signed URL described in `download-token.ts`. */
  async downloadUrl(tenantId: string, fileId: string, basePath = '/api/v1'): Promise<FileDownloadResponse> {
    const row = await withTenantTx(this.database.db, tenantId, (tx) => this.loadOwned(tx, tenantId, fileId));
    if (row.status !== 'ready') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'File upload has not been finalized yet',
        422,
        { field: 'status' },
      );
    }

    const expiresAtEpochSeconds =
      Math.floor(Date.now() / 1000) + env.FILES_DOWNLOAD_URL_TTL_SECONDS;
    const signature = signDownloadToken({ fileId, tenantId, expiresAtEpochSeconds });

    return {
      fileId,
      name: row.name,
      url:
        `${basePath}/files/${fileId}/content?tenant=${tenantId}` +
        `&expires=${expiresAtEpochSeconds}&signature=${signature}`,
      expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
    };
  }

  /**
   * Internal provider capability: give a trusted background adapter a short-lived storage
   * URL without making it depend on the browser-facing `/files/:id/content` redirect.
   * The row is still resolved under tenant RLS before the capability is minted.
   */
  async providerDownloadUrl(tenantId: string, fileId: string): Promise<FileContentTarget> {
    const row = await withTenantTx(this.database.db, tenantId, (tx) => this.loadOwned(tx, tenantId, fileId));
    if (row.status !== 'ready') {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'File upload has not been finalized yet', 422, { field: 'status' });
    }
    const presigned = this.storage.presignDownload(row.objectKey, row.name);
    return { url: presigned.url, expiresAt: presigned.expiresAt, fileName: row.name, mime: row.mime };
  }

  /**
   * Verifies an app-signed URL and resolves the storage target.
   *
   * Runs unauthenticated (the signature *is* the capability), so it re-reads the row
   * with the tenant bound from the token — never from the request.
   */
  async resolveSignedContent(
    fileId: string,
    expires: number,
    signature: string,
    tenantId: string,
  ): Promise<FileContentTarget> {
    if (isExpired(expires)) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Download link has expired', 401);
    }
    if (!verifyDownloadToken({ fileId, tenantId, expiresAtEpochSeconds: expires }, signature)) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Download link signature is invalid', 401);
    }

    const row = await withTenantTx(this.database.db, tenantId, (tx) => this.loadOwned(tx, tenantId, fileId));
    const presigned = this.storage.presignDownload(row.objectKey, row.name);
    return { url: presigned.url, expiresAt: presigned.expiresAt, fileName: row.name, mime: row.mime };
  }

  /**
   * `DELETE /files/{id}` — «🗑️ حذف» من مدير الملفات (R7).
   *
   * الحذف **ناعمٌ في القاعدة وقاطعٌ في التخزين**: الصفّ يُوسم `deleted` و`deleted_at`
   * فيبقى أثرُ مَن حذف ومتى داخل المسار نفسه، والكائن يُطلب إسقاطه بعد **إتمام**
   * المعاملة — بهذا الترتيب عينه الذي أُعلن في `collectOrphans`: انقطاعُ التخزين لا
   * يُعيد ملفاً محذوفاً إلى الوجود، وأسوأ ما يقع بايتاتٌ يتيمة يُنظّفها جامع الأيتام.
   *
   * و`objectRemoved` يُعاد إلى الشاشة: هل ذهبت البايتات فعلاً أم بقيت حتى تُنظَّف.
   * إخفاء هذه الحقيقة هو الفرق بين «حذفتُ الملف» و«حذفتُ الصفّ».
   */
  async remove(
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    fileId: string,
  ): Promise<{ id: string; name: string; deleted: true; objectRemoved: boolean }> {
    const row = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.loadOwned(tx, tenantId, fileId);
      const now = new Date();

      const [updated] = await tx
        .update(files)
        .set({
          status: 'deleted',
          deletedAt: now,
          updatedAt: now,
          updatedBy: actorUserId,
          version: current.version + 1,
        })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
        .returning();
      const next = updated ?? current;

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId,
        membershipId,
        action: 'delete',
        entity: 'files',
        entityId: fileId,
        before: toFileDto(current),
        after: toFileDto(next),
        meta: { objectKey: current.objectKey, source: 'file_manager' },
      });

      return next;
    });

    // بعد الالتزام: البايتات. `deleteObject` لا يرمي أبداً (تسجيلٌ وتحذير في الأسوأ).
    const objectRemoved = await this.storage.deleteObject(row.objectKey);
    if (!objectRemoved) {
      this.logger.warn(
        { tenantId, fileId, objectKey: row.objectKey },
        'file row deleted but the object was not removed; it will be retried by the orphan collector',
      );
    }

    return { id: row.id, name: row.name, deleted: true, objectRemoved };
  }

  /**
   * Orphan collection (PHASE_04 §4 "orphan GC job stub registered"): a `pending` row
   * older than `FILES_ORPHAN_GC_HOURS` is an upload that was presigned and abandoned.
   * The row is soft-deleted first, then the object is best-effort removed — in that
   * order, so a storage outage can never resurrect a collected file.
   */
  async collectOrphans(tenantId: string, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - env.FILES_ORPHAN_GC_HOURS * 3_600_000);

    const collected = await withTenantTx(this.database.db, tenantId, async (tx) =>
      tx
        .update(files)
        .set({ status: 'deleted', deletedAt: now })
        .where(
          and(
            eq(files.tenantId, tenantId),
            eq(files.status, 'pending'),
            isNull(files.deletedAt),
            lt(files.createdAt, cutoff),
          ),
        )
        .returning({ id: files.id, objectKey: files.objectKey }),
    );

    for (const row of collected) {
      await this.storage.deleteObject(row.objectKey);
    }
    if (collected.length > 0) {
      this.logger.log({ tenantId, collected: collected.length }, 'collected orphaned uploads');
    }
    return collected.length;
  }

  private async loadOwned(
    tx: DrizzleTx,
    tenantId: string,
    fileId: string,
  ): Promise<typeof files.$inferSelect> {
    const [row] = await tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId), isNull(files.deletedAt)))
      .limit(1);

    // MULTI_TENANCY §7.1: a foreign id must be indistinguishable from a missing one.
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, `No file with id ${fileId}`, 404);
    return row;
  }

  private assertMimeAllowed(mime: string): void {
    const allowed = env.FILES_ALLOWED_MIME_TYPES;
    if (!allowed.includes(mime.toLowerCase())) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `Content type '${mime}' is not accepted for upload`,
        400,
        { field: 'mime' },
      );
    }
  }

  private assertSizeAllowed(sizeBytes: number): void {
    if (sizeBytes > env.FILES_MAX_UPLOAD_BYTES) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `File exceeds the maximum upload size of ${env.FILES_MAX_UPLOAD_BYTES} bytes`,
        400,
        { field: 'sizeBytes' },
      );
    }
  }

  private assertEntityRegistered(entity: string, entityId: string | undefined): void {
    if (!entityId) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'entityId is required when entity is set', 400, {
        field: 'entityId',
      });
    }
    if (!this.attachments.isRegistered(entity)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `Entity '${entity}' cannot receive attachments (registered: ${
          this.attachments.registeredEntities().join(', ') || 'none'
        })`,
        422,
        { field: 'entity' },
      );
    }
  }
}

/**
 * `tenants/{tenantId}/{yyyy}/{mm}/{fileId}/{name}` — the tenant prefix is what makes a
 * stolen object key useless across tenants, and the date segments keep bucket listings
 * navigable.
 */
export function buildObjectKey(tenantId: string, fileId: string, name: string, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `tenants/${tenantId}/${year}/${month}/${fileId}/${safeName}`;
}

type FileRow = typeof files.$inferSelect;

export function toFileDto(row: FileRow): FileDto {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    sizeBytes: Number(row.sizeBytes),
    bucket: row.bucket,
    objectKey: row.objectKey,
    checksum: row.checksum,
    status: row.status as FileDto['status'],
    entity: row.entity,
    entityId: row.entityId,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  };
}
