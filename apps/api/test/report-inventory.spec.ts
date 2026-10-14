import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part four — 📚 تقارير المخزون والأرقام التسلسلية: seven windows, eight reports.
 *
 *   `frmRptInventory.xaml`               «تقرير مستندات المخزون»      → inventory-documents
 *   `frmRptItemsActivity.xaml`           «مادة باجمالي الحركات»       → item-movement-totals
 *   `frmRptItemsActivityDetailed.xaml`   «حركة صنف تفصيلي»            → item-movement-details
 *   `frmRptItemsExpiration.xaml`         «صلاحية المواد»              → item-expiry
 *   `frmRptSerialNo.xaml`                «حركة الأرقام التسلسلية»     → serial-movements
 *   `frmRptSerialNoSummary.xaml`         «أرصدة الأرقام التسلسلية»    → serial-balances
 *   `frmRptProducedItems.xaml`           «تقرير مواد المنتجة»         → produced-items (+ مكونات)
 *
 * The rules the cloud has to keep:
 *   - `frmRptInventory.xaml.cs` L260-267 — eight inventory documents behind one combo, read
 *     here from the movement ledger's `doc_type` instead of `Inv.inv_type` / `proc_type`.
 *   - `frmRptItemsActivity.xaml.cs` L248 — الرصيد = أول مدة + مشتريات − مرتجع مشتريات
 *     − مبيعات + مرتجع مبيعات − نقطة بيع + مرتجع POS + مناقلة − مناقلة + إدخال − إخراج
 *     + تسوية − تسوية; every column is a magnitude and the balance applies the signs.
 *   - `CalcAvgCost()` L363-415 — متوسط التكلفة of the receipts; the cloud keeps it on the
 *     balance row, and إجمالي التكلفة is الرصيد × متوسط التكلفة (L271).
 *   - `frmRptItemsActivityDetailed.xaml.cs` L355-365 — a running رصيد accumulated row by
 *     row, and `IsInput = 0` rows are dropped: only movements that move stock appear.
 *   - `dbo.ItemsExpirationStock()` — only items whose `ItemProperty = 8` (expiry-tracked)
 *     and only lots that still hold quantity; باقي سنوات/أشهر/أيام are `DATEDIFF`s.
 *   - `dbo.funCalculateSerialNoSummary()` — العدد of a serial is Σ in − Σ out; a piece that
 *     left the shelf is no longer a balance.
 *   - `frmRptProducedItems` — two grids over one period: 🏭 المواد المنتجة and 🔧 المكونات.
 */
