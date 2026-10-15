import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSyncedOfflineInvoices,
  getOrCreateDeviceId,
  getNextSequence,
  listOfflineInvoices,
  offlineQueueCounts,
  pendingOfflineInvoices,
  readOfflineCatalog,
  removeOfflineInvoice,
  resetOfflineStorage,
  saveOfflineCatalog,
  saveOfflineInvoice,
  updateOfflineInvoice,
  type OfflineCheckoutPayload,
} from '../src/offline-db';

/**
 * M2 — behavioral specs for the offline IndexedDB adapter (the old staff spec only
 * asserted source text; the adapter itself had no tests). The browser owns the offline
 * copy while the API stays the authority after replay, so the queue contract pinned
 * here is what the sync engine (and the cashier's screen) rely on.
 */

const payload = (n: number): OfflineCheckoutPayload => ({
  branchId: `branch-${n}`,
  lines: [{ itemId: 'item-1', quantity: '2.0000', unitPrice: '3.5000' }],
  payment: { method: 'cash', tendered: '10.0000' },
});

describe('offline device identity', () => {
  beforeEach(async () => {
    await resetOfflineStorage();
  });

  it('creates a stable device id and persists it across calls', async () => {
    const first = await getOrCreateDeviceId();
    expect(first).toMatch(/^device-/);
    const second = await getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  it('hands out a monotonically increasing sequence per device', async () => {
    expect(await getNextSequence()).toBe(1);
    expect(await getNextSequence()).toBe(2);
    expect(await getNextSequence()).toBe(3);
  });
});

describe('offline invoice queue', () => {
  beforeEach(async () => {
    await resetOfflineStorage();
  });

  it('queues invoices as pending with device id, sequence and a unique offline id', async () => {
    const one = await saveOfflineInvoice(payload(1));
    const two = await saveOfflineInvoice(payload(2));

    expect(one.status).toBe('pending');
    expect(one.deviceId).toMatch(/^device-/);
    expect(one.sequenceNo).toBe(1);
    expect(two.sequenceNo).toBe(2);
    expect(one.offlineId).not.toBe(two.offlineId);
    expect(one.offlineId).toContain('OFFLINE-');

    const all = await listOfflineInvoices();
    // Newest first — the cashier sees the latest ticket at the top.
    expect(all.map((record) => record.sequenceNo)).toEqual([2, 1]);
    expect(await pendingOfflineInvoices()).toHaveLength(2);
  });

  it('keeps conflicts and pending rows when clearing only the synced ones', async () => {
    const one = await saveOfflineInvoice(payload(1));
    const two = await saveOfflineInvoice(payload(2));
    const three = await saveOfflineInvoice(payload(3));
    await updateOfflineInvoice(one.offlineId, { status: 'synced', invoiceId: 'inv-1', number: 'S-1' });
    await updateOfflineInvoice(two.offlineId, { status: 'conflict', errorCode: 'STOCK_SHORT' });

    await clearSyncedOfflineInvoices();

    const remaining = (await listOfflineInvoices()).map((record) => record.offlineId).sort();
    expect(remaining).toEqual([three.offlineId, two.offlineId].sort());
    const counts = await offlineQueueCounts();
    expect(counts).toEqual({ pending: 1, conflicts: 1, synced: 0 });
  });

  it('updates a queued record without losing its identity, and reports missing ids', async () => {
    const record = await saveOfflineInvoice(payload(1));
    const patched = await updateOfflineInvoice(record.offlineId, {
      status: 'synced',
      invoiceId: 'inv-9',
      number: 'S-9',
    });
    expect(patched?.offlineId).toBe(record.offlineId);
    expect(patched?.status).toBe('synced');
    expect(patched?.number).toBe('S-9');
    expect(patched?.sequenceNo).toBe(record.sequenceNo);

    expect(await updateOfflineInvoice('OFFLINE-does-not-exist', { status: 'synced' })).toBeUndefined();
    await removeOfflineInvoice(record.offlineId);
    expect(await listOfflineInvoices()).toHaveLength(0);
  });
});

describe('offline catalog cache', () => {
  beforeEach(async () => {
    await resetOfflineStorage();
  });

  it('round-trips the catalog bundle written by the server', async () => {
    expect(await readOfflineCatalog()).toBeUndefined();

    await saveOfflineCatalog({
      schemaVersion: 3,
      items: [{ id: 'item-1', nameAr: 'خبز' }],
      customers: [{ id: 'party-1', nameAr: 'عميل' }, { noIdColumn: true }],
    });

    const catalog = await readOfflineCatalog();
    expect(catalog?.schemaVersion).toBe(3);
    expect(catalog?.items).toEqual([{ id: 'item-1', nameAr: 'خبز' }]);
    // The bundle is stored verbatim (rows without a string id only fail to enter the
    // dedicated `customers` store — `saveOfflineCatalog` filters those puts, but the
    // bundle read back by the till keeps exactly what the server sent).
    expect(catalog?.customers).toEqual([{ id: 'party-1', nameAr: 'عميل' }, { noIdColumn: true }]);
  });
});
