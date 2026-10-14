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
 * R8 — الأرقام التسلسلية والدفعات على **سطور فواتير البيع والشراء**.
 *
 * `Class/InvoiceOper.cs:1635` يكتب الأرقام الأربعة على سطر الفاتورة نفسها
 * (`ItemSerialNo`, `BatchNo`, `ItemProductionDate`, `ItemExpireDate`) ويقرؤها عائدةً عند
 * فتح المستند (L3885)؛ ونافذة البيع تبحث بالرقم التسلسلي في رأسها
 * (`frmInvSale.xaml` L592 ← `SearchBySerialNo` L722) وتفتح نافذة الأرقام من قائمة السياق
 * («🔢 الرقم التسلسلي» L679). والسحابة كانت تحسم الأرقام على **المستندات المخزنية** وحدها
 * (§12 و§R5)، وفاتورة البيع لا يقول رقمُها أيَّ قطعةٍ خرجت.
 *
 * القواعد التي يثبّتها هذا السبيك:
 *
 *   1. الأرقام تُحفظ على السطر كما كتبها المُدخِل — في المسودّة بلا لمس المخزون.
 *   2. عند الترحيل: الشراء **يُنشئ** الأرقام والدفعة، والبيع **يصرفها**، والمرتجع
 *      **يُعيدها** إلى الرفّ، والإلغاء يعكس ما فعله الترحيل.
 *   3. عدد الأرقام = عدد القطع، والرقم الواحد مرّةً واحدة، والرقم المجهول أو الذي في
 *      مستودعٍ آخر يُرفض — فالتتبّع لا يُكتب بالتخمين.
 *   4. البحث بالرقم (`GET /inventory/serials/lookup`) يجيب: أيُّ صنفٍ هو، وعلى الرفّ أم
 *      بيع، وفي أي مستنداتٍ سافر — وهو ما كانت خانة الديسكتوب تجيب عنه بحساب حركاته.
 */
