/**
 * M5 — the operation builders: every write the rep app can make offline, shaped EXACTLY
 * as the M4 replay endpoint (`apps/api/src/modules/field-sync/field-sync-replay.service.ts`)
 * consumes them. The acceptance tests in `tests/offline.spec.ts` pin these shapes against
 * the payloads the API's own specs replay.
 *
 * Money and quantities are strings everywhere (PROJECT_CONTRACT §3 — decimal.js locally,
 * server-side Decimal on the API; floats never touch money).
 */
import { Decimal } from 'decimal.js';

import { getOrCreateDeviceId, nextSequence, saveQueueRecord } from './rep-db';
import type {
  RepCollectionPayload,
  RepInvoicePayload,
  RepOpenCreditDocument,
  RepOpenLoadOrder,
  RepQueueRecord,
  RepReceiptPayload,
  RepReturnPayload,
  RepStockRow,
} from './types';

Decimal.set({ precision: 20 });

async function enqueue(
  operation: RepQueueRecord['operation'],
  payload: RepQueueRecord['payload'],
): Promise<RepQueueRecord> {
  const deviceId = await getOrCreateDeviceId();
  const sequenceNo = await nextSequence();
  const entropy = Math.random().toString(36).slice(2, 8);
  const record: RepQueueRecord = {
    offlineId: `OFFLINE-${deviceId}-${sequenceNo}-${entropy}`,
    deviceId,
    sequenceNo,
    createdAt: new Date().toISOString(),
    operation,
    payload,
    status: 'pending',
  };
  await saveQueueRecord(record);
  return record;
}

/* ------------------------------------------------------- custody math */

/**
 * Expected remaining on a load order — the SAME formula the API enforces
 * (`load_orders` remaining = `COALESCE(NULLIF(received_qty, 0), loaded_qty) - sold_qty -
 * bonus_qty - returned_qty - damaged_qty`), evaluated offline on the snapshot row.
 */
export function remainingOfLoadOrder(order: RepOpenLoadOrder): Decimal {
  const base = new Decimal(order.receivedQty || '0');
  const effective = base.isZero() ? new Decimal(order.loadedQty || '0') : base;
  return effective
    .minus(new Decimal(order.soldQty || '0'))
    .minus(new Decimal(order.bonusQty || '0'))
    .minus(new Decimal(order.returnedQty || '0'))
    .minus(new Decimal(order.damagedQty || '0'));
}

/** Cash still owed on a load order (expected − collected). */
export function outstandingCashOf(order: RepOpenLoadOrder): Decimal {
  return new Decimal(order.expectedCash || '0').minus(new Decimal(order.collectedCash || '0'));
}

/** Outstanding on an open credit document. */
export function outstandingOfDocument(document: RepOpenCreditDocument): Decimal {
  return new Decimal(document.outstanding ?? '0');
}

/**
 * A pending return's target (which order + item it gives qty back to). Server documents
 * carry their load order on the snapshot row; offline invoices are resolved through the
 * queue record that created them.
 */
export function resolveReturnTarget(
  payload: RepReturnPayload,
  records: RepQueueRecord[],
  documents: RepOpenCreditDocument[],
): { loadOrderId: string; itemId: string | null } | null {
  if (payload.sourceOfflineId) {
    const invoice = records.find((record) => record.offlineId === payload.sourceOfflineId);
    if (invoice && invoice.operation === 'invoice') {
      const invoicePayload = invoice.payload as RepInvoicePayload;
      return { loadOrderId: invoicePayload.loadOrderId, itemId: invoicePayload.itemId ?? null };
    }
    return null;
  }
  if (payload.documentId) {
    const document = documents.find((row) => row.id === payload.documentId);
    if (!document) return null;
    return { loadOrderId: document.loadOrderId ?? '', itemId: document.itemId ?? null };
  }
  return null;
}

function liveOps(records: RepQueueRecord[]): RepQueueRecord[] {
  // Conflicted ops are excluded everywhere below: on the server they did NOT happen.
  return records.filter((record) => record.status === 'pending' || record.status === 'synced');
}

/**
 * The load order's remaining as THIS PHONE sees it: snapshot remaining minus pending
 * invoices (sold+bonus) plus pending returns. Pending receipts change nothing — the
 * server refuses to sell off an unreceived order (`VAN_LOAD_ORDER_NOT_RECEIVED`), and
 * so does this projection: `remainingOfLoadOrder` already uses `receivedQty`/`loadedQty`
 * from the snapshot, which a pending receipt has not touched yet.
 */
