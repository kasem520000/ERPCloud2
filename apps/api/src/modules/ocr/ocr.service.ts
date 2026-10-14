import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import { files, newId, ocrJobs, parties, purchaseInvoices, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { FilesService, FileAttachmentRegistry, OutboxService } from '../platform-services/index.js';
import { PurchasesService, type PurchaseLineInput } from '../purchases/purchases.service.js';

import { OCR_ENTITY_TYPE, type OcrEntityType, type OcrExtraction, type OcrJobStatus, type OcrProvider } from './ocr.types.js';
import { normaliseOcrPayload } from './ocr.utils.js';
import { OCR_PROVIDER } from './ocr.tokens.js';

export type OcrCreateJobInput = {
  fileId: string;
  entityType?: OcrEntityType;
};

export type OcrInvoiceLineInput = {
  itemId: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  taxRate?: string;
  taxGroupId?: string;
};

export type OcrInvoiceFromInput = {
  ocrJobId: string;
  branchId: string;
  warehouseId?: string;
  partyId?: string;
  supplierName?: string;
  supplierTaxNumber?: string;
  currency?: string;
  supplierReferenceNo?: string;
  supplierReferenceDate?: string;
  headerTotals?: { subtotal: string; tax: string; total: string };
  lines?: OcrInvoiceLineInput[];
};

export type OcrActor = { userId: string; membershipId: string };

export type OcrJobDto = {
  id: string;
  file: { id: string; name: string; mime: string; downloadUrl: string };
  entityType: OcrEntityType;
  status: OcrJobStatus;
  extracted: OcrExtraction;
  confidence: number | null;
  provider: string | null;
  error: string | null;
  attempts: number;
  processedAt: string | null;
  draftInvoiceId: string | null;
  createdAt: string;
};

const OCR_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

@Injectable()
export class OcrService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly filesService: FilesService,
    private readonly outbox: OutboxService,
    private readonly purchases: PurchasesService,
    private readonly attachments: FileAttachmentRegistry,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
  ) {}

  onModuleInit(): void {
    // The file service refuses unknown entity names during finalize. Registering the hook
    // here keeps that boundary owned by the purchase module instead of accepting arbitrary
    // `entity/entity_id` pairs from an OCR client.
    this.attachments.register('purchase_invoice', async (tx, tenantId, entityId) => {
      const [row] = await tx
        .select({ id: purchaseInvoices.id })
        .from(purchaseInvoices)
        .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, entityId)))
        .limit(1);
      return row !== undefined;
    });
  }

  assertOcrMime(mime: string): void {
    if (!OCR_MIMES.has(mime.toLowerCase())) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'OCR accepts PDF, PNG, JPEG, WEBP or GIF purchase documents',
        422,
        { field: 'mime' },
      );
    }
  }

  async presign(tenantId: string, actorUserId: string, input: { name: string; mime: string; sizeBytes: number }) {
    this.assertOcrMime(input.mime);
    return this.filesService.presign(tenantId, actorUserId, input);
  }

  async createJob(tenantId: string, input: OcrCreateJobInput): Promise<OcrJobDto> {
    if (input.entityType && input.entityType !== OCR_ENTITY_TYPE) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported OCR entity type '${input.entityType}'`, 422);
    }

    const jobId = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [file] = await tx
        .select()
        .from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.id, input.fileId), isNull(files.deletedAt)))
        .limit(1);
      if (!file) throw new DomainError(errorCodes.NOT_FOUND, 'OCR file was not found in this tenant', 404);
      this.assertOcrMime(file.mime);
      if (file.status !== 'ready') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'Finalize the document before creating an OCR job', 422, {
          field: 'fileId',
        });
      }

      const [active] = await tx
        .select({ id: ocrJobs.id })
        .from(ocrJobs)
        .where(
          and(
            eq(ocrJobs.tenantId, tenantId),
            eq(ocrJobs.fileId, input.fileId),
            inArray(ocrJobs.status, ['queued', 'processing']),
          ),
        )
        .limit(1);
      if (active) {
        throw new DomainError(errorCodes.INVALID_STATE, 'An OCR job is already active for this file', 409, {
          jobId: active.id,
        });
      }

      const id = newId();
      await tx.insert(ocrJobs).values({
        id,
        tenantId,
        fileId: input.fileId,
        entityType: OCR_ENTITY_TYPE,
        status: 'queued',
        createdBy: tryGetAuthContext()?.userId,
      });
      await this.outbox.enqueueInTx(tx, {
        tenantId,
        queue: 'maintenance',
        type: 'ocr.process',
        payload: { jobId: id, fileId: input.fileId, entityType: OCR_ENTITY_TYPE },
      });
      return id;
    });

    return this.getJob(tenantId, jobId);
  }

  async listJobs(tenantId: string): Promise<OcrJobDto[]> {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(ocrJobs).where(eq(ocrJobs.tenantId, tenantId)).orderBy(desc(ocrJobs.createdAt)).limit(100),
    );
    return Promise.all(rows.map((row) => this.toDto(tenantId, row)));
  }

  async getJob(tenantId: string, id: string): Promise<OcrJobDto> {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ocrJobs)
        .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, id)))
        .limit(1),
    );
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'OCR job was not found in this tenant', 404);
    return this.toDto(tenantId, row);
  }

  /** Worker entry point. It is safe to run again after a crash or provider timeout. */
  async processJob(tenantId: string, jobId: string): Promise<void> {
    const claimed = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(ocrJobs)
        .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, jobId)))
        .limit(1);
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'OCR job was not found in this tenant', 404);
      if (row.status === 'done') return null;
      const [next] = await tx
        .update(ocrJobs)
        .set({ status: 'processing', attempts: row.attempts + 1, error: null, updatedAt: new Date(), version: row.version + 1 })
        .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, jobId), inArray(ocrJobs.status, ['queued', 'failed'])))
        .returning();
      return next ?? null;
    });
    if (!claimed) return;

    try {
      const file = await this.filesService.read(tenantId, claimed.fileId);
      const download = await this.filesService.providerDownloadUrl(tenantId, claimed.fileId);
      const result = await this.provider.extract({ file, documentUrl: download.url });
      const extracted = normaliseOcrPayload(result.payload);
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(ocrJobs)
          .set({
            status: 'done',
            extracted,
            confidence: extracted.confidence.toFixed(4),
            provider: result.provider,
            error: null,
            processedAt: new Date(),
            updatedAt: new Date(),
            version: claimed.version + 1,
          })
          .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, jobId))),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(ocrJobs)
          .set({ status: 'failed', error: message.slice(0, 2_000), processedAt: new Date(), updatedAt: new Date(), version: claimed.version + 1 })
          .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, jobId))),
      );
      throw error;
    }
  }

  async createInvoiceFromOcr(tenantId: string, input: OcrInvoiceFromInput, actor?: OcrActor) {
    const [job] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ocrJobs)
        .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, input.ocrJobId)))
        .limit(1),
    );
    if (!job) throw new DomainError(errorCodes.NOT_FOUND, 'OCR job was not found in this tenant', 404);
    if (job.status !== 'done') throw new DomainError(errorCodes.INVALID_STATE, 'Only a completed OCR job can create a draft', 409);

    const extracted = normaliseStoredExtraction(job.extracted);
    const partyId = input.partyId ?? (await this.findSupplier(tenantId, input.supplierName ?? extracted.supplierName))?.id;
    if (!partyId) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Select or create a supplier before creating the draft', 422, {
        field: 'partyId',
      });
    }

    const mappedLines = (input.lines ?? []).map((line): PurchaseLineInput => ({
      itemId: line.itemId,
      description: line.description ?? undefined,
      quantity: line.quantity ?? extracted.lines.find((candidate) => candidate.description === line.description)?.quantity ?? '1',
      unitPrice: line.unitPrice ?? extracted.lines.find((candidate) => candidate.description === line.description)?.unitPrice ?? '0',
      taxRate: line.taxRate ?? '0',
      taxGroupId: line.taxGroupId,
    }));
    if (job.draftInvoiceId) {
      if (mappedLines.length === 0) return this.purchases.get(tenantId, job.draftInvoiceId);
      return this.purchases.replaceDraftLines(tenantId, job.draftInvoiceId, mappedLines);
    }

    const invoice = await this.purchases.create(tenantId, {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      partyId,
      currency: input.currency ?? extracted.currency ?? undefined,
      supplierReferenceNo: input.supplierReferenceNo ?? extracted.invoiceNumber ?? undefined,
      supplierReferenceDate: input.supplierReferenceDate ?? extracted.invoiceDate ?? undefined,
      headerTotals:
        mappedLines.length === 0
          ? input.headerTotals ?? {
              subtotal: extracted.subtotal ?? '0',
              tax: extracted.taxAmount ?? '0',
              total: extracted.total ?? '0',
            }
          : undefined,
      lines: mappedLines,
    });

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(ocrJobs)
        .set({ draftInvoiceId: invoice.id, updatedAt: new Date(), version: job.version + 1 })
        .where(and(eq(ocrJobs.tenantId, tenantId), eq(ocrJobs.id, job.id), isNull(ocrJobs.draftInvoiceId)));
    });

    if (actor) {
      await this.filesService.finalize(tenantId, actor.userId, actor.membershipId, job.fileId, {
        entity: 'purchase_invoice',
        entityId: invoice.id,
      });
    }
    return invoice;
  }

  private async findSupplier(tenantId: string, name: string | null) {
    if (!name) return undefined;
    const candidates = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), inArray(parties.kind, ['supplier', 'both'])))
        .limit(500),
    );
    const needle = name.trim().toLocaleLowerCase();
    return candidates.find((party) => party.name.trim().toLocaleLowerCase() === needle);
  }

  private async toDto(tenantId: string, row: typeof ocrJobs.$inferSelect): Promise<OcrJobDto> {
    const file = await this.filesService.read(tenantId, row.fileId);
    const download = await this.filesService.downloadUrl(tenantId, row.fileId);
    return {
      id: row.id,
      file: { id: file.id, name: file.name, mime: file.mime, downloadUrl: download.url },
      entityType: row.entityType as OcrEntityType,
      status: row.status as OcrJobStatus,
      extracted: normaliseStoredExtraction(row.extracted),
      confidence: row.confidence === null ? null : Number(row.confidence),
      provider: row.provider,
      error: row.error,
      attempts: row.attempts,
      processedAt: row.processedAt?.toISOString() ?? null,
      draftInvoiceId: row.draftInvoiceId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function normaliseStoredExtraction(value: unknown): OcrExtraction {
  const extraction = normaliseOcrPayload(value);
  // Values written by `normaliseOcrPayload` are already canonical. Running through the
  // same boundary again also protects old rows created by a provider before a deploy.
  return extraction;
}
