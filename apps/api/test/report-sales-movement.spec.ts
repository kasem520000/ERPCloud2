import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part one — 📊 تقارير المبيعات: «حركة المبيعات».
 *
 * `Form_WPF/frmRptSalesInPeriod.xaml` (Title «حركة المبيعات») is one window with two tabs:
 *
 *   📊 `btnShow`      «📊 إجمالي حركة المواد» → tab «📊 إجمالي المبيعات»
 *                     grid: رقم الصنف · الصنف · الكمية · الإجمالي  → `RptSalesInPeriod1.repx`
 *   🧾 `btnShowInvs`  «🧾 عرض الفواتير»      → tab «🧾 عرض الفواتير»
 *                     grid: رقم الحركة · رقم الفاتورة · نوع الفاتورة · التاريخ · الوقت · آجل ·
 *                           نقدي · شبكة · الإجمالي · الضريبة · الخصم · الصافي
 *                                                                    → `RptSalesInPeriod2.repx`
 *
 * and both print «💰 إجمالي المبيعات:» under the grid — `txtSumSale` (الكميات الصافية) and
 * `txtSumSale2` (المبيعات ناقص المردودات), with `header.repx` (المنشأة), «المستخدم» and the
 * strip «أعده · راجعه · المدير».
 *
 * The rules the cloud has to keep:
 *   - `GetSaleData(itemId, invType, procType)` — proc_type 1 بيع و2 مرتجع, and the net is
 *     `SUM(val)` and `SUM(val * exchange_price)` of each; `if (qty == 0.0) continue;`
 *     drops an صنف that was never sold.
 *   - `ShowResults()` — `Proc_Type<>3 AND Proc_Type<>4 AND IS_Buy=0 AND IS_Deleted=0`,
 *     «بيع»/«مرتجع» from `proc_type`, and `IsPostpone` from `pay_type = -1`.
 *   - `cmbInvType.SelectedIndex` — 0 = «مبيعات نقطة البيع» (`inv_type=3`), 1 = «مبيعات
 *     عادية» (`inv_type=2`).
 *   - `PrintDevexpress()` — «لا توجد عمليات بالجدول» when both grids are empty.
 */
