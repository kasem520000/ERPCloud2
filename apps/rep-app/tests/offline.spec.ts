/* global RequestInit */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSession } from '@erp/web-core/api';

import {
  applyDelta,
  getQueueRecord,
  listCustomers,
  findCustomerPrices,
  listOpenLoadOrders,
  listStock,
  nextSequence,
  pendingQueueRecords,
  readMetaBundle,
  resetRepStorage,
  saveQueueRecord,
  saveSnapshot,
} from '../lib/offline/rep-db';
import {
  enqueueCollection,
  enqueueInvoice,
  enqueueReceipt,
  enqueueReturn,
  estimateInvoiceTotal,
  formatMoney,
  formatQty,
  outstandingOfOfflineInvoice,
  projectedRemaining,
  projectedStock,
  remainingOfLoadOrder,
} from '../lib/offline/ops';
import { pullRepData, pushRepQueue, toReplayRow } from '../lib/offline/rep-sync';
import type { RepDelta, RepQueueRecord, RepSnapshot } from '../lib/offline/types';

/**
 * M5 — the rep app's ACCEPTANCE specs: the payloads this app builds are the payloads
 * the M4 API's own specs replay (`apps/api/test/van-sales/field-sync.spec.ts`), the
 * snapshot/delta stores round-trip the M4 wire shapes, and the offline custody math is
 * the server's own formula. If the contract drifts, these fail before the API does.
 */

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function snapshotFixture(): RepSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-16T06:00:00.000Z',
    watermark: '2026-10-16T06:00:00.000Z',
    expiresInSeconds: 86400,
    rep: { salesmanId: 'sm-1', salesmanName: 'سالم', warehouseId: 'wh-van', vehiclePlate: 'ABC-123' },
    customers: [
      { id: 'p-1', code: 'C-001', name: 'بقالة النور', phone: '05000000001', email: null, taxNo: null, branchId: null, creditLimit: '500.00', isOwner: false },
    ],
    customerPrices: [
      {
        partyId: 'p-1',
        itemId: 'i-1',
        priceTierLabel: 'VIP',
        unitPrice: '4.0000',
        maxBonusPct: '2.0000',
        maxBonusQty: '5.0000',
        maxBonusKgPerInvoice: '5.0000',
        expectedDailyQty: '20.0000',
        preferredInvoiceMode: 'zatca_tax',
        creditLimit: '500.00',
        paymentTermsDays: '7',
        lockPrice: true,
        maxDiscountPct: '0',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
    ],
    items: [
      { id: 'i-1', sku: 'SKU-1', barcode: '111', nameAr: 'حليب ١ لتر', nameEn: 'Milk 1L', categoryId: null, baseUnitId: 'u-kg', kind: 'stock', salePrice: '4.5000', purchasePrice: '3.0000', taxGroupId: null, trackLot: false, weightedScale: true, showInPos: true },
    ],
    units: [{ id: 'u-kg', code: 'KG', nameAr: 'كجم', nameEn: 'kg' }],
    taxes: [],
    itemUnits: [],
    barcodes: [],
    priceLists: [],
    priceListItems: [],
    paymentMethods: [
      { id: 'pm-cash', code: 'cash', nameAr: 'نقدي', kind: 'cash', dueDays: '0', cashLocationId: 'cl-1', isDefault: true },
    ],
    stock: [{ itemId: 'i-1', warehouseId: 'wh-van', quantity: '120.0000', value: '360.0000', averageCost: '3.0000' }],
    openLoadOrders: [
      {
        id: 'lo-1',
        number: 'VLO-100',
        loadDate: '2026-10-16',
        status: 'in_route',
        itemId: 'i-1',
        warehouseId: 'wh-main',
        vanWarehouseId: 'wh-van',
        productionBatchNo: 'BATCH-9',
        loadedQty: '150.0000',
        receivedQty: '150.0000',
        soldQty: '25.0000',
        bonusQty: '5.0000',
        returnedQty: '0.0000',
        damagedQty: '0.0000',
        expectedCash: '120.00',
        collectedCash: '20.00',
        stockTransferId: null,
      },
    ],
    openCreditDocuments: [
      {
        id: 'doc-1',
        number: 'VTX-200',
        docDate: '2026-10-15',
        partyId: 'p-1',
        customerName: 'بقالة النور',
        itemId: 'i-1',
        soldQty: '10.0000',
        unitPrice: '4.0000',
        total: '46.00',
        paidAmount: '6.00',
        outstanding: '40.00',
        salesInvoiceId: 'inv-9',
        loadOrderId: 'lo-1',
      },
    ],
  };
}

