/**
 * M5 — the rep app's offline store (native IndexedDB, no Dexie), mirroring the proven
 * `packages/web-core/src/offline-db.ts` arrangement (M2) but rep-shaped: the snapshot
 * collections of the M4 `field-sync` contract replace the POS catalog, and the queue
 * records carry the four van-sales operations.
 *
 * Everything here is `window`-guarded so the module imports cleanly in Node tests and
 * during SSR; the screens call these helpers from effects/handlers only.
 */
import type {
  RepCustomer,
  RepCustomerPrice,
  RepDelta,
  RepItem,
  RepOpenCreditDocument,
  RepOpenLoadOrder,
  RepPaymentMethod,
  RepPriceList,
  RepPriceListItem,
  RepQueueRecord,
  RepSnapshot,
  RepStockRow,
  RepTax,
  RepUnit,
} from './types';

const DB_NAME = 'erpcloud-rep-offline';
const DB_VERSION = 1;

export const STORES = [
  'meta',
  'customers',
  'customerPrices',
  'items',
  'units',
  'taxes',
  'priceLists',
  'priceListItems',
  'paymentMethods',
  'stock',
  'openLoadOrders',
  'openCreditDocuments',
  'itemUnits',
  'barcodes',
  'queue',
] as const;

export type StoreName = (typeof STORES)[number];

export type RepMeta = {
  deviceId: string;
  sequence: number;
  watermark: string;
  snapshotAt: string;
  rep: { salesmanId: string; salesmanName: string; warehouseId: string; vehiclePlate: string | null };
  documentCounts: { pending: number; conflict: number; synced: number };
};

export const REP_DEVICE_ID_KEY = 'erp.rep.deviceId';
export const REP_QUEUE_EVENT = 'rep-queue-changed';

/* --------------------------------------------------------------- plumbing */

function hasIndexedDB(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

let dbPromise: Promise<IDBDatabase> | undefined;

export function repDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDB()) return Promise.reject(new Error('IndexedDB غير متاح على هذا الجهاز'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) {
          if (db.objectStoreNames.contains(store)) continue;
          switch (store) {
            case 'meta':
              db.createObjectStore('meta', { keyPath: 'key' });
              break;
            case 'customerPrices':
              // Composite key as a string: array keyPaths reject `itemId: null` (a null
              // itemId means "price for any item") — null is not a valid IndexedDB key.
              db.createObjectStore('customerPrices', { keyPath: 'priceKey' }).createIndex('partyId', 'partyId');
              break;
            case 'itemUnits':
              db.createObjectStore('itemUnits', { keyPath: 'itemUnitKey' }).createIndex('itemId', 'itemId');
              break;
            case 'stock':
              db.createObjectStore('stock', { keyPath: 'itemId' });
              break;
            case 'queue':
              db.createObjectStore('queue', { keyPath: 'offlineId' })
                .createIndex('status', 'status');
              break;
            default:
              db.createObjectStore(store, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => {
        // A deleteDatabase (reset) asks for a version change first — close willingly so
        // the reset never blocks on this cached connection (same contract as web-core).
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('تعذر فتح قاعدة البيانات المحلية'));
    });
  }
  return dbPromise;
}

function requestDone(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('فشلت العملية في القاعدة المحلية'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('فشلت المعاملة المحلية'));
    transaction.onabort = () => reject(transaction.error ?? new Error('أُلغيت المعاملة المحلية'));
  });
}

