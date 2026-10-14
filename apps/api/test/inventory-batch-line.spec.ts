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
 * Phase 05 (part eight) — الدفعة على سطر المستند (R5).
 *
 * `Class/InvoiceOper.cs:1635` writes the batch onto the line it belongs to:
 * `INSERT INTO InvoiceItemDetail(…, ItemSerialNo, BatchNo, ItemProductionDate,
 * ItemExpireDate …)`, and L3886–L3888 reads those columns straight back for the draft
 * and for the posted document. The cloud kept a lot in its own table and an optional
 * `lot_id` on the line, so a storeman had to register the batch in one screen, come
 * back, and pick it — and a line that named a batch nobody had registered lost the
 * number, and with it the date.
 *
 * The three rules this spec pins down:
 *
 *   1. يكتب الرقم على السطر ⇒ الدفعة تُبحث أو **تُنشأ** بتواريخ السطر، ويُحفظ الرقم
 *      والتاريخان على السطر نفسه كما كُتبا على العبوة.
 *   2. تاريخٌ فارغ يُملأ ولا يُمحى، وتاريخٌ **مخالف** لما هو مسجَّل يُرفض
 *      (`LOT_EXPIRY_MISMATCH`, 409) — فلا يكون لدفعةٍ واحدة تاريخان يقرأ منهما تقرير
 *      الصلاحية أيَّهما شاء.
 *   3. صنفٌ لا يُتتبَّع بالدفعات لا تُقبل له دفعة (`LOT_NOT_TRACKED`, 422)؛ و`lotId`
 *      صريح يبقى مقبولاً لكنه يُفحَص على الصنف والمستأجر.
 *
 * كما يثبّت أن تاريخ الإنتاج ليس تاريخ الاستلام — وهو السبب الذي جعل العمود يُضاف:
 * تقرير «صلاحية الصنف» (`frmItemsExpire`, `Inventory.ItemsExpirationStock`) يقرأ
 * تاريخ الانتهاء، ورقم الدفعة على السطر هو ما يوصل التاريخ من العبوة إلى السجل.
 */
