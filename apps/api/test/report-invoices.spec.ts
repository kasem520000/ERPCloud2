import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part three — 🧾 تقارير الفواتير والإشعارات والحركة اليومية: seven windows.
 *
 *   `frmRptInvSalesDetails.xaml`        «تقرير فواتير المبيعات»      → sales-invoices-details
 *   `frmRptInvSalesDetailsPos.xaml`     «تقرير مبيعات الفواتير»      → pos-sales-invoices-details
 *   `frmRptInvNotfic.xaml`              «تقرير الإشعارات»            → sales-notifications
 *   `frmRptInvPurchaseDetails.xaml`     «تفاصيل فواتير المشتريات»    → purchase-invoices-details
 *   `frmRptDailySales.xaml`             «تقرير مبيعات حسب اليوم»     → daily-sales
 *   `frmRptDailyProcess.xaml`           «تقرير الحركة اليومية»       → daily-process
 *   `frmRptInvAnalysis.xaml`            «تقرير تحليل المبيعات»       → sales-inv-analysis
 *
 * The rules the cloud has to keep:
 *   - `UpdateSummaryCards()` — `Calc(x) = purchases.Sum(x) − returns.Sum(x)`, i.e. a مرتجع and an
 *     إشعار دائن subtract from «المجموع · الخصم · الإجمالي · الضريبة · ضريبة إضافية · إجمالي
 *     الضريبة · الصافي · نقدي · شبكة · المدفوع»; the report therefore reads signed columns.
 *   - `GetPaymentText` — «آجل · نقدي · شبكة · متعدد · ضيافة»; an unpaid فاتورة is «آجل», a
 *     settled one is named after the leg that settled it, and several legs read «متعدد».
 *   - «المجموع» is Σ(quantity × unit_price) and «الخصم» is what is left of it after «الإجمالي».
 *   - `SalesByDay` — one row per يوم with «الضريبة» separate from «الإجمالي», and the day is named
 *     by `ToString("ddd", culture ar)`.
 *   - `DoProcess(name, type1, type2)` — six rows in a fixed order, each of them split into نقدي
 *     (anything that is not unpaid) and آجل.
 *   - `frmRptInvAnalysis` — the صافي of every dimension is بيع − مرتجع, and the two نسبتان are
 *     shares of the report's own totals.
 */