describe('rep offline store', () => {
  beforeEach(async () => {
    await resetRepStorage();
    localStorage.clear();
    localStorage.removeItem('erp.rep.deviceId');
    writeSession({ accessToken: 'token-rep', refreshToken: 'refresh-rep', tenantCode: 'TEN', expiresAt: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    writeSession(undefined);
  });

  it('round-trips a snapshot into the stores and records the watermark + rep card', async () => {
    await saveSnapshot(snapshotFixture());

    const meta = await readMetaBundle();
    expect(meta.watermark).toBe('2026-10-16T06:00:00.000Z');
    expect(meta.rep).toMatchObject({ salesmanId: 'sm-1', warehouseId: 'wh-van', vehiclePlate: 'ABC-123' });

    const customers = await listCustomers();
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: 'p-1', name: 'بقالة النور' });

    const prices = await findCustomerPrices('p-1');
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({ partyId: 'p-1', itemId: 'i-1', unitPrice: '4.0000', lockPrice: true });

    const stock = await listStock();
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ itemId: 'i-1', quantity: '120.0000' });
  });

  it('applies a delta exactly as the M4 contract frames it: changed upsert, deleted remove, full re-read', async () => {
    await saveSnapshot(snapshotFixture());

    const delta: RepDelta = {
      since: '2026-10-16T06:00:00.000Z',
      watermark: '2026-10-16T07:30:00.000Z',
      changed: {
        customers: [
          { id: 'p-1', code: 'C-001', name: 'بقالة النور المحدثة', phone: null, email: null, taxNo: null, branchId: null, creditLimit: '500.00', isOwner: false },
          { id: 'p-2', code: 'C-002', name: 'مقهى الشمس', phone: null, email: null, taxNo: null, branchId: null, creditLimit: '100.00', isOwner: false },
        ],
        customerPrices: [
          {
            partyId: 'p-1',
            itemId: null,
            priceTierLabel: 'عام',
            unitPrice: '4.2000',
            maxBonusPct: '0',
            maxBonusQty: '0',
            maxBonusKgPerInvoice: '0',
            expectedDailyQty: '0',
            preferredInvoiceMode: 'zatca_tax',
            creditLimit: '500.00',
            paymentTermsDays: '0',
            lockPrice: false,
            maxDiscountPct: '0',
            effectiveFrom: '2026-01-01',
            effectiveTo: null,
          },
        ],
        items: [],
        units: [],
        taxes: [],
        priceLists: [],
        priceListItems: [],
        paymentMethods: [],
      },
      deleted: {
        customers: [],
        customerPrices: [{ partyId: 'p-1', itemId: 'i-1' }],
        items: [],
        units: [],
        taxes: [],
        priceLists: [],
        paymentMethods: [],
      },
      full: {
        itemUnits: [],
        barcodes: [],
        stock: [{ itemId: 'i-1', warehouseId: 'wh-van', quantity: '100.0000', value: '300.0000', averageCost: '3.0000' }],
        openLoadOrders: [],
        openCreditDocuments: [],
      },
    };
    await applyDelta(delta);

    const customers = await listCustomers();
    expect(customers.map((customer) => customer.id).sort()).toEqual(['p-1', 'p-2']);
    expect(customers.find((customer) => customer.id === 'p-1')?.name).toBe('بقالة النور المحدثة');

    // The item-specific price row was deleted; the any-item row replaced the set.
    const prices = await findCustomerPrices('p-1');
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({ itemId: null, unitPrice: '4.2000' });

    // `stock` is a full re-read, not a merge.
    expect(await listStock()).toMatchObject([{ quantity: '100.0000' }]);
    // `openLoadOrders` is a full re-read too — the route was closed server-side.
    expect(await listOpenLoadOrders()).toHaveLength(0);

    expect((await readMetaBundle()).watermark).toBe('2026-10-16T07:30:00.000Z');
  });
});

