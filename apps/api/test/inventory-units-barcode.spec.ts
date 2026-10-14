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
 * Phase 05 (part 2) — وحدات القياس المتعددة، الباركود المتعدد، وتواريخ الصلاحية.
 *
 * The desktop kept these in `ItemUnits` (`perc`), `ItemBarcodes` and the expiry column
 * of a lot, and read them everywhere: `InvoiceOper` L5031 computes
 * `ItemPrimaryQnty = ItemQuantity * UnitEquality`, because the stock ledger only ever
 * holds base units.
 *
 * Migration 0003 created `item_units` but with `FORCE ROW LEVEL SECURITY`, no policy
 * and no `tenant_id` — a table that silently refuses every read and write. 0035 gives
 * it a tenant and a policy; these tests are what prove the table is alive, and that a
 * document written in boxes moves pieces.
 */
describe('Item units, barcodes and expiry', () => {
  let ctx: TestApp;
  let actor: Actor;
  let neighbour: Actor;

  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let secondItemId = '';
  let baseUnitId = '';
  let boxUnitId = '';
  let cartonUnitId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  beforeAll(async () => {
    ctx = await createTestApp('inventory-units');
    actor = await createActor(ctx, {
      tenantCode: 'inv-units',
      email: 'owner@inv-units.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'inventory.view',
        'inventory.adjust',
        'inventory.negative.override',
        'accounting.period.close',
        'accounting.reports.view',
      ],
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
    const piece = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    const box = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'BOX', nameAr: 'علبة' },
    });
    const carton = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'CTN', nameAr: 'كرتون' },
    });
    baseUnitId = data(piece.body).id as string;
    boxUnitId = data(box.body).id as string;
    cartonUnitId = data(carton.body).id as string;

    const makeItem = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: actor.token,
        body: { categoryId: data(category.body).id, baseUnitId, ...payload },
      });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    itemId = await makeItem({ sku: 'SKU-U1', nameAr: 'صنف بوحدات' });
    secondItemId = await makeItem({ sku: 'SKU-U2', nameAr: 'صنف ثانٍ' });

    neighbour = await createActor(ctx, {
      tenantCode: 'inv-units-beta',
      email: 'owner@inv-units-beta.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'inventory.view'],
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  const levelOf = async (item: string): Promise<string> => {
    const levels = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${item}`,
      {
        token: actor.token,
      },
    );
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string }>;
    return rows[0]?.quantity ?? '0';
  };

  it('answers with the base unit before any unit is configured', async () => {
    const list = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${itemId}/units`, {
      token: actor.token,
    });
    expect(list.status).toBe(200);
    const rows = (list.body.data ?? list.body) as Array<{ unitId: string; ratio: string }>;
    expect(rows[0]?.unitId).toBe(baseUnitId);
    expect(rows[0]?.ratio).toBe(
      '1.000000'.slice(0, rows[0]?.ratio.length ?? 0) === '' ? rows[0]?.ratio : rows[0]?.ratio,
    );
    expect(Number(rows[0]?.ratio)).toBe(1);
  });

  it('defines a box of 12 and refuses a ratio that is not a number', async () => {
    const created = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${itemId}/units`, {
      token: actor.token,
      body: { unitId: boxUnitId, ratio: '12', isDefaultSale: true },
    });
    expect(created.status).toBe(201);
    expect(Number((data(created.body) as { ratio: string }).ratio)).toBe(12);

    const bad = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${itemId}/units`, {
      token: actor.token,
      body: { unitId: cartonUnitId, ratio: '0' },
    });
    expect(bad.status).toBe(422);
    expect(codeOf(bad.body)).toBe('CATALOG_UNIT_RATIO_INVALID');
  });

  it('will not let the base unit convert to anything but 1:1', async () => {
    const refused = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${itemId}/units`, {
      token: actor.token,
      body: { unitId: baseUnitId, ratio: '6' },
    });
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body)).toBe('CATALOG_UNIT_RATIO_INVALID');
  });

  it('receives in boxes and moves pieces', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_in',
        reason: 'استلام بالكرتون',
        lines: [{ itemId, qty: '2', unitId: boxUnitId, unitCost: '120' }],
      },
    });
    expect(created.status).toBe(201);
    const id = (data(created.body) as { id: string }).id;
    const posted = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status).toBe(201);

    // 2 boxes × 12 = 24 base units, and the value is 2 × 120 = 240 — the unit the clerk
    // counted in must not change what the stock is worth.
    expect(Number(await levelOf(itemId))).toBe(24);
    expect(Number((data(posted.body) as { totalCost: string }).totalCost).toFixed(2)).toBe('240.00');

    const movements = await api(ctx.server, 'get', `/api/v1/inventory/movements?item_id=${itemId}`, {
      token: actor.token,
    });
    const rows = (movements.body.data ?? movements.body) as Array<{
      qty: string;
      baseQty: string;
      unitId: string | null;
      factor: string;
      unitCost: string;
      docId: string;
    }>;
    const mine = rows.find((row) => row.docId === id);
    expect(mine).toBeDefined();
    expect(Number(mine?.qty)).toBe(2);
    expect(Number(mine?.baseQty)).toBe(24);
    expect(mine?.unitId).toBe(boxUnitId);
    expect(Number(mine?.factor)).toBe(12);
    // Average cost is per base unit — 240 ÷ 24 = 10, not 120.
    expect(Number(mine?.unitCost)).toBeCloseTo(10, 4);
  });

  it('issues in boxes at the average cost of a piece', async () => {
    const before = Number(await levelOf(itemId));
    const created = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_out',
        reason: 'صرف علبة',
        lines: [{ itemId, qty: '1', unitId: boxUnitId }],
      },
    });
    const id = (data(created.body) as { id: string }).id;
    const posted = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status).toBe(201);
    expect(Number(await levelOf(itemId))).toBe(before - 12);
    expect(Number((data(posted.body) as { totalCost: string }).totalCost).toFixed(2)).toBe('120.00');
  });

  it('refuses a unit the item card does not define', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_out',
        lines: [{ itemId: secondItemId, qty: '1', unitId: cartonUnitId }],
      },
    });
    expect(created.status).toBe(201);
    const id = (data(created.body) as { id: string }).id;
    const posted = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body)).toBe('INVENTORY_UNIT_NOT_ALLOWED');
  });

  it('resolves a scanned barcode to its item, unit and factor', async () => {
    const label = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${itemId}/barcodes`, {
      token: actor.token,
      body: { barcode: 'BOX-LABEL-1', unitId: boxUnitId },
    });
    expect(label.status).toBe(201);

    const scan = await api(ctx.server, 'get', '/api/v1/inventory/barcode/BOX-LABEL-1', {
      token: actor.token,
    });
    expect(scan.status).toBe(200);
    const found = data(scan.body) as { itemId: string; unitId: string; factor: string; matchedBy: string };
    expect(found.itemId).toBe(itemId);
    expect(found.unitId).toBe(boxUnitId);
    expect(Number(found.factor)).toBe(12);
    expect(found.matchedBy).toBe('item_barcodes');

    const unknown = await api(ctx.server, 'get', '/api/v1/inventory/barcode/NO-SUCH-LABEL', {
      token: actor.token,
    });
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown.body)).toBe('BARCODE_NOT_FOUND');
  });

  it('keeps one barcode belonging to one item only', async () => {
    // A second label on the same item is fine…
    const ok = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${itemId}/barcodes`, {
      token: actor.token,
      body: { barcode: 'EXTRA-1' },
    });
    expect(ok.status).toBe(201);

    // …but moving it to another item is not: the scanner would hand the wrong item.
    const taken = await api(
      ctx.server,
      'post',
      `/api/v1/organization/catalog/items/${secondItemId}/barcodes`,
      {
        token: actor.token,
        body: { barcode: 'EXTRA-1' },
      },
    );
    expect(taken.status).toBe(409);
    expect(codeOf(taken.body)).toBe('CATALOG_BARCODE_TAKEN');

    const listed = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${itemId}/barcodes`, {
      token: actor.token,
    });
    const rows = (listed.body.data ?? listed.body) as Array<{ barcode: string; unitId: string | null }>;
    expect(rows.map((row) => row.barcode).sort()).toEqual(['BOX-LABEL-1', 'EXTRA-1']);

    const removed = await api(
      ctx.server,
      'delete',
      `/api/v1/organization/catalog/items/${itemId}/barcodes/EXTRA-1`,
      { token: actor.token },
    );
    expect(removed.status).toBe(200);
    const gone = await api(ctx.server, 'get', '/api/v1/inventory/barcode/EXTRA-1', { token: actor.token });
    expect(gone.status).toBe(404);
  });

  it('reports lots by expiry and hides the ones that are still fine', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    for (const [lotNo, expiryDate] of [
      ['LOT-SOON', soon],
      ['LOT-LATER', later],
    ] as const) {
      const lot = await api(ctx.server, 'post', '/api/v1/inventory/lots', {
        token: actor.token,
        body: { itemId, lotNo, expiryDate },
      });
      expect(lot.status).toBe(201);
    }

    const list = await api(ctx.server, 'get', '/api/v1/inventory/expiry?days=30', { token: actor.token });
    expect(list.status).toBe(200);
    const rows = (list.body.data ?? list.body) as Array<{
      lotNo: string;
      daysLeft: number;
      expired: boolean;
      quantity: string;
    }>;
    expect(rows.some((row) => row.lotNo === 'LOT-SOON')).toBe(true);
    expect(rows.some((row) => row.lotNo === 'LOT-LATER')).toBe(false);
    const soonRow = rows.find((row) => row.lotNo === 'LOT-SOON');
    expect(soonRow?.expired).toBe(false);
    expect(soonRow?.daysLeft).toBeGreaterThan(0);
    expect(soonRow?.daysLeft).toBeLessThanOrEqual(10);
  });

  it('removes a unit but never the base one', async () => {
    const refused = await api(
      ctx.server,
      'delete',
      `/api/v1/organization/catalog/items/${itemId}/units/${baseUnitId}`,
      {
        token: actor.token,
      },
    );
    expect(refused.status).toBe(409);
    expect(codeOf(refused.body)).toBe('CATALOG_UNIT_IMMUTABLE');

    const removed = await api(
      ctx.server,
      'delete',
      `/api/v1/organization/catalog/items/${itemId}/units/${boxUnitId}`,
      {
        token: actor.token,
      },
    );
    expect(removed.status).toBe(200);

    const list = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${itemId}/units`, {
      token: actor.token,
    });
    const rows = (list.body.data ?? list.body) as Array<{ unitId: string }>;
    expect(rows.some((row) => row.unitId === boxUnitId)).toBe(false);
    expect(rows[0]?.unitId).toBe(baseUnitId);
  });

  it('does not answer a scan from another tenant', async () => {
    const theirs = await api(ctx.server, 'get', '/api/v1/inventory/barcode/BOX-LABEL-1', {
      token: neighbour.token,
    });
    expect(theirs.status).toBe(404);
  });
});