describe('التقارير — frmRptInventory · frmRptItems* · frmRptSerial* · frmRptProducedItems', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let secondWarehouseId = '';
  let categoryId = '';
  let unitId = '';

  let fuelId = '';
  let fuelName = '';
  let serialItemId = '';
  let serialItemName = '';
  let lotItemId = '';
  let productId = '';
  let productName = '';
  let customerId = '';
  let customerName = '';
  let supplierId = '';

  let saleNumber = '';
  let purchaseNumber = '';
  let transferNumber = '';
  let serialNos: string[] = [];
  let serialIds: string[] = [];
  let productionNumber = '';
  let productionComponentCost = '0';

  const today = new Date();
  const iso = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  /**
   * «باقي أشهر» في التقرير فروقُ أشهرٍ تقويمية لا أياماً مقسومةً على 30
   * (`report-catalog.ts` — `(year×12+month)` للطرفين). وكان السبيك يثبّت `0` لدفعةٍ
   * تنتهي بعد 10 أيام، وهو صحيحٌ في وسط الشهر فقط: في 21 أيلول يصبح الانتهاء 1 تشرين
   * الأول ⇒ الشهر التالي ⇒ `1`. فالحساب هنا يتبع التقرير نفسه بدل أن يثبّت رقماً
   * يعتمد على يوم التشغيل.
   */
  const monthsLeft = (expiry: string): number =>
    (Number(expiry.slice(0, 4)) - today.getUTCFullYear()) * 12 + (Number(expiry.slice(5, 7)) - (today.getUTCMonth() + 1));
  const yearsLeft = (expiry: string): number => Number(expiry.slice(0, 4)) - today.getUTCFullYear();
  const from = iso(-1);
  const to = iso(1);

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });

  const runReport = (key: string, query = '', token = actor.token) => get(`/reports/${key}?from=${from}&to=${to}${query}`, token);
  const cardOf = (body: unknown, key: string): string => {
    const cards = (data(body as Record<string, unknown>) as { grandTotal: Array<{ key: string; amount: string }> }).grandTotal;
    return cards.find((card) => card.key === key)?.amount ?? '0';
  };
  const rowsIn = (body: unknown): Array<Record<string, string>> =>
    (data(body as Record<string, unknown>) as { rows: Array<Record<string, string>> }).rows ?? [];
  const money = (value: unknown) => Number(value ?? 0).toFixed(2);

  beforeAll(async () => {
    ctx = await createTestApp('report-inventory');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-inv4',
      email: 'owner@rpt-inv4.test',
      fullName: 'مستخدم تقارير المخزون',
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
        'inventory.production.manage',
        'inventory.production.complete',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.account.view',
        'organization.postingprofile.view',
        'reporting.view',
        'reporting.export.execute',
      ],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'rpt-inv4',
      email: 'viewer@rpt-inv4.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-inv4-2',
      email: 'owner@rpt-inv4-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    const sea = await post('/warehouses', { branchId, code: 'SEA', name: 'مستودع البحر' });
    expect(sea.status).toBe(201);
    secondWarehouseId = data(sea.body).id as string;

    const category = await post('/organization/catalog/categories', { code: 'GEAR', nameAr: 'معدات' });
    expect(category.status).toBe(201);
    categoryId = data(category.body).id as string;

    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    expect(unit.status).toBe(201);
    unitId = data(unit.body).id as string;

    const item = async (sku: string, nameAr: string, extra: Record<string, unknown> = {}) => {
      const created = await post('/organization/catalog/items', {
        sku,
        nameAr,
        categoryId,
        baseUnitId: unitId,
        kind: 'stock',
        salePrice: '100.0000',
        purchasePrice: '60.0000',
        ...extra,
      });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    fuelId = await item('IV4-FUEL', 'وقود التقرير');
    fuelName = 'وقود التقرير';
    serialItemId = await item('IV4-SER', 'صنف تسلسلي', { trackSerial: true });
    serialItemName = 'صنف تسلسلي';
    lotItemId = await item('IV4-LOT', 'صنف صلاحية', { trackLot: true });
    productId = await item('IV4-PRD', 'منتج مُصنَّع');
    productName = 'منتج مُصنَّع';

    const customer = await post('/parties', { kind: 'customer', name: 'عميل التقرير' });
    expect(customer.status).toBe(201);
    customerId = data(customer.body).id as string;
    customerName = data(customer.body).name as string;
    const supplier = await post('/parties', { kind: 'supplier', name: 'مورد التقرير' });
    expect(supplier.status).toBe(201);
    supplierId = data(supplier.body).id as string;

    const postVoucher = async (kind: string, lines: Array<Record<string, unknown>>, reason: string) => {
      const draft = await post('/inventory/vouchers', { branchId, warehouseId, kind, reason, lines });
      expect(draft.status).toBe(201);
      const posted = await post(`/inventory/vouchers/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };

    // 🏁 بضاعة أول مدة — 100 @ 40, the baseline every other movement moves away from.
    const opening = await postVoucher('opening', [{ itemId: fuelId, qty: '100', unitCost: '40' }], 'رصيد افتتاحي');
    expect(opening.number.startsWith('OP-')).toBe(true);

    const postSale = async (body: Record<string, unknown>) => {
      const draft = await post('/sales/invoices', { branchId, warehouseId, ...body });
      expect(draft.status).toBe(201);
      const posted = await post(`/sales/invoices/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };
    const postPurchase = async (body: Record<string, unknown>) => {
      const draft = await post('/purchase-invoices', { branchId, warehouseId, partyId: supplierId, ...body });
      expect(draft.status).toBe(201);
      const posted = await post(`/purchase-invoices/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };

    const purchase = await postPurchase({ lines: [{ itemId: fuelId, quantity: '20', unitPrice: '60', taxRate: '15' }] });
    purchaseNumber = purchase.number;
    await postPurchase({
      kind: 'purchase_return',
      referenceInvoiceId: purchase.id,
      lines: [{ itemId: fuelId, quantity: '5', unitPrice: '60', taxRate: '15' }],
    });

    const sale = await postSale({
      partyId: customerId,
      lines: [{ itemId: fuelId, quantity: '10', unitPrice: '100', taxRate: '15' }],
    });
    saleNumber = sale.number;
    const draftReturn = await post(`/sales/invoices/${sale.id}/return`, {
      branchId,
      warehouseId,
      lines: [{ itemId: fuelId, quantity: '2', unitPrice: '100', taxRate: '15' }],
    });
    expect(draftReturn.status).toBe(201);
    await post(`/sales/invoices/${data(draftReturn.body).id}/post`, {});
    // 🛒 نقطة البيع — «inv_type = 3» is the cash sale with no عميل at all.
    await postSale({ cashCustomerName: 'نقدي', lines: [{ itemId: fuelId, quantity: '1', unitPrice: '100', taxRate: '15' }] });

    // 🚚 مناقلة — send out of the main warehouse, receive into the second one.
    const transfer = await post('/inventory/transfers/draft', {
      branchId,
      fromWarehouseId: warehouseId,
      toWarehouseId: secondWarehouseId,
      lines: [{ itemId: fuelId, qty: '25' }],
    });
    expect(transfer.status).toBe(201);
    transferNumber = data(transfer.body).number as string;
    const sent = await post(`/inventory/transfers/${data(transfer.body).id}/send`, {});
    expect(sent.status).toBe(201);
    const received = await post(`/inventory/transfers/${data(transfer.body).id}/receive`, {
      received: [{ lineNo: 1, qty: '25' }],
    });
    expect(received.status).toBe(201);

    const levels = async (itemId: string, warehouse: string) => {
      const body = rowsOf((await get(`/inventory/levels?item_id=${itemId}`)).body);
      return Number(body.find((row) => row.warehouseId === warehouse)?.quantity ?? 0);
    };
    const level = await levels(fuelId, warehouseId);
    const adjust = async (countedQty: number) => {
      const created = await post('/inventory/adjustments', {
        branchId,
        warehouseId,
        reason: 'تسوية',
        lines: [{ itemId: fuelId, countedQty: String(countedQty) }],
      });
      expect(created.status).toBe(201);
      const posted = await post(`/inventory/adjustments/${data(created.body).id}/post`, { approved: true });
      expect(posted.status).toBe(201);
    };
    await adjust(level + 3); // ⚖️ تسوية إدخال 3
    await adjust(level + 1); // ⚖️ تسوية إخراج 2

    await postVoucher('stock_in', [{ itemId: fuelId, qty: '7', unitCost: '45' }], 'إذن إدخال');
    await postVoucher('stock_out', [{ itemId: fuelId, qty: '4' }], 'إذن إخراج');

    // ⏰ three lots: one near, one far, one already expired.
    const makeLot = async (lotNo: string, expiryDate: string, qty: string) => {
      const lot = await post('/inventory/lots', { itemId: lotItemId, lotNo, expiryDate });
      expect(lot.status).toBe(201);
      await postVoucher('stock_in', [{ itemId: lotItemId, qty, unitCost: '20', lotId: data(lot.body).id }], 'استلام دفعة');
    };
    await makeLot('LOT-SOON', iso(10), '12');
    await makeLot('LOT-LATER', iso(400), '5');
    await makeLot('LOT-PAST', iso(-5), '3');

    // 🔢 three serial numbers, each with one movement on the ledger.
    const generated = await post('/inventory/serials/generate', {
      itemId: serialItemId,
      prefix: 'IV4SN-',
      startAt: 1,
      count: 3,
      warehouseId,
    });
    expect(generated.status).toBe(201);
    const serials = rowsOf((await get(`/inventory/serials?item_id=${serialItemId}`)).body) as Array<{ id: string; serialNo: string }>;
    serialIds = serials.map((row) => row.id);
    serialNos = serials.map((row) => row.serialNo);
    expect(serialNos).toEqual(['IV4SN-1', 'IV4SN-2', 'IV4SN-3']);
    const recorded = await post('/inventory/ledger/record', {
      lines: serials.map((row) => ({
        itemId: serialItemId,
        warehouseId,
        qty: '1',
        unitCost: '75',
        direction: 'in',
        docType: 'opening',
        docId: '00000000-0000-4000-8000-000000000001',
        serialId: row.id,
      })),
    });
    expect(recorded.status).toBe(201);

    // 🏭 أمر إنتاج — the product is built out of two components.
    const order = await post('/inventory/production-orders', {
      branchId,
      warehouseId,
      outputItemId: productId,
      outputQty: '4',
      referenceNo: 'REF-4',
      referenceDate: iso(0),
      components: [
        { itemId: fuelId, qty: '8' },
        { itemId: lotItemId, qty: '2' },
      ],
    });
    expect(order.status).toBe(201);
    const completed = await post(`/inventory/production-orders/${data(order.body).id}/complete`, {});
    expect(completed.status).toBe(201);
    productionNumber = data(completed.body).number as string;
    productionComponentCost = String(data(completed.body).componentCost ?? '0');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('📚 السجل — الثمانية تقارير بأعمدة الديسكتوب', async () => {
    const catalog = rowsOf((await get('/reports')).body) as Array<{ key: string; columns: Array<{ labelAr: string }> }>;
    const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
    const labels = (key: string) => (byKey.get(key)?.columns ?? []).map((column) => column.labelAr).join(' · ');

    expect(labels('inventory-documents')).toBe(
      'م · نوع العملية · رقم المستند · التاريخ · العميل/المورد · المستودع · الفرع · عدد الأصناف · الكمية · التكلفة',
    );
    expect(labels('item-movement-totals')).toBe(
      'الرمز · الصنف · الرصيد · متوسط التكلفة · إجمالي التكلفة · أول مدة · مشتريات · مرتجع مشتريات · المبيعات · مرتجع المبيعات · نقطة البيع · مرتجع POS · مناقلة مرسلة · مناقلة مستلمة · فاتورة إدخال · فاتورة إخراج · تسوية إدخال · تسوية إخراج',
    );
    expect(labels('item-movement-details')).toBe(
      'م · نوع الفاتورة · المستودع · رمز الصنف · الصنف · رقم الفاتورة · رقم المرجع · التاريخ · الحساب · الوحدة · الكمية في الفاتورة · السعر في الفاتورة · الإجمالي في الفاتورة · الكمية الداخلة · الكمية الخارجة · الرصيد · السعر · الإجمالي',
    );
    expect(labels('item-expiry')).toBe(
      'م · رمز الصنف · الصنف · المستودع · الكمية الحالية · تاريخ الإنتهاء · باقي سنوات · باقي أشهر · باقي أيام',
    );
    expect(labels('serial-movements')).toBe('م · الصنف · رمز الصنف · التسلسل · نوع الفاتورة · رقم الفاتورة · التاريخ · الفرع · الإتجاه');
    expect(labels('serial-balances')).toBe('م · الصنف · رمز الصنف · التسلسل · العدد');
    expect(labels('produced-items')).toBe('# · رقم الأمر · التاريخ · الصنف · الوحدة · الكمية · السعر · المجموع · رقم المرجع · الحالة');
    expect(labels('produced-components')).toBe('# · رقم الأمر · التاريخ · الصنف · الوحدة · الكمية · السعر · المجموع');
  });

  it('📋 تقرير مستندات المخزون — سطرٌ لكل مستند وثمانية أنواع عملية', async () => {
    const rows = rowsIn((await runReport('inventory-documents')).body);
    expect(rows.some((row) => row.doc_number === saleNumber)).toBe(true);
    expect(rows.some((row) => row.doc_number === purchaseNumber)).toBe(true);
    expect(rows.filter((row) => row.doc_number === transferNumber)).toHaveLength(2);
    const sale = rows.find((row) => row.doc_number === saleNumber);
    expect(sale?.party_name).toBe(customerName);
    expect(sale?.lines_count).toBe('1');
    const opening = rows.find((row) => String(row.doc_number).startsWith('OP-'));
    expect(money(opening?.cost)).toBe('4000.00');

    const kinds: Array<[string, string]> = [
      ['opening', 'بضاعة أول مدة'],
      ['issue', 'إذن مخزني'],
      ['production', 'أمر إنتاج'],
      ['adjustment', 'تسوية جردية'],
      ['transfer_out', 'مناقلة مرسلة'],
      ['transfer_in', 'مناقلة مستلمة'],
    ];
    for (const [value, label] of kinds) {
      const filtered = rowsIn((await runReport('inventory-documents', `&docType=${value}`)).body);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((row) => row.operation === label)).toBe(true);
    }
    // 📄 «أمر توريد» و«طلب بضاعة» — the cloud keeps them as documents that never move stock.
    for (const value of ['delivery', 'request']) {
      expect(rowsIn((await runReport('inventory-documents', `&docType=${value}`)).body)).toHaveLength(0);
    }
  });

  it('📦 مادة باجمالي الحركات — ثلاثة عشر عموداً وصيغة الرصيد', async () => {
    const rows = rowsIn((await runReport('item-movement-totals', `&itemId=${fuelId}&warehouseId=${warehouseId}`)).body);
    const row = rows.find((entry) => entry.item_name === fuelName);
    expect(row).toBeTruthy();
    expect(money(row?.opening_qty)).toBe('100.00');
    expect(money(row?.purchase_qty)).toBe('20.00');
    expect(money(row?.purchase_return_qty)).toBe('5.00');
    expect(money(row?.sale_qty)).toBe('10.00');
    expect(money(row?.sale_return_qty)).toBe('2.00');
    expect(money(row?.pos_qty)).toBe('1.00');
    expect(money(row?.transfer_received_qty)).toBe('25.00');
    expect(money(row?.entry_qty)).toBe('7.00');
    expect(money(row?.issue_qty)).toBe('4.00');
    expect(money(row?.adjust_in_qty)).toBe('3.00');
    expect(money(row?.adjust_out_qty)).toBe('2.00');
    // 100 + 20 − 5 − 10 + 2 − 1 − 25 + 3 − 2 + 7 − 4 − 8 (مكوّنات أمر الإنتاج) = 77
    expect(money(row?.balance)).toBe('77.00');
    expect(Number(row?.avg_cost)).toBeGreaterThan(0);
    expect(money(row?.total_cost)).toBe(money(Number(row?.balance) * Number(row?.avg_cost)));

    const report = await runReport('item-movement-totals', `&itemId=${fuelId}&warehouseId=${warehouseId}`);
    expect(money(cardOf(report.body, 'balance'))).toBe('77.00');
    expect(Number(cardOf(report.body, 's_count'))).toBe(1);

    // 🏬 The receiving warehouse sees the مناقلة on the other side of the ledger.
    const other = rowsIn((await runReport('item-movement-totals', `&itemId=${fuelId}&warehouseId=${secondWarehouseId}`)).body);
    expect(money(other.find((entry) => entry.item_name === fuelName)?.transfer_sent_qty)).toBe('25.00');
  });

  it('🔍 حركة صنف تفصيلي — رصيدٌ متحرك ونوع فاتورة وحساب', async () => {
    const rows = rowsIn((await runReport('item-movement-details', `&itemId=${fuelId}&warehouseId=${warehouseId}`)).body);
    expect(rows).toHaveLength(12);
    expect(money(rows.at(-1)?.balance)).toBe('77.00');
    expect(rows[0]?.operation).toBe('بضاعة أول مدة');
    expect(money(rows[0]?.qty_in)).toBe('100.00');
    expect(money(rows.find((row) => row.operation === 'مبيعات')?.qty_out)).toBe('10.00');
    expect(rows.some((row) => row.operation === 'نقطة البيع')).toBe(true);
    expect(rows.find((row) => row.doc_number === saleNumber)?.party_name).toBe(customerName);
    expect(rows.at(-1)?.unit_name).toBeTruthy();

    const report = await runReport('item-movement-details', `&itemId=${fuelId}&warehouseId=${warehouseId}`);
    expect(money(cardOf(report.body, 's_qty'))).toBe('77.00');

    // 🔄 نوع العملية — `BuildProcTypeCondition` L426-455, one branch per `inv_type`.
    const sales = rowsIn((await runReport('item-movement-details', `&itemId=${fuelId}&warehouseId=${warehouseId}&kind=sale`)).body);
    expect(sales).toHaveLength(2);
    const purchases = rowsIn((await runReport('item-movement-details', `&itemId=${fuelId}&warehouseId=${warehouseId}&kind=purchase`)).body);
    expect(purchases.map((row) => row.operation).sort()).toEqual(['مرتجع مشتريات', 'مشتريات']);
    // 📋 أنماط الفواتير — «الكل / مشتريات / مرتجع مشتريات».
    const pattern = rowsIn((await runReport('item-movement-details', `&itemId=${fuelId}&warehouseId=${warehouseId}&status=purchase`)).body);
    expect(pattern).toHaveLength(1);
    expect(pattern[0]?.operation).toBe('مشتريات');
  });

  it('⏰ صلاحية المواد — باقي سنوات وأشهر وأيام وبطاقتان', async () => {
    const rows = rowsIn((await runReport('item-expiry', `&itemId=${lotItemId}`)).body);
    expect(rows).toHaveLength(3);
    const soon = rows.find((row) => row.expiry_date === iso(10));
    expect(Number(soon?.days_left)).toBe(10);
    expect(Number(soon?.months_left)).toBe(monthsLeft(iso(10)));
    expect(Number(soon?.years_left)).toBe(yearsLeft(iso(10)));
    expect(money(soon?.qty)).toBe('12.00');
    expect(Number(rows.find((row) => row.expiry_date === iso(400))?.years_left)).toBe(yearsLeft(iso(400)));

    const report = await runReport('item-expiry', `&itemId=${lotItemId}`);
    expect(Number(cardOf(report.body, 's_count'))).toBe(3);
    expect(Number(cardOf(report.body, 's_expired'))).toBe(1);
  });

  it('🔢 حركة الأرقام التسلسلية — رقمٌ بسطر والبحث برقم', async () => {
    const rows = rowsIn((await runReport('serial-movements', `&itemId=${serialItemId}`)).body);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.serial_no).sort()).toEqual([...serialNos].sort());
    expect(rows[0]?.item_name).toBe(serialItemName);
    expect(rows[0]?.direction).toBe('داخل');

    const one = rowsIn((await runReport('serial-movements', `&serial=${serialNos[0]}`)).body);
    expect(one).toHaveLength(1);
    expect(one[0]?.serial_no).toBe(serialNos[0]);
  });

  it('🧮 أرصدة الأرقام التسلسلية — العدد وما يخرج منها', async () => {
    const rows = rowsIn((await runReport('serial-balances', `&itemId=${serialItemId}`)).body);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => money(row.count) === '1.00')).toBe(true);
    const report = await runReport('serial-balances', `&itemId=${serialItemId}`);
    expect(money(cardOf(report.body, 'count'))).toBe('3.00');

    const consumed = await post('/inventory/serials/consume', { serialIds: [serialIds[0]] });
    expect(consumed.status).toBe(201);
    expect(rowsIn((await runReport('serial-balances', `&itemId=${serialItemId}`)).body)).toHaveLength(2);
    const returned = await post('/inventory/serials/return', { serialIds: [serialIds[0]] });
    expect(returned.status).toBe(201);
    expect(rowsIn((await runReport('serial-balances', `&itemId=${serialItemId}`)).body)).toHaveLength(3);
  });

  it('🏭 تقرير مواد المنتجة — المُنتَج ومكوّناته', async () => {
    const rows = rowsIn((await runReport('produced-items')).body).filter((row) => row.order_no === productionNumber);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item_name).toBe(productName);
    expect(money(rows[0]?.qty)).toBe('4.00');
    expect(rows[0]?.ref_no).toBe('REF-4');
    expect(rows[0]?.status_ar).toBe('مكتمل');

    const report = await runReport('produced-items');
    expect(money(cardOf(report.body, 'qty'))).toBe('4.00');
    expect(money(cardOf(report.body, 'sale'))).toBe('400.00');
    expect(money(cardOf(report.body, 'cost'))).toBe(money(Number(productionComponentCost).toFixed(2)));

    const components = rowsIn((await runReport('produced-components')).body).filter((row) => row.order_no === productionNumber);
    expect(components).toHaveLength(2);
    expect(components.map((row) => money(row.qty)).sort()).toEqual(['2.00', '8.00']);
    expect(components.every((row) => money(Number(row.qty) * Number(row.price)) === money(row.total))).toBe(true);
  });

  it('📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر', async () => {
    const empty = await get(`/reports/item-movement-totals?from=2000-01-01&to=2000-01-02`);
    expect(rowsIn(empty.body)).toHaveLength(0);
    expect(money(cardOf(empty.body, 'balance'))).toBe('0.00');
    expect(Number(cardOf(empty.body, 's_count'))).toBe(0);
  });

  it('🔒 عزلٌ بين المستأجرين و👁️ صلاحية «reporting.view»', async () => {
    const theirs = await get(`/reports/item-movement-totals?from=${from}&to=${to}&itemId=${fuelId}`, stranger.token);
    expect(rowsIn(theirs.body)).toHaveLength(0);

    const theirsSerials = await get(`/reports/serial-balances?from=${from}&to=${to}`, stranger.token);
    expect(rowsIn(theirsSerials.body)).toHaveLength(0);

    // 👁️ The read-only viewer sees exactly what the owner sees.
    const mine = await get(`/reports/item-movement-totals?from=${from}&to=${to}&itemId=${fuelId}`, viewer.token);
    expect(rowsIn(mine.body)).toHaveLength(1);

    const forbidden = await api(ctx.server, 'get', `/api/v1/reports/item-movement-totals?from=${from}&to=${to}`, {
      token: (
        await createActor(ctx, {
          tenantCode: 'rpt-inv4',
          email: 'intruder@rpt-inv4.test',
          permissions: [...ALL_PLATFORM_PERMISSIONS],
        })
      ).token,
    });
    expect(forbidden.status).toBe(403);
  });
});