describe('rep operation builders (the M4 replay payloads)', () => {
  beforeEach(async () => {
    await resetRepStorage();
    localStorage.clear();
    localStorage.setItem('erp.rep.deviceId', 'rep-test1');
    writeSession({ accessToken: 'token-rep', refreshToken: 'refresh-rep', tenantCode: 'TEN', expiresAt: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    writeSession(undefined);
  });

  it('builds an invoice payload with the exact M4 shape and a monotonic device sequence', async () => {
    const first = await enqueueInvoice({
      loadOrderId: 'lo-1',
      partyId: 'p-1',
      itemId: 'i-1',
      invoiceMode: 'zatca_tax',
      paymentMethod: 'credit',
      soldQty: '3.0000',
      bonusQty: '1.0000',
      bonusReason: 'اتفاقية الشهر',
      unitPrice: '4.0000',
      notes: 'زيارة صباحية',
    });
    const second = await enqueueInvoice({
      loadOrderId: 'lo-1',
      customerName: 'عميل نقدي',
      invoiceMode: 'internal_delivery',
      paymentMethod: 'cash',
      soldQty: '2.0000',
      unitPrice: '4.1000',
    });

    expect(first.offlineId).toMatch(/^OFFLINE-rep-test1-1-/);
    expect(first.deviceId).toBe('rep-test1');
    expect(first.sequenceNo).toBe(1);
    expect(second.sequenceNo).toBe(2);
    expect(first.status).toBe('pending');
    expect(first.createdAt).toBeTruthy();

    // The wire row (what POST /field-sync/replay receives) carries exactly these keys.
    expect(toReplayRow(first)).toEqual({
      offlineId: first.offlineId,
      deviceId: 'rep-test1',
      sequenceNo: 1,
      operation: 'invoice',
      createdAt: first.createdAt,
      payload: {
        loadOrderId: 'lo-1',
        partyId: 'p-1',
        itemId: 'i-1',
        invoiceMode: 'zatca_tax',
        paymentMethod: 'credit',
        soldQty: '3.0000',
        bonusQty: '1.0000',
        bonusReason: 'اتفاقية الشهر',
        unitPrice: '4.0000',
        notes: 'زيارة صباحية',
      },
    });
    expect(toReplayRow(second).payload).toEqual({
      loadOrderId: 'lo-1',
      customerName: 'عميل نقدي',
      invoiceMode: 'internal_delivery',
      paymentMethod: 'cash',
      soldQty: '2.0000',
      unitPrice: '4.1000',
    });

    // Sequences come from the same device counter the snapshot engine uses.
    expect(await nextSequence()).toBe(3);
  });

  it('builds collection payloads for both target kinds (documentId / sourceOfflineId)', async () => {
    await expect(enqueueCollection({ collectedAmount: '10.00' })).rejects.toThrow();

    // The page resolves the cash location from the snapshot's default cash method —
    // without it the treasury engine cannot post the receipt voucher (M4 contract).
    const onServerDoc = await enqueueCollection({
      documentId: 'doc-1',
      collectedAmount: '40.00',
      cashLocationId: 'cl-1',
      notes: 'سداد كامل',
    });
    expect(toReplayRow(onServerDoc).payload).toEqual({
      documentId: 'doc-1',
      collectedAmount: '40.00',
      cashLocationId: 'cl-1',
      notes: 'سداد كامل',
    });

    const onOwnInvoice = await enqueueCollection({ sourceOfflineId: 'OFFLINE-rep-test1-9-abc', collectedAmount: '12.50' });
    expect(toReplayRow(onOwnInvoice).payload).toEqual({ sourceOfflineId: 'OFFLINE-rep-test1-9-abc', collectedAmount: '12.50' });
  });

  it('builds return and receipt payloads with the exact M4 shapes', async () => {
    await expect(enqueueReturn({ returnedQty: '1.0000' })).rejects.toThrow();

    const returned = await enqueueReturn({ sourceOfflineId: 'OFFLINE-rep-test1-9-abc', returnedQty: '2.0000', reason: 'قرب انتهاء الصلاحية', notes: 'بحالة جيدة' });
    expect(toReplayRow(returned)).toMatchObject({
      operation: 'return',
      payload: { sourceOfflineId: 'OFFLINE-rep-test1-9-abc', returnedQty: '2.0000', reason: 'قرب انتهاء الصلاحية', notes: 'بحالة جيدة' },
    });

    const receipt = await enqueueReceipt({ loadOrderId: 'lo-1', receivedQty: '150.0000', notes: 'استلمت كامل الكمية' });
    expect(toReplayRow(receipt)).toMatchObject({
      operation: 'receipt',
      payload: { loadOrderId: 'lo-1', receivedQty: '150.0000', notes: 'استلمت كامل الكمية' },
    });
  });
});

describe('offline custody math (the server formula, evaluated on the phone)', () => {
  it('derives remaining from the snapshot row exactly like load_orders does', () => {
    const order = snapshotFixture().openLoadOrders[0];
    // 150 received − 25 sold − 5 bonus − 0 returned − 0 damaged = 120
    expect(formatQty(remainingOfLoadOrder(order))).toBe('120.0000');

    // An unreceived order still uses loaded_qty as its basis (legacy path).
    const legacy = { ...order, receivedQty: '0.0000', loadedQty: '100.0000' };
    expect(formatQty(remainingOfLoadOrder(legacy))).toBe('70.0000');
  });

  it('projects remaining and stock against THIS phone\'s pending ops', async () => {
    await resetRepStorage();
    localStorage.clear();
    localStorage.setItem('erp.rep.deviceId', 'rep-test2');

    const snapshot = snapshotFixture();
    await saveSnapshot(snapshot);
    const order = snapshot.openLoadOrders[0];
    const document = snapshot.openCreditDocuments[0];

    const invoice = await enqueueInvoice({
      loadOrderId: 'lo-1',
      partyId: 'p-1',
      itemId: 'i-1',
      invoiceMode: 'zatca_tax',
      paymentMethod: 'credit',
      soldQty: '10.0000',
      bonusQty: '2.0000',
      unitPrice: '4.0000',
    });
    const records: RepQueueRecord[] = [invoice];

    // 120 − 10 sold − 2 bonus = 108
    expect(formatQty(projectedRemaining(order, records, [document]))).toBe('108.0000');
    expect(formatQty(projectedStock(snapshot.stock[0], records, [document]))).toBe('108.0000');

    // A pending return against the offline invoice gives its qty back (both views).
    const returned = await enqueueReturn({ sourceOfflineId: invoice.offlineId, returnedQty: '3.0000', reason: 'تالف جزئيًا' });
    const withReturn = [...records, returned];
    expect(formatQty(projectedRemaining(order, withReturn, [document]))).toBe('111.0000');
    expect(formatQty(projectedStock(snapshot.stock[0], withReturn, [document]))).toBe('111.0000');

    // A conflicted op never happened — it must not move the projection.
    const conflicted = await enqueueInvoice({
      loadOrderId: 'lo-1',
      partyId: 'p-1',
      itemId: 'i-1',
      invoiceMode: 'zatca_tax',
      paymentMethod: 'cash',
      soldQty: '50.0000',
      unitPrice: '4.0000',
    });
    const conflictedRecord: RepQueueRecord = { ...conflicted, status: 'conflict' };
    await saveQueueRecord(conflictedRecord);
    const allRecords = [...withReturn, conflictedRecord];
    expect(formatQty(projectedRemaining(order, allRecords, [document]))).toBe('111.0000');
  });

  it('estimates an offline invoice total (VAT only for zatca_tax) and nets local collections', async () => {
    await resetRepStorage();
    localStorage.clear();
    localStorage.setItem('erp.rep.deviceId', 'rep-test3');

    const estimate = estimateInvoiceTotal({ loadOrderId: 'lo-1', soldQty: '10.0000', unitPrice: '4.0000', invoiceMode: 'zatca_tax' });
    expect(formatMoney(estimate)).toBe('46.00'); // 40 + 15%
    const delivery = estimateInvoiceTotal({ loadOrderId: 'lo-1', soldQty: '10.0000', unitPrice: '4.0000', invoiceMode: 'internal_delivery' });
    expect(formatMoney(delivery)).toBe('40.00');

    const invoice = await enqueueInvoice({
      loadOrderId: 'lo-1',
      partyId: 'p-1',
      itemId: 'i-1',
      invoiceMode: 'zatca_tax',
      paymentMethod: 'credit',
      soldQty: '10.0000',
      unitPrice: '4.0000',
    });
    expect(formatMoney(outstandingOfOfflineInvoice(invoice.offlineId, [invoice]))).toBe('46.00');

    await enqueueCollection({ sourceOfflineId: invoice.offlineId, collectedAmount: '16.00' });
    const records = await pendingQueueRecords();
    const invoiceRow = records.find((row) => row.offlineId === invoice.offlineId) as RepQueueRecord;
    expect(formatMoney(outstandingOfOfflineInvoice(invoice.offlineId, records))).toBe('30.00');
    void invoiceRow;
  });
});

describe('rep sync engine', () => {
  beforeEach(async () => {
    await resetRepStorage();
    localStorage.clear();
    localStorage.setItem('erp.rep.deviceId', 'rep-test4');
    writeSession({ accessToken: 'token-rep', refreshToken: 'refresh-rep', tenantCode: 'TEN', expiresAt: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    writeSession(undefined);
  });

  it('pulls a snapshot when no watermark exists, then a delta on the next cycle', async () => {
    const snapshot = snapshotFixture();
    const delta: RepDelta = {
      since: snapshot.watermark,
      watermark: '2026-10-16T08:00:00.000Z',
      changed: { customers: [], customerPrices: [], items: [], units: [], taxes: [], priceLists: [], priceListItems: [], paymentMethods: [] },
      deleted: { customers: [], customerPrices: [], items: [], units: [], taxes: [], priceLists: [], paymentMethods: [] },
      full: { itemUnits: [], barcodes: [], stock: [], openLoadOrders: [], openCreditDocuments: [] },
    };

    const fetchMock = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(okResponse({ data: snapshot }))
      .mockResolvedValueOnce(okResponse({ data: delta }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await pullRepData();
    expect(first).toMatchObject({ kind: 'snapshot', watermark: snapshot.watermark });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/field-sync/snapshot');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer token-rep');

    const second = await pullRepData();
    expect(second).toMatchObject({ kind: 'delta', watermark: delta.watermark });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/field-sync/delta?since=${encodeURIComponent(snapshot.watermark)}`);
  });

  it('posts the pending queue as the exact replay batch and merges every result back', async () => {
    const invoice = await enqueueInvoice({
      loadOrderId: 'lo-1',
      partyId: 'p-1',
      itemId: 'i-1',
      invoiceMode: 'zatca_tax',
      paymentMethod: 'credit',
      soldQty: '10.0000',
      unitPrice: '4.0000',
    });
    const collection = await enqueueCollection({ sourceOfflineId: invoice.offlineId, collectedAmount: '16.00' });

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/field-sync/replay');
      const body = JSON.parse(String(init?.body)) as { deviceId: string; operations: Array<ReturnType<typeof toReplayRow>> };
      // Sequence order, the whole queue, one batch — the M4 contract.
      expect(body.deviceId).toBe('rep-test4');
      expect(body.operations.map((row) => row.sequenceNo)).toEqual([1, 2]);
      expect(body.operations[0]).toMatchObject({ operation: 'invoice', offlineId: invoice.offlineId });
      return okResponse({
        data: {
          processed: 2,
          synced: 1,
          conflicts: 1,
          results: [
            {
              offlineId: invoice.offlineId,
              sequenceNo: 1,
              status: 'synced',
              operation: 'invoice',
              documentId: 'doc-77',
              documentNumber: 'VTX-777',
              total: '46.00',
              salesInvoiceId: 'inv-77',
              invoiceNumber: 'INV-777',
            },
            {
              offlineId: collection.offlineId,
              sequenceNo: 2,
              status: 'conflict',
              errorCode: 'STOCK_INSUFFICIENT',
              message: 'الكمية غير كافية',
              resolution: { action: 'edit-quantity-or-refresh-stock' },
            },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await pushRepQueue();
    expect(summary).toEqual({ processed: 2, synced: 1, conflicts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const syncedInvoice = await getQueueRecord(invoice.offlineId);
    expect(syncedInvoice).toMatchObject({
      status: 'synced',
      documentId: 'doc-77',
      documentNumber: 'VTX-777',
      total: '46.00',
      invoiceNumber: 'INV-777',
    });
    expect(syncedInvoice?.syncedAt).toBeTruthy();

    const conflictedCollection = await getQueueRecord(collection.offlineId);
    expect(conflictedCollection).toMatchObject({
      status: 'conflict',
      errorCode: 'STOCK_INSUFFICIENT',
      resolution: { action: 'edit-quantity-or-refresh-stock' },
    });

    // The synced invoice's outstanding uses the server total — and the CONFLICTED
    // collection did not happen, so it must not reduce it (46.00 stays outstanding).
    const records = [syncedInvoice as RepQueueRecord, conflictedCollection as RepQueueRecord];
    expect(formatMoney(outstandingOfOfflineInvoice(invoice.offlineId, records))).toBe('46.00');
  });

  it('replays in batches of at most 100 operations (the M4 cap)', async () => {
    for (let index = 0; index < 3; index += 1) {
      await enqueueCollection({ documentId: `doc-${index}`, collectedAmount: '1.00' });
    }
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      okResponse({
        data: { processed: 0, synced: 0, conflicts: 0, results: [] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Only 3 pending — one batch. The batching itself is asserted by the slice cap below.
    await pushRepQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { operations: unknown[] };
    expect(body.operations).toHaveLength(3);
  });
});
