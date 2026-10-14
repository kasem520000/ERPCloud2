import { beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * R19 — قوائم أسعار واعية بالوحدات
 * الديسكتوب: ItemPrices.UnitID — السعر لكل وحدة
 * السحابة: price_list_items.unit_id
 */
describe('R19 price lists unit-aware', () => {
  let ctx: TestApp;
  let actor: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp();
    actor = await createActor(ctx, {
      tenantCode: 'price-unit',
      email: 'owner@price-unit.test',
      permissions: [
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.view',
        'catalog.category.manage',
        'catalog.unit.view',
        'catalog.unit.manage',
        'organization.priceList.view',
        'organization.priceList.manage',
      ],
    });
  });

  it('creates price list and prices per unit', async () => {
    const catRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: actor.token, body: { code: 'CAT-R19', nameAr: 'تصنيف R19' } });
    expect(catRes.status).toBe(201);
    const catId = data(catRes.body as any).id as string;

    const baseUnitRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'PCS-R19', nameAr: 'حبة R19' } });
    expect(baseUnitRes.status).toBe(201);
    const baseUnitId = data(baseUnitRes.body as any).id as string;

    const boxUnitRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'BOX-R19', nameAr: 'علبة R19' } });
    expect(boxUnitRes.status).toBe(201);
    const boxUnitId = data(boxUnitRes.body as any).id as string;

    const itemRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'SKU-R19',
        nameAr: 'صنف R19',
        categoryId: catId,
        baseUnitId,
        kind: 'stock',
      },
    });
    expect(itemRes.status).toBe(201);
    const itemId = data(itemRes.body as any).id as string;

    const itemUnitRes = await api(ctx.server, 'post', `/api/v1/organization/catalog/items/${itemId}/units`, {
      token: actor.token,
      body: { unitId: boxUnitId, ratio: '12', salePrice: '120' },
    });
    expect(itemUnitRes.status).toBe(201);

    await api(ctx.server, 'post', '/api/v1/currencies', { token: actor.token, body: { code: 'SAR', nameAr: 'ريال سعودي', isBase: true } });
    // currency may already exist or 201/200
    const plRes = await api(ctx.server, 'post', '/api/v1/price-lists', { token: actor.token, body: { name: 'قائمة R19', currencyCode: 'SAR' } });
    expect(plRes.status).toBe(201);
    const plId = data(plRes.body as any).id as string;

    const basePriceRes = await api(ctx.server, 'post', `/api/v1/price-lists/${plId}/items`, { token: actor.token, body: { itemId, unitPrice: '10.0000', minQty: '0' } });
    expect(basePriceRes.status).toBe(201);
    expect(data(basePriceRes.body as any).unitId).toBeNull();

    const boxPriceRes = await api(ctx.server, 'post', `/api/v1/price-lists/${plId}/items`, { token: actor.token, body: { itemId, unitId: boxUnitId, unitPrice: '120.0000', minQty: '0' } });
    expect(boxPriceRes.status).toBe(201);
    expect(data(boxPriceRes.body as any).unitId).toBe(boxUnitId);

    const listRes = await api(ctx.server, 'get', `/api/v1/price-lists/${plId}/items?limit=100`, { token: actor.token });
    expect(listRes.status).toBe(200);
    const rows = (listRes.body as any).data as any[];
    expect(rows.length).toBe(2);
    const unitIds = rows.map((r: any) => r.unitId);
    expect(unitIds).toContain(null);
    expect(unitIds).toContain(boxUnitId);

    const upsertRes = await api(ctx.server, 'post', `/api/v1/price-lists/${plId}/items`, { token: actor.token, body: { itemId, unitId: boxUnitId, unitPrice: '115.0000', minQty: '0' } });
    expect(upsertRes.status).toBe(201);
    expect(data(upsertRes.body as any).unitPrice).toBe('115.0000');

    const listRes2 = await api(ctx.server, 'get', `/api/v1/price-lists/${plId}/items?limit=100`, { token: actor.token });
    const rows2 = (listRes2.body as any).data as any[];
    expect(rows2.length).toBe(2);
  });

  it('rejects unit not defined for item', async () => {
    const otherUnitRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'OTHER-R19', nameAr: 'أخرى R19' } });
    const otherUnitId = data(otherUnitRes.body as any).id as string;

    const catRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: actor.token, body: { code: 'CAT-R19-2', nameAr: 'تصنيف R19-2' } });
    const catId = data(catRes.body as any).id as string;

    const baseUnitRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'PCS-R19-2', nameAr: 'حبة R19-2' } });
    const baseUnitId = data(baseUnitRes.body as any).id as string;

    const itemRes = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'SKU-R19-2', nameAr: 'صنف R19-2', categoryId: catId, baseUnitId, kind: 'stock' },
    });
    const itemId = data(itemRes.body as any).id as string;

    // ensure SAR exists (first test may have created)
    await api(ctx.server, 'post', '/api/v1/currencies', { token: actor.token, body: { code: 'SAR', nameAr: 'ريال سعودي', isBase: true } }).catch(() => {});

    const plRes = await api(ctx.server, 'post', '/api/v1/price-lists', { token: actor.token, body: { name: 'قائمة R19-2', currencyCode: 'SAR' } });
    const plId = data(plRes.body as any).id as string;

    const badRes = await api(ctx.server, 'post', `/api/v1/price-lists/${plId}/items`, { token: actor.token, body: { itemId, unitId: otherUnitId, unitPrice: '5.0000' } });
    expect(badRes.status).toBe(422);
  });
});
