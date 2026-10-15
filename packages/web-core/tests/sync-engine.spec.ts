/* global RequestInit */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSession, writeSession } from '../src/api';
import { resetOfflineStorage, saveOfflineInvoice, type OfflineQueueRecord } from '../src/offline-db';
import { retryOfflineConflict, syncOfflineInvoices, type OfflineSyncResponse } from '../src/sync-engine';

/**
 * M2 — behavioral specs for the sync engine: what gets posted, what gets marked, and
 * what stays untouched. The API stays the authority; the engine only replays pending
 * records and records the outcome per ticket.
 */

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('sync engine', () => {
  beforeEach(async () => {
    await resetOfflineStorage();
    localStorage.clear();
    writeSession({ accessToken: 'token-1', refreshToken: 'refresh-1', tenantCode: 'TEN', expiresAt: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    writeSession(undefined);
  });

  it('posts pending invoices with their identity and applies the results to the queue', async () => {
    const first = await saveOfflineInvoice({
      branchId: 'b-1',
      lines: [{ itemId: 'i-1', quantity: '1.0000', unitPrice: '2.0000' }],
      payment: { method: 'cash' },
    });
    const second = await saveOfflineInvoice({
      branchId: 'b-1',
      lines: [{ itemId: 'i-2', quantity: '5.0000', unitPrice: '1.0000' }],
      payment: { method: 'cash' },
    });

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/pos/offline-sync');
      const body = JSON.parse(String(init?.body)) as {
        deviceId: string;
        invoices: Array<Pick<OfflineQueueRecord, 'offlineId' | 'sequenceNo'>>;
      };
      // Replay order follows the queue listing: newest ticket first.
      expect(body.invoices.map((invoice) => invoice.offlineId)).toEqual([second.offlineId, first.offlineId]);
      expect(body.invoices.every((invoice) => typeof invoice.sequenceNo === 'number')).toBe(true);
      const response: OfflineSyncResponse = {
        processed: 2,
        synced: 1,
        conflicts: 1,
        results: [
          { offlineId: first.offlineId, sequenceNo: first.sequenceNo, status: 'synced', invoiceId: 'inv-1', number: 'S-100' },
          { offlineId: second.offlineId, sequenceNo: second.sequenceNo, status: 'conflict', errorCode: 'STOCK_SHORT', message: 'الكمية غير متوفرة' },
        ],
      };
      return okResponse({ data: response });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncOfflineInvoices();

    expect(result).toMatchObject({ processed: 2, synced: 1, conflicts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The bearer token from the stored session rides along.
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-1');

    const pending = await import('../src/offline-db').then((module) => module.listOfflineInvoices());
    const byId = new Map(pending.map((record) => [record.offlineId, record]));
    expect(byId.get(first.offlineId)).toMatchObject({ status: 'synced', invoiceId: 'inv-1', number: 'S-100' });
    expect(byId.get(second.offlineId)).toMatchObject({ status: 'conflict', errorCode: 'STOCK_SHORT' });
  });

  it('is a no-op while offline and when nothing is pending', async () => {
    const online = vi.fn();
    vi.stubGlobal('fetch', online);
    vi.stubGlobal('navigator', { onLine: false });

    expect(await syncOfflineInvoices()).toEqual({ processed: 0, synced: 0, conflicts: 0, results: [] });
    expect(online).not.toHaveBeenCalled();

    // Back online, but the queue is empty — still no call.
    vi.stubGlobal('navigator', { onLine: true });
    expect(await syncOfflineInvoices()).toEqual({ processed: 0, synced: 0, conflicts: 0, results: [] });
    expect(online).not.toHaveBeenCalled();
  });

  it('re-queues a conflict for replay and posts it again', async () => {
    const record = await saveOfflineInvoice({
      branchId: 'b-1',
      lines: [{ itemId: 'i-1', quantity: '1.0000', unitPrice: '2.0000' }],
      payment: { method: 'cash' },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          data: {
            processed: 1,
            synced: 0,
            conflicts: 1,
            results: [{ offlineId: record.offlineId, sequenceNo: record.sequenceNo, status: 'conflict', errorCode: 'STOCK_SHORT' }],
          } satisfies OfflineSyncResponse,
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          data: {
            processed: 1,
            synced: 1,
            conflicts: 0,
            results: [{ offlineId: record.offlineId, sequenceNo: record.sequenceNo, status: 'synced', invoiceId: 'inv-2', number: 'S-200' }],
          } satisfies OfflineSyncResponse,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await syncOfflineInvoices();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The cashier hits "retry" on the conflict: it becomes pending again and the next
    // sync posts it again — same offlineId, one more attempt.
    await retryOfflineConflict(record.offlineId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { invoices: Array<{ offlineId: string }> };
    expect(secondBody.invoices).toEqual([expect.objectContaining({ offlineId: record.offlineId })]);
  });

  it('exposes the session through the api module it shares (single instance check)', () => {
    // The sync engine and the test both import the same api module instance; the stored
    // session is what the engine's bearer token comes from (asserted above via the
    // authorization header). Sanity: the session written in beforeEach is readable.
    expect(readSession()?.tenantCode).toBe('TEN');
  });
});
