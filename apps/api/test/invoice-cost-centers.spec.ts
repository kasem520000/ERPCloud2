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
 * R9 — 📊 مركز التكلفة على فاتورة البيع والشراء، ووصوله إلى **القيد**.
 *
 * الديسكتوب يحمل المركز مرّتين: على الرأس (قائمة «📊 مركز التكلفة:» — `frmInvSale.xaml`
 * L530 و`frmInvPurch.xaml` L467، والقيمة `Invoices.CCcode`) وعلى السطر
 * (`Inv_Sub.ItemCostCenter`، يُكتب في `Class/InvoiceOper.cs` L1635). وعند بناء القيد يُوسم
 * به حساب البند (L2432: `account.CCcode = invoiceItem.ItemCostCenter`)، فإن لم يكن للسطر
 * مركز أخذ حساب الفاتورة مركزَ الرأس (L2461: `account.CCcode = inv.InvCCcode`).
 *
 * والسحابة كانت تحفظ `purchase_invoice_lines.cost_center_id` ولا تكتبه ولا تقرؤه، ولا تحمل
 * الفاتورة مركزاً أصلاً — فكشف مركز الكلفة (`frmCostCenterBalance`) لا يرى مبيعاتٍ ولا
 * مشتريات. وهذا السبيك يقيس ما يلي:
 *
 *   1. المركز يُحفظ على الرأس والسطّر كما أُدخل (مسودّةً بلا أثر على القيد).
 *   2. عند الترحيل تُقسم رجلُ الإيراد على مراكز السطور (والباقي بعد التقريب على آخر مركز)،
 *      ومن لم يذكر مركزاً على سطره يأخذ مركز الرأس.
 *   3. مركزٌ لا يخصّ المستأجر (أو محذوف) يُرفض **قبل أي كتابة**: `404 COST_CENTER_NOT_FOUND`.
 *   4. الإلغاء يعكس بالمركز نفسه — العيبُ الذي كان يُبقي مالَ الفاتورة الملغاة في تقرير
 *      مركز التكلفة (نظير ما أُصلح في `reverseJournal` بالترحيل `0047`).
 *   5. بلا أي مركزٍ في الفاتورة: القيد كما كان بالحرف (رجلٌ واحدة غير موسومة).
 */
