import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('e-commerce API — tenanted stores, orders and signed webhooks', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let otherTenant: Actor;
  let branchId = '';
  let storeId = '';

  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });
  const post = (path: string, body: Record<string, unknown>, token = actor.token) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token, body });

  const data = (body: Record<string, unknown>) => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: Record<string, unknown>) =>
    (Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []) as Array<
      Record<string, unknown>
    >;

  beforeAll(async () => {
    ctx = await createTestApp('ecommerce-api');
    actor = await createActor(ctx, {
      tenantCode: 'ecommerce-api',
      email: 'owner@ecommerce-api.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'ecommerce.manage',
        'sales.invoice.create',
      ],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'ecommerce-api',
      tenantId: actor.tenantId,
      email: 'viewer@ecommerce-api.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS],
    });
    otherTenant = await createActor(ctx, {
      tenantCode: 'ecommerce-api-other',
      email: 'owner@ecommerce-api-other.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'ecommerce.manage'],
    });
    const branch = await post('/branches', { code: 'ECOM', nameAr: 'E-commerce branch' });
    branchId = String(data(branch.body).id ?? '');
  }, 240_000);

  afterAll(async () => ctx?.close());

  it('lists salla, zid and shopify', async () => {
    const response = await get('/ecommerce/providers');
    expect(response.status).toBe(200);
    expect(rows(response.body).map((row) => row.provider)).toEqual(['salla', 'zid', 'shopify']);
  });

  it('connects a mock Salla store and never returns credentials', async () => {
    const response = await post('/ecommerce/stores', {
      provider: 'salla',
      apiKey: 'MOCK-ECO-API',
      webhookSecret: 'MOCK-API-SECRET',
      settings: { branchId },
    });
    expect(response.status).toBe(201);
    const store = data(response.body);
    storeId = String(store.id);
    expect(store.status).toBe('active');
    expect(store.accessTokenMasked).toBe('****');
    expect(store.accessTokenEnc).toBeUndefined();
  });

  it('lists only stores in the current tenant', async () => {
    const own = await get('/ecommerce/stores');
    const stranger = await get('/ecommerce/stores', otherTenant.token);
    expect(own.status).toBe(200);
    expect(rows(own.body).map((row) => row.id)).toContain(storeId);
    expect(stranger.status).toBe(200);
    expect(rows(stranger.body).map((row) => row.id)).not.toContain(storeId);
  });

  it('denies a membership without ecommerce.manage', async () => {
    const response = await get('/ecommerce/stores', viewer.token);
    expect(response.status).toBe(403);
  });

  it('manual sync fetches five mock orders and imports drafts', async () => {
    const response = await post(`/ecommerce/stores/${storeId}/sync`, {});
    expect(response.status).toBe(201);
    expect(data(response.body)).toMatchObject({ fetched: 5, created: 5, imported: 5, failed: 0 });
  }, 120_000);

  it('returns orders with imported status and ERP invoice links', async () => {
    const response = await get(`/ecommerce/orders?store_id=${storeId}`);
    const orders = rows(response.body);
    expect(response.status).toBe(200);
    expect(orders).toHaveLength(5);
    expect(
      orders.every((order) => order.status === 'imported' && typeof order.erpInvoiceId === 'string'),
    ).toBe(true);
  });

  it('uses store plus remote id as an idempotency key', async () => {
    const response = await post(`/ecommerce/stores/${storeId}/sync`, {});
    expect(data(response.body)).toMatchObject({ fetched: 5, created: 0, skipped: 5 });
  }, 120_000);

  it('accepts a signed webhook and imports one draft order', async () => {
    const body = {
      tenantId: actor.tenantId,
      storeId,
      id: 'MOCK-WEBHOOK-API',
      orderNo: 'WEBHOOK-API',
      total: '22',
      customer: { name: 'Webhook API' },
      lines: [{ name: 'Webhook line', quantity: '1', unitPrice: '22' }],
    };
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', 'MOCK-API-SECRET').update(raw).digest('hex');
    const response = await api(ctx.server, 'post', '/api/v1/ecommerce/webhooks/salla', {
      body,
      headers: { 'x-tenant-id': actor.tenantId, 'x-salla-signature': signature },
    });
    expect(response.status).toBe(201);
    expect(data(response.body)).toMatchObject({ accepted: true, duplicate: false });
  });

  it('rejects a webhook with an invalid HMAC', async () => {
    const body = { tenantId: actor.tenantId, storeId, id: 'MOCK-WEBHOOK-BAD', total: '1' };
    const response = await api(ctx.server, 'post', '/api/v1/ecommerce/webhooks/salla', {
      body,
      headers: { 'x-tenant-id': actor.tenantId, 'x-salla-signature': 'invalid' },
    });
    expect(response.status).toBe(401);
  });

  it('marks rejected provider tokens as error without exposing them', async () => {
    const response = await post('/ecommerce/stores', {
      provider: 'zid',
      apiKey: 'MOCK-FAIL-API',
      webhookSecret: 'bad',
    });
    expect(response.status).toBe(201);
    const store = data(response.body);
    expect(store.status).toBe('error');
    expect(store.lastError).toMatch(/rejected|token/i);
    expect(store.accessTokenEnc).toBeUndefined();
  });

  it('keeps the new stores/orders tenant isolated from another tenant', async () => {
    const response = await get('/ecommerce/orders', otherTenant.token);
    expect(response.status).toBe(200);
    expect(rows(response.body)).toHaveLength(0);
  });
});
