import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId, permissionGrants } from '@erp/contracts';
import { fieldSyncQueue, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { VanSalesCustodyService } from '../van-sales/van-sales-custody.service.js';
import { VanSalesDocumentsService } from '../van-sales/van-sales-documents.service.js';
import { VanSalesLoadOrdersService } from '../van-sales/van-sales-load-orders.service.js';
import { first, rows, str } from '../van-sales/van-sales-shared.service.js';

import type { AuthorisedRep } from './field-sync-rep-guard.service.js';

/**
 * ♻️ إعادة تشغيل طابور المندوب — replaying the device's offline queue, one row at a time.
 *
 * Same contract as offline POS (`pos.service.ts offlineSync`): a bad row is a row-level
 * conflict, never a batch failure; the device learns per row whether it synced, already
 * synced (idempotent replay), or conflicts and why.
 *
 * Idempotency is layered, outermost first:
 *
 *   1. `offline_id` unique per tenant — a synced row answers with its recorded outcome
 *      without calling any engine (remove-local-copy).
 *   2. `(device, sequence)` monotonic — an old or replayed sequence never re-enters.
 *   3. The engine saga keys — every engine call passes
 *      `idempotencyKey = "field-sync:{offlineId}"`, and the van-sales sagas (documents,
 *      collections) already key their documents/movements/payments on it. If the process
 *      dies between the engine commit and the queue update, the next replay re-calls the
 *      saga, which finds its own key and does nothing twice.
 *
 * Ownership (D-004) is checked BEFORE any engine call: the load order / credit document
 * named in a payload must belong to the replaying rep's own salesman card, and the
 * `salesman_id` written on the queue row is derived from his membership, never taken from
 * the payload. A `collection`/`return` may instead name a `sourceOfflineId` — an invoice
 * from the same device's queue — which resolves to that row's document, so a rep can
 * collect a credit sale he just made offline before the server had ever seen it.
 */
@Injectable()
export class FieldSyncReplayService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly documents: VanSalesDocumentsService,
    private readonly custody: VanSalesCustodyService,
    private readonly loadOrders: VanSalesLoadOrdersService,
  ) {}

  async replay(input: {
    tenantId: string;
    userId: string;
    membershipId: string | null;
    permissions: readonly string[];
    rep: AuthorisedRep;
    batch: FieldSyncReplayInput;
  }) {
    const { tenantId, userId, membershipId, permissions, rep } = input;
    const batch = input.batch ?? ({} as FieldSyncReplayInput);
    const operations = Array.isArray(batch.operations) ? batch.operations : [];
    if (operations.length === 0)
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'مرر عمليات الطابور للمزامنة', 422);
    if (operations.length > 100)
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'دفعة المزامنة لا تتجاوز 100 عملية', 422);

    const results: Array<Record<string, unknown>> = [];
    const seenDeviceSequences = new Set<string>();

    for (const operation of operations) {
      results.push(
        await this.replayOne(
          { tenantId, userId, membershipId, permissions, rep },
          operation,
          batch,
          seenDeviceSequences,
        ),
      );
    }

    return {
      data: {
        processed: results.length,
        synced: results.filter((row) => row.status === 'synced').length,
        conflicts: results.filter((row) => row.status === 'conflict').length,
        results,
      },
    };
  }

  private async replayOne(
    ctx: ReplayContext,
    operation: FieldSyncReplayOperation,
    batch: FieldSyncReplayInput,
    seenDeviceSequences: Set<string>,
  ): Promise<Record<string, unknown>> {
    const { tenantId, userId, rep } = ctx;
    const deviceId = str(operation.deviceId ?? batch.deviceId).trim();
    const offlineId = typeof operation.offlineId === 'string' ? operation.offlineId.trim() : '';
    const sequenceNo = operation.sequenceNo;
    const kind = str(operation.operation).trim();

    if (!deviceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) {
      return conflict(offlineId || null, sequenceNo, 'FIELD_SYNC_DEVICE_INVALID', 'معرّف جهاز ثابت مطلوب', {
        action: 'reconfigure-device',
      });
    }
    if (!offlineId || offlineId.length > 160 || !Number.isInteger(sequenceNo) || (sequenceNo ?? 0) <= 0) {
      return conflict(offlineId || null, sequenceNo, 'FIELD_SYNC_SEQUENCE_INVALID', 'offlineId ورقم تسلسل صحيح موجب مطلوبان', {
        action: 'edit-and-retry',
      });
    }
    /** التحقق أعلاه يضمن أنه عدد صحيح موجب؛ هذا يُثبّت النوع لبقية الدالة. */
    const seq = sequenceNo as number;
    const sequenceKey = `${deviceId}:${seq}`;
    if (seenDeviceSequences.has(sequenceKey)) {
      return conflict(offlineId, seq, 'FIELD_SYNC_SEQUENCE_DUPLICATE', 'رقم التسلسل مكرر داخل الدفعة', {
        action: 'remove-duplicate',
      });
    }
    seenDeviceSequences.add(sequenceKey);

    if (!['invoice', 'collection', 'return', 'receipt'].includes(kind)) {
      return conflict(offlineId, seq, 'FIELD_SYNC_OPERATION_UNKNOWN', `عملية غير معروفة: ${kind}`, {
        action: 'edit-and-retry',
      });
    }

    // 1) السجل القائم — a previously synced row replays its recorded outcome, a pending
    //    row from another sequence/device is a client bug, never re-entered blindly.
    const [existing] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(fieldSyncQueue)
        .where(and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.offlineId, offlineId)))
        .limit(1),
    );
    if (existing) {
      if (existing.salesmanId && existing.salesmanId !== rep.salesmanId) {
        return conflict(offlineId, seq, 'FIELD_SYNC_SCOPE_VIOLATION', 'المعرّف offlineId مسجل على مندوب آخر', {
          action: 'use-own-offline-ids',
        });
      }
      if (existing.sequenceNo !== seq) {
        return conflict(offlineId, seq, 'FIELD_SYNC_ID_SEQUENCE_MISMATCH', 'نفس offlineId أُرسل برقم تسلسل آخر', {
          action: 'restore-original-sequence',
          sequenceNo: existing.sequenceNo,
        });
      }
      if (existing.status === 'synced') {
        return {
          offlineId,
          sequenceNo: seq,
          status: 'synced',
          operation: existing.operation,
          result: existing.result ?? null,
          documentId: existing.documentId ?? null,
          resolution: { action: 'remove-local-copy' },
        };
      }
    }

    // 2) التسلسل حسب الجهاز — monotonic per device, and the device belongs to one rep.
    const [latest] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          sequenceNo: fieldSyncQueue.sequenceNo,
          salesmanId: fieldSyncQueue.salesmanId,
        })
        .from(fieldSyncQueue)
        .where(and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.deviceId, deviceId)))
        .orderBy(desc(fieldSyncQueue.sequenceNo))
        .limit(1),
    );
    if (!existing && latest) {
      if (latest.salesmanId && latest.salesmanId !== rep.salesmanId) {
        return conflict(offlineId, seq, 'FIELD_SYNC_DEVICE_BOUND', 'الجهاز مسجل على مندوب آخر', {
          action: 'use-own-device',
        });
      }
      if (seq <= latest.sequenceNo) {
        return conflict(offlineId, seq, 'FIELD_SYNC_SEQUENCE_OLD', `التسلسل ${seq} ليس أحدث من آخر تسلسل مقبول ${latest.sequenceNo}`, {
          action: 'refresh-device-sequence',
          lastAcceptedSequence: latest.sequenceNo,
        });
      }
    }

    // 3) الصلاحية — route-level van_sales.view already passed; each operation still needs
    //    its own code, so a rep licensed only to collect cannot invoice through the queue.
    const requiredPermission =
      kind === 'collection' ? 'van_sales.collection.create' : 'van_sales.invoice.create';
    if (!permissionGrants(ctx.permissions, requiredPermission)) {
      return conflict(offlineId, seq, 'FIELD_SYNC_PERMISSION_MISSING', `الصلاحية ${requiredPermission} مطلوبة`, {
        action: 'request-permission',
        permission: requiredPermission,
      });
    }

    const payload = (operation.payload ?? {}) as Record<string, unknown>;

    // 4) الملكية (D-004) — the named resource must be the rep's own, checked before any
    //    engine call so a foreign id is a clean conflict, not a saga half-run.
    const ownership = await this.resolveOwnership(ctx, kind, payload, offlineId, seq);
    if ('conflict' in ownership) return ownership.conflict;
    const owned = ownership.resolved;

    // 5) تسجيل الصف قبل المحرك — pending first: whatever happens next, the ledger shows
    //    the device sent it (and the crash window between engine commit and this update is
    //    covered by the saga idempotency keys in step 6).
    if (existing) {
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(fieldSyncQueue)
          .set({
            status: 'pending',
            operation: kind,
            payload: payload as Record<string, unknown>,
            errorCode: null,
            errorDetail: null,
            updatedAt: new Date(),
          })
          .where(and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.offlineId, offlineId))),
      );
    } else {
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.insert(fieldSyncQueue).values({
          id: newId(),
          tenantId,
          deviceId,
          salesmanId: rep.salesmanId,
          offlineId,
          sequenceNo: seq,
          operation: kind,
          status: 'pending',
          payload: payload as Record<string, unknown>,
          createdBy: userId,
          createdAt:
            operation.createdAt && !Number.isNaN(Date.parse(operation.createdAt))
              ? new Date(operation.createdAt)
              : new Date(),
          updatedAt: new Date(),
        }),
      );
    }

    // 6) المحرك الرسمي — always the van-sales sagas; they alone talk to
    //    `sales.postInTx` / the treasury voucher engine. No second document writer.
    try {
      const outcome = await this.runEngine(ctx, kind, payload, owned, offlineId);
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(fieldSyncQueue)
          .set({
            status: 'synced',
            result: outcome.result,
            documentId: outcome.documentId ?? null,
            errorCode: null,
            errorDetail: null,
            updatedAt: new Date(),
            syncedAt: new Date(),
          })
          .where(and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.offlineId, offlineId))),
      );
      return {
        offlineId,
        sequenceNo: seq,
        status: 'synced',
        operation: kind,
        ...outcome.result,
      };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : 'تعذّر ترحيل العملية';

      /**
       * نافذة الانهيار — the receipt saga committed but the queue update did not. The
       * load order is no longer awaiting receipt, which is exactly the evidence that the
       * receipt already happened: record it as synced instead of a false conflict.
       */
      if (kind === 'receipt' && code === 'VAN_LOAD_ORDER_NOT_AWAITING_RECEIPT') {
        const state = await this.loadOrderState(tenantId, str(owned.loadOrderId));
        if (state && Number(state.receivedQty) > 0) {
          const outcome = {
            loadOrderId: str(owned.loadOrderId),
            loadOrderStatus: state.status,
            receivedQty: state.receivedQty,
          };
          await withTenantTx(this.database.db, tenantId, (tx) =>
            tx
              .update(fieldSyncQueue)
              .set({
                status: 'synced',
                result: outcome,
                errorCode: null,
                errorDetail: null,
                updatedAt: new Date(),
                syncedAt: new Date(),
              })
              .where(
                and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.offlineId, offlineId)),
              ),
          );
          return { offlineId, sequenceNo: seq, status: 'synced', operation: kind, ...outcome };
        }
      }

      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(fieldSyncQueue)
          .set({ status: 'conflict', errorCode: code, errorDetail: message, updatedAt: new Date() })
          .where(and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.offlineId, offlineId))),
      );
      return conflict(offlineId, seq, code, message, resolutionFor(code));
    }
  }

  /**
   * ملكية الموارد — resolves what the payload names into concrete, rep-owned resources.
   * `sourceOfflineId` lets a collection/return target an invoice from this same device's
   * queue (already synced earlier in the batch) before the server ever assigned it a
   * number the device could know.
   */
  private async resolveOwnership(
    ctx: ReplayContext,
    kind: string,
    payload: Record<string, unknown>,
    offlineId: string,
    seq: number,
  ): Promise<{ resolved: OwnedResources } | { conflict: Record<string, unknown> }> {
    const { tenantId, rep } = ctx;
    const scopeViolation = (detail: string) =>
      conflict(offlineId, seq, 'FIELD_SYNC_SCOPE_VIOLATION', detail, {
        action: 'review-and-retry',
      });
    const invalid = (message: string) =>
      conflict(offlineId, seq, 'FIELD_SYNC_SEQUENCE_INVALID', message, {
        action: 'edit-and-retry',
      });
    const missing = (code: string, message: string, action: string) =>
      conflict(offlineId, seq, code, message, { action });

    if (kind === 'invoice' || kind === 'receipt') {
      const loadOrderId = str(payload.loadOrderId).trim();
      if (!loadOrderId) return { conflict: invalid('loadOrderId مطلوب') };
      const order = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT salesman_id::text FROM van_load_orders
            WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          `),
        ),
      );
      if (!order)
        return { conflict: missing(errorCodes.NOT_FOUND, 'أمر التحميل غير موجود', 'refresh-load-orders') };
      if (str(order.salesman_id) !== rep.salesmanId) {
        return { conflict: scopeViolation('أمر التحميل لعهدة مندوب آخر') };
      }
      return { resolved: { loadOrderId } };
    }

    // collection / return — a server document id or this device's own earlier offline id.
    const documentId = str(payload.documentId).trim();
    const sourceOfflineId = str(payload.sourceOfflineId).trim();
    let resolvedDocumentId = documentId || null;
    if (!resolvedDocumentId && sourceOfflineId) {
      const [source] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select({
            status: fieldSyncQueue.status,
            documentId: fieldSyncQueue.documentId,
            salesmanId: fieldSyncQueue.salesmanId,
          })
          .from(fieldSyncQueue)
          .where(
            and(eq(fieldSyncQueue.tenantId, tenantId), eq(fieldSyncQueue.offlineId, sourceOfflineId)),
          )
          .limit(1),
      );
      if (!source || source.status !== 'synced' || !source.documentId) {
        return {
          conflict: conflict(
            offlineId,
            seq,
            'FIELD_SYNC_SOURCE_NOT_SYNCED',
            'الفاتورة المصدر غير موجودة أو لم تُرحَّل بعد',
            { action: 'retry-after-source' },
          ),
        };
      }
      if (source.salesmanId && source.salesmanId !== rep.salesmanId) {
        return { conflict: scopeViolation('الفاتورة المصدر لمندوب آخر') };
      }
      resolvedDocumentId = source.documentId;
    }
    if (!resolvedDocumentId) {
      return { conflict: invalid('documentId أو sourceOfflineId مطلوب') };
    }
    const doc = await withTenantTx(this.database.db, tenantId, async (tx) =>
      first(
        await tx.execute(sql`
          SELECT salesman_id::text FROM van_sales_documents
          WHERE id = ${resolvedDocumentId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      ),
    );
    if (!doc) return { conflict: missing(errorCodes.NOT_FOUND, 'المستند غير موجود', 'refresh-documents') };
    if (str(doc.salesman_id) !== rep.salesmanId) {
      return { conflict: scopeViolation('المستند لعهدة مندوب آخر') };
    }
    return { resolved: { documentId: resolvedDocumentId } };
  }

  /** الاستدعاء الوحيد للمحركات — van-sales sagas only; outcome is read back, not derived. */
  private async runEngine(
    ctx: ReplayContext,
    kind: string,
    payload: Record<string, unknown>,
    owned: OwnedResources,
    offlineId: string,
  ): Promise<{ result: Record<string, unknown>; documentId?: string }> {
    const { tenantId, userId, membershipId } = ctx;
    const engineKey = `field-sync:${offlineId}`;

    if (kind === 'invoice') {
      type CreateDocumentBody = Parameters<VanSalesDocumentsService['createDocument']>[2];
      await this.documents.createDocument(tenantId, userId, {
        ...payload,
        loadOrderId: owned.loadOrderId,
        idempotencyKey: engineKey,
      } as CreateDocumentBody);
      const doc = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT d.id::text, d.number, d.total::text, d.sales_invoice_id::text,
                   si.number AS invoice_number
            FROM van_sales_documents d
            LEFT JOIN sales_invoices si ON si.id = d.sales_invoice_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.idempotency_key = ${engineKey}
              AND d.document_kind = 'sale'
              AND d.deleted_at IS NULL
            ORDER BY d.created_at DESC
            LIMIT 1
          `),
        ),
      );
      if (!doc) throw new DomainError('INTERNAL', 'لم يُعثر على المستند بعد الترحيل', 500);
      return {
        documentId: str(doc.id),
        result: {
          documentId: str(doc.id),
          documentNumber: str(doc.number),
          total: str(doc.total),
          salesInvoiceId: doc.sales_invoice_id ? str(doc.sales_invoice_id) : null,
          invoiceNumber: doc.invoice_number ? str(doc.invoice_number) : null,
        },
      };
    }

    if (kind === 'return') {
      await this.documents.createReturnDocument(tenantId, userId, {
        documentId: owned.documentId,
        returnedQty: str(payload.returnedQty) || undefined,
        reason: str(payload.reason) || undefined,
        notes: str(payload.notes) || undefined,
        idempotencyKey: engineKey,
      });
      const doc = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT d.id::text, d.number, d.total::text, d.sales_invoice_id::text,
                   si.number AS invoice_number
            FROM van_sales_documents d
            LEFT JOIN sales_invoices si ON si.id = d.sales_invoice_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.idempotency_key = ${engineKey}
              AND d.document_kind = 'return'
              AND d.deleted_at IS NULL
            ORDER BY d.created_at DESC
            LIMIT 1
          `),
        ),
      );
      if (!doc) throw new DomainError('INTERNAL', 'لم يُعثر على مستند المرتجع بعد الترحيل', 500);
      return {
        documentId: str(doc.id),
        result: {
          documentId: str(doc.id),
          documentNumber: str(doc.number),
          total: str(doc.total),
          salesInvoiceId: doc.sales_invoice_id ? str(doc.sales_invoice_id) : null,
          invoiceNumber: doc.invoice_number ? str(doc.invoice_number) : null,
        },
      };
    }

    if (kind === 'collection') {
      await this.custody.collectCustomerDebt(tenantId, userId, {
        documentId: owned.documentId,
        collectedAmount: str(payload.collectedAmount) || undefined,
        cashLocationId: str(payload.cashLocationId) || undefined,
        offsetAccountId: str(payload.offsetAccountId) || undefined,
        notes: str(payload.notes) || undefined,
        idempotencyKey: engineKey,
      });
      const movement = await withTenantTx(this.database.db, tenantId, async (tx) =>
        first(
          await tx.execute(sql`
            SELECT m.id::text, m.amount::text, m.voucher_id::text, v.number AS voucher_number,
                   v.status AS voucher_status
            FROM van_stock_movements m
            LEFT JOIN vouchers v ON v.id = m.voucher_id
            WHERE m.tenant_id = ${tenantId}::uuid
              AND m.idempotency_key = ${engineKey}
              AND m.movement_type = 'collection_receipt'
            ORDER BY m.created_at DESC
            LIMIT 1
          `),
        ),
      );
      if (!movement) throw new DomainError('INTERNAL', 'لم يُعثر على حركة التحصيل بعد الترحيل', 500);
      return {
        result: {
          movementId: str(movement.id),
          amount: str(movement.amount),
          voucherId: movement.voucher_id ? str(movement.voucher_id) : null,
          voucherNumber: movement.voucher_number ? str(movement.voucher_number) : null,
          voucherStatus: movement.voucher_status ? str(movement.voucher_status) : null,
        },
      };
    }

    // receipt
    await this.loadOrders.confirmReceipt(tenantId, userId, membershipId, str(owned.loadOrderId), {
      receivedQty: str(payload.receivedQty) || undefined,
      notes: str(payload.notes) || undefined,
    });
    const state = await this.loadOrderState(tenantId, str(owned.loadOrderId));
    return {
      result: {
        loadOrderId: str(owned.loadOrderId),
        loadOrderStatus: state?.status ?? null,
        receivedQty: state?.receivedQty ?? null,
      },
    };
  }

  private async loadOrderState(tenantId: string, loadOrderId: string) {
    const row = await withTenantTx(this.database.db, tenantId, async (tx) =>
      first(
        await tx.execute(sql`
          SELECT status, received_qty::text FROM van_load_orders
          WHERE id = ${loadOrderId}::uuid AND tenant_id = ${tenantId}::uuid
        `),
      ),
    );
    if (!row) return null;
    return { status: str(row.status), receivedQty: str(row.received_qty) };
  }

  /** 📥 صندوق التعارضات — the rep's own queue rows, newest first. */
  async queue(tenantId: string, rep: AuthorisedRep, status?: string, limit = 200) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const statusFilter =
        status && ['pending', 'synced', 'conflict'].includes(status)
          ? sql`AND q.status = ${status}`
          : sql``;
      const limitClamp = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const queueRows = rows(
        await tx.execute(sql`
          SELECT q.id::text, q.device_id, q.offline_id, q.sequence_no::text, q.operation,
                 q.status, q.result::text, q.document_id::text, q.error_code, q.error_detail,
                 q.created_at, q.synced_at
          FROM field_sync_queue q
          WHERE q.tenant_id = ${tenantId}::uuid
            AND q.salesman_id = ${rep.salesmanId}::uuid
            ${statusFilter}
          ORDER BY q.created_at DESC
          LIMIT ${limitClamp}
        `),
      );
      return {
        data: queueRows.map((row) => ({
          id: str(row.id),
          deviceId: str(row.device_id),
          offlineId: str(row.offline_id),
          sequenceNo: str(row.sequence_no),
          operation: str(row.operation),
          status: str(row.status),
          result: row.result ? JSON.parse(str(row.result)) : null,
          documentId: row.document_id ? str(row.document_id) : null,
          errorCode: row.error_code ? str(row.error_code) : null,
          errorDetail: row.error_detail ? str(row.error_detail) : null,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : str(row.created_at),
          syncedAt:
            row.synced_at instanceof Date
              ? row.synced_at.toISOString()
              : row.synced_at
                ? str(row.synced_at)
                : null,
        })),
      };
    });
  }
}

