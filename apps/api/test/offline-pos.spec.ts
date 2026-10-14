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

describe('offline POS PWA contract', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let cashLocationId = '';
  let itemId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('offline-pos');
    actor = await createActor(ctx, {
      tenantCode: 'offline-pos-alpha',
      email: 'owner@offline-pos.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'parties.view',
        'pos.view',
        'pos.operate',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'inventory.view',
        'inventory.adjust',
        'accounting.account.view',
        'accounting.period.close',
        'accounting.reports.view',
        'organization.postingprofile.view',
        'treasury.view',
      ],
    });
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;
    cashLocationId = defaults.cashLocationId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY-OFFLINE-${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'OFFLINE', nameAr: 'أوفلاين' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS-OFF', nameAr: 'حبة' },
    });
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'OFFLINE-SKU',
        nameAr: 'صنف أوفلاين',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '10.0000',
        showInPos: true,
      },
    });
    itemId = data(item.body).id as string;
    const receipt = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '3',
            unitCost: '4',
            direction: 'in',
            docType: 'opening',
            docId: '00000000-0000-0000-0000-000000000006',
          },
        ],
      },
    });
    expect(receipt.status).toBe(201);
  }, 240_000);

  afterAll(async () => ctx.close());

  const ticket = (offlineId: string, sequenceNo: number, quantity = '1') => ({
    offlineId,
    deviceId: 'offline-test-device',
    sequenceNo,
    payload: {
      branchId,
      warehouseId,
      cashCustomerName: 'عميل أوفلاين',
      priceIncludesVat: true,
      lines: [{ itemId, quantity, unitPrice: '10', taxRate: '0' }],
      payment: { method: 'cash' as const, cashLocationId, tendered: String(Number(quantity) * 10) },
    },
  });

  it('returns a tenant-scoped catalog containing the POS snapshot', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/pos/offline-data', { token: actor.token });
    expect(response.status).toBe(200);
    const snapshot = data(response.body);
    expect((snapshot.items as Array<{ id: string }>).some((row) => row.id === itemId)).toBe(true);
    expect(snapshot).toHaveProperty('prices');
    expect(snapshot).toHaveProperty('customers');
    expect(snapshot).toHaveProperty('taxes');
    expect(snapshot).toHaveProperty('defaults');
  });

  it('syncs each cash ticket independently and turns stock shortage into a conflict', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/pos/offline-sync', {
      token: actor.token,
      body: {
        deviceId: 'offline-test-device',
        invoices: [ticket('OFFLINE-test-1', 1, '1'), ticket('OFFLINE-test-2', 2, '99')],
      },
    });
    expect(response.status).toBe(201);
    const result = data(response.body) as {
      synced: number;
      conflicts: number;
      results: Array<Record<string, unknown>>;
    };
    expect(result.synced).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(result.results.find((row) => row.offlineId === 'OFFLINE-test-1')).toMatchObject({
      status: 'synced',
    });
    expect(result.results.find((row) => row.offlineId === 'OFFLINE-test-2')).toMatchObject({
      status: 'conflict',
      errorCode: 'STOCK_INSUFFICIENT',
    });
  });

  it('is idempotent when the client retries a synced offline id', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/pos/offline-sync', {
      token: actor.token,
      body: { deviceId: 'offline-test-device', invoices: [ticket('OFFLINE-test-1', 1, '1')] },
    });
    expect(response.status).toBe(201);
    const result = data(response.body) as { results: Array<Record<string, unknown>> };
    expect(result.results[0]).toMatchObject({ offlineId: 'OFFLINE-test-1', status: 'synced' });
  });
});
