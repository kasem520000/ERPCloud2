import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { ALL_ORGANIZATION_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Currencies, FX rates and price lists — API_CONTRACT §3, PHASE_05 §5.4 / §5.6.
 *
 * `GET /fx-rates/resolve` is the endpoint the whole ledger will lean on, so all four
 * rungs of the resolution ladder are exercised against real rows: identity, direct,
 * inverse and triangulation through the tenant's base currency.
 */
describe('currencies, FX and price lists (PHASE_05 §5.4, §5.6)', () => {
  let ctx: TestApp;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('org-money');
    admin = await createActor(ctx, {
      tenantCode: 'org-money',
      email: 'admin@org-money.test',
      permissions: ALL_ORGANIZATION_PERMISSIONS,
    });

    for (const body of [
      { code: 'SAR', nameAr: 'ريال سعودي', nameEn: 'Saudi riyal' },
      { code: 'USD', nameAr: 'دولار أمريكي', nameEn: 'US dollar' },
      { code: 'EUR', nameAr: 'يورو', nameEn: 'Euro' },
      { code: 'KWD', nameAr: 'دينار كويتي', nameEn: 'Kuwaiti dinar', minorUnits: 3 },
    ]) {
      const created = await api(ctx.server, 'post', '/api/v1/currencies', {
        token: admin.token,
        body,
      });
      expect(created.status).toBe(201);
    }
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const token = () => admin.token;

  it('makes the first enabled currency the base one and writes it back to the tenant', async () => {
    const list = await api(ctx.server, 'get', '/api/v1/currencies?limit=50', { token: token() });
    expect(list.status).toBe(200);
    const rows = list.body.data as Array<{ code: string; isBase: boolean; minorUnits: number }>;
    expect(rows.filter((row) => row.isBase).map((row) => row.code)).toEqual(['SAR']);
    expect(rows.find((row) => row.code === 'KWD')?.minorUnits).toBe(3);

    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows: tenantRows } = await client.query<{ base_currency: string }>(
        'SELECT base_currency FROM tenants WHERE id = $1',
        [admin.tenantId],
      );
      expect(tenantRows[0]?.base_currency.trim()).toBe('SAR');
    } finally {
      await client.end();
    }
  });

  it('refuses to enable the same ISO code twice', async () => {
    const duplicate = await api(ctx.server, 'post', '/api/v1/currencies', {
      token: token(),
      body: { code: 'usd', nameAr: 'دولار' },
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.detail).toContain('USD');
  });

  it('refuses to clear or deactivate the base currency', async () => {
    const cleared = await api(ctx.server, 'patch', '/api/v1/currencies/SAR', {
      token: token(),
      body: { isBase: false },
    });
    expect(cleared.status).toBe(422);

    const deactivated = await api(ctx.server, 'patch', '/api/v1/currencies/SAR', {
      token: token(),
      body: { isActive: false },
    });
    expect(deactivated.status).toBe(422);
  });

  it('resolves the identity rate without touching the table', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/fx-rates/resolve?from=SAR&to=SAR', {
      token: token(),
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      fromCode: 'SAR',
      toCode: 'SAR',
      rate: '1',
      source: 'identity',
      effectiveFrom: null,
      via: null,
    });
  });

  it('fails with 422 when no rate can be reached', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/fx-rates/resolve?from=USD&to=SAR', {
      token: token(),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.detail).toContain('USD→SAR');
  });

  it('stores a rate and resolves it directly, inversely and as of a date', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/fx-rates', {
      token: token(),
      body: { fromCode: 'USD', toCode: 'SAR', rate: '3.75', effectiveFrom: '2026-01-01' },
    });
    expect(created.status).toBe(201);

    const direct = await api(ctx.server, 'get', '/api/v1/fx-rates/resolve?from=USD&to=SAR&date=2026-06-01', {
      token: token(),
    });
    expect(direct.body.data).toMatchObject({ rate: '3.75', source: 'direct', effectiveFrom: '2026-01-01' });

    const inverse = await api(ctx.server, 'get', '/api/v1/fx-rates/resolve?from=SAR&to=USD&date=2026-06-01', {
      token: token(),
    });
    expect(inverse.body.data).toMatchObject({ rate: '0.2666666667', source: 'inverse' });

    // A date before the first quote has nothing to read — silence beats a wrong number.
    const tooEarly = await api(
      ctx.server,
      'get',
      '/api/v1/fx-rates/resolve?from=USD&to=SAR&date=2025-12-31',
      { token: token() },
    );
    expect(tooEarly.status).toBe(422);
  });

  it('reads the newest quote on or before the requested date', async () => {
    const later = await api(ctx.server, 'post', '/api/v1/fx-rates', {
      token: token(),
      body: { fromCode: 'USD', toCode: 'SAR', rate: '3.7600000000', effectiveFrom: '2026-03-01' },
    });
    expect(later.status).toBe(201);

    const february = await api(
      ctx.server,
      'get',
      '/api/v1/fx-rates/resolve?from=USD&to=SAR&date=2026-02-15',
      { token: token() },
    );
    expect(february.body.data).toMatchObject({ rate: '3.75', effectiveFrom: '2026-01-01' });

    const april = await api(ctx.server, 'get', '/api/v1/fx-rates/resolve?from=USD&to=SAR&date=2026-04-15', {
      token: token(),
    });
    expect(april.body.data).toMatchObject({ rate: '3.76', effectiveFrom: '2026-03-01' });
  });

  it('refuses two quotes for the same pair and date', async () => {
    const duplicate = await api(ctx.server, 'post', '/api/v1/fx-rates', {
      token: token(),
      body: { fromCode: 'USD', toCode: 'SAR', rate: '3.80', effectiveFrom: '2026-01-01' },
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.detail).toContain('2026-01-01');
  });

  it('refuses a rate for a currency the tenant has not enabled', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/fx-rates', {
      token: token(),
      body: { fromCode: 'JPY', toCode: 'SAR', rate: '0.025', effectiveFrom: '2026-01-01' },
    });
    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('JPY');
  });

  it('triangulates through the base currency when no pair is quoted', async () => {
    // EUR→SAR exists; USD→SAR exists. EUR→USD does not, and must be derived
    // as EUR→SAR × SAR→USD (the second leg inverted from the stored USD→SAR).
    const eurToSar = await api(ctx.server, 'post', '/api/v1/fx-rates', {
      token: token(),
      body: { fromCode: 'EUR', toCode: 'SAR', rate: '4.10', effectiveFrom: '2026-02-01' },
    });
    expect(eurToSar.status).toBe(201);

    const response = await api(ctx.server, 'get', '/api/v1/fx-rates/resolve?from=EUR&to=USD&date=2026-02-15', {
      token: token(),
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      source: 'triangulated',
      via: 'SAR',
      // 4.10 × (1/3.75) = 1.0933333333 at the stored scale.
      rate: '1.0933333333',
      // The staler of the two legs — a derived rate is only as fresh as its worst half.
      effectiveFrom: '2026-01-01',
    });
  });

  it('keeps only the rate mutable on an FX row', async () => {
    const list = await api(ctx.server, 'get', '/api/v1/fx-rates?filter[fromCode]=EUR', { token: token() });
    const fxRateId = (list.body.data as Array<{ id: string }>)[0]?.id ?? '';

    const repriced = await api(ctx.server, 'patch', `/api/v1/fx-rates/${fxRateId}`, {
      token: token(),
      body: { rate: '4.2000000000' },
    });
    expect(repriced.status).toBe(200);
    expect((repriced.body.data as { rate: string }).rate).toBe('4.2000000000');

    const rewritten = await api(ctx.server, 'patch', `/api/v1/fx-rates/${fxRateId}`, {
      token: token(),
      body: { effectiveFrom: '2026-05-05' },
    });
    expect(rewritten.status).toBe(400);

    const removed = await api(ctx.server, 'delete', `/api/v1/fx-rates/${fxRateId}`, { token: token() });
    expect(removed.status).toBe(204);
    const gone = await api(ctx.server, 'get', `/api/v1/fx-rates/${fxRateId}`, { token: token() });
    expect(gone.status).toBe(404);
  });

  it('creates a price list in an enabled currency and refuses one in a foreign currency', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/price-lists', {
      token: token(),
      body: { name: 'Retail', currencyCode: 'SAR' },
    });
    expect(created.status).toBe(201);
    expect((created.body.data as { isDefault: boolean }).isDefault).toBe(true);

    const foreign = await api(ctx.server, 'post', '/api/v1/price-lists', {
      token: token(),
      body: { name: 'Yen retail', currencyCode: 'JPY' },
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body.detail).toContain('JPY');

    const duplicate = await api(ctx.server, 'post', '/api/v1/price-lists', {
      token: token(),
      body: { name: 'Retail', currencyCode: 'USD' },
    });
    expect(duplicate.status).toBe(422);
  });

  it('upserts price-list items by (item, quantity break) and deletes them hard', async () => {
    const list = await api(ctx.server, 'post', '/api/v1/price-lists', {
      token: token(),
      body: { name: 'Wholesale', currencyCode: 'USD' },
    });
    const priceListId = (list.body.data as { id: string }).id;
    const itemId = '018f3b8a-0000-7000-8000-0000000000a1';

    const first = await api(ctx.server, 'post', `/api/v1/price-lists/${priceListId}/items`, {
      token: token(),
      body: { itemId, unitPrice: '19.9900' },
    });
    expect(first.status).toBe(201);
    const rowId = (first.body.data as { id: string; minQty: string }).id;
    expect((first.body.data as { minQty: string }).minQty).toBe('0.0000');

    // Same item, same break → an update, not a second row.
    const repriced = await api(ctx.server, 'post', `/api/v1/price-lists/${priceListId}/items`, {
      token: token(),
      body: { itemId, unitPrice: '18.5000' },
    });
    expect(repriced.status).toBe(201);
    expect((repriced.body.data as { id: string }).id).toBe(rowId);
    expect((repriced.body.data as { unitPrice: string }).unitPrice).toBe('18.5000');

    // Same item, a different break → a genuine second tier.
    const bulk = await api(ctx.server, 'post', `/api/v1/price-lists/${priceListId}/items`, {
      token: token(),
      body: { itemId, unitPrice: '15.0000', minQty: '100' },
    });
    expect(bulk.status).toBe(201);
    expect((bulk.body.data as { id: string }).id).not.toBe(rowId);

    const items = await api(ctx.server, 'get', `/api/v1/price-lists/${priceListId}/items`, {
      token: token(),
    });
    expect((items.body.meta as { total: number }).total).toBe(2);
    expect((items.body.data as Array<{ minQty: string }>).map((row) => row.minQty)).toEqual([
      '0.0000',
      '100.0000',
    ]);

    const removed = await api(ctx.server, 'delete', `/api/v1/price-lists/${priceListId}/items/${rowId}`, {
      token: token(),
    });
    expect(removed.status).toBe(204);
    const after = await api(ctx.server, 'get', `/api/v1/price-lists/${priceListId}/items`, {
      token: token(),
    });
    expect((after.body.meta as { total: number }).total).toBe(1);
  });

  it('refuses to re-denominate a price list that already holds prices', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/price-lists', {
      token: token(),
      body: { name: 'Priced', currencyCode: 'SAR' },
    });
    const priceListId = (created.body.data as { id: string }).id;
    await api(ctx.server, 'post', `/api/v1/price-lists/${priceListId}/items`, {
      token: token(),
      body: { unitPrice: '10.0000' },
    });

    const redenominated = await api(ctx.server, 'patch', `/api/v1/price-lists/${priceListId}`, {
      token: token(),
      body: { currencyCode: 'USD' },
    });
    expect(redenominated.status).toBe(422);
    expect(redenominated.body.detail).toContain('Empty the price list');
  });

  it('refuses to deactivate a currency a price list still uses', async () => {
    const response = await api(ctx.server, 'patch', '/api/v1/currencies/USD', {
      token: token(),
      body: { isActive: false },
    });
    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('price list');
  });
});