describe('Batch on the stock document line', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let otherWarehouseId = '';
  let categoryId = '';
  let baseUnitId = '';
  let trackedId = '';
  let plainId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  const errorsOf = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    ((body.error as { errors?: unknown } | undefined)?.errors ??
      (body.errors as unknown[] | undefined) ??
      []) as Array<Record<string, unknown>>;

  const makeItem = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { categoryId, baseUnitId, ...payload },
    });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  /** سند إدخال — the desktop's وارد, with the batch columns exactly as on the pack. */
  const receipt = async (lines: Array<Record<string, unknown>>, warehouse = warehouseId) => {
    const voucher = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: { branchId, warehouseId: warehouse, kind: 'stock_in', reason: 'وارد', lines },
    });
    return voucher;
  };

  /** الدفعات المسجَّلة لهذا الصنف. */
  const lots = async (itemId: string) => {
    const response = await api(ctx.server, 'get', `/api/v1/inventory/lots?item_id=${itemId}`, {
      token: actor.token,
    });
    expect(response.status).toBe(200);
    return rows(response.body);
  };

  beforeAll(async () => {
    ctx = await createTestApp('inventory-batch-line');
    actor = await createActor(ctx, {
      tenantCode: 'inv-batch',
      email: 'owner@inv-batch.test',
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
      tenantCode: 'inv-batch-2',
      email: 'owner@inv-batch-2.test',
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

    trackedId = await makeItem({ sku: 'LOT-1', nameAr: 'لبن مبستر', trackLot: true });
    plainId = await makeItem({ sku: 'LOT-2', nameAr: 'مسامير', trackLot: false });

    const second = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH2', name: 'مستودع ثانٍ' },
    });
    otherWarehouseId = data(second.body).id as string;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الرقم على السطر ينشئ الدفعة بتواريخها، وتبقى على السطر كما كُتبت', async () => {
    const voucher = await receipt([
      {
        itemId: trackedId,
        qty: '12',
        unitCost: '20',
        batchNo: 'B-2026-01',
        productionDate: '2026-01-05',
        expiryDate: '2027-01-05',
      },
    ]);
    expect(voucher.status).toBe(201);
    const line = (data(voucher.body).lines as Array<Record<string, unknown>>)[0];
    // The line is a receipt note, not a reference: it keeps the pack's text.
    expect(line.batchNo).toBe('B-2026-01');
    expect(line.productionDate).toBe('2026-01-05');
    expect(line.expiryDate).toBe('2027-01-05');
    expect(line.lotId).toEqual(expect.any(String));

    // And the batch itself is now registered — no separate visit to شاشة الدفعات.
    const registered = await lots(trackedId);
    const lot = registered.find((row) => row.lotNo === 'B-2026-01');
    expect(lot).toBeTruthy();
    expect(lot?.productionDate).toBe('2026-01-05');
    expect(lot?.expiryDate).toBe('2027-01-05');
    expect(lot?.id).toBe(line.lotId);

    // إنتاج ≠ استلام: the production date does not overwrite the day it arrived.
    const receivedAt = lot?.receivedAt ? new Date(lot.receivedAt as string).toISOString().slice(0, 10) : '';
    expect(receivedAt).not.toBe('2026-01-05');
  });

  it('2. سطرٌ يذكر الرقم وحده يُكمل تاريخ الدفعة ولا يمحوه', async () => {
    // A second line for the same batch, this time with only the number — as a clerk
    // reading a second carton would write it.
    const voucher = await receipt([
      { itemId: trackedId, qty: '3', unitCost: '20', batchNo: 'B-2026-01' },
    ]);
    expect(voucher.status).toBe(201);
    const line = (data(voucher.body).lines as Array<Record<string, unknown>>)[0];
    expect(line.lotId).toEqual(expect.any(String));
    expect(line.expiryDate).toBe('2027-01-05');

    // The empty fields did not erase anything…
    const again = (await lots(trackedId)).filter((row) => row.lotNo === 'B-2026-01');
    expect(again.length).toBe(1);
    expect(again[0].expiryDate).toBe('2027-01-05');
    expect(again[0].productionDate).toBe('2026-01-05');

    // …and a missing date is filled in, not left blank forever.
    const filled = await receipt([
      { itemId: trackedId, qty: '1', unitCost: '20', batchNo: 'B-2026-09', productionDate: '2026-09-01' },
    ]);
    expect(filled.status).toBe(201);
    const filledLot = (await lots(trackedId)).find((row) => row.lotNo === 'B-2026-09');
    expect(filledLot?.productionDate).toBe('2026-09-01');
    const filledLine = (data(filled.body).lines as Array<Record<string, unknown>>)[0];
    expect(filledLine.productionDate).toBe('2026-09-01');
  });

  it('3. تاريخٌ مخالف لما هو مسجَّل يُرفض 409 — ولا يكون لدفعةٍ واحدة تاريخان', async () => {
    const clash = await receipt([
      {
        itemId: trackedId,
        qty: '2',
        unitCost: '20',
        batchNo: 'B-2026-01',
        expiryDate: '2028-01-05',
      },
    ]);
    expect(clash.status).toBe(409);
    const body = clash.body as Record<string, unknown>;
    expect(codeOf(body)).toBe('LOT_EXPIRY_MISMATCH');
    // The message names the batch and both dates, so the clerk knows which is which.
    const detail = (body.error as { message?: string } | undefined)?.message ?? (body.detail as string);
    expect(String(detail)).toContain('B-2026-01');
    expect(String(detail)).toContain('2027-01-05');
    expect(String(detail)).toContain('2028-01-05');
    const detailRow = errorsOf(body)[0];
    expect(detailRow?.recorded).toBe('2027-01-05');
    expect(detailRow?.given).toBe('2028-01-05');

    // Nothing was created and nothing was patched by the refused line.
    const unchanged = (await lots(trackedId)).find((row) => row.lotNo === 'B-2026-01');
    expect(unchanged?.expiryDate).toBe('2027-01-05');
  });

  it('4. صنفٌ لا يُتتبَّع بالدفعات ⇒ 422، والرقم لا يُحفظ في العدم', async () => {
    const refused = await receipt([
      { itemId: plainId, qty: '100', unitCost: '1', batchNo: 'N-1', expiryDate: '2027-06-01' },
    ]);
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body as Record<string, unknown>)).toBe('LOT_NOT_TRACKED');
    expect(await lots(plainId)).toEqual([]);

    // …and the same item passes when the line stays silent about batches.
    const plain = await receipt([{ itemId: plainId, qty: '100', unitCost: '1' }]);
    expect(plain.status).toBe(201);
    expect((data(plain.body).lines as Array<Record<string, unknown>>)[0].lotId).toBeNull();
  });

  it('5. lotId صريح يُفحَص على الصنف والمستأجر — لا دفعةَ جاره ولا دفعةَ صنفٍ آخر', async () => {
    const lot = (await lots(trackedId)).find((row) => row.lotNo === 'B-2026-01')!;
    const wrongItem = await receipt([{ itemId: plainId, qty: '1', lotId: lot.id as string }]);
    // plainId does not track batches at all, so the lot cannot belong to it.
    expect([404, 422]).toContain(wrongItem.status);

    const missing = await receipt([
      { itemId: trackedId, qty: '1', unitCost: '20', lotId: '00000000-0000-4000-8000-000000000000' },
    ]);
    expect(missing.status).toBe(404);
    expect(codeOf(missing.body as Record<string, unknown>)).toBe('LOT_NOT_FOUND');

    // Another tenant's lot is not reachable even by id.
    const outsider = await api(ctx.server, 'post', '/api/v1/inventory/lots', {
      token: stranger.token,
      body: { itemId: trackedId, lotNo: 'B-2026-01' },
    });
    void outsider; // the stranger's tenant may not even see our item; what matters is below
    const foreign = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: stranger.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_in',
        reason: 'وارد',
        lines: [{ itemId: trackedId, qty: '1', lotId: lot.id as string }],
      },
    });
    expect([404, 422]).toContain(foreign.status);
  });

  it('6. السطر يُصبح دفعةً مسجَّلة يراها تقرير الصلاحية — لا نصّاً على ورق', async () => {
    // A batch whose expiry falls inside the horizon, named only on the line.
    const soon = await receipt([
      {
        itemId: trackedId,
        qty: '5',
        unitCost: '20',
        batchNo: 'B-SOON',
        expiryDate: '2026-10-01',
      },
    ]);
    expect(soon.status).toBe(201);

    const report = await api(ctx.server, 'get', '/api/v1/inventory/expiry?days=3650', {
      token: actor.token,
    });
    expect(report.status).toBe(200);
    const row = rows(report.body).find((entry) => entry.lotNo === 'B-SOON');
    expect(row).toBeTruthy();
    expect(row?.expiryDate).toBe('2026-10-01');
    expect(row?.itemId).toBe(trackedId);
  });

  it('7. التحويل والجرد يحملان الدفعة كذلك — النقل يستلم ما أُرسل، والجرد يعدّ ما في الرف', async () => {
    const transfer = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: otherWarehouseId,
        lines: [
          { itemId: trackedId, qty: '2', batchNo: 'B-2026-01', productionDate: '2026-01-05' },
        ],
      },
    });
    expect(transfer.status).toBe(201);
    const transferId = data(transfer.body).id as string;
    const fetched = await api(ctx.server, 'get', `/api/v1/inventory/transfers/${transferId}`, {
      token: actor.token,
    });
    const transferLine = (data(fetched.body).lines as Array<Record<string, unknown>>)[0];
    expect(transferLine.batchNo).toBe('B-2026-01');
    // الحقيقة على السطر: تواريخ الدفعة كما هي مسجَّلة، لا كما كُتبت ناقصة.
    expect(transferLine.productionDate).toBe('2026-01-05');
    expect(transferLine.expiryDate).toBe('2027-01-05');

    const adjustment = await api(ctx.server, 'post', '/api/v1/inventory/adjustments', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        reason: 'جرد',
        lines: [{ itemId: trackedId, countedQty: '11', batchNo: 'B-2026-01' }],
      },
    });
    expect(adjustment.status).toBe(201);
    const adjustmentLine = (data(adjustment.body).lines as Array<Record<string, unknown>>)[0];
    expect(adjustmentLine.batchNo).toBe('B-2026-01');
    expect(adjustmentLine.expiryDate).toBe('2027-01-05');
    expect(adjustmentLine.lotId).toBeTruthy();
  });

  it('8. شاشة الدفعات تُنشئ إنتاجاً واستلاماً منفصلين، ولا تخلط العنوانين', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/inventory/lots', {
      token: actor.token,
      body: {
        itemId: trackedId,
        lotNo: 'B-MANUAL',
        productionDate: '2026-02-01',
        expiryDate: '2027-02-01',
        receivedAt: '2026-03-01T00:00:00.000Z',
      },
    });
    expect([200, 201]).toContain(created.status);
    const lot = data(created.body);
    expect(lot.productionDate).toBe('2026-02-01');
    expect(lot.expiryDate).toBe('2027-02-01');
    expect(new Date(lot.receivedAt as string).toISOString().slice(0, 10)).toBe('2026-03-01');
  });
});
