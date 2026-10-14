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
 * Phase 05 (part 5) — مكوّنات الصنف: the bill of materials.
 *
 * `item_components` has sat in the schema since migration 0003 and nothing ever wrote to
 * it: 0003 created it under FORCE RLS with no policy, and although 0035 repaired the
 * table, no endpoint ever appeared — so the item card could not describe what an item is
 * made of, and a production order had to be typed out line by line every single time.
 *
 * The desktop kept this on the item card itself (`frmItems` → تبويب «المكونات»,
 * `Class/ItemComponent.cs`): a component, a store, a quantity, a unit and a bit saying
 * whether the line is added or consumed. These tests follow one assembly from "define
 * what it is made of" to "build three of them and watch the right stock leave".
 */
describe('Item components (BOM) and building from them', () => {
  let ctx: TestApp;
  let actor: Actor;
  let reader: Actor;

  let branchId = '';
  let warehouseId = '';
  let categoryId = '';
  let baseUnitId = '';
  let cartonId = '';
  let assemblyId = '';
  let partId = '';
  let otherPartId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  beforeAll(async () => {
    ctx = await createTestApp('inventory-bom');
    actor = await createActor(ctx, {
      tenantCode: 'inv-bom',
      email: 'owner@inv-bom.test',
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
    // A colleague who may look at the card but must not change the recipe.
    reader = await createActor(ctx, {
      tenantCode: 'inv-bom',
      email: 'reader@inv-bom.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'catalog.item.view', 'inventory.view'],
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

    assemblyId = await makeItem({ sku: 'ASM-1', nameAr: 'منتج مركّب', kind: 'composite' });
    partId = await makeItem({ sku: 'PRT-1', nameAr: 'مكوّن أول' });
    otherPartId = await makeItem({ sku: 'PRT-2', nameAr: 'مكوّن ثانٍ' });

    // The part is sold in cartons of 12 pieces, so a BOM line counted in cartons can be
    // converted — and one counted in a unit the card does not define cannot.
    const cartonUnit = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${partId}/units`, {
      token: actor.token,
      body: { unitId: cartonId, ratio: '12' },
    });
    expect(cartonUnit.status).toBe(201);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. a component is added, read back with its name and unit, and removed again', async () => {
    const empty = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
    });
    expect(empty.status).toBe(200);
    expect(data(empty.body)).toEqual([]);

    const added = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
      body: { componentItemId: partId, qty: '2', warehouseId },
    });
    expect(added.status).toBe(201);
    expect(data(added.body)).toMatchObject({ componentItemId: partId, qty: '2.0000', kind: 'component' });
    expect((data(added.body) as { warehouseName: string | null }).warehouseName).toBeTruthy();

    const list = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
    });
    const rows = data(list.body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: 'PRT-1', nameAr: 'مكوّن أول', unitId: baseUnitId, unitCode: 'PCS' });

    // Redefining the same component updates it instead of duplicating it.
    const again = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
      body: { componentItemId: partId, qty: '3' },
    });
    expect(again.status).toBe(201);
    expect(data(again.body)).toMatchObject({ qty: '3.0000' });
    const afterUpdate = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
    });
    expect(data(afterUpdate.body)).toHaveLength(1);

    const removed = await api(
      ctx.server,
      'delete',
      `/api/v1/organization/catalog/items/${assemblyId}/components/${partId}`,
      { token: actor.token },
    );
    expect(data(removed.body)).toMatchObject({ deleted: true });
    const afterDelete = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
    });
    expect(data(afterDelete.body)).toEqual([]);
  });

  it('2. refuses the quantities and units that would make the recipe unusable', async () => {
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { componentItemId: partId, qty: '0' }, code: 'VALIDATION_FAILED' },
      { body: { componentItemId: partId, qty: '-1' }, code: 'VALIDATION_FAILED' },
      { body: { componentItemId: assemblyId, qty: '1' }, code: 'CATALOG_COMPONENT_SELF' },
      // 'حبة' is not defined on the *other* part's card.
      { body: { componentItemId: otherPartId, qty: '1', unitId: cartonId }, code: 'CATALOG_COMPONENT_UNIT_INVALID' },
    ];
    for (const testCase of cases) {
      const response = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
        token: actor.token,
        body: testCase.body,
      });
      expect(codeOf(response.body), JSON.stringify(response.body)).toBe(testCase.code);
    }

    const missing = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
      body: { componentItemId: '6f1d4f2e-0000-4000-8000-000000000000', qty: '1' },
    });
    expect(missing.status).toBe(404);
  });

  it('3. a component cannot contain the item it belongs to', async () => {
    // PRT-2 becomes a sub-assembly of PRT-1…
    await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${otherPartId}/components`, {
      token: actor.token,
      body: { componentItemId: partId, qty: '1' },
    });
    // …so PRT-1 may no longer contain PRT-2: building one would need one of itself first.
    const cyclic = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${partId}/components`, {
      token: actor.token,
      body: { componentItemId: otherPartId, qty: '1' },
    });
    expect(cyclic.status).toBe(409);
    expect(codeOf(cyclic.body)).toBe('CATALOG_COMPONENT_CYCLE');

    await api(ctx.server, 'delete', `/api/v1/organization/catalog/items/${otherPartId}/components/${partId}`, {
      token: actor.token,
    });
  });

  it('4. reading is allowed to a viewer, writing is not', async () => {
    const view = await api(ctx.server, 'get', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: reader.token,
    });
    expect(view.status).toBe(200);

    const write = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: reader.token,
      body: { componentItemId: partId, qty: '1' },
    });
    expect(write.status).toBe(403);
  });

  it('5. a production order typed with no components is filled from the item card', async () => {
    // The assembly: 2 pieces of PRT-1 and 1 of PRT-2, per unit built.
    await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
      body: { componentItemId: partId, qty: '2', warehouseId },
    });
    await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
      body: { componentItemId: otherPartId, qty: '1', warehouseId },
    });

    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: assemblyId, outputQty: '3' },
    });
    expect(order.status).toBe(201);
    const components = (data(order.body) as { components: Array<Record<string, unknown>> }).components;
    // 2 × 3 and 1 × 3 — the BOM is per unit built, not per order.
    expect(components).toHaveLength(2);
    const byItem = new Map(components.map((line) => [line.itemId as string, line.qty as string]));
    expect(byItem.get(partId)).toBe('6.0000');
    expect(byItem.get(otherPartId)).toBe('3.0000');
  });

  it('6. an item with no recipe asks for components instead of inventing them', async () => {
    const bare = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'ASM-9', nameAr: 'بلا مكونات', categoryId, baseUnitId, kind: 'composite' },
    });
    expect(bare.status).toBe(201);
    const bareId = data(bare.body).id as string;

    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: bareId, outputQty: '1' },
    });
    expect(order.status).toBe(422);
    expect(codeOf(order.body)).toBe('PRODUCTION_COMPONENTS_REQUIRED');

    // Typing them in still works — the BOM is a convenience, not a gate.
    const typed = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: bareId, outputQty: '1', components: [{ itemId: partId, qty: '1' }] },
    });
    expect(typed.status).toBe(201);
  });

  it('7. building it moves the components out and the assembly in', async () => {
    // Stock the shelves first: 20 of PRT-1 and 20 of PRT-2 at 5 apiece.
    for (const [item, qty] of [
      [partId, '20'],
      [otherPartId, '20'],
    ] as Array<[string, string]>) {
      const voucher = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
        token: actor.token,
        body: {
          branchId,
          warehouseId,
          kind: 'stock_in',
          reason: `تجهيز مكونات ${qty}`,
          lines: [{ itemId: item, qty, unitCost: '5' }],
        },
      });
      expect(voucher.status).toBe(201);
      const posted = await api(
        ctx.server,
        'post',
        `/api/v1/inventory/vouchers/${(data(voucher.body) as { id: string }).id}/post`,
        { token: actor.token, body: {} },
      );
      expect([200, 201]).toContain(posted.status);
    }

    const created = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: assemblyId, outputQty: '3' },
    });
    const orderId = (data(created.body) as { id: string }).id;

    const done = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/complete`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(done.status);
    const order = data(done.body) as { status: string; unitCost: string; componentCost: string };
    expect(order.status).toBe('completed');
    // 6 × 5 + 3 × 5 = 45 out, so three assemblies cost 15 each.
    expect(order.componentCost).toBe('45.0000');
    expect(order.unitCost).toBe('15.0000');

    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${warehouseId}`, {
      token: actor.token,
    });
    const rows = data(levels.body) as Array<{ itemId: string; quantity: string }>;
    const levelOf = (item: string) => rows.find((row) => row.itemId === item)?.quantity ?? '0';
    expect(levelOf(partId)).toBe('14.0000');
    expect(levelOf(otherPartId)).toBe('17.0000');
    expect(levelOf(assemblyId)).toBe('3.0000');
  });

  it('8. a component counted in cartons is consumed in pieces', async () => {
    // Redefine PRT-1's line as "half a carton" — 6 pieces per assembly instead of 2.
    const recipe = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${assemblyId}/components`, {
      token: actor.token,
      body: { componentItemId: partId, qty: '0.5', unitId: cartonId, warehouseId },
    });
    expect(recipe.status).toBe(201);

    const created = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: assemblyId, outputQty: '2' },
    });
    expect(created.status).toBe(201);
    const components = (data(created.body) as { components: Array<Record<string, unknown>> }).components;
    const line = components.find((row) => row.itemId === partId);
    // 0.5 × 2 = 1 carton, and the order remembers it was counted in cartons.
    expect(line).toMatchObject({ qty: '1.0000', unitId: cartonId });

    const orderId = (data(created.body) as { id: string }).id;
    const done = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/complete`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(done.status);

    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${warehouseId}`, {
      token: actor.token,
    });
    const rows = data(levels.body) as Array<{ itemId: string; quantity: string }>;
    // 14 − (1 carton = 12 pieces) = 2.
    expect(rows.find((row) => row.itemId === partId)?.quantity).toBe('2.0000');
  });
});