describe('Serials and batches on invoice lines (R8)', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let otherWarehouseId = '';
  let categoryId = '';
  let baseUnitId = '';
  let serialItemId = '';
  let lotItemId = '';
  let plainItemId = '';
  let supplierId = '';
  let customerId = '';
  /** فاتورة البيع التي صرفت SN-1 — مصدرُ المرتجع في الاختبار الرابع. */
  let sn1SaleId = '';

  /**
   * نفس الرموز للاثنين: العزل يُقاس بالمستأجر لا بالصلاحية — فلو نقص رمزٌ عند
   * أحدهما لصار الرفض 403 وحُسِب «عزلاً» وهو ليس عزلاً.
   */
  const permissions = [
    ...ALL_PLATFORM_PERMISSIONS,
    ...ALL_ORGANIZATION_PERMISSIONS,
    'catalog.item.view',
    'catalog.item.manage',
    'catalog.category.manage',
    'catalog.unit.manage',
    'parties.view',
    'parties.manage',
    'sales.view',
    'sales.invoice.create',
    'sales.invoice.post',
    'sales.invoice.void',
    'sales.return.create',
    'purchase.view',
    'purchase.invoice.create',
    'purchase.invoice.post',
    'purchase.invoice.void',
    'inventory.view',
    'inventory.adjust',
    'accounting.period.close',
    'accounting.reports.view',
    'accounting.account.view',
    'organization.postingprofile.view',
  ];

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

  /** فاتورة شراء مسودّة — الإدخال الذي يُنشئ الأرقام عند الترحيل. */
  const draftPurchase = (lines: Array<Record<string, unknown>>, warehouse = warehouseId) =>
    api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId: warehouse,
        partyId: supplierId,
        kind: 'purchase',
        lines,
      },
    });

  const postPurchase = (id: string) =>
    api(ctx.server, 'post', `/api/v1/purchase-invoices/${id}/post`, { token: actor.token, body: {} });

  const draftSale = (lines: Array<Record<string, unknown>>, warehouse = warehouseId) =>
    api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId: warehouse,
        partyId: customerId,
        kind: 'sale',
        lines,
      },
    });

  const postSale = (id: string) =>
    api(ctx.server, 'post', `/api/v1/sales/invoices/${id}/post`, { token: actor.token, body: {} });

  /** يشتري قطعتين بالرقمين المدخَلين ويعيد معرّف الفاتورة المُرحَّلة. */
  const stockSerials = async (numbers: string[]): Promise<string> => {
    const created = await draftPurchase([
      {
        itemId: serialItemId,
        quantity: String(numbers.length),
        unitPrice: '100',
        serialNos: numbers,
        batchNo: 'B-100',
        productionDate: '2026-02-01',
        expiryDate: '2027-02-01',
      },
    ]);
    expect(created.status).toBe(201);
    const id = data(created.body).id as string;
    const posted = await postPurchase(id);
    expect(posted.status).toBe(201);
    return id;
  };

  /** رصيد الصنف في المستودع (رقماً، فالجواب يصل نصّاً و'0' ليس '0.0000'). */
  const levelNum = async (itemId: string): Promise<number> => Number(await level(itemId));

  /** خط الدفعة — الكمية على السطر والقيمة الحالية في المخزون. */
  const level = async (itemId: string): Promise<string> => {
    const response = await api(ctx.server, 'get', `/api/v1/inventory/levels?item_id=${itemId}`, {
      token: actor.token,
    });
    expect(response.status).toBe(200);
    const row = rows(response.body).find((entry) => entry.itemId === itemId);
    return String(row?.quantity ?? '0');
  };

  beforeAll(async () => {
    ctx = await createTestApp('invoice-line-numbers');
    actor = await createActor(ctx, {
      tenantCode: 'line-numbers',
      email: 'owner@line-numbers.test',
      permissions,
    });
    stranger = await createActor(ctx, {
      tenantCode: 'line-numbers-2',
      email: 'owner@line-numbers-2.test',
      permissions,
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

    serialItemId = await makeItem({ sku: 'SN-1', nameAr: 'شاشة', trackSerial: true, trackLot: true });
    lotItemId = await makeItem({ sku: 'LOT-9', nameAr: 'لبن', trackLot: true });
    plainItemId = await makeItem({ sku: 'PL-1', nameAr: 'مسامير' });

    const second = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH2', name: 'مستودع ثانٍ' },
    });
    otherWarehouseId = data(second.body).id as string;

    const supplier = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'supplier', name: 'مورد الأجهزة' },
    });
    supplierId = data(supplier.body).id as string;
    const customer = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'customer', name: 'عميل التجزئة' },
    });
    customerId = data(customer.body).id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. مسودّة الشراء تحفظ الأرقام على السطر بلا لمس المخزون ولا الأرقام', async () => {
    const created = await draftPurchase([
      {
        itemId: serialItemId,
        quantity: '2',
        unitPrice: '100',
        serialNos: ['SN-A', 'SN-B'],
        batchNo: 'B-100',
        productionDate: '2026-02-01',
        expiryDate: '2027-02-01',
      },
    ]);
    expect(created.status).toBe(201);
    const line = (data(created.body).lines as Array<Record<string, unknown>>)[0];
    expect(line.serialNos).toEqual(['SN-A', 'SN-B']);
    expect(line.batchNo).toBe('B-100');
    expect(line.productionDate).toBe('2026-02-01');
    // المسودّة لا تُنشئ دفعةً ولا رقماً: الأرقام تُحسم عند الترحيل.
    expect(line.lotId).toBeNull();
    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-A', {
      token: actor.token,
    });
    expect(lookup.status).toBe(200);
    expect(data(lookup.body).found).toBe(false);

    // ولا أثر مخزني: رصيد الصنف صفر.
    expect(await levelNum(serialItemId)).toBe(0);
  });

  it('2. ترحيل الشراء يُنشئ الأرقام والدفعة ويربطهما بسطر الفاتورة', async () => {
    const purchaseId = await stockSerials(['SN-1', 'SN-2']);
    const invoice = await api(ctx.server, 'get', `/api/v1/purchase-invoices/${purchaseId}`, {
      token: actor.token,
    });
    const line = (data(invoice.body).lines as Array<Record<string, unknown>>)[0];
    expect(line.serialNos).toEqual(['SN-1', 'SN-2']);
    expect(line.lotId).toBeTruthy();
    expect(line.batchNo).toBe('B-100');
    expect(await levelNum(serialItemId)).toBe(2);

    // «أين هذا الرقم؟» — جوابٌ من الرابط المحسوم لا من تخمين.
    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-1', {
      token: actor.token,
    });
    expect(lookup.status).toBe(200);
    const found = data(lookup.body);
    expect(found.found).toBe(true);
    expect(found.status).toBe('available');
    expect((found.item as Record<string, unknown>).sku).toBe('SN-1');
    const documents = found.documents as Array<Record<string, unknown>>;
    expect(documents.length).toBe(1);
    expect(documents[0].docType).toBe('purchase_invoice');
    expect(documents[0].docId).toBe(purchaseId);
  });

  it('3. البيع يصرف الأرقام المذكورة على سطوره ويقيّد مسارها', async () => {
    const sale = await draftSale([
      { itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-1'] },
    ]);
    expect(sale.status).toBe(201);
    const saleId = data(sale.body).id as string;
    sn1SaleId = saleId;
    const posted = await postSale(saleId);
    expect(posted.status).toBe(201);

    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-1', {
      token: actor.token,
    });
    const found = data(lookup.body);
    expect(found.status).toBe('sold');
    const types = (found.documents as Array<Record<string, unknown>>).map((row) => row.docType);
    expect(types).toEqual(['purchase_invoice', 'sales_invoice']);
    // القطعة الأخرى بقيت على الرفّ، والرصيد نزل واحداً.
    expect(await levelNum(serialItemId)).toBe(1);

    // والبيع يكتب الدفعة على السطر: الرقم سافر داخل عبوة.
    const invoice = await api(ctx.server, 'get', `/api/v1/sales/invoices/${saleId}`, {
      token: actor.token,
    });
    const line = (data(invoice.body).lines as Array<Record<string, unknown>>)[0];
    expect(line.batchNo).toBe('B-100');
    expect(line.expiryDate).toBe('2027-02-01');
  });

  it('4. المرتجع يُعيد الرقم إلى الرفّ لا يُنشئه من جديد', async () => {
    const sale = await draftSale([
      { itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-2'] },
    ]);
    const saleId = data(sale.body).id as string;
    expect((await postSale(saleId)).status).toBe(201);

    const returned = await api(ctx.server, 'post', `/api/v1/sales/invoices/${saleId}/return`, {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: customerId,
        lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-2'] }],
      },
    });
    expect(returned.status).toBe(201);
    const returnId = data(returned.body).id as string;
    expect((await postSale(returnId)).status).toBe(201);

    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-2', {
      token: actor.token,
    });
    expect(data(lookup.body).status).toBe('available');
    expect(await levelNum(serialItemId)).toBe(1);

    // مرتجعٌ لقطعةٍ **لم تُبع** (على الرفّ) يُرفض بدلالةٍ صريحة: المنشأة تُعيد ما باعته،
    // ولا تُعيد قطعةً لم تخرج. والبوّابة على حالة الرقم لا على نصّه.
    await stockSerials(['SN-8']);
    const wrong = await api(ctx.server, 'post', `/api/v1/sales/invoices/${sn1SaleId}/return`, {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: customerId,
        lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-8'] }],
      },
    });
    expect(wrong.status).toBe(201);
    const wrongPosted = await postSale(data(wrong.body).id as string);
    expect(wrongPosted.status).toBe(422);
    expect(codeOf(wrongPosted.body)).toBe('SERIAL_NOT_RETURNABLE');
    // والقطعة بقيت على الرفّ كما كانت.
    const untouched = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-8', {
      token: actor.token,
    });
    expect(data(untouched.body).status).toBe('available');
  });

  it('5. الإلغاء يعكس الأرقام — قطعة البيع تعود إلى الرفّ', async () => {
    const sale = await draftSale([
      { itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-2'] },
    ]);
    const saleId = data(sale.body).id as string;
    expect((await postSale(saleId)).status).toBe(201);
    let lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-2', {
      token: actor.token,
    });
    expect(data(lookup.body).status).toBe('sold');

    const voided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${saleId}/void`, {
      token: actor.token,
      body: { reason: 'خطأ في الإدخال' },
    });
    expect(voided.status).toBe(201);
    lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-2', {
      token: actor.token,
    });
    const found = data(lookup.body);
    expect(found.status).toBe('available');
    // والرابط يُحذف: لا تتبّعَ معلّقاً إلى مستند ملغى — والمسارات السابقة تبقى.
    const documents = found.documents as Array<Record<string, unknown>>;
    expect(documents.some((row) => row.docId === saleId)).toBe(false);
    expect(documents[0]?.docType).toBe('purchase_invoice');
  });

  it('6. عدد الأرقام = عدد القطع، والرقم الواحد مرّةً واحدة', async () => {
    // المخزون يكفي أولاً: البوّابة الأسبق هي الرصيد، ثم يأتي فحص العدد — فلا يُقاس
    // قانونُ الأرقام على سطرٍ يرفضه المخزون قبل أن يبلغه.
    await stockSerials(['SN-6A', 'SN-6B']);
    const short = await draftSale([
      { itemId: serialItemId, quantity: '2', unitPrice: '200', serialNos: ['SN-2'] },
    ]);
    const shortId = data(short.body).id as string;
    const posted = await postSale(shortId);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body)).toBe('SERIAL_COUNT_MISMATCH');

    // سطرٌ يقول قطعةً واحدة ويكتب الرقم مرّتين: التكرار يُزال فيُسجَّل الرقم مرّة.
    const single = await draftSale([
      { itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-6A', 'SN-6A'] },
    ]);
    const singleId = data(single.body).id as string;
    expect((await postSale(singleId)).status).toBe(201);
    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-6A', {
      token: actor.token,
    });
    expect(data(lookup.body).status).toBe('sold');
  });

  it('7. رقمٌ مجهول أو في مستودعٍ آخر لا يُكتب بالتخمين', async () => {
    await stockSerials(['SN-7']); // المخزون يكفي، فالفحص الذي يفشل هو فحص الرقم
    const unknown = await draftSale([
      { itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-NOPE'] },
    ]);
    const unknownId = data(unknown.body).id as string;
    const missing = await postSale(unknownId);
    expect(missing.status).toBe(422);
    expect(codeOf(missing.body)).toBe('SERIAL_NOT_FOUND');

    // قطعةٌ على الرفّ في مستودعٍ آخر: البيع من هذا المستودع يُرفض بـ`SERIAL_WRONG_WAREHOUSE`.
    const elsewhere = await draftPurchase(
      [{ itemId: serialItemId, quantity: '1', unitPrice: '100', serialNos: ['SN-W2'] }],
      otherWarehouseId,
    );
    const elsewhereId = data(elsewhere.body).id as string;
    expect((await postPurchase(elsewhereId)).status).toBe(201);

    const wrong = await draftSale([
      { itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: ['SN-W2'] },
    ]);
    const wrongId = data(wrong.body).id as string;
    const rejected = await postSale(wrongId);
    expect(rejected.status).toBe(422);
    expect(codeOf(rejected.body)).toBe('SERIAL_WRONG_WAREHOUSE');
  });

  it('8. صنفٌ لا يُتتبَّع بالدفعات لا تُكتب له دفعة (والبحث لا يجده)', async () => {
    const created = await draftPurchase([
      { itemId: plainItemId, quantity: '5', unitPrice: '10', batchNo: 'B-PLAIN' },
    ]);
    const id = data(created.body).id as string;
    const posted = await postPurchase(id);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body)).toBe('LOT_NOT_TRACKED');
    // ورقمٌ لا وجود له: الديسكتوب كان يقول «لا يوجد صنف بهذا الرقم التسلسلي».
    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-A', {
      token: actor.token,
    });
    expect(data(lookup.body).found).toBe(false);
  });

  it('9. عزل المستأجرين: رقم مستأجرٍ آخر ليس رقماً عنده', async () => {
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(stranger.tenantId);
    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: stranger.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    // البحث بالرقم عنده لا يجده: الرقم ملكُ مستأجرٍ آخر.
    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-1', {
      token: stranger.token,
    });
    expect(lookup.status).toBe(200);
    expect(data(lookup.body).found).toBe(false);

    // وعنده صنفُه ودليلُه ورقمُه: مشترياتٌ تنجح… ثم بيعٌ باسم رقمٍ ليس له.
    const otherCategory = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: stranger.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    const otherUnit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: stranger.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    const otherItem = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: stranger.token,
      body: {
        sku: 'OTHER-1',
        nameAr: 'صنف آخر',
        trackSerial: true,
        categoryId: data(otherCategory.body).id,
        baseUnitId: data(otherUnit.body).id,
      },
    });
    const otherItemId = data(otherItem.body).id as string;
    const otherSupplier = await api(ctx.server, 'post', '/api/v1/parties', {
      token: stranger.token,
      body: { kind: 'supplier', name: 'مورد آخر' },
    });
    const receipt = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: stranger.token,
      body: {
        branchId: defaults.branchId,
        warehouseId: defaults.warehouseId,
        partyId: data(otherSupplier.body).id,
        kind: 'purchase',
        lines: [{ itemId: otherItemId, quantity: '1', unitPrice: '50', serialNos: ['OTHER-1'] }],
      },
    });
    expect(receipt.status).toBe(201);
    const receiptPosted = await api(
      ctx.server,
      'post',
      `/api/v1/purchase-invoices/${data(receipt.body).id}/post`,
      { token: stranger.token, body: {} },
    );
    expect(receiptPosted.status).toBe(201);

    // المخزون كافٍ عنده، فالفحص الذي يفشل هو فحص الرقم: «SN-1» ليس من أرقامه.
    const sale = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: stranger.token,
      body: {
        branchId: defaults.branchId,
        warehouseId: defaults.warehouseId,
        kind: 'sale',
        cashCustomerName: 'نقدي',
        lines: [{ itemId: otherItemId, quantity: '1', unitPrice: '70', serialNos: ['SN-1'] }],
      },
    });
    expect(sale.status).toBe(201);
    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${data(sale.body).id}/post`, {
      token: stranger.token,
      body: {},
    });
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body)).toBe('SERIAL_NOT_FOUND');

    // ورقم صاحبنا لم يُمسّ.
    const stillMine = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-1', {
      token: actor.token,
    });
    expect(data(stillMine.body).found).toBe(true);
  });

  it('10. الدفعة تُبحث أو تُنشأ على سطر البيع كذلك', async () => {
    const purchase = await draftPurchase([
      {
        itemId: lotItemId,
        quantity: '10',
        unitPrice: '5',
        batchNo: 'L-2026',
        productionDate: '2026-03-01',
        expiryDate: '2026-12-31',
      },
    ]);
    const purchaseId = data(purchase.body).id as string;
    expect((await postPurchase(purchaseId)).status).toBe(201);

    // سطرُ بيعٍ يذكر الرقم بلا تواريخ: يأخذ تواريخ الدفعة المسجَّلة كما هي.
    const sale = await draftSale([{ itemId: lotItemId, quantity: '2', unitPrice: '9', batchNo: 'L-2026' }]);
    const saleId = data(sale.body).id as string;
    expect((await postSale(saleId)).status).toBe(201);
    const invoice = await api(ctx.server, 'get', `/api/v1/sales/invoices/${saleId}`, {
      token: actor.token,
    });
    const line = (data(invoice.body).lines as Array<Record<string, unknown>>)[0];
    expect(line.lotId).toBeTruthy();
    expect(line.productionDate).toBe('2026-03-01');
    expect(line.expiryDate).toBe('2026-12-31');
  });

  it('11. مردود الشراء يأخذ الرقم خارج الرفّ', async () => {
    const purchase = await draftPurchase([
      { itemId: serialItemId, quantity: '1', unitPrice: '100', serialNos: ['SN-R1'] },
    ]);
    const purchaseId = data(purchase.body).id as string;
    expect((await postPurchase(purchaseId)).status).toBe(201);

    const returned = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        referenceInvoiceId: purchaseId,
        kind: 'purchase_return',
        lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '100', serialNos: ['SN-R1'] }],
      },
    });
    expect(returned.status).toBe(201);
    const returnId = data(returned.body).id as string;
    expect((await postPurchase(returnId)).status).toBe(201);

    const lookup = await api(ctx.server, 'get', '/api/v1/inventory/serials/lookup?serialNo=SN-R1', {
      token: actor.token,
    });
    const found = data(lookup.body);
    expect(found.status).toBe('sold');
    const types = (found.documents as Array<Record<string, unknown>>).map((row) => row.docType);
    expect(types).toEqual(['purchase_invoice', 'purchase_return']);
  });
});
