import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Production orders and contracting returns — the two documents that transform or reverse
 * value which has already been recorded.
 *
 * For production the invariant is conservation: the value that leaves the warehouse as
 * components must be exactly the value that re-enters it as the finished item, otherwise
 * the order silently invents or destroys inventory.
 *
 * For a contracting return it is that two things move together — the BOQ term gives its
 * value back *and* the customer gets a credit note. Either one alone leaves the project
 * double-billed or permanently short.
 */
describe('production orders and contracting returns', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let unitId = '';
  let categoryId = '';
  let woodId = '';
  let glueId = '';
  let tableId = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, string>;
  const code = (response: { body: Record<string, unknown> }) => (response.body.code ?? (response.body as { error?: { code: string } }).error?.code) as string;

  beforeAll(async () => {
    ctx = await createTestApp('production-and-returns');
    actor = await createActor(ctx, {
      tenantCode: 'workshop',
      email: 'owner@workshop.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.unit.manage',
        'catalog.category.manage',
        'inventory.view',
        'inventory.adjust',
        'inventory.production.manage',
        'inventory.production.complete',
        'projects.view',
        'projects.manage',
        'projects.bill.post',
        'parties.view',
        'parties.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'accounting.period.close',
        'sales.adjustment.create',
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
    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع الرئيسي' } });
    warehouseId = body(warehouse).id;
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'PCS', nameAr: 'حبة' } });
    unitId = body(unit).id;
    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } });
    categoryId = body(category).id;

    const item = async (sku: string, nameAr: string) => {
      const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', { token: actor.token, body: { sku, nameAr, categoryId, baseUnitId: unitId, kind: 'stock' } });
      return body(created).id;
    };
    woodId = await item('WOOD', 'خشب');
    glueId = await item('GLUE', 'غراء');
    tableId = await item('TABLE', 'طاولة');

    await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          { itemId: woodId, warehouseId, qty: '100', unitCost: '25', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000001' },
          { itemId: glueId, warehouseId, qty: '50', unitCost: '4', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000002' },
        ],
      },
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('conserves inventory value across a production order', async () => {
    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { branchId, warehouseId, outputItemId: tableId, outputQty: '5', components: [{ itemId: woodId, qty: '10' }, { itemId: glueId, qty: '5' }] },
    });
    expect(order.status).toBe(201);
    expect(body(order).status).toBe('draft');

    const completed = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${body(order).id}/complete`, { token: actor.token, body: {} });
    // 10 × 25 + 5 × 4 = 270 spread over 5 units.
    expect(body(completed).componentCost).toBe('270.0000');
    expect(body(completed).unitCost).toBe('54.0000');

    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${warehouseId}`, { token: actor.token });
    const rows = (levels.body.data ?? levels.body) as Array<{ itemId: string; quantity: string; value: string }>;
    const table = rows.find((row) => row.itemId === tableId);
    const wood = rows.find((row) => row.itemId === woodId);
    const glue = rows.find((row) => row.itemId === glueId);
    expect(Number(table?.quantity)).toBe(5);
    expect(Number(table?.value)).toBe(270);
    // What left the components is exactly what the finished item now carries.
    expect(Number(wood?.value) + Number(glue?.value) + Number(table?.value)).toBe(100 * 25 + 50 * 4);

    const twice = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${body(order).id}/complete`, { token: actor.token, body: {} });
    expect(twice.status).toBe(409);
  });

  it('refuses impossible orders and stock it does not have', async () => {
    const selfMade = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: tableId, outputQty: '1', components: [{ itemId: tableId, qty: '1' }] },
    });
    expect(selfMade.status).toBe(422);
    expect(code(selfMade)).toBe('PRODUCTION_COMPONENT_IS_OUTPUT');

    const duplicate = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: tableId, outputQty: '1', components: [{ itemId: woodId, qty: '1' }, { itemId: woodId, qty: '2' }] },
    });
    expect(code(duplicate)).toBe('PRODUCTION_COMPONENT_DUPLICATE');

    const hungry = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: { warehouseId, outputItemId: tableId, outputQty: '1', components: [{ itemId: woodId, qty: '10000' }] },
    });
    const starved = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${body(hungry).id}/complete`, { token: actor.token, body: {} });
    expect(starved.status).toBe(422);
    expect(code(starved)).toBe('STOCK_INSUFFICIENT');

    const cancelled = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${body(hungry).id}/cancel`, { token: actor.token, body: {} });
    expect(body(cancelled).status).toBe('cancelled');
  });

  it('returns certified work to the BOQ and raises a credit note for it', async () => {
    const client = await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: { kind: 'customer', name: 'عميل المشروع' } });
    const project = await api(ctx.server, 'post', '/api/v1/projects', {
      token: actor.token,
      body: { branchId, code: 'PRJ-R', name: 'مشروع المرتجع', partyId: body(client).id, contractValue: '300000', retentionPct: '10' },
    });
    const projectId = body(project).id;
    const term = await api(ctx.server, 'post', `/api/v1/projects/${projectId}/boq`, { token: actor.token, body: { code: 'B-1', description: 'أعمال حفر', qty: '1', unitValue: '100000' } });
    const termId = body(term).id;

    const bill = await api(ctx.server, 'post', `/api/v1/projects/${projectId}/progress-bills`, {
      token: actor.token,
      body: { billDate: '2026-09-01', lines: [{ termId, billValue: '60000' }] },
    });
    const billId = body(bill).id;

    // A draft bill has moved nothing: edit it instead of reversing it.
    const early = await api(ctx.server, 'post', '/api/v1/contracting/returns', { token: actor.token, body: { billId, reason: 'قياس خاطئ', lines: [{ termId, returnValue: '1000' }] } });
    expect(early.status).toBe(409);
    expect(code(early)).toBe('PROGRESS_BILL_INVALID_STATE');

    await api(ctx.server, 'post', `/api/v1/projects/progress-bills/${billId}/post`, { token: actor.token, body: { branchId } });

    const tooMuch = await api(ctx.server, 'post', '/api/v1/contracting/returns', { token: actor.token, body: { billId, reason: 'قياس خاطئ', lines: [{ termId, returnValue: '70000' }] } });
    expect(tooMuch.status).toBe(422);
    expect(code(tooMuch)).toBe('CONTRACTING_RETURN_EXCEEDS_BILL');

    const created = await api(ctx.server, 'post', '/api/v1/contracting/returns', { token: actor.token, body: { billId, reason: 'رفض القسم الشمالي', lines: [{ termId, returnValue: '10000' }] } });
    expect(created.status).toBe(201);
    // Retention was withheld from the bill, so returning the work releases it too.
    expect(body(created).retentionValue).toBe('1000.0000');
    expect(body(created).netValue).toBe('9000.0000');

    const postedReturn = await api(ctx.server, 'post', `/api/v1/contracting/returns/${body(created).id}/post`, { token: actor.token, body: {} });
    expect(body(postedReturn).status).toBe('posted');
    expect(body(postedReturn).creditNoteId).toBeTruthy();

    const after = await api(ctx.server, 'get', `/api/v1/projects/${projectId}`, { token: actor.token });
    const boq = ((after.body.data ?? after.body) as { boq: Array<{ id: string; previouslyBilled: string }> }).boq;
    expect(Number(boq.find((row) => row.id === termId)?.previouslyBilled)).toBe(50000);

    const notes = await api(ctx.server, 'get', '/api/v1/sales/adjustment-notes?kind=credit', { token: actor.token });
    const note = ((notes.body.data ?? notes.body) as Array<{ id: string; status: string; amount: string }>).find((row) => row.id === body(postedReturn).creditNoteId);
    expect(note?.status).toBe('draft');
    expect(Number(note?.amount)).toBe(9000);

    // A cancelled return releases the value it was holding for re-billing.
    const spare = await api(ctx.server, 'post', '/api/v1/contracting/returns', { token: actor.token, body: { billId, reason: 'تسوية', lines: [{ termId, returnValue: '50000' }] } });
    const blocked = await api(ctx.server, 'post', '/api/v1/contracting/returns', { token: actor.token, body: { billId, reason: 'زائد', lines: [{ termId, returnValue: '1' }] } });
    expect(code(blocked)).toBe('CONTRACTING_RETURN_EXCEEDS_BILL');
    await api(ctx.server, 'post', `/api/v1/contracting/returns/${body(spare).id}/cancel`, { token: actor.token, body: {} });
    const freed = await api(ctx.server, 'post', '/api/v1/contracting/returns', { token: actor.token, body: { billId, reason: 'بعد الإلغاء', lines: [{ termId, returnValue: '50000' }] } });
    expect(freed.status).toBe(201);
  });
});
