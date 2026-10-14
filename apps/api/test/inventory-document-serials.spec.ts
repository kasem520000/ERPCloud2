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
 * Phase 05 (part seven) — الرقم التسلسلي على سطر المستند.
 *
 * `Class/InvoiceOper.cs:1635` puts `ItemSerialNo` and `BatchNo` on the document line:
 * a serial says *which piece* moved, and the document says *who moved it*. The cloud
 * had a serial's state but no link from a document to the numbers it moved, so a sold
 * number could not be traced back to the voucher that sold it, and a receipt created
 * no pieces at all — the clerk had to run the generator separately and hope the counts
 * agreed.
 *
 * `frmItemSerialNo.xaml.cs:524` answers the other half of the question —
 * `SELECT SerialNo AS DgvSerialNo FROM ItemSerialNo, inv` — which is the trace: which
 * documents has this number travelled through.
 */
describe('Serial numbers on the stock document line', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let otherWarehouseId = '';
  let categoryId = '';
  let baseUnitId = '';
  let trackedId = '';
  let otherId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const makeItem = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { categoryId, baseUnitId, ...payload },
    });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const receipt = async (lines: Array<Record<string, unknown>>, warehouse = warehouseId) => {
    const voucher = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: { branchId, warehouseId: warehouse, kind: 'stock_in', reason: 'وارد', lines },
    });
    expect(voucher.status).toBe(201);
    return data(voucher.body);
  };

  const post = async (id: string) => {
    const posted = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/post`, {
      token: actor.token,
      body: {},
    });
    return posted;
  };

  beforeAll(async () => {
    ctx = await createTestApp('inventory-doc-serials');
    actor = await createActor(ctx, {
      tenantCode: 'inv-dser',
      email: 'owner@inv-dser.test',
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
        'inventory.negative.override',
        'accounting.period.close',
        'accounting.reports.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'inv-dser-2',
      email: 'owner@inv-dser-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'inventory.view', 'inventory.adjust'],
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

    trackedId = await makeItem({ sku: 'TRK-1', nameAr: 'جهاز مُرقّم' });
    otherId = await makeItem({ sku: 'TRK-2', nameAr: 'جهاز آخر' });

    const second = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH2', name: 'مستودع ثانٍ' },
    });
    otherWarehouseId = data(second.body).id as string;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. إدخال brings the pieces in and names them, one number per piece', async () => {
    const voucher = await receipt([
      { itemId: trackedId, qty: '3', unitCost: '100', serialNos: ['A-1', 'A-2', 'A-3'] },
    ]);
    // A draft remembers the numbers without inventing pieces that have not arrived.
    expect((voucher.lines as Array<Record<string, unknown>>)[0].serialNos).toEqual(['A-1', 'A-2', 'A-3']);

    const posted = await post(voucher.id as string);
    expect([200, 201]).toContain(posted.status);

    const numbers = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    expect(rows(numbers.body).map((row) => row.serialNo)).toEqual(['A-1', 'A-2', 'A-3']);
    expect(rows(numbers.body).every((row) => row.status === 'available')).toBe(true);
    expect(rows(numbers.body).every((row) => row.warehouseId === warehouseId)).toBe(true);
  });

  it('2. the count has to agree with the quantity — 3 pieces, 2 numbers is refused', async () => {
    const voucher = await receipt([
      { itemId: otherId, qty: '3', unitCost: '50', serialNos: ['B-1', 'B-2'] },
    ]);
    const posted = await post(voucher.id as string);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('SERIAL_COUNT_MISMATCH');

    // Nothing moved: the document is still a draft and no piece was invented.
    const still = await api(ctx.server, 'get', `/api/v1/inventory/vouchers/${voucher.id}`, {
      token: actor.token,
    });
    expect(data(still.body).status).toBe('draft');
    const numbers = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${otherId}`, {
      token: actor.token,
    });
    expect(rows(numbers.body).length).toBe(0);
  });

  it('3. إخراج sells the named pieces, and refuses a number that is not on the shelf', async () => {
    const issue = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_out',
        reason: 'صرف',
        lines: [{ itemId: trackedId, qty: '2', serialNos: ['A-1', 'A-2'] }],
      },
    });
    expect(issue.status).toBe(201);
    const posted = await post(data(issue.body).id as string);
    expect([200, 201]).toContain(posted.status);

    const left = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    const byNumber = new Map(rows(left.body).map((row) => [row.serialNo, row.status]));
    expect(byNumber.get('A-1')).toBe('sold');
    expect(byNumber.get('A-2')).toBe('sold');
    expect(byNumber.get('A-3')).toBe('available');

    // Selling the same number twice is refused by the state machine, not by luck.
    const again = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_out',
        reason: 'صرف مكرر',
        lines: [{ itemId: trackedId, qty: '1', serialNos: ['A-1'] }],
      },
    });
    const secondPost = await post(data(again.body).id as string);
    expect(secondPost.status).toBe(422);
    expect(codeOf(secondPost.body as Record<string, unknown>)).toBe('SERIAL_INVALID_STATE');

    // A number belonging to another item is not this item's to spend.
    const foreign = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_out',
        reason: 'صرف خاطئ',
        lines: [{ itemId: trackedId, qty: '1', serialNos: ['NOPE-1'] }],
      },
    });
    const foreignPost = await post(data(foreign.body).id as string);
    expect(foreignPost.status).toBe(422);
    expect(codeOf(foreignPost.body as Record<string, unknown>)).toBe('SERIAL_NOT_FOUND');
  });

  it('4. a number cannot be in two warehouses at once, and the same number cannot ride twice', async () => {
    // Stock the second warehouse with a piece of its own, so the balance check is not
    // what stops the next issue — the serial's own warehouse is.
    const fed = await receipt([{ itemId: trackedId, qty: '1', unitCost: '100', serialNos: ['A-9'] }], otherWarehouseId);
    await post(fed.id as string);

    const moved = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId: otherWarehouseId,
        kind: 'stock_out',
        reason: 'صرف من مستودع آخر',
        lines: [{ itemId: trackedId, qty: '1', serialNos: ['A-3'] }],
      },
    });
    const posted = await post(data(moved.body).id as string);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('SERIAL_WRONG_WAREHOUSE');

    const twice = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_in',
        reason: 'تكرار',
        lines: [{ itemId: otherId, qty: '2', unitCost: '10', serialNos: ['C-1', 'C-1'] }],
      },
    });
    expect(twice.status).toBe(422);
    expect(codeOf(twice.body as Record<string, unknown>)).toBe('SERIAL_DUPLICATE');
  });

  it('5. every number carries the document that moved it', async () => {
    const numbers = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    const soldOne = rows(numbers.body).find((row) => row.serialNo === 'A-1');
    expect(soldOne).toBeDefined();

    const trace = await api(ctx.server, 'get', `/api/v1/inventory/serials/${soldOne!.id}/documents`, {
      token: actor.token,
    });
    expect(trace.status).toBe(200);
    const payload = data(trace.body);
    expect((payload.serial as Record<string, unknown>).serialNo).toBe('A-1');
    // It came in on the receipt and went out on the issue, in that order.
    const documents = payload.documents as Array<Record<string, unknown>>;
    expect(documents.map((row) => row.docType)).toEqual(['stock_voucher', 'stock_voucher']);
    expect(documents.length).toBe(2);

    // A stranger's tenant cannot trace our numbers.
    const forbidden = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/serials/${soldOne!.id}/documents`,
      { token: stranger.token },
    );
    expect(forbidden.status).toBe(404);
  });

  it('6. إلغاء puts every number back where the document found it', async () => {
    const voucher = await receipt([
      { itemId: otherId, qty: '2', unitCost: '20', serialNos: ['D-1', 'D-2'] },
    ]);
    await post(voucher.id as string);
    const before = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${otherId}`, {
      token: actor.token,
    });
    expect(rows(before.body).length).toBe(2);

    const voided = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${voucher.id}/void`, {
      token: actor.token,
      body: { reason: 'خطأ في الإدخال' },
    });
    expect([200, 201]).toContain(voided.status);

    // The receipt invented these pieces; voiding it takes them back out.
    const after = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${otherId}`, {
      token: actor.token,
    });
    expect(rows(after.body).length).toBe(0);

    // And an issue that sold a number gives it back to the shelf.
    const issue = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_out',
        reason: 'صرف',
        lines: [{ itemId: trackedId, qty: '1', serialNos: ['A-3'] }],
      },
    });
    const issueId = data(issue.body).id as string;
    await post(issueId);
    const spent = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    expect(rows(spent.body).find((row) => row.serialNo === 'A-3')?.status).toBe('sold');

    await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${issueId}/void`, {
      token: actor.token,
      body: { reason: 'تراجع عن الصرف' },
    });
    const restored = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${trackedId}`, {
      token: actor.token,
    });
    expect(rows(restored.body).find((row) => row.serialNo === 'A-3')?.status).toBe('available');
  });

  it('7. a مناقلة takes the named pieces with it and hands them over on arrival', async () => {
    // Two pieces in the first warehouse; the transfer names one of them.
    await post(
      (
        await receipt([{ itemId: otherId, qty: '2', unitCost: '20', serialNos: ['E-1', 'E-2'] }])
      ).id as string,
    );

    const transfer = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: otherWarehouseId,
        lines: [{ itemId: otherId, qty: '1', serialNos: ['E-1'] }],
      },
    });
    expect(transfer.status).toBe(201);

    // A number the sending warehouse does not own cannot ride this transfer.
    const wrong = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: otherWarehouseId,
        lines: [{ itemId: otherId, qty: '1', serialNos: ['E-99'] }],
      },
    });
    const wrongSend = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${data(wrong.body).id}/send`, {
      token: actor.token,
      body: {},
    });
    expect(wrongSend.status).toBe(422);
    expect(codeOf(wrongSend.body as Record<string, unknown>)).toBe('SERIAL_NOT_FOUND');

    const sent = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${data(transfer.body).id}/send`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(sent.status);
    const onTheRoad = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${otherId}`, {
      token: actor.token,
    });
    // Booked to the transfer, not spent: a piece on the road is neither sold nor free.
    expect(rows(onTheRoad.body).find((row) => row.serialNo === 'E-1')?.status).toBe('reserved');

    const received = await api(
      ctx.server,
      'post',
      `/api/v1/inventory/transfers/${data(transfer.body).id}/receive`,
      { token: actor.token, body: { received: [{ lineNo: 1, qty: '1' }] } },
    );
    expect([200, 201]).toContain(received.status);
    const arrived = await api(ctx.server, 'get', `/api/v1/inventory/serials?item_id=${otherId}`, {
      token: actor.token,
    });
    const moved = rows(arrived.body).find((row) => row.serialNo === 'E-1');
    expect(moved?.status).toBe('available');
    // The piece is now in the warehouse it was sent to.
    expect(moved?.warehouseId).toBe(otherWarehouseId);

    // And the trace remembers the whole journey: the receipt that created the piece,
    // the transfer that sent it, and the receipt that took it in.
    const trace = await api(ctx.server, 'get', `/api/v1/inventory/serials/${moved!.id}/documents`, {
      token: actor.token,
    });
    expect(
      (data(trace.body).documents as Array<Record<string, unknown>>).map((row) => row.docType),
    ).toEqual(['stock_voucher', 'stock_transfer', 'stock_transfer_receipt']);
  });
});