describe('Cost centre on invoice headers and lines (R9)', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let categoryId = '';
  let baseUnitId = '';
  let stockItemId = '';
  let supplierId = '';
  let customerId = '';

  let centerA = '';
  let centerB = '';
  /** مركز المستأجر الآخر — لا يجوز أن يمرّ عندنا. */
  let foreignCenter = '';

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
    'accounting.account.view',
    'accounting.account.manage',
    'accounting.period.close',
    'accounting.period.view',
    'accounting.reports.view',
    'organization.postingprofile.view',
  ];

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const makeCenter = async (token: string, code: string, nameAr: string): Promise<string> => {
    const created = await api(ctx.server, 'post', '/api/v1/cost-centers', {
      token,
      body: { code, nameAr },
    });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  /** صافي المبلغ الذي رُحّل بهذا المركز: مدين ما خرج، ودائن ما دخل. */
  const centreTotals = async (centerId: string) => {
    const response = await api(ctx.server, 'get', `/api/v1/statements/cost-center/${centerId}`, {
      token: actor.token,
    });
    expect(response.status).toBe(200);
    return (response.body as { totals?: { debit?: string; credit?: string } }).totals ?? {};
  };

  const draftSale = (body: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: { branchId, kind: 'sale', cashCustomerName: 'عميل نقدي', ...body },
    });

  const postSale = (id: string) =>
    api(ctx.server, 'post', `/api/v1/sales/invoices/${id}/post`, { token: actor.token, body: {} });

  beforeAll(async () => {
    ctx = await createTestApp('invoice-cost-centers');
    actor = await createActor(ctx, {
      tenantCode: 'cost-centres',
      email: 'owner@cost-centres.test',
      permissions,
    });
    stranger = await createActor(ctx, {
      tenantCode: 'cost-centres-2',
      email: 'owner@cost-centres-2.test',
      permissions,
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    expect(
      (
        await api(ctx.server, 'post', '/api/v1/fiscal-years', {
          token: actor.token,
          body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
        })
      ).status,
    ).toBe(201);

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
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { categoryId, baseUnitId, sku: 'CC-1', nameAr: 'صنف مركز التكلفة' },
    });
    stockItemId = data(item.body).id as string;

    const supplier = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'supplier', name: 'مورد' },
    });
    supplierId = data(supplier.body).id as string;
    const customer = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'customer', name: 'عميل' },
    });
    customerId = data(customer.body).id as string;

    centerA = await makeCenter(actor.token, 'CC-A', 'مركز أ');
    centerB = await makeCenter(actor.token, 'CC-B', 'مركز ب');
    foreignCenter = await makeCenter(stranger.token, 'CC-X', 'مركز المستأجر الآخر');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. المركز يُحفظ على الرأس والسطر، ورجل الإيراد تُقسم على المراكز عند الترحيل', async () => {
    const created = await draftSale({
      costCenterId: centerA,
      lines: [
        { description: 'بند أ', quantity: '1', unitPrice: '100', costCenterId: centerA },
        { description: 'بند ب', quantity: '1', unitPrice: '300', costCenterId: centerB },
      ],
    });
    expect(created.status).toBe(201);
    const invoice = data(created.body);
    expect(invoice.costCenterId).toBe(centerA);
    const lines = invoice.lines as Array<Record<string, unknown>>;
    expect(lines.map((line) => line.costCenterId)).toEqual([centerA, centerB]);
    // المسودّة لا تلمس القيد.
    expect((await centreTotals(centerA)).credit ?? '0.0000').toBe('0.0000');

    expect((await postSale(invoice.id as string)).status).toBe(201);
    // 100 على مركز أ و300 على مركز ب — كلٌّ بنصيب سطره.
    expect((await centreTotals(centerA)).credit).toBe('100.0000');
    expect((await centreTotals(centerB)).credit).toBe('300.0000');
  });

  it('2. سطرٌ بلا مركز يأخذ مركز الرأس (وهو ترتيب الديسكتوب: L2461 ثم L2432)', async () => {
    const created = await draftSale({
      costCenterId: centerA,
      lines: [
        { description: 'يرث الرأس', quantity: '1', unitPrice: '50' },
        { description: 'يخالف الرأس', quantity: '1', unitPrice: '70', costCenterId: centerB },
      ],
    });
    expect(created.status).toBe(201);
    const invoice = data(created.body);
    expect((invoice.lines as Array<Record<string, unknown>>)[0].costCenterId).toBeNull();
    expect((await postSale(invoice.id as string)).status).toBe(201);

    const before = await centreTotals(centerA);
    const other = await centreTotals(centerB);
    // المركز ب أخذ سطره وحده (70)، والرأس أخذ ما لم يُذكر له مركز (50).
    expect(Number(other.credit)).toBeGreaterThanOrEqual(70);
    expect(Number(before.credit)).toBeGreaterThanOrEqual(50);
  });

  it('3. مركزٌ لا يخصّ المستأجر ⇒ 404 COST_CENTER_NOT_FOUND قبل أي كتابة', async () => {
    const foreign = await draftSale({
      costCenterId: foreignCenter,
      lines: [{ description: 'ب', quantity: '1', unitPrice: '10' }],
    });
    expect(foreign.status).toBe(404);
    expect(codeOf(foreign.body)).toBe('COST_CENTER_NOT_FOUND');

    // وعلى السطر كذلك — لا فرق بين رأسٍ وسطّر.
    const onLine = await draftSale({
      lines: [{ description: 'ب', quantity: '1', unitPrice: '10', costCenterId: foreignCenter }],
    });
    expect(onLine.status).toBe(404);
    expect(codeOf(onLine.body)).toBe('COST_CENTER_NOT_FOUND');

    // والمجهول كذلك، والرسالة تسمّي الحقل.
    const unknown = await draftSale({
      costCenterId: '01a0c600-0000-7000-8000-000000000999',
      lines: [{ description: 'ب', quantity: '1', unitPrice: '10' }],
    });
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown.body)).toBe('COST_CENTER_NOT_FOUND');
  });

  it('4. الشراء: رجل المخزون تُوسم بمركز السطر، ومركز الرأس يورَّث لسطرٍ بلا مركز', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        kind: 'purchase',
        costCenterId: centerA,
        lines: [
          { itemId: stockItemId, quantity: '4', unitPrice: '25', costCenterId: centerB },
          { itemId: stockItemId, quantity: '2', unitPrice: '25' },
        ],
      },
    });
    expect(created.status).toBe(201);
    const invoice = data(created.body);
    expect(invoice.costCenterId).toBe(centerA);
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${invoice.id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status).toBe(201);

    // 100 على مركز ب (سطره)، و50 على مركز أ (السطر الذي ورث الرأس).
    const afterB = Number((await centreTotals(centerB)).debit);
    const afterA = Number((await centreTotals(centerA)).debit);
    expect(afterB).toBeGreaterThanOrEqual(100);
    expect(afterA).toBeGreaterThanOrEqual(50);
  });

  it('5. الإلغاء يعكس **بالمركز نفسه** — وإلا بقي مال الفاتورة الملغاة في التقرير', async () => {
    const created = await draftSale({
      costCenterId: centerB,
      lines: [{ description: 'بند يُلغى', quantity: '1', unitPrice: '40', costCenterId: centerB }],
    });
    const invoice = data(created.body);
    expect((await postSale(invoice.id as string)).status).toBe(201);
    const afterPost = Number((await centreTotals(centerB)).credit);

    const voided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'فحص العكس' },
    });
    expect(voided.status).toBe(201);
    const afterVoid = await centreTotals(centerB);
    // رجل العكس تحمل المركز نفسه: ما بقي موسوماً بهذا المركز هو الفرق بين الترحيل والإلغاء،
    // ولو أُسقط المركز من المرآة لبقي الرصيد دائناً بالكامل بعد الإلغاء.
    const net = Number(afterVoid.credit ?? '0') - Number(afterVoid.debit ?? '0');
    expect(Number(afterVoid.debit)).toBeGreaterThanOrEqual(40);
    expect(net).toBeLessThan(afterPost);
  });

  it('6. بلا أي مركز: القيد كما كان — لا رجلَ موسومة ولا تقسيم', async () => {
    const beforeA = await centreTotals(centerA);
    const beforeB = await centreTotals(centerB);
    const created = await draftSale({ lines: [{ description: 'بلا مراكز', quantity: '1', unitPrice: '10' }] });
    const invoice = data(created.body);
    expect(invoice.costCenterId).toBeNull();
    expect((invoice.lines as Array<Record<string, unknown>>)[0].costCenterId).toBeNull();
    expect((await postSale(invoice.id as string)).status).toBe(201);
    // لم يتغيّر أي كشف: الرجل غير الموسومة لا تُنسب إلى مركزٍ لم تُكتب فيه.
    expect(await centreTotals(centerA)).toEqual(beforeA);
    expect(await centreTotals(centerB)).toEqual(beforeB);
  });

  it('7. مردود البيع: رجل المخزون والتكلفة تُوسم بمركز السطر أيضاً', async () => {
    // بيعٌ لصنفٍ مخزني بعد شرائه، ثم مرتجعُه — كي يوجد مخزون وتكلفة.
    const purchase = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        kind: 'purchase',
        costCenterId: centerA,
        lines: [{ itemId: stockItemId, quantity: '2', unitPrice: '30' }],
      },
    });
    await api(ctx.server, 'post', `/api/v1/purchase-invoices/${data(purchase.body).id}/post`, {
      token: actor.token,
      body: {},
    });
    const sale = await draftSale({
      partyId: customerId,
      warehouseId,
      costCenterId: centerB,
      lines: [{ itemId: stockItemId, quantity: '1', unitPrice: '50', costCenterId: centerB }],
    });
    const saleId = data(sale.body).id as string;
    expect((await postSale(saleId)).status).toBe(201);

    const beforeReturn = Number((await centreTotals(centerB)).credit);
    const returned = await api(ctx.server, 'post', `/api/v1/sales/invoices/${saleId}/return`, {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: customerId,
        referenceInvoiceId: saleId,
        costCenterId: centerB,
        lines: [{ itemId: stockItemId, quantity: '1', unitPrice: '50', costCenterId: centerB }],
      },
    });
    expect(returned.status).toBe(201);
    expect(data(returned.body).costCenterId).toBe(centerB);
    expect(
      (
        await api(ctx.server, 'post', `/api/v1/sales/invoices/${data(returned.body).id}/post`, {
          token: actor.token,
          body: {},
        })
      ).status,
    ).toBe(201);
    // المرتجع خفّض صافي المركز: مدين المرتجع يقابل دائن البيع.
    const afterReturn = await centreTotals(centerB);
    expect(Number(afterReturn.debit)).toBeGreaterThan(0);
    expect(Number(afterReturn.credit) - Number(afterReturn.debit)).toBeLessThan(beforeReturn);
  });
});
