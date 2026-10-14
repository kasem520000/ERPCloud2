import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part two — 📦 تقارير الأصناف: four تجميعي windows.
 *
 *   `frmRptItemsSalesDetails.xaml`      «مبيعات الأصناف تجميعي»        → items-sales-summary
 *                                       «مشتريات الأصناف تجميعي»      → items-purchases-summary
 *                                       (`OperType = 2`, the very same window)
 *   `frmRptItemsSalesDetailsPOS.xaml`   «مبيعات الأصناف تجميعي - نقطة البيع»
 *                                                                     → items-pos-sales-summary
 *   `frmRptItemsProfit.xaml`            «أرباح المواد تجميعي»         → items-profit-summary
 *
 * The rules the cloud has to keep:
 *   - `ShowResults()` — netQty = saleVal − retSaleVal + posVal − posRetVal for مبيعات and
 *     purchVal − rePurchVal for مشتريات, with the same four directions in the amounts.
 *   - `if (!hasMovement) continue;` (L282 / L223 / L220) — an صنف with no حركة at all is not
 *     a row; note this is *any* movement, not a non-zero net, which is why the reports keep
 *     `HAVING sum(line.quantity) <> 0` instead of the net test «حركة المبيعات» uses.
 *   - `frmRptItemsProfit.GetSaleData` — the header discount is distributed over the lines:
 *     `ItemPriceWithoutVAT * minus / NULLIF(InvSum,0)`. The cloud distributes it at save
 *     time instead (`calculateInvoiceTotals` spreads `invoiceDiscount` pro-rata by gross
 *     into every `line.net`), so the report reads `line.net` as it stands.
 *   - «نسبة الربح» = (صافي البيع − التكلفة) ÷ التكلفة × 100, and «0%» when the cost is zero.
 */
