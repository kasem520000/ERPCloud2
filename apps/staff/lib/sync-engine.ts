import { apiData, apiPost } from './api';
import {
  getOrCreateDeviceId,
  listOfflineInvoices,
  pendingOfflineInvoices,
  saveOfflineCatalog,
  updateOfflineInvoice,
  type OfflineCatalog,
  type OfflineQueueRecord,
} from './offline-db';

export type OfflineSyncResult = {
  offlineId: string;
  sequenceNo: number;
  status: 'synced' | 'conflict' | 'pending';
  invoiceId?: string;
  number?: string | null;
  errorCode?: string;
  message?: string;
  resolution?: unknown;
};

export type OfflineSyncResponse = {
  processed: number;
  synced: number;
  conflicts: number;
  results: OfflineSyncResult[];
};

export async function refreshOfflineCatalog(): Promise<OfflineCatalog> {
  const catalog = await apiData<OfflineCatalog>('/pos/offline-data');
  await saveOfflineCatalog(catalog);
  return catalog;
}

/**
 * Sends only pending records. Synced records remain in IndexedDB long enough for the
 * cashier to see the real invoice number, while conflicts remain actionable.
 */
export async function syncOfflineInvoices(): Promise<OfflineSyncResponse> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { processed: 0, synced: 0, conflicts: 0, results: [] };
  }
  const invoices = await pendingOfflineInvoices();
  if (!invoices.length) return { processed: 0, synced: 0, conflicts: 0, results: [] };
  const deviceId = await getOrCreateDeviceId();
  const response = await apiPost<OfflineSyncResponse>('/pos/offline-sync', {
    deviceId,
    invoices: invoices.map((record) => ({
      offlineId: record.offlineId,
      deviceId: record.deviceId,
      sequenceNo: record.sequenceNo,
      createdAt: record.createdAt,
      payload: record.payload,
    })),
  });
  for (const result of response.results ?? []) {
    await updateOfflineInvoice(result.offlineId, {
      status: result.status === 'synced' ? 'synced' : 'conflict',
      invoiceId: result.invoiceId,
      number: result.number,
      errorCode: result.errorCode,
      message: result.message,
      resolution: result.resolution,
    });
  }
  return response;
}

export async function retryOfflineConflict(offlineId: string): Promise<OfflineSyncResponse> {
  await updateOfflineInvoice(offlineId, {
    status: 'pending',
    errorCode: undefined,
    message: undefined,
    resolution: undefined,
  });
  return syncOfflineInvoices();
}

export async function queueSnapshot(): Promise<OfflineQueueRecord[]> {
  return listOfflineInvoices();
}

/** Runs immediately, on reconnect, and at most once every ten seconds. */
export function startOfflineAutoSync(onComplete?: (result: OfflineSyncResponse) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let inFlight = false;
  const run = () => {
    if (inFlight || !navigator.onLine) return;
    inFlight = true;
    void syncOfflineInvoices()
      .then((result) => onComplete?.(result))
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  window.addEventListener('online', run);
  const timer = window.setInterval(run, 10_000);
  run();
  return () => {
    window.removeEventListener('online', run);
    window.clearInterval(timer);
  };
}