async function withStore<T>(store: StoreName, mode: 'readonly' | 'readwrite', run: (objectStore: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await repDatabase();
  const transaction = db.transaction(store, mode);
  const result = await run(transaction.objectStore(store));
  await transactionDone(transaction);
  return result;
}

export function priceKeyOf(partyId: string, itemId: string | null): string {
  return `${partyId}|${itemId ?? '*'}`;
}

function withPriceKeys(rows: RepCustomerPrice[]): Array<RepCustomerPrice & { priceKey: string }> {
  return rows.map((row) => ({ ...row, priceKey: priceKeyOf(row.partyId, row.itemId) }));
}

/** Visible to tests only — bundles `itemId`+`unitId` into the item-unit store key. */
export function itemUnitKeyOf(itemId: string, unitId: string): string {
  return `${itemId}|${unitId}`;
}

/* ------------------------------------------------------------- meta / ids */

export function getOrCreateDeviceId(): Promise<string> {
  const existing = typeof window !== 'undefined' ? window.localStorage.getItem(REP_DEVICE_ID_KEY) : null;
  if (existing) return Promise.resolve(existing);
  const deviceId = `rep-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  if (typeof window !== 'undefined') window.localStorage.setItem(REP_DEVICE_ID_KEY, deviceId);
  return Promise.resolve(deviceId);
}

async function readMetaKey<T>(key: string): Promise<T | undefined> {
  const row = (await withStore('meta', 'readonly', (store) => requestDone(store.get(key)))) as { key: string; value: T } | undefined;
  return row?.value;
}

async function writeMetaKey(key: string, value: unknown): Promise<void> {
  await withStore('meta', 'readwrite', (store) => store.put({ key, value }));
}

/** Reads every `meta` row and folds them into one `RepMeta` (rows are `{key,value}`). */
export async function readMetaBundle(): Promise<Partial<RepMeta>> {
  const rows = (await withStore('meta', 'readonly', (store) => requestDone(store.getAll()))) as Array<{ key: string; value: unknown }>;
  const bundle: Record<string, unknown> = {};
  for (const row of rows) bundle[row.key] = row.value;
  return bundle as Partial<RepMeta>;
}

/** Monotonic per-device sequence (the replay endpoint rejects gaps/duplicates). */
export async function nextSequence(): Promise<number> {
  const current = ((await readMetaKey<number>('sequence')) ?? 0) + 1;
  await writeMetaKey('sequence', current);
  return current;
}

export async function readWatermark(): Promise<string | undefined> {
  return readMetaKey<string>('watermark');
}

/* ------------------------------------------------------ snapshot / delta */

export async function saveSnapshot(snapshot: RepSnapshot): Promise<void> {
  const db = await repDatabase();
  const transaction = db.transaction([...STORES], 'readwrite');
  const stores = {
    customers: transaction.objectStore('customers'),
    customerPrices: transaction.objectStore('customerPrices'),
    items: transaction.objectStore('items'),
    units: transaction.objectStore('units'),
    taxes: transaction.objectStore('taxes'),
    priceLists: transaction.objectStore('priceLists'),
    priceListItems: transaction.objectStore('priceListItems'),
    paymentMethods: transaction.objectStore('paymentMethods'),
    stock: transaction.objectStore('stock'),
    openLoadOrders: transaction.objectStore('openLoadOrders'),
    openCreditDocuments: transaction.objectStore('openCreditDocuments'),
    itemUnits: transaction.objectStore('itemUnits'),
    barcodes: transaction.objectStore('barcodes'),
    meta: transaction.objectStore('meta'),
  };

  stores.customers.clear();
  for (const row of snapshot.customers) stores.customers.put(row);
  stores.customerPrices.clear();
  for (const row of withPriceKeys(snapshot.customerPrices)) stores.customerPrices.put(row);
  stores.items.clear();
  for (const row of snapshot.items) stores.items.put(row);
  stores.units.clear();
  for (const row of snapshot.units) stores.units.put(row);
  stores.taxes.clear();
  for (const row of snapshot.taxes) stores.taxes.put(row);
  stores.priceLists.clear();
  for (const row of snapshot.priceLists) stores.priceLists.put(row);
  stores.priceListItems.clear();
  for (const row of snapshot.priceListItems) stores.priceListItems.put(row);
  stores.paymentMethods.clear();
  for (const row of snapshot.paymentMethods) stores.paymentMethods.put(row);
  stores.stock.clear();
  for (const row of snapshot.stock) stores.stock.put(row);
  stores.openLoadOrders.clear();
  for (const row of snapshot.openLoadOrders) stores.openLoadOrders.put(row);
  stores.openCreditDocuments.clear();
  for (const row of snapshot.openCreditDocuments) stores.openCreditDocuments.put(row);
  stores.itemUnits.clear();
  for (const row of snapshot.itemUnits.map((itemUnit) => ({ ...itemUnit, itemUnitKey: itemUnitKeyOf(itemUnit.itemId, itemUnit.unitId) }))) {
    stores.itemUnits.put(row);
  }
  stores.barcodes.clear();
  for (const row of snapshot.barcodes) stores.barcodes.put(row);

  stores.meta.put({ key: 'watermark', value: snapshot.watermark });
  stores.meta.put({ key: 'snapshotAt', value: new Date().toISOString() });
  stores.meta.put({
    key: 'rep',
    value: {
      salesmanId: snapshot.rep.salesmanId,
      salesmanName: snapshot.rep.salesmanName,
      warehouseId: snapshot.rep.warehouseId,
      vehiclePlate: snapshot.rep.vehiclePlate,
    },
  });

  await transactionDone(transaction);
}

/**
 * Applies a delta exactly the way the M4 contract frames it: `changed` rows upsert,
 * `deleted` keys remove, `full` collections are re-read whole (clear + put).
 */
export async function applyDelta(delta: RepDelta): Promise<void> {
  const db = await repDatabase();
  const transaction = db.transaction(
    ['customers', 'customerPrices', 'items', 'units', 'taxes', 'priceLists', 'priceListItems', 'paymentMethods', 'stock', 'openLoadOrders', 'openCreditDocuments', 'itemUnits', 'barcodes', 'meta'],
    'readwrite',
  );

  const upsert = <T>(storeName: string, rows: T[]) => {
    const store = transaction.objectStore(storeName);
    for (const row of rows) store.put(row);
  };
  const remove = (storeName: string, keys: string[]) => {
    const store = transaction.objectStore(storeName);
    for (const key of keys) store.delete(key);
  };

  upsert('customers', delta.changed.customers);
  upsert('customerPrices', withPriceKeys(delta.changed.customerPrices));
  upsert('items', delta.changed.items);
  upsert('units', delta.changed.units);
  upsert('taxes', delta.changed.taxes);
  upsert('priceLists', delta.changed.priceLists);
  upsert('priceListItems', delta.changed.priceListItems);
  upsert('paymentMethods', delta.changed.paymentMethods);

  remove('customers', delta.deleted.customers);
  remove('customerPrices', delta.deleted.customerPrices.map((row) => priceKeyOf(row.partyId, row.itemId)));
  remove('items', delta.deleted.items);
  remove('units', delta.deleted.units);
  remove('taxes', delta.deleted.taxes);
  remove('priceLists', delta.deleted.priceLists);
  remove('paymentMethods', delta.deleted.paymentMethods);

  for (const [storeName, rows] of [
    ['stock', delta.full.stock],
    ['openLoadOrders', delta.full.openLoadOrders],
    ['openCreditDocuments', delta.full.openCreditDocuments],
  ] as const) {
    const store = transaction.objectStore(storeName);
    store.clear();
    for (const row of rows) store.put(row);
  }
  const itemUnitStore = transaction.objectStore('itemUnits');
  itemUnitStore.clear();
  for (const row of delta.full.itemUnits.map((itemUnit) => ({ ...itemUnit, itemUnitKey: itemUnitKeyOf(itemUnit.itemId, itemUnit.unitId) }))) {
    itemUnitStore.put(row);
  }
  const barcodeStore = transaction.objectStore('barcodes');
  barcodeStore.clear();
  for (const row of delta.full.barcodes) barcodeStore.put(row);

  transaction.objectStore('meta').put({ key: 'watermark', value: delta.watermark });
  transaction.objectStore('meta').put({ key: 'snapshotAt', value: new Date().toISOString() });

  await transactionDone(transaction);
}

/* ------------------------------------------------------------------ reads */

export async function listCustomers(): Promise<RepCustomer[]> {
  return (await withStore('customers', 'readonly', (store) => requestDone(store.getAll()))) as RepCustomer[];
}

export async function findCustomerPrices(partyId: string): Promise<RepCustomerPrice[]> {
  return (
    (await withStore('customerPrices', 'readonly', (store) => requestDone(store.index('partyId').getAll(partyId)))) as Array<RepCustomerPrice & { priceKey: string }>
  ).map(({ priceKey: _priceKey, ...row }) => row);
}

export async function listItems(): Promise<RepItem[]> {
  return (await withStore('items', 'readonly', (store) => requestDone(store.getAll()))) as RepItem[];
}

export async function listUnits(): Promise<RepUnit[]> {
  return (await withStore('units', 'readonly', (store) => requestDone(store.getAll()))) as RepUnit[];
}

export async function listTaxes(): Promise<RepTax[]> {
  return (await withStore('taxes', 'readonly', (store) => requestDone(store.getAll()))) as RepTax[];
}

export async function listPaymentMethods(): Promise<RepPaymentMethod[]> {
  return (await withStore('paymentMethods', 'readonly', (store) => requestDone(store.getAll()))) as RepPaymentMethod[];
}

export async function listPriceLists(): Promise<RepPriceList[]> {
  return (await withStore('priceLists', 'readonly', (store) => requestDone(store.getAll()))) as RepPriceList[];
}

export async function listPriceListItems(): Promise<RepPriceListItem[]> {
  return (await withStore('priceListItems', 'readonly', (store) => requestDone(store.getAll()))) as RepPriceListItem[];
}

export async function listStock(): Promise<RepStockRow[]> {
  return (await withStore('stock', 'readonly', (store) => requestDone(store.getAll()))) as RepStockRow[];
}

export async function listOpenLoadOrders(): Promise<RepOpenLoadOrder[]> {
  return (await withStore('openLoadOrders', 'readonly', (store) => requestDone(store.getAll()))) as RepOpenLoadOrder[];
}

export async function listOpenCreditDocuments(): Promise<RepOpenCreditDocument[]> {
  return (await withStore('openCreditDocuments', 'readonly', (store) => requestDone(store.getAll()))) as RepOpenCreditDocument[];
}

/** Row counts for the sync screen ("what exactly is on this phone?"). */
export async function offlineCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const store of ['customers', 'customerPrices', 'items', 'paymentMethods', 'stock', 'openLoadOrders', 'openCreditDocuments'] as const) {
    counts[store] = (await withStore(store, 'readonly', (objectStore) => requestDone(objectStore.count()))) as number;
  }
  return counts;
}

/* ------------------------------------------------------------------ queue */

export async function saveQueueRecord(record: RepQueueRecord): Promise<void> {
  await withStore('queue', 'readwrite', (store) => store.put(record));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REP_QUEUE_EVENT));
}

export async function getQueueRecord(offlineId: string): Promise<RepQueueRecord | undefined> {
  return (await withStore('queue', 'readonly', (store) => requestDone(store.get(offlineId)))) as RepQueueRecord | undefined;
}

export async function listQueueRecords(): Promise<RepQueueRecord[]> {
  const rows = (await withStore('queue', 'readonly', (store) => requestDone(store.getAll()))) as RepQueueRecord[];
  return rows.sort((left, right) => right.sequenceNo - left.sequenceNo);
}

export async function pendingQueueRecords(): Promise<RepQueueRecord[]> {
  const rows = (await withStore('queue', 'readonly', (store) => requestDone(store.index('status').getAll('pending')))) as RepQueueRecord[];
  return rows.sort((left, right) => left.sequenceNo - right.sequenceNo);
}

export async function updateQueueRecord(offlineId: string, patch: Partial<RepQueueRecord>): Promise<void> {
  const existing = await getQueueRecord(offlineId);
  if (!existing) return;
  await withStore('queue', 'readwrite', (store) => store.put({ ...existing, ...patch, offlineId }));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REP_QUEUE_EVENT));
}

/** Wipes every store (queue included) — used on sign-out so the next rep on a shared
 * phone starts from a clean device, never from the previous rep's prices. */
export async function clearRepData(): Promise<void> {
  const db = await repDatabase();
  const transaction = db.transaction([...STORES], 'readwrite');
  for (const store of STORES) transaction.objectStore(store).clear();
  await transactionDone(transaction);
}

/** Test/teardown helper — drops the whole database (mirrors `resetOfflineStorage`). */
export async function resetRepStorage(): Promise<void> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return;
  dbPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not clear the rep offline storage'));
    request.onblocked = () => reject(new Error('Close other ERP tabs before clearing the rep offline storage'));
  });
}