describe('التقارير — frmRptItems* · تقارير الأصناف التجميعية', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let mainWarehouseName = '';
  let seaWarehouseId = '';
  let catGearId = '';
  let catRigId = '';

  // 📦 أربعة أصناف مباعة وصنفٌ لم يتحرك — `if (!hasMovement) continue;`
  let fuelId = '';
  let jacketId = '';
  let ropeId = '';
  let anchorId = '';
  let buoyId = '';
  let customerId = '';
  let supplierId = '';

  const today = new Date();
  const iso = (offsetDays: number) => {
    const date = new Date(today.getTime() + offsetDays * 86_400_000);
    return date.toISOString().slice(0, 10);
  };
  const from = iso(-1);
  const to = iso(1);

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });

  /** Runs one of the four reports over the period the desktop opens with (today ± margin). */
  const runReport = (key: string, query = '', token = actor.token) =>
    get(`/reports/${key}?from=${from}&to=${to}${query}`, token);
  /** The 💰 card of a run, by the column it sums. */
  const cardOf = (body: unknown, key: string): string => {
    const cards = (data(body as Record<string, unknown>) as { grandTotal: Array<{ key: string; amount: string }> }).grandTotal;
    return cards.find((card) => card.key === key)?.amount ?? '0';
  };
  /** Rows keyed by «الصنف», the way the desktop's grid is read top to bottom. */
  const byItem = (body: unknown): Map<string, Record<string, string>> =>
    new Map((((data(body as Record<string, unknown>) as { rows: Array<Record<string, string>> }).rows) ?? []).map((row) => [row.item_name, row]));

  beforeAll(async () => {
    ctx = await createTestApp('report-items-summary');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-items',
      email: 'owner@rpt-items.test',
      fullName: 'مستخدم التقارير',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.return.create',
        'purchase.view',
        'purchase.invoice.create',
        'purchase.invoice.post',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'accounting.account.view',
        'organization.postingprofile.view',
        'reporting.view',
        'reporting.export.execute',
      ],
    });
    // 👁️ A second person in the same tenant who may read reports and nothing else.
    viewer = await createActor(ctx, {
      tenantCode: 'rpt-items',
      email: 'viewer@rpt-items.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-items-2',
      email: 'owner@rpt-items-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;
    // 🏭 «المستودع» في «أرباح المواد تفصيلي» يُقرأ من اسم المستودع لا من معرّفه.
    const warehouseList = rowsOf((await get('/warehouses')).body) as Array<{ id: string; name: string }>;
    mainWarehouseName = warehouseList.find((row) => row.id === warehouseId)?.name ?? '';

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    // 🏪 Two مستودعات, so the «🏪 المستودع» filter has something to separate.
    const sea = await post('/warehouses', { branchId, code: 'SEA', name: 'مستودع البحر' });
    expect(sea.status).toBe(201);
    seaWarehouseId = data(sea.body).id as string;

    const category = async (code: string, nameAr: string) => {
      const created = await post('/organization/catalog/categories', { code, nameAr });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    catGearId = await category('GEAR', 'معدات');
    catRigId = await category('RIG', 'تجهيزات');

    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    const unitId = data(unit.body).id as string;

    const item = async (sku: string, nameAr: string, categoryId: string) => {
      const created = await post('/organization/catalog/items', {
        sku,
        nameAr,
        categoryId,
        baseUnitId: unitId,
        kind: 'stock',
        salePrice: '100.0000',
        purchasePrice: '60.0000',
      });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    fuelId = await item('IS-FUEL', 'وقود', catGearId);
    jacketId = await item('IS-JACKET', 'سترة نجاة', catGearId);
    // 📦 An صنف that never moves: `if (!hasMovement) continue;` keeps it out.
    ropeId = await item('IS-ROPE', 'حبل', catRigId);
    anchorId = await item('IS-ANCHOR', 'مرساة', catRigId);
    buoyId = await item('IS-BUOY', 'طوق نجاة', catRigId);

    // 📚 «متوسط التكلفة» — every صنف opens at 40 a وحدة, so the profit is predictable.
    const stock = await post('/inventory/ledger/record', {
      lines: [
        ...[fuelId, jacketId, ropeId, buoyId].map((itemId, index) => ({
          itemId,
          warehouseId,
          qty: '100',
          unitCost: '40',
          direction: 'in',
          docType: 'opening',
          docId: `00000000-0000-0000-0000-00000000000${index + 1}`,
        })),
        {
          itemId: anchorId,
          warehouseId: seaWarehouseId,
          qty: '100',
          unitCost: '40',
          direction: 'in',
          docType: 'opening',
          docId: '00000000-0000-0000-0000-000000000010',
        },
      ],
    });
    expect(stock.status).toBe(201);

    const customer = await post('/parties', { kind: 'customer', name: 'عميل التقرير' });
    customerId = data(customer.body).id as string;
    const supplier = await post('/parties', { kind: 'supplier', name: 'مورد التقرير' });
    supplierId = data(supplier.body).id as string;
  }, 240_000);

  afterAll(async () => ctx.close());

  /** Creates a بيع or a مرتجع and posts it; only posted documents reach a report. */
  const createSale = async (body: Record<string, unknown>) => {
    const created = await post('/sales/invoices', { branchId, warehouseId, ...body });
    expect(created.status).toBe(201);
    const id = data(created.body).id as string;
    const posted = await post(`/sales/invoices/${id}/post`, {});
    expect(posted.status).toBe(201);
    return data(posted.body) as { id: string; number: string };
  };
  const createPurchase = async (body: Record<string, unknown>) => {
    const created = await post('/purchase-invoices', { branchId, warehouseId, partyId: supplierId, ...body });
    expect(created.status).toBe(201);
    const id = data(created.body).id as string;
    const posted = await post(`/purchase-invoices/${id}/post`, {});
    expect(posted.status).toBe(201);
    return data(posted.body) as { id: string; number: string };
  };

  const seed = async () => {
    if (seeded) return;
    seeded = true;
    // 🧾 بيع عادي — صنفان بمستودع المتجر.
    await createSale({
      partyId: customerId,
      lines: [
        { itemId: fuelId, quantity: '10', unitPrice: '100', taxRate: '15' },
        { itemId: jacketId, quantity: '3', unitPrice: '50', taxRate: '15' },
      ],
    }).then((invoice) => {
      saleInvoiceId = invoice.id;
    });
    // ↩️ مرتجع — وحدتان من الوقود تعودان إلى الفاتورة نفسها (`proc_type = 2`).
    const draft = await post(`/sales/invoices/${saleInvoiceId}/return`, {
      branchId,
      warehouseId,
      lines: [{ itemId: fuelId, quantity: '2', unitPrice: '100', taxRate: '15' }],
    });
    expect(draft.status).toBe(201);
    const returned = await post(`/sales/invoices/${data(draft.body).id as string}/post`, {});
    expect(returned.status).toBe(201);
    // 🧾 نقطة البيع — بلا عميل: `si.party_id IS NULL`.
    await createSale({ cashCustomerName: 'عميل نقدي', lines: [{ itemId: jacketId, quantity: '1', unitPrice: '50', taxRate: '15' }] });
    // 🏪 مستودع البحر وحده — the row the «🏪 المستودع» filter isolates.
    await createSale({
      partyId: customerId,
      warehouseId: seaWarehouseId,
      lines: [{ itemId: anchorId, quantity: '4', unitPrice: '200', taxRate: '15' }],
    });
    // ✂️ خصم رأس الفاتورة — 50 of 500, distributed over the only line.
    await createSale({
      partyId: customerId,
      invoiceDiscount: '50',
      lines: [{ itemId: buoyId, quantity: '5', unitPrice: '100', taxRate: '15' }],
    });
    // 📥 شراء ومردود شراء — `OperType = 2` in the same window.
    await createPurchase({ lines: [{ itemId: fuelId, quantity: '20', unitPrice: '60', taxRate: '15' }] });
    await createPurchase({ kind: 'purchase_return', lines: [{ itemId: fuelId, quantity: '5', unitPrice: '60', taxRate: '15' }] });
  };
  let seeded = false;
  let saleInvoiceId = '';

  it('registers the four windows with the desktop’s own columns, filters and 💰 cards', async () => {
    const catalog = await get('/reports');
    expect(catalog.status).toBe(200);
    const entries = rowsOf(catalog.body) as Array<{
      key: string;
      titleAr: string;
      group: string;
      params: Array<{ name: string; labelAr: string }>;
      columns: Array<{ key: string; labelAr: string }>;
      grandTotal: string[];
      grandTotalCards: Array<{ key: string; labelAr: string }>;
    }>;
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));

    // 📦 مبيعات الأصناف تجميعي — `frmRptItemsSalesDetails.xaml` (OperType = 1)
    const sales = byKey.get('items-sales-summary')!;
    expect(sales.titleAr).toBe('مبيعات الأصناف تجميعي');
    expect(sales.columns.map((column) => column.labelAr)).toEqual(['رمز الصنف', 'الصنف', 'المجموعة', 'الكمية', 'صافي البيع']);
    expect(sales.params.map((param) => param.labelAr)).toEqual([
      'المستودع',
      'المجموعة',
      'الصنف',
      'الفرع',
      'من تاريخ',
      'وقت البدء (HH:mm)',
      'إلى تاريخ',
      'وقت الانتهاء (HH:mm)',
    ]);
    // 💵 «إجمالي صافي البيع» · 📦 «إجمالي الكميات» — `UpdateSummary()` in the same file.
    expect(sales.grandTotal).toEqual(['إجمالي صافي البيع', 'إجمالي الكميات']);
    expect(sales.grandTotalCards).toEqual([
      { key: 'net_sales', labelAr: 'إجمالي صافي البيع' },
      { key: 'quantity', labelAr: 'إجمالي الكميات' },
    ]);

    // 🧾 مبيعات الأصناف تجميعي - نقطة البيع — `frmRptItemsSalesDetailsPOS.xaml`
    const pos = byKey.get('items-pos-sales-summary')!;
    expect(pos.titleAr).toBe('مبيعات الأصناف تجميعي - نقطة البيع');
    expect(pos.columns.map((column) => column.labelAr)).toEqual(['رمز الصنف', 'الصنف', 'المجموعة', 'الكمية', 'صافي البيع']);
    // 👤 المستخدم (مؤجَّل) و📅 الفترة الزمنية — that panel has no مستودع ولا مجموعة ولا فرع.
    expect(pos.params.map((param) => param.labelAr)).toEqual([
      'من تاريخ',
      'وقت البدء (HH:mm)',
      'إلى تاريخ',
      'وقت الانتهاء (HH:mm)',
    ]);

    // 💰 أرباح المواد تجميعي — `frmRptItemsProfit.xaml`
    const profit = byKey.get('items-profit-summary')!;
    expect(profit.titleAr).toBe('أرباح المواد تجميعي');
    expect(profit.columns.map((column) => column.labelAr)).toEqual([
      'رمز المادة',
      'المادة',
      'الكمية',
      'متوسط التكلفة',
      'صافي البيع',
      'الربح',
      'نسبة الربح',
    ]);
    // 📅 «من / حتى» — that window has no time box and no فرع box.
    expect(profit.params.map((param) => param.labelAr)).toEqual(['المستودع', 'المجموعة', 'الصنف', 'من', 'حتى']);
    expect(profit.grandTotal).toEqual(['إجمالي صافي البيع', 'إجمالي الربح']);

    // 📥 مشتريات الأصناف تجميعي — the same window with `OperType = 2`
    const purchases = byKey.get('items-purchases-summary')!;
    expect(purchases.titleAr).toBe('مشتريات الأصناف تجميعي');
    expect(purchases.group).toBe('purchases');
    expect(purchases.columns.map((column) => column.labelAr)).toEqual(['رمز الصنف', 'الصنف', 'المجموعة', 'الكمية', 'صافي الشراء']);
    expect(purchases.grandTotal).toEqual(['إجمالي صافي الشراء', 'إجمالي الكميات']);
  });

  it('جمع «مبيعات الأصناف تجميعي» كل صنفٍ صافياً من مردوداته، وترك ما لم يتحرك', async () => {
    await seed();
    const run = await runReport('items-sales-summary');
    expect(run.status).toBe(200);
    const rows = byItem(run.body);

    // وقود: 10 − 2 = 8 · (1000+150) − 230 = 920
    expect(Number(rows.get('وقود')?.quantity)).toBeCloseTo(8, 4);
    expect(Number(rows.get('وقود')?.net_sales)).toBeCloseTo(920, 2);
    expect(rows.get('وقود')?.category).toBe('معدات');
    // سترة نجاة: 3 من الفاتورة + 1 من نقطة البيع = 4 · 172.5 + 57.5 = 230
    expect(Number(rows.get('سترة نجاة')?.quantity)).toBeCloseTo(4, 4);
    expect(Number(rows.get('سترة نجاة')?.net_sales)).toBeCloseTo(230, 2);
    // مرساة — من مستودع البحر، والتقرير يجمع كل المستودعات حين لا يُحدَّد واحد.
    expect(Number(rows.get('مرساة')?.quantity)).toBeCloseTo(4, 4);
    expect(Number(rows.get('مرساة')?.net_sales)).toBeCloseTo(920, 2);
    // طوق نجاة: (500 − 50 خصم رأس) × 1.15 = 517.50 — «صافي البيع» يحمل الضريبة كما في
    // `RptItemsSalesDetails.repx`، وخصم الرأس موزَّعٌ على السطر أصلاً.
    expect(Number(rows.get('طوق نجاة')?.quantity)).toBeCloseTo(5, 4);
    expect(Number(rows.get('طوق نجاة')?.net_sales)).toBeCloseTo(517.5, 2);
    // حبل — «لا حركة → تجاهل»
    expect(rows.has('حبل')).toBe(false);

    // 💵 إجمالي صافي البيع · 📦 إجمالي الكميات
    expect(Number(cardOf(run.body, 'net_sales'))).toBeCloseTo(2587.5, 2);
    expect(Number(cardOf(run.body, 'quantity'))).toBeCloseTo(21, 4);
  });

  it('🏪🏗️📦 فلاتر «المستودع · المجموعة · الصنف» تضيّق التقرير إلى ما طُلب وحده', async () => {
    await seed();
    const inSea = await runReport('items-sales-summary', `&warehouseId=${seaWarehouseId}`);
    const seaRows = byItem(inSea.body);
    expect([...seaRows.keys()]).toEqual(['مرساة']);
    expect(Number(cardOf(inSea.body, 'net_sales'))).toBeCloseTo(920, 2);

    const rig = await runReport('items-sales-summary', `&categoryId=${catRigId}`);
    expect([...byItem(rig.body).keys()].sort()).toEqual(['طوق نجاة', 'مرساة']);

    const one = await runReport('items-sales-summary', `&itemId=${fuelId}`);
    const oneRows = byItem(one.body);
    expect([...oneRows.keys()]).toEqual(['وقود']);
    expect(oneRows.get('وقود')?.item_code).toBe('IS-FUEL');
  });

  it('🧾 «نقطة البيع» جمعت فواتير نقطة البيع وحدها (`PosVal − PosRetVal`)', async () => {
    await seed();
    const run = await runReport('items-pos-sales-summary');
    expect(run.status).toBe(200);
    const rows = byItem(run.body);
    // The بيع العادي, the مرتجع and the فاتورة مستودع البحر all carry a عميل, so only the
    // cash sale is left: 1 × 50 × 1.15 = 57.50.
    expect([...rows.keys()]).toEqual(['سترة نجاة']);
    expect(Number(rows.get('سترة نجاة')?.quantity)).toBeCloseTo(1, 4);
    expect(Number(rows.get('سترة نجاة')?.net_sales)).toBeCloseTo(57.5, 2);
    expect(Number(cardOf(run.body, 'net_sales'))).toBeCloseTo(57.5, 2);
    expect(Number(cardOf(run.body, 'quantity'))).toBeCloseTo(1, 4);
  });

  it('💰 «أرباح المواد تجميعي» وزّع خصم رأس الفاتورة وحسب الربح ونسبته', async () => {
    await seed();
    const run = await runReport('items-profit-summary');
    expect(run.status).toBe(200);
    const rows = byItem(run.body);

    // وقود: صافي البيع 1000 − 200 = 800 · التكلفة 10×40 − 2×40 = 320 · الربح 480 · 150%
    expect(Number(rows.get('وقود')?.quantity)).toBeCloseTo(8, 4);
    expect(Number(rows.get('وقود')?.total_cost)).toBeCloseTo(320, 2);
    expect(Number(rows.get('وقود')?.net_sales)).toBeCloseTo(800, 2);
    expect(Number(rows.get('وقود')?.profit)).toBeCloseTo(480, 2);
    expect(Number(rows.get('وقود')?.profit_ratio)).toBeCloseTo(150, 2);

    // سترة نجاة: 150 + 50 = 200 · التكلفة 160 · الربح 40 · 25%
    expect(Number(rows.get('سترة نجاة')?.net_sales)).toBeCloseTo(200, 2);
    expect(Number(rows.get('سترة نجاة')?.total_cost)).toBeCloseTo(160, 2);
    expect(Number(rows.get('سترة نجاة')?.profit)).toBeCloseTo(40, 2);
    expect(Number(rows.get('سترة نجاة')?.profit_ratio)).toBeCloseTo(25, 2);

    // مرساة: 800 · التكلفة 160 · الربح 640 · 400%
    expect(Number(rows.get('مرساة')?.profit)).toBeCloseTo(640, 2);
    expect(Number(rows.get('مرساة')?.profit_ratio)).toBeCloseTo(400, 2);

    // طوق نجاة: 500 ناقص نصيبه من خصم الرأس (500 × 50 ÷ 500 = 50) ⇒ 450 ·
    // التكلفة 5×40 = 200 · الربح 250 · 125%
    expect(Number(rows.get('طوق نجاة')?.net_sales)).toBeCloseTo(450, 2);
    expect(Number(rows.get('طوق نجاة')?.total_cost)).toBeCloseTo(200, 2);
    expect(Number(rows.get('طوق نجاة')?.profit)).toBeCloseTo(250, 2);
    expect(Number(rows.get('طوق نجاة')?.profit_ratio)).toBeCloseTo(125, 2);

    // حبل — «تجاهل الصنف إذا لم تكن له حركة»
    expect(rows.has('حبل')).toBe(false);

    // 💵 إجمالي صافي البيع · 💰 إجمالي الربح
    expect(Number(cardOf(run.body, 'net_sales'))).toBeCloseTo(2250, 2);
    expect(Number(cardOf(run.body, 'profit'))).toBeCloseTo(1410, 2);
  });

  it('📥 «مشتريات الأصناف تجميعي» طرح مردود الشراء من الشراء (`PurchVal − RePurchVal`)', async () => {
    await seed();
    const run = await runReport('items-purchases-summary');
    expect(run.status).toBe(200);
    const rows = byItem(run.body);
    // وقود: 20 − 5 = 15 · (20×60×1.15) − (5×60×1.15) = 1380 − 345 = 1035
    expect([...rows.keys()]).toEqual(['وقود']);
    expect(Number(rows.get('وقود')?.quantity)).toBeCloseTo(15, 4);
    expect(Number(rows.get('وقود')?.net_purchases)).toBeCloseTo(1035, 2);
    expect(Number(cardOf(run.body, 'net_purchases'))).toBeCloseTo(1035, 2);
    expect(Number(cardOf(run.body, 'quantity'))).toBeCloseTo(15, 4);
  });

  it('📅 فترةٌ بلا حركة تعطي جدولاً فارغاً وبطاقتي صفر', async () => {
    const run = await get('/reports/items-sales-summary?from=2001-01-01&to=2001-01-31');
    expect(run.status).toBe(200);
    const body = data(run.body) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
    expect(Number(cardOf(run.body, 'net_sales'))).toBe(0);
    expect(Number(cardOf(run.body, 'quantity'))).toBe(0);
  });

  it('🖨️ طباعة — البطاقتان «إجمالي صافي البيع» و«إجمالي الكميات» في شريطٍ واحد', async () => {
    await seed();
    const printed = await get(`/reports/print/items-sales-summary?from=${from}&to=${to}`);
    expect(printed.status).toBe(200);
    const html = (printed.body as { html: string }).html;
    expect(html).toContain('مبيعات الأصناف تجميعي');
    expect(html).toContain('رمز الصنف');
    expect(html).toContain('المجموعة');
    expect(html).toContain('إجمالي صافي البيع');
    expect(html).toContain('إجمالي الكميات');
    expect(html).toContain('المستخدم: مستخدم التقارير');
    // أعده · راجعه · المدير — `footer.repx` inside `RptItemsSalesDetails.repx`.
    expect(html).toContain('أعده');
    expect(html).toContain('راجعه');
    expect(html).toContain('المدير');
  });

  it('📊 تصدير CSV — الأعمدة الخمسة كما يعرضها الجدول', async () => {
    await seed();
    const exported = await api(ctx.server, 'post', `/api/v1/reports/items-sales-summary/export?from=${from}&to=${to}`, {
      token: actor.token,
      body: { format: 'csv' },
    });
    expect(exported.status).toBe(201);
    const payload = data(exported.body) as { content: string; filename: string };
    expect(payload.filename).toContain('.csv');
    const [header, ...lines] = payload.content.replace(/^\uFEFF/, '').trim().split('\n');
    expect(header).toContain('رمز الصنف');
    expect(header).toContain('صافي البيع');
    expect(lines).toHaveLength(4); // وقود · سترة نجاة · مرساة · طوق نجاة — لا حبل
  });

  it('💰 «أرباح المواد تفصيلي» — سطرٌ لكل حركة بتكلفتها وسعرها وخصمها وربحها', async () => {
    await seed();
    const run = await runReport('items-profit-details');
    expect(run.status).toBe(200);
    const rows = (data(run.body) as { rows: Array<Record<string, string>> }).rows;
    // ستة أسطر: وقود · سترة في البيع، ووقود في المرتجع، وسترة في نقطة البيع،
    // ومرساة من مستودع البحر، وطوق نجاة بخصم رأس.
    expect(rows).toHaveLength(6);
    const fuel = rows.filter((row) => row.item_name === 'وقود');
    expect(fuel).toHaveLength(2);
    const sold = fuel.find((row) => Number(row.quantity) > 0)!;
    expect(Number(sold.quantity)).toBeCloseTo(10, 4);
    expect(Number(sold.unit_price)).toBeCloseTo(100, 2);
    expect(Number(sold.gross)).toBeCloseTo(1000, 2); // المجموع
    expect(Number(sold.net)).toBeCloseTo(1000, 2); // الإجمالي
    expect(Number(sold.discount)).toBeCloseTo(0, 2);
    expect(Number(sold.unit_cost)).toBeCloseTo(40, 2); // متوسط التكلفة
    expect(Number(sold.total_cost)).toBeCloseTo(400, 2); // إجمالي التكلفة
    expect(Number(sold.profit)).toBeCloseTo(600, 2);
    expect(Number(sold.profit_ratio)).toBeCloseTo(150, 2);
    expect(sold.operation).toBe('بيع');
    expect(sold.unit).toBe('حبة');
    expect(sold.warehouse).toBe(mainWarehouseName);

    const returned = fuel.find((row) => Number(row.quantity) < 0)!;
    expect(Number(returned.quantity)).toBeCloseTo(-2, 4);
    expect(Number(returned.total_cost)).toBeCloseTo(-80, 2);
    expect(returned.operation).toBe('مرتجع');

    // ✂️ خصم رأس الفاتورة: المجموع 500، الإجمالي 450، الخصم 50.
    const buoy = rows.find((row) => row.item_name === 'طوق نجاة')!;
    expect(Number(buoy.gross)).toBeCloseTo(500, 2);
    expect(Number(buoy.net)).toBeCloseTo(450, 2);
    expect(Number(buoy.discount)).toBeCloseTo(50, 2);
    expect(Number(buoy.profit)).toBeCloseTo(250, 2);

    // 🏪 المستودع — مرساة وحدها من مستودع البحر.
    const inSea = (data((await runReport('items-profit-details', `&warehouseId=${seaWarehouseId}`)).body) as { rows: Array<Record<string, string>> }).rows;
    expect(inSea.map((row) => row.item_name)).toEqual(['مرساة']);

    // 📊 ملخص الأرباح — إجمالي التكلفة · المجموع · الإجمالي · الخصم · إجمالي الربح
    expect(Number(cardOf(run.body, 'total_cost'))).toBeCloseTo(840, 2);
    expect(Number(cardOf(run.body, 'gross'))).toBeCloseTo(2300, 2);
    expect(Number(cardOf(run.body, 'net'))).toBeCloseTo(2250, 2);
    expect(Number(cardOf(run.body, 'discount'))).toBeCloseTo(50, 2);
    expect(Number(cardOf(run.body, 'profit'))).toBeCloseTo(1410, 2);
  });

  it('🗂️ «تقرير مبيعات الأصناف حسب المجموعة» — كل صنفٍ تحت مجموعته بمجاميعه الأربعة', async () => {
    await seed();
    const run = await runReport('items-sales-by-category');
    expect(run.status).toBe(200);
    const rows = byItem(run.body);

    // وقود: الإجمالي 800 (بلا ضريبة) · الضريبة 120 · الصافي 920 · الخصم 0
    expect(Number(rows.get('وقود')?.quantity)).toBeCloseTo(8, 4);
    expect(Number(rows.get('وقود')?.total)).toBeCloseTo(800, 2);
    expect(Number(rows.get('وقود')?.tax)).toBeCloseTo(120, 2);
    expect(Number(rows.get('وقود')?.net)).toBeCloseTo(920, 2);
    expect(rows.get('وقود')?.category).toBe('معدات');
    // طوق نجاة: الإجمالي 450 · الضريبة 67.50 · الصافي 517.50 · الخصم 50
    expect(Number(rows.get('طوق نجاة')?.total)).toBeCloseTo(450, 2);
    expect(Number(rows.get('طوق نجاة')?.tax)).toBeCloseTo(67.5, 2);
    expect(Number(rows.get('طوق نجاة')?.net)).toBeCloseTo(517.5, 2);
    expect(Number(rows.get('طوق نجاة')?.discount)).toBeCloseTo(50, 2);
    expect(rows.get('طوق نجاة')?.category).toBe('تجهيزات');
    expect(rows.has('حبل')).toBe(false);

    // 🏷️ البطاقات الأربع — إجمالي الكمية · الإجمالي · الضريبة · الصافي
    expect(Number(cardOf(run.body, 'quantity'))).toBeCloseTo(21, 4);
    expect(Number(cardOf(run.body, 'total'))).toBeCloseTo(2250, 2);
    expect(Number(cardOf(run.body, 'tax'))).toBeCloseTo(337.5, 2);
    expect(Number(cardOf(run.body, 'net'))).toBeCloseTo(2587.5, 2);

    // 📄 نوع الفاتورة — «مبيعات» تترك فاتورة نقطة البيع، و«نقطة بيع» لا تُبقي سواها.
    const saleOnly = await runReport('items-sales-by-category', '&invType=sale');
    expect(Number(byItem(saleOnly.body).get('سترة نجاة')?.quantity)).toBeCloseTo(3, 4);
    expect(Number(cardOf(saleOnly.body, 'net'))).toBeCloseTo(2530, 2);
    const posOnly = await runReport('items-sales-by-category', '&invType=pos');
    expect([...byItem(posOnly.body).keys()]).toEqual(['سترة نجاة']);
    expect(Number(cardOf(posOnly.body, 'net'))).toBeCloseTo(57.5, 2);
  });

  it('📅 «تقرير المبيعات اليومية للمجموعة» — كل مجموعةٍ في يومٍ باسم اليوم', async () => {
    await seed();
    const run = await get(`/reports/category-sales-by-day?from=${from}&to=${to}`);
    expect(run.status).toBe(200);
    const rows = (data(run.body) as { rows: Array<Record<string, string>> }).rows;
    // مجموعتان في اليوم نفسه: معدات (وقود + سترة) وتجهيزات (مرساة + طوق نجاة).
    expect(rows).toHaveLength(2);
    const gear = rows.find((row) => row.category === 'معدات')!;
    const rig = rows.find((row) => row.category === 'تجهيزات')!;
    expect(Number(gear.total)).toBeCloseTo(1150, 2);
    expect(Number(rig.total)).toBeCloseTo(1437.5, 2);
    expect(gear.day_name).toMatch(/^(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت)$/);
    expect(gear.day).toBe(today.toISOString().slice(0, 10));
    expect(gear.category_code).toBe('GEAR');
    // 💰 «إجمالي المبيعات:»
    expect(Number(cardOf(run.body, 'total'))).toBeCloseTo(2587.5, 2);

    // 📄 «فاتورة نقطة البيع» — سترة نقطة البيع وحدها.
    const posOnly = await get(`/reports/category-sales-by-day?from=${from}&to=${to}&invType=pos`);
    const posRows = (data(posOnly.body) as { rows: Array<Record<string, string>> }).rows;
    expect(posRows).toHaveLength(1);
    expect(Number(posRows[0]?.total)).toBeCloseTo(57.5, 2);
    // 🗂️ المجموعة — «تجهيزات» وحدها.
    const rigOnly = await get(`/reports/category-sales-by-day?from=${from}&to=${to}&categoryId=${catRigId}`);
    const rigRows = (data(rigOnly.body) as { rows: Array<Record<string, string>> }).rows;
    expect(rigRows).toHaveLength(1);
    expect(Number(cardOf(rigOnly.body, 'total'))).toBeCloseTo(1437.5, 2);
  });

  it('👁️ reporting.view reads the reports and nothing else may', async () => {
    await seed();
    const read = await runReport('items-sales-summary', '', viewer.token);
    expect(read.status).toBe(200);

    const denied = await createActor(ctx, {
      tenantCode: 'rpt-items',
      email: 'noreports@rpt-items.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'sales.view'],
    });
    expect((await runReport('items-profit-summary', '', denied.token)).status).toBe(403);
  });

  it('a second tenant sees none of these documents', async () => {
    await seed();
    for (const key of [
      'items-sales-summary',
      'items-pos-sales-summary',
      'items-profit-summary',
      'items-purchases-summary',
      'items-profit-details',
      'items-sales-by-category',
      'category-sales-by-day',
    ]) {
      const run = await runReport(key, '', stranger.token);
      expect(run.status).toBe(200);
      expect((data(run.body) as { rows: unknown[] }).rows, key).toHaveLength(0);
      expect(Number(cardOf(run.body, 'net_sales')), key).toBe(0);
      expect(Number(cardOf(run.body, 'net_purchases')), key).toBe(0);
    }
  });
});
