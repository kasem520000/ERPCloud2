/**
 * M5 — the rep app's sync engine (mirrors `packages/web-core/src/sync-engine.ts` (M2),
 * rep-shaped): pull snapshot/delta into the offline stores, push the pending queue via
 * `POST /field-sync/replay`, and merge every result back into the queue records.
 *
 * Auto-sync starts on mount, listens to `online`, and ticks every 10 seconds — but
 * every cycle is a no-op while offline or while another cycle is in flight.
 */
import { apiData, apiPost } from '@erp/web-core/api';

import {
  applyDelta,
  listQueueRecords,
  pendingQueueRecords,
  readWatermark,
  saveSnapshot,
  updateQueueRecord,
} from './rep-db';
import type { RepDelta, RepOperation, RepQueueRecord, RepServerQueueRow, RepSnapshot, RepSyncResponse } from './types';

const REPLAY_BATCH_LIMIT = 100;
const AUTO_SYNC_INTERVAL_MS = 10_000;

export type PullSummary =
  | { kind: 'snapshot'; watermark: string; counts: Partial<Record<keyof RepSnapshot, number>> }
  | { kind: 'delta'; watermark: string; changed: number; deleted: number; full: number };

export type PushSummary = { processed: number; synced: number; conflicts: number };

export type SyncCycle = { pull?: PullSummary; push?: PushSummary; error?: string };

/** `GET /field-sync/snapshot` — the full pre-route bundle. */
export async function fetchSnapshot(): Promise<RepSnapshot> {
  return apiData<RepSnapshot>('/field-sync/snapshot');
}

/** `GET /field-sync/delta?since=…` — the incremental refresh. */
export async function fetchDelta(since: string): Promise<RepDelta> {
  return apiData<RepDelta>(`/field-sync/delta?since=${encodeURIComponent(since)}`);
}

/** `GET /field-sync/queue` — the server-side inbox (statuses + conflicts). */
export async function fetchServerQueue(): Promise<RepServerQueueRow[]> {
  return apiData<RepServerQueueRow[]>('/field-sync/queue');
}

/** The rep workspace day read (online surfaces: home + closing). */
export async function fetchRepDay(date: string): Promise<{ day: unknown; custody: unknown }> {
  const [day, custody] = await Promise.all([
    apiData<unknown>(`/rep-workspace/day?date=${encodeURIComponent(date)}`),
    apiData<unknown>('/rep-workspace/custody'),
  ]);
  return { day, custody };
}

/**
 * Pull: delta when a watermark exists (falling back to a full snapshot if the server no
 * longer remembers the watermark), snapshot otherwise.
 */
export async function pullRepData(): Promise<PullSummary> {
  const watermark = await readWatermark();
  if (watermark) {
    try {
      const delta = await fetchDelta(watermark);
      await applyDelta(delta);
      return {
        kind: 'delta',
        watermark: delta.watermark,
        changed:
          delta.changed.customers.length +
          delta.changed.customerPrices.length +
          delta.changed.items.length +
          delta.changed.units.length +
          delta.changed.taxes.length +
          delta.changed.priceLists.length +
          delta.changed.priceListItems.length +
          delta.changed.paymentMethods.length,
        deleted:
          delta.deleted.customers.length +
          delta.deleted.customerPrices.length +
          delta.deleted.items.length +
          delta.deleted.units.length +
          delta.deleted.taxes.length +
          delta.deleted.priceLists.length +
          delta.deleted.paymentMethods.length,
        full:
          delta.full.itemUnits.length +
          delta.full.barcodes.length +
          delta.full.stock.length +
          delta.full.openLoadOrders.length +
          delta.full.openCreditDocuments.length,
      };
    } catch (error) {
      // A `since` the server rejects (`VALIDATION_FAILED`, 422 — empty/invalid watermark)
      // means "resnapshot from scratch"; every other error propagates to the caller.
      const code = (error as { code?: string }).code;
      if (code !== 'VALIDATION_FAILED') throw error;
    }
  }
  const snapshot = await fetchSnapshot();
  await saveSnapshot(snapshot);
  return {
    kind: 'snapshot',
    watermark: snapshot.watermark,
    counts: {
      customers: snapshot.customers.length,
      customerPrices: snapshot.customerPrices.length,
      items: snapshot.items.length,
      stock: snapshot.stock.length,
      openLoadOrders: snapshot.openLoadOrders.length,
      openCreditDocuments: snapshot.openCreditDocuments.length,
      paymentMethods: snapshot.paymentMethods.length,
    },
  };
}

