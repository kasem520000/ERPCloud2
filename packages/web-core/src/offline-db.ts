/*
 * Small native IndexedDB adapter for the offline till.
 *
 * We intentionally do not make Dexie a runtime dependency for a single queue: the
 * browser owns the offline copy, while the API remains the authority after replay.
 */

export type OfflineCatalogItem = {
  id: string;
  sku?: string;
  barcode?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  categoryId?: string | null;
  baseUnitId?: string | null;
  kind?: string;
  salePrice?: string | null;
  taxGroupId?: string | null;
  trackLot?: boolean;
  trackSerial?: boolean;
  weightedScale?: boolean;
};

export type OfflineCatalog = {
  schemaVersion?: number;
  generatedAt?: string;
  expiresInSeconds?: number;
  items: OfflineCatalogItem[];
  categories?: Array<Record<string, unknown>>;
  units?: Array<Record<string, unknown>>;
  itemUnits?: Array<Record<string, unknown>>;
  barcodes?: Array<Record<string, unknown>>;
  taxes?: Array<Record<string, unknown>>;
  customers?: Array<Record<string, unknown>>;
  branches?: Array<Record<string, unknown>>;
  warehouses?: Array<Record<string, unknown>>;
  cashLocations?: Array<Record<string, unknown>>;
  priceLists?: Array<Record<string, unknown>>;
  prices?: Array<Record<string, unknown>>;
  stock?: Array<Record<string, unknown>>;
  defaults?: {
    branchId?: string | null;
    warehouseId?: string | null;
    cashLocationId?: string | null;
  };
};

export type OfflineCheckoutPayload = {
  branchId: string;
  warehouseId?: string;
  partyId?: string;
  cashCustomerName?: string;
  cashCustomerMobile?: string;
  priceIncludesVat?: boolean;
  invoiceDiscount?: string;
  orderType?: string;
  lines: Array<{
    itemId: string;
    quantity: string;
    unitPrice: string;
    taxRate?: string;
    discountAmount?: string;
    description?: string;
  }>;
  payment: {
    method: 'cash';
    cashLocationId?: string;
    tendered?: string;
  };
};

export type OfflineQueueStatus = 'pending' | 'synced' | 'conflict';

export type OfflineQueueRecord = {
  offlineId: string;
  deviceId: string;
  sequenceNo: number;
  createdAt: string;
  payload: OfflineCheckoutPayload;
  status: OfflineQueueStatus;
  invoiceId?: string;
  number?: string | null;
  errorCode?: string;
  message?: string;
  resolution?: unknown;
};

const DB_NAME = 'erpcloud-pos-offline';
const DB_VERSION = 1;
const STORE_NAMES = ['meta', 'items', 'customers', 'catalog', 'queue'] as const;
type StoreName = (typeof STORE_NAMES)[number];

