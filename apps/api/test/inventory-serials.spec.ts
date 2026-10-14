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
 * Phase 05 (part six) — دورة الأرقام التسلسلية والدفعات، وترويسة أمر الإنتاج.
 *
 * The desktop kept serials on the document line (`InvoiceItemDetail.ItemSerialNo`) and
 * swept them between two grids in `frmItemSerialNo`: `📋 الأرقام المتاحة` and
 * `📤 الأرقام المباعة`, with `⚙️ توليد` making a batch off one prefix and `🗑️` taking a
 * number back out. The cloud already had the state machine (available → reserved → sold
 * → available) with no screen that could drive it, and no way to make a batch of
 * numbers without typing them one by one.
 *
 * `frmProductionOrder.xaml` also asked for `📄 رقم المرجع`, `📅 تاريخ المرجع` and
 * `📐 الوحدة` — three things the order could not remember, so the last test gives it
 * all three and checks the output lands in the unit it was counted in.
 */
describe('Serial lifecycle, lots and the production order header', () => {
  let ctx: TestApp;
  let actor: Actor;
  let reader: Actor;

  let branchId = '';
  let warehouseId = '';
  let categoryId = '';
  let baseUnitId = '';
  let cartonId = '';
  let trackedId = '';
  let plainId = '';
  let partId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  beforeAll(async () => {
    ctx = await createTestApp('inventory-serials');
    actor = await createActor(ctx, {
      tenantCode: 'inv-ser',
      email: 'owner@inv-ser.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.manage',
        'catalog.item.view',
        'catalog.category.manage',
        'catalog.unit.manage',
        'catalog.unit.view',
        'inventory.view',
        'inventory.adjust',
        'inventory.production.manage',
        'inventory.production.complete',
        'inventory.negative.override',
        'accounting.period.close',
        'accounting.reports.view',
      ],
    });
    // A storekeeper who may read the shelf but may not move a number on it.
    reader = await createActor(ctx, {
      tenantCode: 'inv-ser',
      email: 'reader@inv-ser.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'inventory.view', 'catalog.item.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    categoryId = data(category.body).id as string;

    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    baseUnitId = data(unit.body).id as string;
    const carton = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'CTN', nameAr: 'كرتون' },
    });
    cartonId = data(carton.body).id as string;

    const makeItem = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: actor.token,
        body: { categoryId, baseUnitId, ...payload },
      });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };

    trackedId = await makeItem({ sku: 'SER-1', nameAr: 'جهاز مُرقّم' });
    plainId = await makeItem({ sku: 'SER-2', nameAr: 'جهاز آخر' });
    partId = await makeItem({ sku: 'SER-PRT', nameAr: 'مكوّن' });

    const cartonUnit = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${trackedId}/units`, {
      token: actor.token,
      body: { unitId: cartonId, ratio: '6' },
    });
    expect(cartonUnit.status).toBe(201);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. ⚙️ توليد makes a batch off one prefix, and refuses to overwrite a live number', async () => {
    const generated = await api(ctx.server, 'post', '/api/v1/inventory/serials/generate', {
      token: actor.token,
      body: { itemId: trackedId, prefix: 'SN-', startAt: 1, count: 5, warehouseId },
    });
    expect(generated.status).toBe(201);
    const made = data(generated.body);
    expect(made.count).toBe(5);
    expect(made.serialNos).toEqual(['SN-1', 'SN-2', 'SN-3', 'SN-4', 'SN-5']);

    // Zero padding follows the last number in the batch, so the list sorts like a human reads it.
    const padded = await api(ctx.server, 'post', '/api/v1/inventory/serials/generate', {
      token: actor.token,
      body: { itemId: trackedId, prefix: 'BX-', startAt: 98, count: 4 },
    });
    expect(padded.status).toBe(201);
    expect(data(padded.body).serialNos).toEqual(['BX-098', 'BX-099', 'BX-100', 'BX-101']);

    const clash = await api(ctx.server, 'post', '/api/v1/inventory/serials/generate', {
      token: actor.token,
      body: { itemId: trackedId, prefix: 'SN-', startAt: 4, count: 3 },
    });
    expect(clash.status).toBe(409);
    expect(codeOf(clash.body as Record<string, unknown>)).toBe('SERIAL_DUPLICATE');

    // Nothing of the rejected batch leaked in — it is all or nothing.
    const after = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    expect(rows(after.body).length).toBe(9);

    const silly = await api(ctx.server, 'post', '/api/v1/inventory/serials/generate', {
      token: actor.token,
      body: { itemId: trackedId, prefix: 'X-', count: 0 },
    });
    expect(silly.status).toBe(422);
    expect(codeOf(silly.body as Record<string, unknown>)).toBe('SERIAL_COUNT_INVALID');
  });

  it('2. a reader cannot move a serial, and a serial cannot be withdrawn once it left the shelf', async () => {
    const one = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}&q=SN-1`, {
      token: actor.token,
    });
    const single = rows(one.body).find((row) => row.serialNo === 'SN-1');
    expect(single).toBeDefined();
    const serialId = single!.id as string;

    const forbidden = await api(ctx.server, 'post', '/api/v1/inventory/serials/reserve', {
      token: reader.token,
      body: { serialIds: [serialId] },
    });
    expect(forbidden.status).toBe(403);

    const reserved = await api(ctx.server, 'post', '/api/v1/inventory/serials/reserve', {
      token: actor.token,
      body: { serialIds: [serialId] },
    });
    expect(reserved.status).toBe(201);
    expect(data(reserved.body).status).toBe('reserved');

    // Reserving twice is not "reserve again", it is a mistake.
    const twice = await api(ctx.server, 'post', '/api/v1/inventory/serials/reserve', {
      token: actor.token,
      body: { serialIds: [serialId] },
    });
    expect(twice.status).toBe(422);
    expect(codeOf(twice.body as Record<string, unknown>)).toBe('SERIAL_INVALID_STATE');

    const released = await api(ctx.server, 'post', '/api/v1/inventory/serials/release', {
      token: actor.token,
      body: { serialIds: [serialId] },
    });
    expect(data(released.body).status).toBe('available');
  });

  it('3. 📋 الأرقام المتاحة → 📤 الأرقام المباعة → إرجاع، والرقم المحذوف يختفي', async () => {
    const list = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    const all = rows(list.body);
    const ids = all.filter((row) => String(row.serialNo).startsWith('BX-')).map((row) => row.id as string);
    expect(ids.length).toBe(4);

    const sold = await api(ctx.server, 'post', '/api/v1/inventory/serials/consume', {
      token: actor.token,
      body: { serialIds: ids.slice(0, 3) },
    });
    expect(sold.status).toBe(201);
    expect(data(sold.body).status).toBe('sold');

    const soldList = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}&status=sold`, {
      token: actor.token,
    });
    expect(rows(soldList.body).length).toBe(3);

    // A sold number that comes back is available again, not "reserved for nobody".
    const returned = await api(ctx.server, 'post', '/api/v1/inventory/serials/return', {
      token: actor.token,
      body: { serialIds: ids.slice(0, 1) },
    });
    expect(data(returned.body).status).toBe('available');

    // The last one of the batch is withdrawn: only an available number may be deleted.
    const notAvailable = ids[2];
    const refused = await api(ctx.server, 'delete', `/api/v1/inventory/serials/${notAvailable}`, {
      token: actor.token,
    });
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body as Record<string, unknown>)).toBe('SERIAL_INVALID_STATE');

    const removed = await api(ctx.server, 'delete', `/api/v1/inventory/serials/${ids[3]}`, {
      token: actor.token,
    });
    expect([200, 201]).toContain(removed.status);
    expect(data(removed.body).deleted).toBe(true);

    const after = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    expect(rows(after.body).some((row) => row.id === ids[3])).toBe(false);

    // A search that matches nothing is an empty list, not an error.
    const none = await api(ctx.server, 'get', '/api/v1/inventory/serials?q=NOPE-9', {
      token: actor.token,
    });
    expect(rows(none.body)).toEqual([]);
  });

  it('4. a lot carries its numbers, and cannot be taken away while it still has them', async () => {
    const lot = await api(ctx.server, 'post', '/api/v1/inventory/lots', {
      token: actor.token,
      body: { itemId: plainId, lotNo: 'LOT-900', expiryDate: '2026-12-31' },
    });
    expect(lot.status).toBe(201);
    const lotId = data(lot.body).id as string;

    const generated = await api(ctx.server, 'post', '/api/v1/inventory/serials/generate', {
      token: actor.token,
      body: { itemId: plainId, prefix: 'LOT-900-', count: 2, lotId },
    });
    expect(generated.status).toBe(201);

    const inUse = await api(ctx.server, 'delete', `/api/v1/inventory/lots/${lotId}`, {
      token: actor.token,
    });
    expect(inUse.status).toBe(409);
    expect(codeOf(inUse.body as Record<string, unknown>)).toBe('LOT_IN_USE');

    const serialId = (
      rows(
        (await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${plainId}`, { token: actor.token })).body,
      )[0] as Record<string, unknown>
    ).id as string;
    await api(ctx.server, 'delete', `/api/v1/inventory/serials/${serialId}`, { token: actor.token });

    const listed = await api(ctx.server, 'get', `/api/v1/inventory/lots?item_id=${plainId}&q=LOT-9`, {
      token: actor.token,
    });
    expect(rows(listed.body).some((row) => row.id === lotId)).toBe(true);
  });

  it('5. another tenant sees neither the numbers nor the lots', async () => {
    const stranger = await createActor(ctx, {
      tenantCode: 'inv-ser-2',
      email: 'owner@inv-ser-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'inventory.view'],
    });
    const serials = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: stranger.token,
    });
    expect(rows(serials.body)).toEqual([]);
    const lots = await api(ctx.server, 'get', '/api/v1/inventory/lots', { token: stranger.token });
    expect(rows(lots.body)).toEqual([]);
  });

  it('6. 📄 رقم المرجع و📅 تاريخ المرجع و📐 الوحدة on a production order', async () => {
    const stock = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_in',
        reason: 'تغذية',
        lines: [{ itemId: partId, qty: '60', unitCost: '10' }],
      },
    });
    expect(stock.status).toBe(201);
    const posted = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${data(stock.body).id}/post`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(posted.status);

    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: {
        warehouseId,
        outputItemId: trackedId,
        outputQty: '2',
        // Counted in cartons of 6 pieces, because that is how the workshop boxes them.
        unitId: cartonId,
        referenceNo: 'SO-4417',
        referenceDate: '2026-09-01',
        components: [{ itemId: partId, qty: '4' }],
      },
    });
    expect(order.status).toBe(201);
    const created = data(order.body);
    expect(created.referenceNo).toBe('SO-4417');
    expect(created.referenceDate).toBe('2026-09-01');
    expect(created.unitId).toBe(cartonId);

    // A unit the item does not carry has no ratio, so it cannot be honoured.
    const foreignUnit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PAL', nameAr: 'طبلية' },
    });
    const badUnit = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: {
        warehouseId,
        outputItemId: partId,
        outputQty: '1',
        unitId: data(foreignUnit.body).id as string,
        components: [{ itemId: trackedId, qty: '1' }],
      },
    });
    expect(badUnit.status).toBe(422);
    expect(codeOf(badUnit.body as Record<string, unknown>)).toBe('PRODUCTION_UNIT_INVALID');

    const done = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${created.id}/complete`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(done.status);

    // 2 cartons × 6 = 12 pieces came in — the order was counted in cartons, the ledger
    // stores pieces.
    const level = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${trackedId}`,
      { token: actor.token },
    );
    expect(Number(rows(level.body)[0]?.quantity ?? 0)).toBe(12);
  });
});