export function projectedRemaining(order: RepOpenLoadOrder, records: RepQueueRecord[], documents: RepOpenCreditDocument[]): Decimal {
  let projected = remainingOfLoadOrder(order);
  for (const record of records) {
    if (record.status !== 'pending') continue;
    if (record.operation === 'invoice') {
      const payload = record.payload as RepInvoicePayload;
      if (payload.loadOrderId === order.id) {
        projected = projected.minus(new Decimal(payload.soldQty || '0')).minus(new Decimal(payload.bonusQty || '0'));
      }
    }
    if (record.operation === 'return') {
      const target = resolveReturnTarget(record.payload as RepReturnPayload, records, documents);
      if (target?.loadOrderId === order.id) {
        projected = projected.plus(new Decimal((record.payload as RepReturnPayload).returnedQty || '0'));
      }
    }
  }
  return projected;
}

/**
 * Van stock as this phone sees it: snapshot stock minus pending invoice qty (sold+bonus)
 * plus pending returns that resolve to this item. Synced ops are already inside the next
 * delta's stock rows.
 */
export function projectedStock(stock: RepStockRow, records: RepQueueRecord[], documents: RepOpenCreditDocument[]): Decimal {
  let projected = new Decimal(stock.quantity || '0');
  for (const record of records) {
    if (record.status !== 'pending') continue;
    if (record.operation === 'invoice' && (record.payload as RepInvoicePayload).itemId === stock.itemId) {
      const payload = record.payload as RepInvoicePayload;
      projected = projected.minus(new Decimal(payload.soldQty || '0')).minus(new Decimal(payload.bonusQty || '0'));
    }
    if (record.operation === 'return') {
      const target = resolveReturnTarget(record.payload as RepReturnPayload, records, documents);
      if (target?.itemId === stock.itemId) {
        projected = projected.plus(new Decimal((record.payload as RepReturnPayload).returnedQty || '0'));
      }
    }
  }
  return projected;
}

/**
 * Estimated total of an offline invoice. The SERVER computes the document's money
 * (zatca_tax adds the 15% VAT, internal_delivery does not — M4 facts); this estimate
 * exists only so the rep sees a number before the first sync, and every screen that
 * shows it labels it تقديري.
 */
export function estimateInvoiceTotal(payload: RepInvoicePayload): Decimal {
  const net = new Decimal(payload.soldQty || '0').times(new Decimal(payload.unitPrice || '0')).minus(new Decimal(payload.discountAmount || '0'));
  return payload.invoiceMode === 'zatca_tax' ? net.times(new Decimal('1.15')) : net;
}

/**
 * What is still uncollected on an offline invoice of this device: the synced record's
 * server total (or the estimate while pending) minus every collection that targets it
 * (`sourceOfflineId`, the M4 self-collection path).
 */
export function outstandingOfOfflineInvoice(offlineId: string, records: RepQueueRecord[]): Decimal {
  const invoice = records.find((record) => record.offlineId === offlineId);
  if (!invoice || invoice.operation !== 'invoice') return new Decimal(0);
  const recordedTotal = invoice.total ? new Decimal(invoice.total) : null;
  const totalValue = invoice.status === 'synced' && recordedTotal ? recordedTotal : estimateInvoiceTotal(invoice.payload as RepInvoicePayload);
  const collected = liveOps(records)
    .filter((record) => record.operation === 'collection' && (record.payload as RepCollectionPayload).sourceOfflineId === offlineId)
    .reduce((sum, record) => sum.plus(new Decimal((record.payload as RepCollectionPayload).collectedAmount || '0')), new Decimal(0));
  return Decimal.max(totalValue.minus(collected), new Decimal(0));
}

/* ---------------------------------------------------------- the builders */

/** `operation: 'invoice'` — a van sale with optional bonus lines (VTX/VDL upstream). */
export async function enqueueInvoice(payload: RepInvoicePayload): Promise<RepQueueRecord> {
  return enqueue('invoice', payload);
}

/** `operation: 'collection'` — cash collected on a server document or on an offline
 * invoice of this same device (`sourceOfflineId`, the M4 self-collection path). */
export async function enqueueCollection(payload: RepCollectionPayload): Promise<RepQueueRecord> {
  if (!payload.documentId && !payload.sourceOfflineId) {
    throw new Error('التحصيل يحتاج مستندًا خادميًا أو فاتورة محلية');
  }
  return enqueue('collection', payload);
}

/** `operation: 'return'` — goods returned against a document or an offline invoice. */
export async function enqueueReturn(payload: RepReturnPayload): Promise<RepQueueRecord> {
  if (!payload.documentId && !payload.sourceOfflineId) {
    throw new Error('المرتجع يحتاج مستندًا خادميًا أو فاتورة محلية');
  }
  return enqueue('return', payload);
}

/** `operation: 'receipt'` — the rep confirming he received the loaded goods. */
export async function enqueueReceipt(payload: RepReceiptPayload): Promise<RepQueueRecord> {
  return enqueue('receipt', payload);
}

/** Formats a quantity the way the rep-workspace screens do (4 decimals). */
export function formatQty(value: Decimal | string | number): string {
  return new Decimal(value).toFixed(4);
}

/** Formats money the way the rep-workspace screens do (2 decimals). */
export function formatMoney(value: Decimal | string | number): string {
  return new Decimal(value).toFixed(2);
}
