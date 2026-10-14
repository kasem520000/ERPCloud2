import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * طلب بضاعة and توصيل مخزني.
 *
 * The two invariants worth a real database behind them: an approved request must hand its
 * *approved* quantities (not the requested ones) to a draft transfer, and a delivery must
 * never let the warehouse promise more units than the invoice actually sold.
 */
describe('goods requests and stock deliveries', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let fromWarehouseId = '';
  let toWarehouseId = '';
  let itemId = '';
  let otherItemId = '';

  const inventoryPermissions = [
    'inventory.view',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.request.manage',
    'inventory.request.approve',
    'inventory.delivery.manage',
  ];

  beforeAll(async () => {
    ctx = await createTestApp('warehouse-documents');
    actor = await createActor(ctx, {
      tenantCode: 'wh-docs',
      email: 'owner@wh-docs.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        ...inventoryPermissions,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'accounting.period.close',
      ],
    });


    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);
    const first = await api(ctx.server, 'post', '/api/v1/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع الرئيسي' } });
    fromWarehouseId = ((first.body.data ?? first.body) as { id: string }).id;
    const second = await api(ctx.server, 'post', '/api/v1/warehouses', { token: actor.token, body: { branchId, code: 'WH2', name: 'مستودع الفرع' } });
    toWarehouseId = ((second.body.data ?? second.body) as { id: string }).id;

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'PCS', nameAr: 'حبة' } });
    const categoryId = ((category.body.data ?? category.body) as { id: string }).id;
    const baseUnitId = ((unit.body.data ?? unit.body) as { id: string }).id;
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'SKU-1', nameAr: 'صنف أول', categoryId, baseUnitId, salePrice: '100.0000' },
    });
    itemId = ((item.body.data ?? item.body) as { id: string }).id;
    const other = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'SKU-2', nameAr: 'صنف ثانٍ', categoryId, baseUnitId, salePrice: '50.0000' },
    });
    otherItemId = ((other.body.data ?? other.body) as { id: string }).id;
  }, 240_000);

  afterAll(async () => ctx.close());

  it('walks a request from draft to a transfer carrying the approved quantities', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/inventory/requests', {
      token: actor.token,
      body: { branchId, toWarehouseId, lines: [{ itemId, qty: '50' }, { itemId: otherItemId, qty: '10' }] },
    });
    expect(created.status).toBe(201);
    const request = (created.body.data ?? created.body) as { id: string; number: string; status: string };
    expect(request.number).toMatch(/^GR-\d{6}$/);
    expect(request.status).toBe('draft');

    const early = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/approve`, { token: actor.token, body: {} });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('GOODS_REQUEST_INVALID_STATUS');

    await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/submit`, { token: actor.token, body: {} });

    const tooMuch = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/approve`, {
      token: actor.token,
      body: { fromWarehouseId, lines: [{ lineNo: 1, approvedQty: '80' }] },
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code).toBe('GOODS_REQUEST_APPROVED_QTY_INVALID');

    const approved = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/approve`, {
      token: actor.token,
      body: { fromWarehouseId, lines: [{ lineNo: 1, approvedQty: '30' }, { lineNo: 2, approvedQty: '0' }] },
    });
    expect(approved.status).toBe(201);
    expect((approved.body.data ?? approved.body).status).toBe('approved');

    const fulfilled = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/fulfil`, { token: actor.token, body: {} });
    expect(fulfilled.status).toBe(201);
    const done = (fulfilled.body.data ?? fulfilled.body) as { status: string; transferId: string };
    expect(done.status).toBe('fulfilled');

    const transfers = await api(ctx.server, 'get', '/api/v1/inventory/transfers', { token: actor.token });
    const transfer = ((transfers.body.data ?? transfers.body) as Array<{ id: string; number: string; status: string; lines: Array<{ qty: string }> }>).find((row) => row.id === done.transferId);
    expect(transfer?.status).toBe('draft');
    expect(transfer?.number).toMatch(/^TR-\d{6}$/);
    // The zero-approved line is dropped, not transferred as a zero quantity.
    expect(transfer?.lines).toHaveLength(1);
    expect(transfer?.lines[0]?.qty).toBe('30.0000');

    const again = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/fulfil`, { token: actor.token, body: {} });
    expect(again.status).toBe(409);
  });

  it('requires a reason to reject a submitted request', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/inventory/requests', {
      token: actor.token,
      body: { branchId, toWarehouseId, lines: [{ itemId, qty: '4' }] },
    });
    const request = (created.body.data ?? created.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/submit`, { token: actor.token, body: {} });

    const blank = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/reject`, { token: actor.token, body: { reason: '   ' } });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('GOODS_REQUEST_REASON_REQUIRED');

    const rejected = await api(ctx.server, 'post', `/api/v1/inventory/requests/${request.id}/reject`, { token: actor.token, body: { reason: 'لا يوجد رصيد' } });
    expect(rejected.status).toBe(201);
    expect((rejected.body.data ?? rejected.body).status).toBe('rejected');
  });

  it('delivers a posted invoice without moving stock twice, and never beyond what was sold', async () => {
    await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: { lines: [{ itemId, warehouseId: fromWarehouseId, qty: '100', unitCost: '60', direction: 'in', docType: 'opening', docId: crypto.randomUUID() }] },
    });

    const draft = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: { branchId, warehouseId: fromWarehouseId, cashCustomerName: 'عميل نقدي', lines: [{ itemId, quantity: '10', unitPrice: '100', taxRate: '15' }] },
    });
    const invoice = (draft.body.data ?? draft.body) as { id: string };

    const tooEarly = await api(ctx.server, 'post', '/api/v1/inventory/deliveries', { token: actor.token, body: { invoiceId: invoice.id } });
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.code).toBe('DELIVERY_INVOICE_NOT_POSTED');

    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);

    const outstanding = await api(ctx.server, 'get', '/api/v1/inventory/deliveries/outstanding', { token: actor.token });
    const pending = ((outstanding.body.data ?? outstanding.body) as Array<{ id: string; lines: Array<{ remainingQty: string }> }>).find((row) => row.id === invoice.id);
    expect(pending?.lines[0]?.remainingQty).toBe('10.0000');

    const partial = await api(ctx.server, 'post', '/api/v1/inventory/deliveries', {
      token: actor.token,
      body: { invoiceId: invoice.id, recipientName: 'أحمد', lines: [{ itemId, qty: '4' }] },
    });
    expect(partial.status).toBe(201);
    const delivery = (partial.body.data ?? partial.body) as { id: string; number: string };
    expect(delivery.number).toMatch(/^DLV-\d{6}$/);

    const over = await api(ctx.server, 'post', '/api/v1/inventory/deliveries', { token: actor.token, body: { invoiceId: invoice.id, lines: [{ itemId, qty: '7' }] } });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('DELIVERY_QTY_EXCEEDS_INVOICE');

    const foreign = await api(ctx.server, 'post', '/api/v1/inventory/deliveries', { token: actor.token, body: { invoiceId: invoice.id, lines: [{ itemId: otherItemId, qty: '1' }] } });
    expect(foreign.status).toBe(422);
    expect(foreign.body.code).toBe('DELIVERY_ITEM_NOT_ON_INVOICE');

    await api(ctx.server, 'post', `/api/v1/inventory/deliveries/${delivery.id}/deliver`, { token: actor.token, body: {} });
    const rest = await api(ctx.server, 'post', '/api/v1/inventory/deliveries', { token: actor.token, body: { invoiceId: invoice.id } });
    expect(rest.status).toBe(201);
    expect(((rest.body.data ?? rest.body) as { lines: Array<{ qty: string }> }).lines[0]?.qty).toBe('6.0000');

    const exhausted = await api(ctx.server, 'post', '/api/v1/inventory/deliveries', { token: actor.token, body: { invoiceId: invoice.id } });
    expect(exhausted.status).toBe(422);
    expect(exhausted.body.code).toBe('DELIVERY_NOTHING_OUTSTANDING');

    // Cancelling returns the quantity to the invoice's outstanding balance …
    const cancelled = await api(ctx.server, 'post', `/api/v1/inventory/deliveries/${((rest.body.data ?? rest.body) as { id: string }).id}/cancel`, { token: actor.token, body: {} });
    expect(cancelled.status).toBe(201);
    const reopened = await api(ctx.server, 'get', '/api/v1/inventory/deliveries/outstanding', { token: actor.token });
    const back = ((reopened.body.data ?? reopened.body) as Array<{ id: string; lines: Array<{ remainingQty: string }> }>).find((row) => row.id === invoice.id);
    expect(back?.lines[0]?.remainingQty).toBe('6.0000');

    // … and none of it touched the stock ledger: posting the invoice already did.
    const movements = await api(ctx.server, 'get', `/api/v1/inventory/movements?item_id=${itemId}`, { token: actor.token });
    const rows = (movements.body.data ?? movements.body) as Array<{ docType: string }>;
    expect(rows.filter((row) => row.docType.includes('delivery'))).toHaveLength(0);
  });
});