type ReplayContext = {
  tenantId: string;
  userId: string;
  membershipId: string | null;
  permissions: readonly string[];
  rep: AuthorisedRep;
};

type OwnedResources = {
  loadOrderId?: string;
  documentId?: string;
};

export type FieldSyncReplayInput = {
  deviceId?: string;
  operations: FieldSyncReplayOperation[];
};

export type FieldSyncReplayOperation = {
  deviceId?: string;
  offlineId?: string;
  sequenceNo?: number;
  operation?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
};

function conflict(
  offlineId: string | null,
  sequenceNo: number | undefined,
  code: string,
  message: string,
  resolution: Record<string, unknown>,
): Record<string, unknown> {
  return {
    offlineId,
    sequenceNo: sequenceNo ?? null,
    status: 'conflict',
    errorCode: code,
    message,
    resolution,
  };
}

function resolutionFor(code: string): Record<string, unknown> {
  if (code === 'STOCK_INSUFFICIENT' || code === errorCodes.VALIDATION_FAILED)
    return { action: 'edit-quantity-or-refresh-stock' };
  if (code === 'PARTY_CREDIT_LIMIT_EXCEEDED') return { action: 'reduce-qty-or-collect-first' };
  if (code === 'ACCOUNTING_PERIOD_CLOSED' || code === 'ACCOUNT_PROFILE_MISSING')
    return { action: 'contact-accountant' };
  return { action: 'review-and-retry' };
}