let databasePromise: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB is not available in this browser'));
  }
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Could not open offline storage'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('customers')) db.createObjectStore('customers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('queue')) {
        const queue = db.createObjectStore('queue', { keyPath: 'offlineId' });
        queue.createIndex('status', 'status', { unique: false });
        queue.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function getOrCreateDeviceId(): Promise<string> {
  const db = await database();
  const transaction = db.transaction('meta', 'readwrite');
  const store = transaction.objectStore('meta');
  const current = (await requestResult(store.get('deviceId'))) as { key: string; value: string } | undefined;
  const deviceId = current?.value ?? `device-${randomId()}`;
  if (!current) store.put({ key: 'deviceId', value: deviceId });
  await transactionDone(transaction);
  return deviceId;
}

export async function getNextSequence(): Promise<number> {
  const db = await database();
  const transaction = db.transaction('meta', 'readwrite');
  const store = transaction.objectStore('meta');
  const current = (await requestResult(store.get('sequence'))) as { key: string; value: number } | undefined;
  const sequenceNo = (current?.value ?? 0) + 1;
  store.put({ key: 'sequence', value: sequenceNo });
  await transactionDone(transaction);
  return sequenceNo;
}

export async function saveOfflineCatalog(catalog: OfflineCatalog): Promise<void> {
  const db = await database();
  const transaction = db.transaction([...STORE_NAMES] as StoreName[], 'readwrite');
  transaction.objectStore('items').clear();
  transaction.objectStore('customers').clear();
  transaction.objectStore('catalog').clear();
  for (const item of catalog.items ?? []) transaction.objectStore('items').put(item);
  for (const customer of catalog.customers ?? []) {
    if (typeof customer.id === 'string') transaction.objectStore('customers').put(customer);
  }
  transaction.objectStore('catalog').put({ key: 'bundle', ...catalog });
  transaction.objectStore('meta').put({ key: 'catalogAt', value: new Date().toISOString() });
  await transactionDone(transaction);
}

export async function readOfflineCatalog(): Promise<OfflineCatalog | undefined> {
  const db = await database();
  const transaction = db.transaction('catalog', 'readonly');
  const row = (await requestResult(transaction.objectStore('catalog').get('bundle'))) as
    ({ key: string } & OfflineCatalog) | undefined;
  if (!row) return undefined;
  return row;
}

export async function saveOfflineInvoice(
  payload: OfflineCheckoutPayload,
  deviceId = '',
): Promise<OfflineQueueRecord> {
  const actualDeviceId = deviceId || (await getOrCreateDeviceId());
  const sequenceNo = await getNextSequence();
  const record: OfflineQueueRecord = {
    offlineId: `OFFLINE-${actualDeviceId}-${sequenceNo}-${randomId().slice(0, 8)}`,
    deviceId: actualDeviceId,
    sequenceNo,
    createdAt: new Date().toISOString(),
    payload,
    status: 'pending',
  };
  const db = await database();
  const transaction = db.transaction('queue', 'readwrite');
  transaction.objectStore('queue').put(record);
  await transactionDone(transaction);
  return record;
}

export async function listOfflineInvoices(): Promise<OfflineQueueRecord[]> {
  const db = await database();
  const transaction = db.transaction('queue', 'readonly');
  const rows = (await requestResult(transaction.objectStore('queue').getAll())) as OfflineQueueRecord[];
  return rows.sort((left, right) => right.sequenceNo - left.sequenceNo);
}

export async function pendingOfflineInvoices(): Promise<OfflineQueueRecord[]> {
  const records = await listOfflineInvoices();
  return records.filter((record) => record.status === 'pending');
}

export async function updateOfflineInvoice(
  offlineId: string,
  patch: Partial<OfflineQueueRecord>,
): Promise<OfflineQueueRecord | undefined> {
  const db = await database();
  const transaction = db.transaction('queue', 'readwrite');
  const store = transaction.objectStore('queue');
  const current = (await requestResult(store.get(offlineId))) as OfflineQueueRecord | undefined;
  if (!current) {
    await transactionDone(transaction);
    return undefined;
  }
  const next = { ...current, ...patch, offlineId };
  store.put(next);
  await transactionDone(transaction);
  return next;
}

export async function removeOfflineInvoice(offlineId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction('queue', 'readwrite');
  transaction.objectStore('queue').delete(offlineId);
  await transactionDone(transaction);
}

export async function clearSyncedOfflineInvoices(): Promise<void> {
  const records = await listOfflineInvoices();
  await Promise.all(
    records
      .filter((record) => record.status === 'synced')
      .map((record) => removeOfflineInvoice(record.offlineId)),
  );
}

export async function offlineQueueCounts(): Promise<{ pending: number; conflicts: number; synced: number }> {
  const records = await listOfflineInvoices();
  return {
    pending: records.filter((record) => record.status === 'pending').length,
    conflicts: records.filter((record) => record.status === 'conflict').length,
    synced: records.filter((record) => record.status === 'synced').length,
  };
}

export async function resetOfflineStorage(): Promise<void> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return;
  databasePromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not clear offline storage'));
    request.onblocked = () => reject(new Error('Close other ERP tabs before clearing offline storage'));
  });
}