describe('التقارير — frmRptInv* · تقارير الفواتير والإشعارات والحركة اليومية', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let mainWarehouseName = '';
  let seaWarehouseId = '';
  let catGearId = '';

  let fuelId = '';
  let jacketId = '';
  let salesmanId = '';
  let taxCustomerId = '';
  let simpleCustomerId = '';
  let supplierId = '';
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

  /** Runs one of the seven reports over the period the desktop opens with (today ± margin). */
  const runReport = (key: string, query = '', token = actor.token) =>
    get(`/reports/${key}?from=${from}&to=${to}${query}`, token);
  /** The 💰 card of a run, by the column it sums. */
  const cardOf = (body: unknown, key: string): string => {
    const cards = (data(body as Record<string, unknown>) as { grandTotal: Array<{ key: string; amount: string }> }).grandTotal;
    return cards.find((card) => card.key === key)?.amount ?? '0';
  };
  const rowsIn = (body: unknown): Array<Record<string, string>> =>
    (data(body as Record<string, unknown>) as { rows: Array<Record<string, string>> }).rows ?? [];

  beforeAll(async () => {
    ctx = await createTestApp('report-invoices');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-inv',
      email: 'owner@rpt-inv.test',
      fullName: 'مستخدم التقارير',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.view',
        'sales.salesman.manage',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.invoice.pay',
        'sales.return.create',
        'purchase.view',
        'purchase.invoice.create',
        'purchase.invoice.post',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
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
      tenantCode: 'rpt-inv',
      email: 'viewer@rpt-inv.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-inv-2',
      email: 'owner@rpt-inv-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;
    // 🏭 «المستودع» في «تفاصيل فواتير المشتريات» يُقرأ من اسم المستودع لا من معرّفه.
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
    fuelId = await item('IV-FUEL', 'وقود', catGearId);
    jacketId = await item('IV-JACKET', 'سترة نجاة', catGearId);

    // 📚 «متوسط التكلفة» — the two أصناف open at 40 a وحدة, so the profit is predictable.
    const stock = await post('/inventory/ledger/record', {
      lines: [fuelId, jacketId].map((itemId, index) => ({
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

    // 🧑‍💼 المندوب — the «المندوب» column and the مندوب البيع radio of the تحليل window.
    const salesman = await post('/sales/salesmen', { name: 'مندوب التقرير' });
    expect(salesman.status).toBe(201);
    salesmanId = data(salesman.body).id as string;

    // 🧾 «فاتورة ضريبية» needs a عميل برقم ضريبي; «فاتورة ضريبية مبسطة» is one without.
    const taxCustomer = await post('/parties', { kind: 'customer', name: 'عميل ضريبي', taxNo: '300000000000003' });
    taxCustomerId = data(taxCustomer.body).id as string;
    const simpleCustomer = await post('/parties', { kind: 'customer', name: 'عميل مبسط' });
    simpleCustomerId = data(simpleCustomer.body).id as string;
    const supplier = await post('/parties', { kind: 'supplier', name: 'مورد التقرير' });
    supplierId = data(supplier.body).id as string;
    const cash = await post('/cash-locations', { branchId, kind: 'safe', name: 'الخزينة الرئيسية' });
    expect(cash.status).toBe(201);
    cashLocationId = data(cash.body).id as string;
  }, 240_000);

  afterAll(async () => ctx.close());

  /** Creates a بيع or an إشعار and posts it; only posted documents reach a report. */
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

  let seeded = false;
  let saleInvoiceId = '';
  let saleNumber = '';

  const seed = async () => {
    if (seeded) return;
    seeded = true;
    // 🧾 بيع — صنفان، عميلٌ برقم ضريبي، نصفه نقداً ونصفه شبكة (`PaymentStatus = 2`).
    await createSale({
      partyId: taxCustomerId,
      salesmanId,
      lines: [
        { itemId: fuelId, quantity: '10', unitPrice: '100', taxRate: '15' },
        { itemId: jacketId, quantity: '3', unitPrice: '50', taxRate: '15' },
      ],
    }).then((invoice) => {
      saleInvoiceId = invoice.id;
      saleNumber = invoice.number;
      return invoice;
    });
    const cashLeg = await post(`/sales/invoices/${saleInvoiceId}/payments`, {
      method: 'cash',
      amount: '500',
      idempotencyKey: 'rpt-inv-cash-1',
      cashLocationId,
    });
    expect(cashLeg.status).toBe(201);
    const cardLeg = await post(`/sales/invoices/${saleInvoiceId}/payments`, {
      method: 'card',
      amount: '322.5',
      idempotencyKey: 'rpt-inv-card-1',
    });
    expect(cardLeg.status).toBe(201);
    // ↩️ مرتجع — وحدتان من الوقود إلى الفاتورة نفسها، بلا سداد (`PaymentStatus = 0`).
    const draft = await post(`/sales/invoices/${saleInvoiceId}/return`, {
      branchId,
      warehouseId,
      lines: [{ itemId: fuelId, quantity: '2', unitPrice: '100', taxRate: '15' }],
    });
    expect(draft.status).toBe(201);
    const returned = await post(`/sales/invoices/${data(draft.body).id as string}/post`, {});
    expect(returned.status).toBe(201);
    // 🧾 نقطة البيع — بلا عميل: «فاتورة ضريبية مبسطة»، آجلة.
    await createSale({ cashCustomerName: 'عميل نقدي', lines: [{ itemId: jacketId, quantity: '1', unitPrice: '50', taxRate: '15' }] });
    // 📄 إشعار دائن — `inv_type = 22`; the only row of «تقرير الإشعارات».
    await createSale({
      kind: 'credit_note',
      partyId: taxCustomerId,
      referenceInvoiceId: saleInvoiceId,
      lines: [{ itemId: fuelId, quantity: '1', unitPrice: '100', taxRate: '15' }],
    });
    // 📥 شراء ومردود شراء — `proc_type` 1 و2 في `frmRptInvPurchaseDetails`.
    const purchase = await createPurchase({ lines: [{ itemId: fuelId, quantity: '20', unitPrice: '60', taxRate: '15' }] });
    await createPurchase({
      kind: 'purchase_return',
      referenceInvoiceId: purchase.id,
      lines: [{ itemId: fuelId, quantity: '5', unitPrice: '60', taxRate: '15' }],
    });
  };

  it('registers the seven windows with the desktop’s own columns, filters and 💰 cards', async () => {
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

    // 🧾 تقرير فواتير المبيعات — `frmRptInvSalesDetails.xaml`
    const sales = byKey.get('sales-invoices-details')!;
    expect(sales.titleAr).toBe('تقرير فواتير المبيعات');
    expect(sales.group).toBe('sales');
    expect(sales.columns.map((column) => column.labelAr)).toEqual([
      'نوع الفاتورة',
      'رقم الفاتورة',
      'رقم المرجع',
      'تاريخ الفاتورة',
      'الوقت',
      'نوع الدفع',
      'المدفوع',
      'العميل',
      'نقدي',
      'شبكة',
      'المجموع',
      'الخصم',
      'الإجمالي',
      'الضريبة',
      'ضريبة إضافية',
      'إجمالي الضريبة',
      'الصافي',
      'المستودع',
      'الفرع',
      'المندوب',
      'المستخدم',
    ]);
    // 🔍 خيارات البحث — the same ten boxes as the desktop panel.
    expect(sales.params.map((param) => param.labelAr)).toEqual([
      'نوع الفاتورة',
      'نوع الدفع',
      'المستودع',
      'المندوب',
      'الطرف',
      'الفرع',
      'من تاريخ',
      'من وقت (HH:mm)',
      'إلى تاريخ',
      'إلى وقت (HH:mm)',
      'الضريبة',
      'حالة الدفع',
      'نوع العملية',
    ]);
    expect(sales.grandTotal).toEqual([
      'المجموع',
      'الخصم',
      'الإجمالي',
      'الضريبة',
      'ضريبة إضافية',
      'إجمالي الضريبة',
      'الصافي',
      'نقدي',
      'شبكة',
      'المدفوع',
    ]);
    expect(sales.grandTotalCards).toEqual([
      { key: 's_sum_price', labelAr: 'المجموع' },
      { key: 's_discount', labelAr: 'الخصم' },
      { key: 's_subtotal', labelAr: 'الإجمالي' },
      { key: 's_tax', labelAr: 'الضريبة' },
      { key: 's_extra_tax', labelAr: 'ضريبة إضافية' },
      { key: 's_total_tax', labelAr: 'إجمالي الضريبة' },
      { key: 's_net', labelAr: 'الصافي' },
      { key: 's_cash', labelAr: 'نقدي' },
      { key: 's_network', labelAr: 'شبكة' },
      { key: 's_paid', labelAr: 'المدفوع' },
    ]);

    // 🧾 تقرير مبيعات الفواتير — `frmRptInvSalesDetailsPos.xaml` (`inv.inv_type = 3`)
    const pos = byKey.get('pos-sales-invoices-details')!;
    expect(pos.titleAr).toBe('تقرير مبيعات الفواتير');
    expect(pos.params.map((param) => param.labelAr)).toEqual([
      'نوع العملية',
      'حالة الدفع',
      'المستودع',
      'من تاريخ',
      'من وقت (HH:mm)',
      'إلى تاريخ',
      'إلى وقت (HH:mm)',
    ]);
    expect(pos.grandTotal).toEqual(['المجموع', 'الخصم', 'الإجمالي', 'الضريبة', 'ضريبة إضافية', 'إجمالي الضريبة', 'الصافي', 'نقدي', 'شبكة']);

    // 📄 تقرير الإشعارات — `frmRptInvNotfic.xaml` (`inv_type` 21/22)
    const notifications = byKey.get('sales-notifications')!;
    expect(notifications.titleAr).toBe('تقرير الإشعارات');
    expect(notifications.columns.slice(0, 4).map((column) => column.labelAr)).toEqual(['نوع الإشعار', 'رقم الإشعار', 'رقم المرجع', 'تاريخ الإشعار']);
    expect(notifications.params.map((param) => param.labelAr)).toEqual([
      'نوع الإشعار',
      'نوع العملية',
      'المندوب',
      'الطرف',
      'من تاريخ',
      'من وقت (HH:mm)',
      'إلى تاريخ',
      'إلى وقت (HH:mm)',
    ]);

    // 📥 تفاصيل فواتير المشتريات — `frmRptInvPurchaseDetails.xaml`
    const purchase = byKey.get('purchase-invoices-details')!;
    expect(purchase.titleAr).toBe('تفاصيل فواتير المشتريات');
    expect(purchase.group).toBe('purchases');
    expect(purchase.columns.map((column) => column.labelAr)).toEqual([
      'نوع الفاتورة',
      'رقم الفاتورة',
      'رقم المرجع',
      'التاريخ',
      'الوقت',
      'نوع الدفع',
      'المورد',
      'المجموع',
      'الخصم',
      'الإجمالي',
      'الضريبة',
      'الصافي',
      'المدفوع',
      'المتبقي',
      'المستودع',
      'الفرع',
      'المستخدم',
    ]);
    expect(purchase.params.map((param) => param.labelAr)).toEqual([
      'الضريبة',
      'نوع العملية',
      'الفرع',
      'الطرف',
      'المستودع',
      'من تاريخ',
      'من وقت (HH:mm)',
      'إلى تاريخ',
      'إلى وقت (HH:mm)',
    ]);
    expect(purchase.grandTotal).toEqual(['المجموع', 'الخصم', 'الإجمالي', 'الضريبة', 'الصافي']);

    // 📅 تقرير مبيعات حسب اليوم — `SalesByDay` in `frmRptDailySales.xaml.cs`
    const daily = byKey.get('daily-sales')!;
    expect(daily.titleAr).toBe('تقرير مبيعات حسب اليوم');
    expect(daily.columns.map((column) => column.labelAr)).toEqual(['الرقم', 'التاريخ', 'اليوم', 'الإجمالي قبل الضريبة', 'الضريبة', 'الإجمالي']);
    expect(daily.params.map((param) => param.labelAr)).toEqual(['نوع الفاتورة', 'الفرع', 'من تاريخ', 'إلى تاريخ']);
    expect(daily.grandTotal).toEqual(['إجمالي قبل الضريبة', 'إجمالي الضريبة', 'الإجمالي الكلي']);

    // 🔄 تقرير الحركة اليومية — `DoProcess(name, type1, type2)`
    const process = byKey.get('daily-process')!;
    expect(process.titleAr).toBe('تقرير الحركة اليومية');
    expect(process.columns.map((column) => column.labelAr)).toEqual(['نوع العملية', 'عدد الفواتير', 'الإجمالي', 'نقدي', 'آجل']);
    expect(process.params.map((param) => param.labelAr)).toEqual(['الفرع', 'من تاريخ', 'من وقت (HH:mm)', 'إلى تاريخ', 'إلى وقت (HH:mm)']);

    // 📊 تقرير تحليل المبيعات — the eight radios of `frmRptInvAnalysis.xaml`
    const analysis = byKey.get('sales-inv-analysis')!;
    expect(analysis.titleAr).toBe('تقرير تحليل المبيعات');
    expect(analysis.columns.map((column) => column.labelAr)).toEqual([
      'البعد',
      'فواتير',
      'صافي الكمية',
      'صافي الإجمالي',
      'صافي الخصم',
      'صافي التكلفة',
      'صافي الربح',
      'نسبة الربح للتكلفة',
      'نسبة الاجمالي لإجمالي البيع',
      'نسبة الربح لإجمالي الربح',
    ]);
    expect(analysis.params.map((param) => param.labelAr)).toEqual([
      'نوع التقرير',
      'الطرف',
      'المجموعة',
      'المندوب',
      'المستودع',
      'من تاريخ',
      'إلى تاريخ',
    ]);
    expect(analysis.grandTotal).toEqual(['صافي الكمية', 'صافي الإجمالي', 'صافي الخصم', 'صافي التكلفة', 'صافي الربح']);
  });

  it('🧾 «تقرير فواتير المبيعات» — سطرٌ لكل فاتورة بنوعها وطريقة دفعها ومجاميعها', async () => {
    await seed();
    const run = await runReport('sales-invoices-details');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    // ثلاث فواتير: البيع، ومرتجعه، ونقطة البيع — أما الإشعار الدائن فله نافذته.
    expect(rows).toHaveLength(3);

    const sale = rows.find((row) => Number(row.net) === 1322.5)!;
    expect(sale.invoice_type).toBe('فاتورة ضريبية'); // TaxType = 2: للعميل رقم ضريبي
    expect(sale.number).toMatch(/\S/);
    expect(sale.day).toBe(today.toISOString().slice(0, 10));
    expect(sale.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(sale.payment_method).toBe('متعدد'); // نقد + شبكة
    expect(Number(sale.paid)).toBeCloseTo(822.5, 2);
    expect(Number(sale.cash)).toBeCloseTo(500, 2);
    expect(Number(sale.network)).toBeCloseTo(322.5, 2);
    expect(sale.customer).toBe('عميل ضريبي');
    expect(Number(sale.sum_price)).toBeCloseTo(1150, 2); // المجموع
    expect(Number(sale.discount)).toBeCloseTo(0, 2);
    expect(Number(sale.subtotal)).toBeCloseTo(1150, 2); // الإجمالي
    expect(Number(sale.tax)).toBeCloseTo(172.5, 2);
    expect(Number(sale.extra_tax)).toBeCloseTo(0, 2);
    expect(Number(sale.total_tax)).toBeCloseTo(172.5, 2);
    expect(sale.warehouse).toBe(mainWarehouseName);
    expect(sale.branch).not.toBe('—');
    expect(sale.salesman).toBe('مندوب التقرير');
    expect(sale.user_name).toBe('مستخدم التقارير');

    expect(sale.reference).toBe('—'); // لا فاتورةً تشير إليها
    const returned = rows.find((row) => Number(row.net) === 230)!;
    expect(returned.reference).toBe(saleNumber); // 🔗 رقم المرجع — الفاتورة الأصل
    expect(returned.invoice_type).toBe('إشعار دائن للفاتورة الضريبية');
    expect(returned.payment_method).toBe('آجل'); // لم يُسدَّد شيء
    expect(Number(returned.paid)).toBe(0);

    const pos = rows.find((row) => Number(row.net) === 57.5)!;
    expect(pos.invoice_type).toBe('فاتورة ضريبية مبسطة'); // بلا رقم ضريبي
    expect(pos.customer).toBe('عميل نقدي');
    expect(pos.payment_method).toBe('آجل');

    // 📊 ملخص النتائج — `Calc(x) = purchases.Sum(x) − returns.Sum(x)`
    expect(Number(cardOf(run.body, 's_sum_price'))).toBeCloseTo(1000, 2); // 1150 − 200 + 50
    expect(Number(cardOf(run.body, 's_discount'))).toBeCloseTo(0, 2);
    expect(Number(cardOf(run.body, 's_subtotal'))).toBeCloseTo(1000, 2);
    expect(Number(cardOf(run.body, 's_tax'))).toBeCloseTo(150, 2); // 172.5 − 30 + 7.5
    expect(Number(cardOf(run.body, 's_extra_tax'))).toBeCloseTo(0, 2);
    expect(Number(cardOf(run.body, 's_total_tax'))).toBeCloseTo(150, 2);
    expect(Number(cardOf(run.body, 's_net'))).toBeCloseTo(1150, 2); // 1322.5 − 230 + 57.5
    expect(Number(cardOf(run.body, 's_cash'))).toBeCloseTo(500, 2);
    expect(Number(cardOf(run.body, 's_network'))).toBeCloseTo(322.5, 2);
    expect(Number(cardOf(run.body, 's_paid'))).toBeCloseTo(822.5, 2);
  });

  it('🔍 خيارات البحث — نوع الفاتورة ونوع العملية وحالة الدفع ونوع الدفع والضريبة', async () => {
    await seed();
    const count = async (query: string) => rowsIn((await runReport('sales-invoices-details', query)).body).length;

    // 🔄 نوع العملية — «مبيعات» (proc_type = 1) و«مرتجع» (proc_type = 2).
    expect(await count('&procType=sale')).toBe(2); // البيع ونقطة البيع
    expect(await count('&procType=return')).toBe(1); // المرتجع وحده
    // 💵 حالة الدفع — مدفوع · غير مدفوع · مدفوع جزئي.
    expect(await count('&paymentStatus=paid')).toBe(0);
    expect(await count('&paymentStatus=partial')).toBe(1);
    expect(await count('&paymentStatus=unpaid')).toBe(2);
    // 💳 نوع الدفع — نقدية · آجلة · شبكة · بنك.
    expect(await count('&payType=cash')).toBe(1);
    expect(await count('&payType=card')).toBe(1);
    expect(await count('&payType=bank')).toBe(0);
    expect(await count('&payType=credit')).toBe(2);
    // 🧾 الضريبة — كل فاتورة here carries ضريبة, so «بدون ضريبة» is empty.
    expect(await count('&vat=with')).toBe(3);
    expect(await count('&vat=without')).toBe(0);
    // 📄 نوع الفاتورة — «مبيعات» (inv_type = 2) و«نقطة بيع» (inv_type = 3).
    expect(await count('&invType=sale')).toBe(2);
    expect(await count('&invType=pos')).toBe(1);
    // 🏪 المستودع — «مستودع البحر» لا فاتورة فيه.
    expect(await count(`&warehouseId=${seaWarehouseId}`)).toBe(0);
    // 🧑‍💼 المندوب — المرتجع لا يرث مندوب فاتورته عند الديسكتوب ولا عند السحابة.
    expect(await count(`&salesmanId=${salesmanId}`)).toBe(1);
    // 👥 العميل — «عميل مبسط» لم يبع شيئاً.
    expect(await count(`&partyId=${simpleCustomerId}`)).toBe(0);
    expect(await count(`&partyId=${taxCustomerId}`)).toBe(2);
  });

  it('⏰ وقت — «من وقت» و«إلى وقت» يقصّان اليوم نفسه لا الفترة كلها', async () => {
    await seed();
    const day = today.toISOString().slice(0, 10);
    const inDay = (query: string) => get(`/reports/sales-invoices-details?from=${day}&to=${day}${query}`);
    expect(rowsIn((await inDay('&fromTime=23:59')).body)).toHaveLength(0);
    expect(rowsIn((await inDay('&toTime=00:00')).body)).toHaveLength(0);
    expect(rowsIn((await inDay('&fromTime=00:00&toTime=23:59')).body)).toHaveLength(3);
  });

  it('🧾 «تقرير مبيعات الفواتير» — `inv.inv_type = 3`: نقطة البيع وحدها', async () => {
    await seed();
    const run = await runReport('pos-sales-invoices-details');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoice_type).toBe('فاتورة ضريبية مبسطة');
    expect(rows[0]?.customer).toBe('عميل نقدي');
    expect(Number(rows[0]?.sum_price)).toBeCloseTo(50, 2);
    expect(Number(rows[0]?.tax)).toBeCloseTo(7.5, 2);
    expect(Number(rows[0]?.net)).toBeCloseTo(57.5, 2);
    // 💰 تسع بطاقات بلا «المدفوع» — هذا التقرير لا يسدِّد.
    const cards = (data(run.body) as { grandTotal: Array<{ key: string; amount: string }> }).grandTotal;
    expect(cards).toHaveLength(9);
    expect(Number(cardOf(run.body, 's_net'))).toBeCloseTo(57.5, 2);
    expect(Number(cardOf(run.body, 's_cash'))).toBeCloseTo(0, 2);
  });

  it('📄 «تقرير الإشعارات» — `inv_type` 21 و22، والإشعار الدائن يخصم', async () => {
    await seed();
    const run = await runReport('sales-notifications');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    expect(rows).toHaveLength(1);
    const credit = rows[0]!;
    expect(credit.invoice_type).toBe('إشعار دائن');
    expect(credit.reference).toBe(saleNumber);
    expect(credit.customer).toBe('عميل ضريبي');
    expect(Number(credit.sum_price)).toBeCloseTo(100, 2);
    expect(Number(credit.tax)).toBeCloseTo(15, 2);
    expect(Number(credit.net)).toBeCloseTo(115, 2);
    // ↩️ «إشعار دائن» يخصم من الملخص كما يخصم المرتجع.
    expect(Number(cardOf(run.body, 's_sum_price'))).toBeCloseTo(-100, 2);
    expect(Number(cardOf(run.body, 's_tax'))).toBeCloseTo(-15, 2);
    expect(Number(cardOf(run.body, 's_net'))).toBeCloseTo(-115, 2);

    // 📄 نوع الإشعار — «إشعار مدين» لا شيء منه here.
    expect(rowsIn((await runReport('sales-notifications', '&notificationType=debit')).body)).toHaveLength(0);
    expect(rowsIn((await runReport('sales-notifications', '&notificationType=credit')).body)).toHaveLength(1);
  });

  it('📥 «تفاصيل فواتير المشتريات» — الشراء والمردود بـ«المدفوع» و«المتبقي»', async () => {
    await seed();
    const run = await runReport('purchase-invoices-details');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    expect(rows).toHaveLength(2);

    const purchase = rows.find((row) => row.invoice_type === 'فاتورة مشتريات')!;
    expect(purchase.supplier).toBe('مورد التقرير');
    expect(Number(purchase.sum_price)).toBeCloseTo(1200, 2);
    expect(Number(purchase.discount)).toBeCloseTo(0, 2);
    expect(Number(purchase.subtotal)).toBeCloseTo(1200, 2);
    expect(Number(purchase.tax)).toBeCloseTo(180, 2);
    expect(Number(purchase.net)).toBeCloseTo(1380, 2);
    expect(Number(purchase.paid)).toBeCloseTo(0, 2);
    expect(Number(purchase.due)).toBeCloseTo(1380, 2); // المتبقي
    expect(purchase.payment_method).toBe('آجل'); // 💳 نوع الدفع — لم يُسدَّد
    expect(purchase.user_name).toBe('مستخدم التقارير');
    expect(purchase.reference).toBe('—');
    expect(purchase.warehouse).toBe(mainWarehouseName);

    const returned = rows.find((row) => row.invoice_type === 'مردود مشتريات')!;
    expect(Number(returned.net)).toBeCloseTo(345, 2);
    expect(Number(returned.due)).toBeCloseTo(345, 2);
    expect(returned.reference).toBe(purchase.number); // 🔗 رقم المرجع — فاتورة الشراء

    // 💰 مجاميع الفواتير — `CalculateSummary` nets proc_type 1 − 2.
    expect(Number(cardOf(run.body, 's_sum_price'))).toBeCloseTo(900, 2); // 1200 − 300
    expect(Number(cardOf(run.body, 's_subtotal'))).toBeCloseTo(900, 2);
    expect(Number(cardOf(run.body, 's_tax'))).toBeCloseTo(135, 2); // 180 − 45
    expect(Number(cardOf(run.body, 's_net'))).toBeCloseTo(1035, 2); // 1380 − 345

    // 🔄 نوع العملية و🧾 الضريبة.
    const returns = rowsIn((await runReport('purchase-invoices-details', '&procType=return')).body);
    expect(returns).toHaveLength(1);
    expect(Number(cardOf((await runReport('purchase-invoices-details', '&procType=return')).body, 's_net'))).toBeCloseTo(-345, 2);
    expect(rowsIn((await runReport('purchase-invoices-details', '&vat=with')).body)).toHaveLength(2);
    expect(rowsIn((await runReport('purchase-invoices-details', '&vat=without')).body)).toHaveLength(0);
    expect(rowsIn((await runReport('purchase-invoices-details', `&warehouseId=${seaWarehouseId}`)).body)).toHaveLength(0);
  });

  it('📅 «تقرير مبيعات حسب اليوم» — سطرٌ لكل يوم باسمه ومجاميعه الثلاثة', async () => {
    await seed();
    const run = await runReport('daily-sales');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    expect(rows).toHaveLength(1);
    const day = rows[0]!;
    expect(day.seq).toBe('1'); // الرقم
    expect(day.day).toBe(today.toISOString().slice(0, 10));
    expect(day.day_name).toMatch(/^(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت)$/);
    // 1150 − 200 + 50 · 172.5 − 30 + 7.5 · 1322.5 − 230 + 57.5
    expect(Number(day.before_tax)).toBeCloseTo(1000, 2);
    expect(Number(day.tax)).toBeCloseTo(150, 2);
    expect(Number(day.total)).toBeCloseTo(1150, 2);
    expect(Number(cardOf(run.body, 'before_tax'))).toBeCloseTo(1000, 2);
    expect(Number(cardOf(run.body, 'tax'))).toBeCloseTo(150, 2);
    expect(Number(cardOf(run.body, 'total'))).toBeCloseTo(1150, 2);

    // 📄 نوع الفاتورة — `invType = cmbInvType.SelectedIndex == 0 ? 2 : 3`.
    const posOnly = rowsIn((await runReport('daily-sales', '&invType=pos')).body);
    expect(posOnly).toHaveLength(1);
    expect(Number(posOnly[0]?.before_tax)).toBeCloseTo(50, 2);
    expect(Number(posOnly[0]?.total)).toBeCloseTo(57.5, 2);
    const docsOnly = rowsIn((await runReport('daily-sales', '&invType=sale')).body);
    expect(Number(docsOnly[0]?.before_tax)).toBeCloseTo(950, 2); // 1150 − 200
  });

  it('🔄 «تقرير الحركة اليومية» — ست حركات بستة أسطر، نقديها وآجلها', async () => {
    await seed();
    const run = await runReport('daily-process');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    expect(rows.map((row) => row.operation)).toEqual([
      'مبيعات',
      'مرتجع مبيعات',
      'نقطة البيع',
      'مرتجع نقطة البيع',
      'مشتريات',
      'مرتجع مشتريات',
    ]);
    const byOp = new Map(rows.map((row) => [row.operation, row]));

    // 🧾 مبيعات — الفاتورة المسدَّدة جزئياً كلها «نقدي» عند الديسكتوب (`pay_type > 0`).
    expect(Number(byOp.get('مبيعات')?.invoices)).toBe(1);
    expect(Number(byOp.get('مبيعات')?.total)).toBeCloseTo(1322.5, 2);
    expect(Number(byOp.get('مبيعات')?.cash)).toBeCloseTo(1322.5, 2);
    expect(Number(byOp.get('مبيعات')?.credit)).toBeCloseTo(0, 2);
    // ↩️ المرتجع و🧾 نقطة البيع لم يُسدَّدا: «آجل».
    expect(Number(byOp.get('مرتجع مبيعات')?.total)).toBeCloseTo(230, 2);
    expect(Number(byOp.get('مرتجع مبيعات')?.credit)).toBeCloseTo(230, 2);
    expect(Number(byOp.get('نقطة البيع')?.total)).toBeCloseTo(57.5, 2);
    expect(Number(byOp.get('نقطة البيع')?.credit)).toBeCloseTo(57.5, 2);
    // 🚫 لا مرتجع لنقطة البيع here — السطر موجود anyway, بأصفار.
    expect(Number(byOp.get('مرتجع نقطة البيع')?.invoices)).toBe(0);
    expect(Number(byOp.get('مرتجع نقطة البيع')?.total)).toBe(0);
    // 📥 المشتريات ومردودها — `DoProcess('مشتريات', 1, 1)` و`DoProcess('مرتجع مشتريات', 1, 2)`.
    expect(Number(byOp.get('مشتريات')?.total)).toBeCloseTo(1380, 2);
    expect(Number(byOp.get('مشتريات')?.credit)).toBeCloseTo(1380, 2);
    expect(Number(byOp.get('مرتجع مشتريات')?.total)).toBeCloseTo(345, 2);
  });

  it('📊 «تقرير تحليل المبيعات» — البعد الذي يختاره الراديو ونسبتاه', async () => {
    await seed();
    const run = await runReport('sales-inv-analysis');
    expect(run.status).toBe(200);
    const rows = rowsIn(run.body);
    // 🏭 المخزن هو البعد الافتراضي (`rdStock` محدداً).
    expect(rows).toHaveLength(1);
    const stock = rows[0]!;
    expect(stock.dimension).toBe(mainWarehouseName);
    expect(Number(stock.invoices)).toBe(3); // بيع + مرتجع + نقطة بيع
    expect(Number(stock.net_quantity)).toBeCloseTo(12, 4); // 10 − 2 + 3 + 1
    expect(Number(stock.net_total)).toBeCloseTo(1000, 2); // 1000 − 200 + 150 + 50
    expect(Number(stock.net_discount)).toBeCloseTo(0, 2);
    expect(Number(stock.net_cost)).toBeCloseTo(480, 2); // 12 × 40
    expect(Number(stock.net_profit)).toBeCloseTo(520, 2);
    expect(Number(stock.profit_to_cost)).toBeCloseTo(108.33, 2); // 520 ÷ 480 × 100
    expect(Number(stock.share_of_sales)).toBeCloseTo(100, 2);
    expect(Number(stock.share_of_profit)).toBeCloseTo(100, 2);
    expect(Number(cardOf(run.body, 'net_quantity'))).toBeCloseTo(12, 4);
    expect(Number(cardOf(run.body, 'net_profit'))).toBeCloseTo(520, 2);

    // 📦 الصنف — صفٌّ لكل صنفٍ تحرَّك، ونسبة كلٍّ من الإجمالي العام.
    const byItem = rowsIn((await runReport('sales-inv-analysis', '&dimension=item')).body);
    expect(byItem).toHaveLength(2);
    const fuel = byItem.find((row) => row.dimension === 'وقود')!;
    expect(Number(fuel.net_quantity)).toBeCloseTo(8, 4);
    expect(Number(fuel.net_total)).toBeCloseTo(800, 2);
    expect(Number(fuel.net_cost)).toBeCloseTo(320, 2);
    expect(Number(fuel.net_profit)).toBeCloseTo(480, 2);
    expect(Number(fuel.share_of_sales)).toBeCloseTo(80, 2);
    expect(Number(fuel.share_of_profit)).toBeCloseTo(92.31, 2);
    const jacket = byItem.find((row) => row.dimension === 'سترة نجاة')!;
    expect(Number(jacket.net_total)).toBeCloseTo(200, 2);
    expect(Number(jacket.share_of_sales)).toBeCloseTo(20, 2);

    // 🧑‍💼 مندوب البيع — فاتورته وحدها موجبة، والباقي (المرتجع ونقطة البيع) بلا مندوب.
    const bySalesman = rowsIn((await runReport('sales-inv-analysis', '&dimension=salesman')).body);
    expect(bySalesman).toHaveLength(2);
    expect(Number(bySalesman.find((row) => row.dimension === 'مندوب التقرير')?.net_total)).toBeCloseTo(1150, 2);
    expect(Number(bySalesman.find((row) => row.dimension === '—')?.net_total)).toBeCloseTo(-150, 2); // 50 − 200
    // 👤 العميل · 📅 اليوم · 🗂️ المجموعة — the other radios of the panel.
    const byCustomer = rowsIn((await runReport('sales-inv-analysis', '&dimension=customer')).body);
    expect(byCustomer.map((row) => row.dimension).sort()).toEqual(['عميل ضريبي', 'عميل نقدي']);
    const byDay = rowsIn((await runReport('sales-inv-analysis', '&dimension=day')).body);
    expect(byDay).toHaveLength(1);
    expect(byDay[0]?.dimension).toBe(today.toISOString().slice(0, 10));
    const byCategory = rowsIn((await runReport('sales-inv-analysis', `&dimension=category&categoryId=${catGearId}`)).body);
    expect(byCategory.map((row) => row.dimension)).toEqual(['معدات']);
  });

  it('📅 فترةٌ بلا حركة — جدولٌ فارغ، وبطاقات صفر، والحركة اليومية بأسطرها الستة', async () => {
    const empty = await get('/reports/sales-invoices-details?from=2001-01-01&to=2001-01-31');
    expect(empty.status).toBe(200);
    expect(rowsIn(empty.body)).toHaveLength(0);
    expect(Number(cardOf(empty.body, 's_net'))).toBe(0);
    expect(Number(cardOf(empty.body, 's_paid'))).toBe(0);

    const daily = await get('/reports/daily-sales?from=2001-01-01&to=2001-01-31');
    expect(rowsIn(daily.body)).toHaveLength(0);
    expect(Number(cardOf(daily.body, 'total'))).toBe(0);

    await seed();
    // 🔄 «الحركة اليومية» يطبع أنواعه الستة كلها ولو بلا حركة.
    const process = await get('/reports/daily-process?from=2001-01-01&to=2001-01-31');
    expect(rowsIn(process.body)).toHaveLength(6);
    for (const row of rowsIn(process.body)) {
      expect(Number(row.invoices)).toBe(0);
      expect(Number(row.total)).toBe(0);
    }
  });

  it('🖨️ طباعة — العنوان والأعمدة والبطاقات وتذييل «أعده · راجعه · المدير»', async () => {
    await seed();
    const printed = await get(`/reports/print/sales-invoices-details?from=${from}&to=${to}`);
    expect(printed.status).toBe(200);
    const html = (printed.body as { html: string }).html;
    expect(html).toContain('تقرير فواتير المبيعات');
    expect(html).toContain('نوع الفاتورة');
    expect(html).toContain('رقم المرجع');
    expect(html).toContain('إجمالي الضريبة');
    expect(html).toContain('الصافي');
    expect(html).toContain('المدفوع');
    expect(html).toContain('المستخدم: مستخدم التقارير');
    // أعده · راجعه · المدير — `footer.repx` inside `RptInvSalesDetails.repx`.
    expect(html).toContain('أعده');
    expect(html).toContain('راجعه');
    expect(html).toContain('المدير');
  });

  it('📊 تصدير CSV — الأعمدة العشرون كما يعرضها الجدول', async () => {
    await seed();
    const exported = await api(ctx.server, 'post', `/api/v1/reports/sales-invoices-details/export?from=${from}&to=${to}`, {
      token: actor.token,
      body: { format: 'csv' },
    });
    expect(exported.status).toBe(201);
    const payload = data(exported.body) as { content: string; filename: string };
    expect(payload.filename).toContain('.csv');
    const [header, ...lines] = payload.content.replace(/^\uFEFF/, '').trim().split('\n');
    expect(header).toContain('نوع الفاتورة');
    expect(header).toContain('إجمالي الضريبة');
    expect(header).not.toContain('المجموع،المجموع'); // the signed twin columns stay hidden
    expect(lines).toHaveLength(3);
  });

  it('👁️ reporting.view reads the reports and nothing else may', async () => {
    await seed();
    const read = await runReport('sales-invoices-details', '', viewer.token);
    expect(read.status).toBe(200);

    const denied = await createActor(ctx, {
      tenantCode: 'rpt-inv',
      email: 'noreports@rpt-inv.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'sales.view'],
    });
    expect((await runReport('sales-invoices-details', '', denied.token)).status).toBe(403);
    expect((await runReport('purchase-invoices-details', '', denied.token)).status).toBe(403);
  });

  it('a second tenant sees none of these documents', async () => {
    await seed();
    for (const key of [
      'sales-invoices-details',
      'pos-sales-invoices-details',
      'sales-notifications',
      'purchase-invoices-details',
      'daily-sales',
      'sales-inv-analysis',
    ]) {
      const run = await runReport(key, '', stranger.token);
      expect(run.status).toBe(200);
      expect((data(run.body) as { rows: unknown[] }).rows, key).toHaveLength(0);
      expect(Number(cardOf(run.body, 's_net')), key).toBe(0);
      expect(Number(cardOf(run.body, 'net_profit')), key).toBe(0);
    }
    // 🔄 «الحركة اليومية» لا يرى منها إلا الأسطر الستة الفارغة.
    const process = await runReport('daily-process', '', stranger.token);
    expect(rowsIn(process.body)).toHaveLength(6);
    for (const row of rowsIn(process.body)) expect(Number(row.total)).toBe(0);
  });
});