/** Maps a queue record to the replay row (the exact wire shape). */
export function toReplayRow(record: RepQueueRecord): RepOperation {
  return {
    offlineId: record.offlineId,
    deviceId: record.deviceId,
    sequenceNo: record.sequenceNo,
    operation: record.operation,
    payload: record.payload,
    createdAt: record.createdAt,
  };
}

/** Folds one replay result back into the local queue record. */
export function mergeResult(record: RepQueueRecord, result: RepSyncResponse['results'][number]): RepQueueRecord {
  return {
    ...record,
    status: result.status === 'synced' ? 'synced' : 'conflict',
    documentId: result.documentId ?? record.documentId ?? null,
    documentNumber: result.documentNumber ?? record.documentNumber ?? null,
    total: result.total ?? record.total ?? null,
    invoiceNumber: result.invoiceNumber ?? record.invoiceNumber ?? null,
    voucherNumber: result.voucherNumber ?? record.voucherNumber ?? null,
    errorCode: result.errorCode ?? null,
    message: result.message ?? null,
    resolution: result.resolution ?? null,
    syncedAt: new Date().toISOString(),
  };
}

/** Push: replay every pending op in sequence order (batches of ≤100, M4 cap). */
export async function pushRepQueue(): Promise<PushSummary> {
  const pending = await pendingQueueRecords();
  const summary: PushSummary = { processed: 0, synced: 0, conflicts: 0 };
  for (let offset = 0; offset < pending.length; offset += REPLAY_BATCH_LIMIT) {
    const batch = pending.slice(offset, offset + REPLAY_BATCH_LIMIT);
    const response = await apiPost<RepSyncResponse>('/field-sync/replay', {
      deviceId: batch[0].deviceId,
      operations: batch.map(toReplayRow),
    });
    for (const result of response.results) {
      const record = batch.find((row) => row.offlineId === result.offlineId);
      if (record) await updateQueueRecord(record.offlineId, mergeResult(record, result));
    }
    summary.processed += response.processed;
    summary.synced += response.synced;
    summary.conflicts += response.conflicts;
  }
  return summary;
}

/** A conflict goes back to pending only by the rep's explicit action (retry button). */
export async function retryConflict(offlineId: string): Promise<void> {
  await updateQueueRecord(offlineId, { status: 'pending', errorCode: null, message: null, resolution: null });
}

/** One full cycle: pull then push. The UI shows exactly what happened. */
export async function runSyncCycle(): Promise<SyncCycle> {
  const cycle: SyncCycle = {};
  try {
    cycle.pull = await pullRepData();
  } catch (error) {
    cycle.error = error instanceof Error ? error.message : String(error);
    return cycle;
  }
  try {
    const pending = await pendingQueueRecords();
    if (pending.length > 0) cycle.push = await pushRepQueue();
  } catch (error) {
    cycle.error = error instanceof Error ? error.message : String(error);
  }
  return cycle;
}

let autoTimer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

/** Same lifecycle as the POS engine: start once, skip while offline or in-flight. */
export function startRepAutoSync(onCycle?: (cycle: SyncCycle) => void): () => void {
  const tick = async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (inFlight) return;
    inFlight = true;
    try {
      const cycle = await runSyncCycle();
      if (onCycle && (cycle.pull || cycle.push || cycle.error)) onCycle(cycle);
    } catch {
      // A dropped cycle is never fatal — the next tick retries.
    } finally {
      inFlight = false;
    }
  };

  void tick();
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(tick, AUTO_SYNC_INTERVAL_MS);
  if (typeof window !== 'undefined') window.addEventListener('online', tick);

  return () => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('online', tick);
  };
}

/** Everything the queue screen renders in one read. */
export async function readQueueBoard(): Promise<{ records: RepQueueRecord[]; pending: number; conflict: number; synced: number }> {
  const records = await listQueueRecords();
  return {
    records,
    pending: records.filter((record) => record.status === 'pending').length,
    conflict: records.filter((record) => record.status === 'conflict').length,
    synced: records.filter((record) => record.status === 'synced').length,
  };
}