describe('التقارير — frmRptSalesInPeriod · حركة المبيعات', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let fuelId = '';
  let jacketId = '';
  let ropeId = '';
  let partyId = '';
  let cashLocationId = '';

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

  /** Runs one of the two reports with the period the desktop opens with (today ± margin). */
  const runReport = (key: string, query = '', token = actor.token) =>
    get(`/reports/${key}?from=${from}&to=${to}${query}`, token);

  beforeAll(async () => {
    ctx = await createTestApp('report-sales-movement');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-sales-mv',
      email: 'owner@rpt-sales-mv.test',
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
        'sales.invoice.pay',
        'sales.return.create',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'accounting.account.view',
        'accounting.account.manage',
        'organization.postingprofile.view',
        'reporting.view',
      ],
    });
    // 👁️ A second person in the same tenant who may read reports and nothing else.
    viewer = await createActor(ctx, {
      tenantCode: 'rpt-sales-mv',
      email: 'viewer@rpt-sales-mv.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-sales-mv-2',
      email: 'owner@rpt-sales-mv-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    const category = await post('/organization/catalog/categories', { code: 'GEN', nameAr: 'عام' });
    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    const categoryId = data(category.body).id as string;
    const unitId = data(unit.body).id as string;

    const item = async (sku: string, nameAr: string) => {
      const created = await post('/organization/catalog/items', { sku, nameAr, categoryId, baseUnitId: unitId, salePrice: '100.0000' });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    fuelId = await item('MV-FUEL', 'وقود');
    jacketId = await item('MV-JACKET', 'سترة نجاة');
    // An صنف that is never sold: `if (qty == 0.0) continue;` keeps it out of the report.
    ropeId = await item('MV-ROPE', 'حبل');

    const stock = await post('/inventory/ledger/record', {
      lines: [fuelId, jacketId, ropeId].map((itemId, index) => ({
        itemId,
        warehouseId,
        qty: '100',
        unitCost: '40',
        direction: 'in',
        docType: 'opening',
        docId: `00000000-0000-0000-0000-00000000000${index + 1}`,
      })),
    });
    expect(stock.status).toBe(201);

    const party = await post('/parties', { kind: 'customer', name: 'عميل التقرير' });
    partyId = data(party.body).id as string;

    // 💵 «نقدي» — a cash payment needs a خزينة, so the report has something to read.
    const cashAccount = await post('/accounts', { code: '1299', nameAr: 'صندوق التقرير', type: 'asset' });
    expect(cashAccount.status).toBe(201);
    const safe = await post('/cash-locations', {
      branchId,
      kind: 'safe',
      name: 'الخزينة الرئيسية',
      accountId: data(cashAccount.body).id as string,
    });
    expect(safe.status).toBe(201);
    cashLocationId = data(safe.body).id as string;
  }, 240_000);

  afterAll(async () => ctx.close());

  /** Creates a بيع or a مرتجع and posts it; only posted documents reach a report. */
  const createInvoice = async (body: Record<string, unknown>) => {
    const created = await post('/sales/invoices', { branchId, warehouseId, ...body });
    expect(created.status).toBe(201);
    const id = data(created.body).id as string;
    const posted = await post(`/sales/invoices/${id}/post`, {});
    expect(posted.status).toBe(201);
    return data(posted.body) as { id: string; number: string; subtotal: string; taxTotal: string; total: string };
  };

  let saleInvoice: { id: string; number: string; total: string } | null = null;
  let returnInvoice: { id: string; number: string; total: string } | null = null;
  let posInvoice: { id: string; number: string; total: string } | null = null;

  const seedDocuments = async () => {
    if (saleInvoice) return;
    // 🧾 فاتورة بيع عادية — صنفان، ثم سداد نقدي + شبكة.
    saleInvoice = await createInvoice({
      partyId,
      lines: [
        { itemId: fuelId, quantity: '10', unitPrice: '100', taxRate: '15' },
        { itemId: jacketId, quantity: '3', unitPrice: '50', taxRate: '15' },
      ],
    });
    const cash = await post(`/sales/invoices/${saleInvoice.id}/payments`, {
      method: 'cash',
      amount: '500',
      idempotencyKey: 'mv-cash-1',
      cashLocationId,
    });
    expect(cash.status).toBe(201);
    const card = await post(`/sales/invoices/${saleInvoice.id}/payments`, {
      method: 'card',
      amount: '322.5',
      idempotencyKey: 'mv-card-1',
    });
    expect(card.status).toBe(201);

    // ↩️ مرتجع — صنفان من الفاتورة نفسها، بلا سداد (آجل).
    const draftReturn = await post(`/sales/invoices/${saleInvoice.id}/return`, {
      branchId,
      warehouseId,
      // ↩️ The price comes back with the line — `InvoiceOper` copies it from the source row,
      //    so a مرتجع is always priced the way the بيع was.
      lines: [{ itemId: fuelId, quantity: '2', unitPrice: '100', taxRate: '15' }],
    });
    expect(draftReturn.status).toBe(201);
    const returnedId = data(draftReturn.body).id as string;
    const postedReturn = await post(`/sales/invoices/${returnedId}/post`, {});
    expect(postedReturn.status).toBe(201);
    returnInvoice = data(postedReturn.body) as { id: string; number: string; total: string };

    // 🧾 مبيعات نقطة البيع — بلا عميل، وبلا سداد.
    posInvoice = await createInvoice({
      // 🧾 مبيعات نقطة البيع — بلا عميل: الاسم النقدي هو ما يعرّف الفاتورة.
      cashCustomerName: 'عميل نقدي',
      lines: [{ itemId: jacketId, quantity: '1', unitPrice: '50', taxRate: '15' }],
    });
  };

  it('registers both reports in the catalogue with the desktop’s own columns and filters', async () => {
    const catalog = await get('/reports');
    expect(catalog.status).toBe(200);
    const entries = rowsOf(catalog.body) as Array<{ key: string; titleAr: string; params: Array<{ name: string; labelAr: string; options?: Array<{ value: string; labelAr: string }> }>; columns: Array<{ key: string; labelAr: string }> }>;

    const items = entries.find((entry) => entry.key === 'sales-movement-items');
    expect(items).toBeDefined();
    expect(items!.titleAr).toContain('حركة المبيعات');
    expect(items!.columns.map((column) => column.labelAr)).toEqual(['رقم الصنف', 'الصنف', 'الكمية', 'الإجمالي']);

    const invoices = entries.find((entry) => entry.key === 'sales-movement-invoices');
    expect(invoices).toBeDefined();
    expect(invoices!.columns.map((column) => column.labelAr)).toEqual([
      'رقم الحركة',
      'رقم الفاتورة',
      'نوع الفاتورة',
      'التاريخ',
      'الوقت',
      'آجل',
      'نقدي',
      'شبكة',
      'الإجمالي',
      'الضريبة',
      'الخصم',
      'الصافي',
    ]);

    // 🧾 نوع الفاتورة · ⏰ الوقت (HH:mm:ss) — the two boxes the cloud had no home for.
    const kind = invoices!.params.find((param) => param.name === 'invType');
    expect(kind?.labelAr).toBe('نوع الفاتورة');
    expect(kind?.options?.map((option) => option.labelAr)).toEqual(['مبيعات نقطة البيع', 'مبيعات عادية']);
    expect(invoices!.params.filter((param) => param.name.endsWith('Time')).map((param) => param.labelAr)).toEqual([
      'الوقت (HH:mm:ss)',
      'الوقت (HH:mm:ss)',
    ]);
  });

  it('جمع «📊 إجمالي المبيعات» كل صنفٍ صافياً من المرتجع، ولم يذكر ما لم يُبع', async () => {
    await seedDocuments();
    const run = await runReport('sales-movement-items');
    expect(run.status).toBe(200);
    const body = data(run.body) as { rows: Array<Record<string, string>>; grandTotal: Array<{ key: string; labelAr: string; amount: string }> };
    const byName = new Map(body.rows.map((row) => [row.item_name, row]));

    // وقود: 10 مباعة − 2 مرتجعة = 8 · (1000+150) − (200+30) = 920
    expect(Number(byName.get('وقود')?.quantity)).toBeCloseTo(8, 4);
    expect(Number(byName.get('وقود')?.total)).toBeCloseTo(920, 2);
    // سترة نجاة: 3 من الفاتورة + 1 من نقطة البيع = 4 · 172.5 + 57.5 = 230
    expect(Number(byName.get('سترة نجاة')?.quantity)).toBeCloseTo(4, 4);
    expect(Number(byName.get('سترة نجاة')?.total)).toBeCloseTo(230, 2);
    // حبل — `if (qty == 0.0) continue;`
    expect(byName.has('حبل')).toBe(false);

    // 💰 إجمالي المبيعات = txtSumSale = Σ(الإجمالي الصافي)
    expect(body.grandTotal).toEqual([{ key: 'total', labelAr: 'إجمالي المبيعات', amount: '1150.00' }]);
  });

  it('عرض «🧾 عرض الفواتير» البيع والمرتجع بوقتهما ونقدهما وشبكتهما وآجلهما', async () => {
    await seedDocuments();
    const run = await runReport('sales-movement-invoices');
    expect(run.status).toBe(200);
    const body = data(run.body) as { rows: Array<Record<string, string>>; grandTotal: Array<{ key: string; labelAr: string; amount: string }> };
    const byNumber = new Map(body.rows.map((row) => [row.number, row]));

    const sale = byNumber.get(saleInvoice!.number)!;
    expect(sale.kind_name).toBe('بيع');
    expect(sale.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(Number(sale.cash)).toBeCloseTo(500, 2);
    expect(Number(sale.network)).toBeCloseTo(322.5, 2);
    expect(Number(sale.subtotal)).toBeCloseTo(1150, 2);
    expect(Number(sale.tax)).toBeCloseTo(172.5, 2);
    expect(Number(sale.net)).toBeCloseTo(1322.5, 2);
    expect(sale.postponed).toBe('—'); // مدفوعة بالكامل

    const returned = byNumber.get(returnInvoice!.number)!;
    expect(returned.kind_name).toBe('مرتجع');
    expect(Number(returned.net)).toBeCloseTo(230, 2);
    expect(returned.postponed).toBe('نعم'); // بلا سداد ⇒ آجل
    expect(Number(returned.cash)).toBe(0);

    expect(byNumber.get(posInvoice!.number)?.kind_name).toBe('بيع');

    // 💰 إجمالي المبيعات = txtSumSale2 = المبيعات − المردودات = 1322.5 − 230 + 57.5
    expect(Number(body.grandTotal?.[0]?.amount)).toBeCloseTo(1150, 2);
  });

  it('🧾 نوع الفاتورة يفرز مبيعات نقطة البيع عن المبيعات العادية', async () => {
    await seedDocuments();
    const pos = await runReport('sales-movement-invoices', '&invType=pos');
    const posRows = (data(pos.body) as { rows: Array<Record<string, string>> }).rows;
    expect(posRows).toHaveLength(1);
    expect(posRows[0]?.number).toBe(posInvoice!.number);

    const sale = await runReport('sales-movement-invoices', '&invType=sale');
    const saleRows = (data(sale.body) as { rows: Array<Record<string, string>> }).rows;
    expect(saleRows.map((row) => row.number).sort()).toEqual([returnInvoice!.number, saleInvoice!.number].sort());
  });

  it('⏰ الوقت (HH:mm:ss) يضيّق الفترة كما يضيّقها صندوق الوقت', async () => {
    await seedDocuments();
    const whole = await runReport('sales-movement-invoices', '&fromTime=00:00:00&toTime=23:59:59');
    expect((data(whole.body) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    // Same day, and the «إلى تاريخ» time box closed at 00:00:01 — nothing was posted that early.
    const narrow = await get(`/reports/sales-movement-invoices?from=${iso(0)}&to=${iso(0)}&fromTime=00:00:00&toTime=00:00:01`);
    expect((data(narrow.body) as { rows: unknown[] }).rows).toHaveLength(0);

    const bad = await get(`/reports/sales-movement-invoices?from=${from}&to=${to}&fromTime=99:99`);
    expect(bad.status).toBe(422);
  });

  it('🖨️ طباعة — المنشأة والعنوان و«المستخدم» و«أعده · راجعه · المدير»', async () => {
    await seedDocuments();
    const printed = await get(`/reports/print/sales-movement-items?from=${from}&to=${to}`);
    expect(printed.status).toBe(200);
    const html = (printed.body as { html: string }).html;
    expect(html).toContain('حركة المبيعات');
    expect(html).toContain('رقم الصنف');
    expect(html).toContain('المستخدم: مستخدم التقارير');
    expect(html).toContain('أعده');
    expect(html).toContain('راجعه');
    expect(html).toContain('المدير');
    expect(html).toContain('إجمالي المبيعات:');
    expect(html).toContain('1,150.00');
  });

  it('🖨️ طباعة — «لا توجد عمليات بالجدول» حين يخلو الجدول', async () => {
    const printed = await get(`/reports/print/sales-movement-invoices?from=2001-01-01&to=2001-01-31`);
    expect(printed.status).toBe(200);
    expect((printed.body as { html: string }).html).toContain('لا توجد عمليات بالجدول');
  });

  it('the signed column is computed, never shown', async () => {
    await seedDocuments();
    const run = await runReport('sales-movement-invoices');
    const body = data(run.body) as { columns: Array<{ key: string }>; rows: Array<Record<string, string>> };
    expect(body.columns.some((column) => column.key === 'net_signed')).toBe(false);
    // The rows carry it so «💰 إجمالي المبيعات» can subtract المردودات from المبيعات.
    expect(body.rows.every((row) => typeof row.net_signed === 'string')).toBe(true);
  });

  it('👁️ reporting.view reads the report and nothing else may', async () => {
    const read = await runReport('sales-movement-items', '', viewer.token);
    expect(read.status).toBe(200);

    const denied = await createActor(ctx, {
      tenantCode: 'rpt-sales-mv',
      email: 'noreports@rpt-sales-mv.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'sales.view'],
    });
    const forbidden = await runReport('sales-movement-items', '', denied.token);
    expect(forbidden.status).toBe(403);
  });

  it('a second tenant sees none of these documents', async () => {
    await seedDocuments();
    const run = await runReport('sales-movement-items', '', stranger.token);
    expect(run.status).toBe(200);
    const body = data(run.body) as { rows: unknown[]; grandTotal: Array<{ amount: string }> };
    expect(body.rows).toHaveLength(0);
    expect(Number(body.grandTotal?.[0]?.amount)).toBe(0);
  });
});
