import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('inventory phase 09 integration', () => {
  let ctx: TestApp;
  let alpha: Actor;
  let beta: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('inventory-phase-09');
    alpha = await createActor(ctx, {
      tenantCode: 'inventory-alpha',
      email: 'owner@inventory-alpha.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'inventory.view', 'inventory.adjust', 'inventory.negative.override'],
    });
    beta = await createActor(ctx, {
      tenantCode: 'inventory-beta',
      email: 'owner@inventory-beta.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'inventory.view', 'inventory.adjust', 'inventory.negative.override'],
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('keeps inventory reads tenant-scoped', async () => {
    const alphaLevels = await api(ctx.server, 'get', '/api/v1/inventory/levels', { token: alpha.token });
    const betaLevels = await api(ctx.server, 'get', '/api/v1/inventory/levels', { token: beta.token });

    expect(alphaLevels.status).toBe(200);
    expect(betaLevels.status).toBe(200);
    expect(alphaLevels.body.data ?? alphaLevels.body).toEqual([]);
    expect(betaLevels.body.data ?? betaLevels.body).toEqual([]);
  });

  it('rejects an empty ledger batch before writing anything', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: alpha.token,
      body: { lines: [] },
    });

    expect(response.status).toBe(422);
    const errorBody = response.body as { error?: { code?: string }; code?: string };
    expect(errorBody.error?.code ?? errorBody.code).toBe('INVENTORY_LINES_REQUIRED');
  });

  it('rejects a non-positive quantity and preserves the empty ledger', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: alpha.token,
      body: {
        lines: [{
          itemId: '00000000-0000-4000-8000-000000000001',
          warehouseId: '00000000-0000-4000-8000-000000000002',
          qty: '0.0000',
          direction: 'in',
          docType: 'test',
          docId: '00000000-0000-4000-8000-000000000003',
        }],
      },
    });

    expect(response.status).toBe(422);
    const errorBody = response.body as { error?: { code?: string }; code?: string };
    expect(errorBody.error?.code ?? errorBody.code).toBe('INVALID_STOCK_QUANTITY');

    const movements = await api(ctx.server, 'get', '/api/v1/inventory/movements', { token: alpha.token });
    expect(movements.status).toBe(200);
    expect(movements.body.data ?? movements.body).toEqual([]);
  });

  it('requires inventory adjustment permission for ledger writes', async () => {
    const viewer = await createActor(ctx, {
      tenantId: alpha.tenantId,
      tenantCode: alpha.tenantCode,
      email: 'viewer@inventory-alpha.test',
      permissions: ['inventory.view'],
      roleNames: ['Inventory Viewer'],
      isOwner: false,
    });

    const response = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: viewer.token,
      body: { lines: [] },
    });

    expect(response.status).toBe(403);
  });

  it('requires inventory view permission for valuations', async () => {
    const viewer = await createActor(ctx, {
      tenantCode: 'inventory-view-check',
      email: 'viewer@inventory-view-check.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS],
      roleNames: ['Platform Viewer'],
      isOwner: false,
    });

    const response = await api(ctx.server, 'get', '/api/v1/inventory/valuation/as-of?as_of=2026-01-01T00:00:00.000Z', {
      token: viewer.token,
    });

    expect(response.status).toBe(403);
  });

  it('rejects invalid transfer shapes before touching the ledger', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/inventory/transfers', {
      token: alpha.token,
      body: {
        transferId: '00000000-0000-4000-8000-000000000010',
        fromWarehouseId: '00000000-0000-4000-8000-000000000011',
        toWarehouseId: '00000000-0000-4000-8000-000000000011',
        lines: [],
      },
    });

    expect(response.status).toBe(422);
    const errorBody = response.body as { error?: { code?: string }; code?: string };
    expect(errorBody.error?.code ?? errorBody.code).toBe('INVALID_STOCK_TRANSFER');

    const movements = await api(ctx.server, 'get', '/api/v1/inventory/movements', { token: alpha.token });
    expect(movements.status).toBe(200);
    expect(movements.body.data ?? movements.body).toEqual([]);
  });

  it('requires an approved journal before posting a stock adjustment', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/inventory/adjustments/post', {
      token: alpha.token,
      body: {
        adjustmentId: '00000000-0000-4000-8000-000000000020',
        itemId: '00000000-0000-4000-8000-000000000021',
        warehouseId: '00000000-0000-4000-8000-000000000022',
        countedQty: '1.0000',
        approved: false,
      },
    });

    expect(response.status).toBe(422);
    const errorBody = response.body as { error?: { code?: string }; code?: string };
    expect(errorBody.error?.code ?? errorBody.code).toBe('ADJUSTMENT_APPROVAL_REQUIRED');
  });

  it('rejects serial reservation without serial identifiers', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/inventory/serials/reserve', {
      token: alpha.token,
      body: { serialIds: [] },
    });

    expect(response.status).toBe(422);
    const errorBody = response.body as { error?: { code?: string }; code?: string };
    expect(errorBody.error?.code ?? errorBody.code).toBe('SERIALS_REQUIRED');
  });
});

export {};
