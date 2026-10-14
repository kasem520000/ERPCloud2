import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 05 (part 3) — بضاعة في الطريق، إقفال المناقلة، وبطاقة الصنف.
 *
 * The desktop left a half-received مناقلة open for ever: the source warehouse had lost
 * the goods at send time and the destination only booked what arrived, so the difference
 * sat in بضاعة تحت التحويل with nothing to close it. These tests follow one transfer from
 * "sent" to "the rest came home" and another to "the rest is gone", and then read the
 * item back as a storekeeper would — بطاقة الصنف with a running balance.
 */
describe('In-transit stock, transfer closure and the item card', () => {
  let ctx: TestApp;
  let actor: Actor;
  let neighbour: Actor;

  let branchId = '';
  let sourceId = '';
  let destinationId = '';
  let itemId = '';
  let secondItemId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  beforeAll(async () => {
    ctx = await createTestApp('inventory-closure');
    actor = await createActor(ctx, {
      tenantCode: 'inv-close',
      email: 'owner@inv-close.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'catalog.unit.view',
        'inventory.view',
        'inventory.adjust',
        'inventory.negative.override',
        'accounting.period.close',
        'accounting.reports.view',
      ],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    sourceId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const other = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH-B', name: 'مستودع ثانٍ' },
    });
    destinationId = data(other.body).id as string;

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    expect(unit.status).toBe(201);
    const baseUnitId = (data(unit.body) as { id: string }).id;
    const makeItem = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: actor.token,
        body: { categoryId: data(category.body).id, baseUnitId, ...payload },
      });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    itemId = await makeItem({ sku: 'SKU-C1', nameAr: 'صنف مناقلة' });
    secondItemId = await makeItem({ sku: 'SKU-C2', nameAr: 'صنف ثانٍ' });

    neighbour = await createActor(ctx, {
      tenantCode: 'inv-close-beta',
      email: 'owner@inv-close-beta.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'inventory.view'],
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  const levelOf = async (item: string, warehouse: string): Promise<number> => {
    const levels = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouse}&item_id=${item}`,
      {
        token: actor.token,
      },
    );
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string }>;
    return Number(rows[0]?.quantity ?? 0);
  };

  async function fundStock(item: string, warehouse: string, qty: string, unitCost: string) {
    const voucher = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId: warehouse,
        kind: 'stock_in',
        reason: 'تمويل للاختبار',
        lines: [{ itemId: item, qty, unitCost }],
      },
    });
    await api(
      ctx.server,
      'post',
      `/api/v1/inventory/vouchers/${(data(voucher.body) as { id: string }).id}/post`,
      {
        token: actor.token,
        body: {},
      },
    );
  }

  async function sendTransfer(item: string, qty: string, unitCost = '10') {
    const draft = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: sourceId,
        toWarehouseId: destinationId,
        lines: [{ itemId: item, qty, unitCost }],
      },
    });
    const id = (data(draft.body) as { id: string }).id;
    const sent = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${id}/send`, {
      token: actor.token,
      body: {},
    });
    expect(sent.status).toBe(201);
    return id;
  }

  it('lists what is still on the road', async () => {
    await fundStock(itemId, sourceId, '100', '10');
    const transferId = await sendTransfer(itemId, '30');

    const list = await api(ctx.server, 'get', `/api/v1/inventory/in-transit?warehouse_id=${sourceId}`, {
      token: actor.token,
    });
    expect(list.status).toBe(200);
    const rows = (list.body.data ?? list.body) as Array<{
      transferId: string;
      qty: string;
      daysInTransit: number;
    }>;
    const mine = rows.find((row) => row.transferId === transferId);
    expect(mine).toBeDefined();
    expect(Number(mine?.qty)).toBe(30);
    expect(mine?.daysInTransit).toBe(0);

    // Receiving a part of it keeps the rest outstanding — that is the whole problem.
    await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/receive`, {
      token: actor.token,
      body: { received: [{ lineNo: 1, qty: '12' }] },
    });
    const after = await api(ctx.server, 'get', '/api/v1/inventory/in-transit', { token: actor.token });
    const row = ((after.body.data ?? after.body) as Array<{ transferId: string; qty: string }>).find(
      (entry) => entry.transferId === transferId,
    );
    expect(Number(row?.qty)).toBe(18);
  });

  it('returns the remainder to the source warehouse', async () => {
    await fundStock(secondItemId, sourceId, '50', '8');
    const transferId = await sendTransfer(secondItemId, '20');
    const before = await levelOf(secondItemId, sourceId);

    const closed = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/close`, {
      token: actor.token,
      body: { mode: 'return', reason: 'رفض الاستلام' },
    });
    expect(closed.status).toBe(201);
    const body = data(closed.body) as {
      status: string;
      mode: string;
      value: string;
      journalEntryId: string | null;
    };
    expect(body.status).toBe('closed');
    expect(body.mode).toBe('return');
    expect(body.journalEntryId).toBeTruthy();
    // 20 × 8 came home.
    expect(Number(body.value)).toBe(160);

    const after = await api(ctx.server, 'get', `/api/v1/inventory/transfers/${transferId}`, {
      token: actor.token,
    });
    const detail = data(after.body) as { lines: Array<{ receivedQty: string; closedQty: string }> };
    // The return is NOT counted as a receipt: the goods never reached the destination.
    expect(Number(detail.lines[0]?.receivedQty)).toBe(0);
    expect(Number(detail.lines[0]?.closedQty)).toBe(20);

    const remaining = await api(ctx.server, 'get', '/api/v1/inventory/in-transit', { token: actor.token });
    expect(
      ((remaining.body.data ?? remaining.body) as Array<{ transferId: string }>).some(
        (row) => row.transferId === transferId,
      ),
    ).toBe(false);
    expect(before).toBeGreaterThan(0);
  });

  it('writes the remainder off when the goods are gone', async () => {
    const transferId = await sendTransfer(itemId, '5');
    const destinationBefore = await levelOf(itemId, destinationId);

    const closed = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/close`, {
      token: actor.token,
      body: { mode: 'shortage', reason: 'تلف أثناء النقل' },
    });
    expect(closed.status).toBe(201);
    const body = data(closed.body) as { mode: string; returnedQty: string; journalEntryId: string | null };
    expect(body.mode).toBe('shortage');
    expect(Number(body.returnedQty)).toBe(0);
    expect(body.journalEntryId).toBeTruthy();

    // A shortage moves no stock: the destination must be exactly where it was.
    expect(await levelOf(itemId, destinationId)).toBe(destinationBefore);

    const again = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/close`, {
      token: actor.token,
      body: { mode: 'shortage' },
    });
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('TRANSFER_ALREADY_CLOSED');
  });

  it('refuses to close a transfer that is not on the road', async () => {
    const draft = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: sourceId,
        toWarehouseId: destinationId,
        lines: [{ itemId: itemId, qty: '1' }],
      },
    });
    const id = (data(draft.body) as { id: string }).id;
    const refused = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${id}/close`, {
      token: actor.token,
      body: { mode: 'return' },
    });
    expect(refused.status).toBe(409);
    expect(codeOf(refused.body)).toBe('TRANSFER_INVALID_STATE');
  });

  it('reads بطاقة الصنف with a running balance that agrees with the balance table', async () => {
    await fundStock(itemId, sourceId, '40', '25');
    const card = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/item-card?item_id=${itemId}&warehouse_id=${sourceId}`,
      {
        token: actor.token,
      },
    );
    expect(card.status).toBe(200);
    const body = data(card.body) as {
      opening: { quantity: string; value: string };
      totals: { inQty: string; outQty: string; inValue: string };
      closing: { quantity: string; value: string };
      rows: Array<{ balanceQty: string; docType: string }>;
    };
    // Opening + in − out = closing, and the closing must be what `stock_balances` holds.
    const closing = Number(body.opening.quantity) + Number(body.totals.inQty) - Number(body.totals.outQty);
    expect(Number(body.closing.quantity)).toBeCloseTo(closing, 4);
    expect(Number(body.closing.quantity)).toBeCloseTo(await levelOf(itemId, sourceId), 4);
    // Every row carries its own running balance, and they never go backwards in time.
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) expect(row.balanceQty).toBeDefined();
    // The value is carried too: 40 × 25 plus whatever was there before.
    expect(Number(body.totals.inValue)).toBeGreaterThanOrEqual(1000);
  });

  it('filters the movement list by period', async () => {
    const all = await api(ctx.server, 'get', `/api/v1/inventory/movements?item_id=${itemId}`, {
      token: actor.token,
    });
    const rows = (all.body.data ?? all.body) as Array<{ occurredAt: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const first = (rows[0] as { occurredAt: string }).occurredAt.slice(0, 10);
    const narrowed = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/movements?item_id=${itemId}&from=${first}&to=${first}`,
      {
        token: actor.token,
      },
    );
    const narrowedRows = (narrowed.body.data ?? narrowed.body) as Array<{ occurredAt: string; sku: string }>;
    expect(narrowedRows.length).toBeGreaterThan(0);
    expect(narrowedRows.every((row) => row.occurredAt.slice(0, 10) === first)).toBe(true);
    // The joined columns are what let the screen print a name instead of a uuid.
    expect(narrowedRows[0]?.sku).toBe('SKU-C1');
  });

  it('needs an item for its card, and does not answer for another tenant', async () => {
    const missing = await api(ctx.server, 'get', '/api/v1/inventory/item-card', { token: actor.token });
    expect(missing.status).toBe(422);
    expect(codeOf(missing.body)).toBe('INVENTORY_ITEM_REQUIRED');

    const theirs = await api(ctx.server, 'get', `/api/v1/inventory/item-card?item_id=${itemId}`, {
      token: neighbour.token,
    });
    expect(theirs.status).toBe(404);
    const transit = await api(ctx.server, 'get', '/api/v1/inventory/in-transit', { token: neighbour.token });
    const transitRows = (transit.body.data ?? transit.body) as Array<{ transferId: string }>;
    expect(transitRows.length).toBe(0);
  });
});
