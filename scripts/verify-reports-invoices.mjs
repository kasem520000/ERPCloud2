#!/usr/bin/env node
/**
 * Live verification of Phase 10 part three — 🧾 تقارير الفواتير والإشعارات والحركة اليومية
 * (`Form_WPF/frmRptInvSalesDetails` · `frmRptInvSalesDetailsPos` · `frmRptInvNotfic` ·
 * `frmRptInvPurchaseDetails` · `frmRptDailySales` · `frmRptDailyProcess` ·
 * `frmRptInvAnalysis`) against a running stack (`node scripts/local-db.mjs` +
 * `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقارير السبعة بأعمدة الديسكتوب وبطاقاته
 *   2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط
 *   3. 🧾 الوثائق — بيع (نقد + شبكة) · مرتجع · نقطة بيع · إشعار دائن · شراء · مردود شراء
 *   4. 🧾 تقرير فواتير المبيعات — سطرٌ لكل فاتورة والعشر بطاقات
 *   5. 🔍 خيارات البحث — نوع الفاتورة · نوع العملية · حالة الدفع · نوع الدفع · الضريبة · المستودع · المندوب
 *   6. ⏰ «من وقت / إلى وقت» — HH:mm كما في الفترة الزمنية
 *   7. 🧾 تقرير مبيعات الفواتير — نقطة البيع وحدها
 *   8. 📄 تقرير الإشعارات — الإشعار الدائن يخصم
 *   9. 📥 تفاصيل فواتير المشتريات — «المدفوع» و«المتبقي»
 *  10. 📅 تقرير مبيعات حسب اليوم — اليوم باسمه ومجاميعه الثلاثة
 *  11. 🔄 تقرير الحركة اليومية — ست حركات بستة أسطر
 *  12. 📊 تقرير تحليل المبيعات — المخزن · الصنف · المندوب
 *  13. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر
 *  14. 🖨️ طباعة — البطاقات في شريطٍ واحد
 *  15. التصدير — CSV وXLSX
 *  16. التنظيف — ما يُلغى يُلغى، والفاتورة المدفوعة تُرفض بقاعدة الدفاتر
 *
 * Re-runnable and non-destructive: everything this script writes carries a stamp, every
 * total is asserted as a **difference from a baseline** taken before anything is written
 * (so a tenant carrying yesterday's documents verifies just as well as an empty one),
 * and everything it creates is undone in a `finally`.
 *
 * Usage: node scripts/verify-reports-invoices.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

let token = '';

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    // Node 22's undici rejects lowercase verbs: `put`/`delete` come back a 405 with an
    // empty body, and `JSON.parse('')` then throws instead of reporting the real problem.
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed;
}

async function call(method, path, body) {
  const parsed = await request(method, path, body);
  return parsed.data ?? parsed;
}

/** A refusal is a result, not a crash — the window shows the sentence to the operator. */
async function refused(method, path, body) {
  try {
    await call(method, path, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

const login = await call('post', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path);
const post = (path, body) => call('post', path, body);
const del = (path) => call('delete', path);
const list = (value) => (Array.isArray(value) ? value : (value?.data ?? []));
const money = (value) => Number(value ?? 0).toFixed(2);
const delta = (after, before) => Number((Number(after ?? 0) - Number(before ?? 0)).toFixed(2));
/** One of the 💰 summary cards under the grid, by the column it sums. */
const cardOf = (report, key) => (report.grandTotal ?? []).find((total) => total.key === key)?.amount ?? '0';
const labels = (rows) => (rows ?? []).map((row) => row.labelAr).join(' · ');
const columns = (entry) => (entry?.columns ?? []).map((column) => column.labelAr).join(' · ');
const params = (entry) => (entry?.params ?? []).map((param) => param.labelAr).join(' · ');

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const from = iso(-1);
const to = iso(1);
const day = today.toISOString().slice(0, 10);

const invoicesReport = (query = '') => get(`/reports/sales-invoices-details?from=${from}&to=${to}${query}`);
const posReport = (query = '') => get(`/reports/pos-sales-invoices-details?from=${from}&to=${to}${query}`);
const notificationsReport = (query = '') => get(`/reports/sales-notifications?from=${from}&to=${to}${query}`);
const purchasesReport = (query = '') => get(`/reports/purchase-invoices-details?from=${from}&to=${to}${query}`);
const dailySalesReport = (query = '') => get(`/reports/daily-sales?from=${from}&to=${to}${query}`);
const dailyProcessReport = (query = '') => get(`/reports/daily-process?from=${from}&to=${to}${query}`);
const analysisReport = (query = '') => get(`/reports/sales-inv-analysis?from=${from}&to=${to}${query}`);

/** Only the rows this very run created — the demo tenant carries yesterday's documents too. */
const mine = (report) => list(report.rows).filter((row) => String(row.customer ?? '').includes(stamp));
const mineSuppliers = (report) => list(report.rows).filter((row) => String(row.supplier ?? '').includes(stamp));
const mineItems = (report) => list(report.rows).filter((row) => String(row.dimension ?? '').includes(stamp));
const rowOfDay = (report) => list(report.rows).find((row) => row.day === day);
const rowOfOperation = (report, operation) => list(report.rows).find((row) => row.operation === operation);

const written = {
  warehouseId: '',
  gearId: '',
  rigId: '',
  unitId: '',
  itemIds: [],
  customerId: '',
  supplierId: '',
  salesmanId: '',
  safeId: '',
  sales: [],
  purchases: [],
};

try {
  // ---------------------------------------------------------------------------
  console.log('1. 📚 السجل — التقارير السبعة بأعمدة الديسكتوب وبطاقاته');

  const catalog = list(await get('/reports'));
  const byCatalogKey = new Map(catalog.map((row) => [row.key, row]));
  const invoices = byCatalogKey.get('sales-invoices-details');
  const pos = byCatalogKey.get('pos-sales-invoices-details');
  const notifications = byCatalogKey.get('sales-notifications');
  const purchases = byCatalogKey.get('purchase-invoices-details');
  const dailySales = byCatalogKey.get('daily-sales');
  const dailyProcess = byCatalogKey.get('daily-process');
  const analysis = byCatalogKey.get('sales-inv-analysis');

  check('🧾 «تقرير فواتير المبيعات» مسجَّل', invoices?.titleAr === 'تقرير فواتير المبيعات', invoices?.titleAr ?? '—');
  check('🧾 «تقرير مبيعات الفواتير» مسجَّل', pos?.titleAr === 'تقرير مبيعات الفواتير', pos?.titleAr ?? '—');
  check('📄 «تقرير الإشعارات» مسجَّل', notifications?.titleAr === 'تقرير الإشعارات', notifications?.titleAr ?? '—');
  check('📥 «تفاصيل فواتير المشتريات» مسجَّل', purchases?.titleAr === 'تفاصيل فواتير المشتريات', purchases?.titleAr ?? '—');
  check('📅 «تقرير مبيعات حسب اليوم» مسجَّل', dailySales?.titleAr === 'تقرير مبيعات حسب اليوم', dailySales?.titleAr ?? '—');
  check('🔄 «تقرير الحركة اليومية» مسجَّل', dailyProcess?.titleAr === 'تقرير الحركة اليومية', dailyProcess?.titleAr ?? '—');
  check('📊 «تقرير تحليل المبيعات» مسجَّل', analysis?.titleAr === 'تقرير تحليل المبيعات', analysis?.titleAr ?? '—');

  check(
    '🧾 الأعمدة الحادية والعشرون — نوع الفاتورة … المستخدم',
    columns(invoices) ===
      'نوع الفاتورة · رقم الفاتورة · رقم المرجع · تاريخ الفاتورة · الوقت · نوع الدفع · المدفوع · العميل · نقدي · شبكة · المجموع · الخصم · الإجمالي · الضريبة · ضريبة إضافية · إجمالي الضريبة · الصافي · المستودع · الفرع · المندوب · المستخدم',
    `${(invoices?.columns ?? []).length} عمود`,
  );
  check(
    '📄 أعمدة الإشعارات — «نوع الإشعار» و«رقم الإشعار» و«رقم المرجع» و«تاريخ الإشعار»',
    columns(notifications).startsWith('نوع الإشعار · رقم الإشعار · رقم المرجع · تاريخ الإشعار'),
    columns(notifications).slice(0, 40),
  );
  check(
    '📥 أعمدة المشتريات — المورد والمدفوع والمتبقي',
    columns(purchases) ===
      'نوع الفاتورة · رقم الفاتورة · رقم المرجع · التاريخ · الوقت · نوع الدفع · المورد · المجموع · الخصم · الإجمالي · الضريبة · الصافي · المدفوع · المتبقي · المستودع · الفرع · المستخدم',
    columns(purchases),
  );
  check(
    '📅 أعمدة اليومية — الرقم · التاريخ · اليوم · الإجمالي قبل الضريبة · الضريبة · الإجمالي',
    columns(dailySales) === 'الرقم · التاريخ · اليوم · الإجمالي قبل الضريبة · الضريبة · الإجمالي',
    columns(dailySales),
  );
  check(
    '🔄 أعمدة الحركة — نوع العملية · عدد الفواتير · الإجمالي · نقدي · آجل',
    columns(dailyProcess) === 'نوع العملية · عدد الفواتير · الإجمالي · نقدي · آجل',
    columns(dailyProcess),
  );
  check(
    '📊 أعمدة التحليل العشرة',
    columns(analysis) ===
      'البعد · فواتير · صافي الكمية · صافي الإجمالي · صافي الخصم · صافي التكلفة · صافي الربح · نسبة الربح للتكلفة · نسبة الاجمالي لإجمالي البيع · نسبة الربح لإجمالي الربح',
    `${(analysis?.columns ?? []).length} عمود`,
  );

  check(
    '🔍 خيارات البحث الثلاثة عشر — نوع الفاتورة … نوع العملية',
    params(invoices) ===
      'نوع الفاتورة · نوع الدفع · المستودع · المندوب · الطرف · الفرع · من تاريخ · من وقت (HH:mm) · إلى تاريخ · إلى وقت (HH:mm) · الضريبة · حالة الدفع · نوع العملية',
    params(invoices),
  );
  check(
    '📊 خيارات التحليل — نوع التقرير أولاً',
    params(analysis) === 'نوع التقرير · الطرف · المجموعة · المندوب · المستودع · من تاريخ · إلى تاريخ',
    params(analysis),
  );
  check(
    '💰 البطاقات العشر — المجموع … المدفوع',
    labels(invoices?.grandTotalCards) ===
      'المجموع · الخصم · الإجمالي · الضريبة · ضريبة إضافية · إجمالي الضريبة · الصافي · نقدي · شبكة · المدفوع',
    labels(invoices?.grandTotalCards),
  );
  check(
    '🧾 بطاقات نقطة البيع تسع — بلا «المدفوع»',
    labels(pos?.grandTotalCards) === 'المجموع · الخصم · الإجمالي · الضريبة · ضريبة إضافية · إجمالي الضريبة · الصافي · نقدي · شبكة',
    labels(pos?.grandTotalCards),
  );
  check(
    '📥 بطاقات المشتريات الخمس',
    labels(purchases?.grandTotalCards) === 'المجموع · الخصم · الإجمالي · الضريبة · الصافي',
    labels(purchases?.grandTotalCards),
  );
  check(
    '📅 بطاقات اليومية الثلاث',
    labels(dailySales?.grandTotalCards) === 'إجمالي قبل الضريبة · إجمالي الضريبة · الإجمالي الكلي',
    labels(dailySales?.grandTotalCards),
  );
  check(
    '📊 بطاقات التحليل الخمس',
    labels(analysis?.grandTotalCards) === 'صافي الكمية · صافي الإجمالي · صافي الخصم · صافي التكلفة · صافي الربح',
    labels(analysis?.grandTotalCards),
  );
  const dimensionOptions = ((analysis?.params ?? []).find((param) => param.name === 'dimension')?.options ?? [])
    .map((option) => option.labelAr)
    .join(' · ');
  check(
    '📋 نوع التقرير — الأبعاد الثمانية',
    dimensionOptions === 'المخزن · العميل · الصنف · مندوب البيع · المستخدم · الأيام · الشهور · مجموعة الصنف',
    dimensionOptions,
  );

  // ---------------------------------------------------------------------------
  console.log('\n2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط');

  const baseInvoices = await invoicesReport();
  const basePos = await posReport();
  const baseNotifications = await notificationsReport();
  const basePurchases = await purchasesReport();
  // 🔄 «مرتجع» وحده — خطّ أساسٌ **بنفس المرشِّح**: الفرق بين تقريرٍ مُرشَّح وخطِّ أساسٍ
  // بلا مرشِّح يختلط فيه مرتجع القديم بمشترياته، فيقيس التقريرُ القديمَ لا الجديد.
  const basePurchaseReturns = await purchasesReport('&procType=return');
  const baseDailySales = await dailySalesReport();
  const baseDailyPos = await dailySalesReport('&invType=pos');
  const baseDailyProcess = await dailyProcessReport();
  const baseAnalysis = await analysisReport();
  check(
    '📏 خطّ الأساس',
    true,
    `الصافي ${money(cardOf(baseInvoices, 's_net'))} · الإشعارات ${money(cardOf(baseNotifications, 's_net'))} · المشتريات ${money(cardOf(basePurchases, 's_net'))} · اليوم ${money(cardOf(baseDailySales, 'total'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n3. 🧾 الوثائق — بيع (نقد + شبكة) · مرتجع · نقطة بيع · إشعار دائن · شراء · مردود شراء');

  const branches = list(await get('/branches'));
  const warehouses = list(await get('/warehouses'));
  const branchId = branches[0]?.id;
  const warehouseId = warehouses[0]?.id;
  const warehouseName = warehouses[0]?.name ?? '';
  // 🏪 A second مستودع, so the «🏪 المستودع» box has something to separate.
  const sea = await post('/warehouses', { branchId, code: `SEA${stamp}`, name: `مستودع البحر ${stamp}` });
  written.warehouseId = sea.id;

  const gear = await post('/organization/catalog/categories', { code: `VG${stamp}`, nameAr: `معدات ${stamp}` });
  written.gearId = gear.id;
  const rig = await post('/organization/catalog/categories', { code: `VR${stamp}`, nameAr: `تجهيزات ${stamp}` });
  written.rigId = rig.id;
  const unit = await post('/organization/catalog/units', { code: `VU${stamp}`, nameAr: 'حبة' });
  written.unitId = unit.id;

  const makeItem = (sku, nameAr, categoryId) =>
    post('/organization/catalog/items', {
      sku,
      nameAr,
      categoryId,
      baseUnitId: unit.id,
      kind: 'stock',
      salePrice: '100.0000',
      purchasePrice: '60.0000',
    });
  const fuel = await makeItem(`VF${stamp}`, `وقود ${stamp}`, gear.id);
  const jacket = await makeItem(`VJ${stamp}`, `سترة ${stamp}`, gear.id);
  written.itemIds = [fuel.id, jacket.id];

  // 📚 «متوسط التكلفة» — the two أصناف open at 40 a وحدة, so the profit is predictable.
  await post('/inventory/ledger/record', {
    lines: [fuel, jacket].map((item, index) => ({
      itemId: item.id,
      warehouseId,
      qty: '100',
      unitCost: '40',
      direction: 'in',
      docType: 'opening',
      docId: `00000000-0000-0000-000${index}-${stamp.padStart(12, '0')}`,
    })),
  });

  // 🧾 عميلٌ برقم ضريبي («فاتورة ضريبية») وآخر بلا («فاتورة ضريبية مبسطة»).
  const customer = await post('/parties', { kind: 'customer', name: `عميل ${stamp}`, taxNo: '300000000000003' });
  written.customerId = customer.id;
  const supplier = await post('/parties', { kind: 'supplier', name: `مورد ${stamp}` });
  written.supplierId = supplier.id;
  const salesman = await post('/sales/salesmen', { name: `مندوب ${stamp}` });
  written.salesmanId = salesman.id;

  const postSale = async (body) => {
    const draft = await post('/sales/invoices', { branchId, warehouseId, ...body });
    const posted = await post(`/sales/invoices/${draft.id}/post`, {});
    written.sales.push({ id: posted.id, number: posted.number, label: body.label ?? 'بيع' });
    return posted;
  };
  const postPurchase = async (body) => {
    const draft = await post('/purchase-invoices', { branchId, warehouseId, partyId: supplier.id, ...body });
    const posted = await post(`/purchase-invoices/${draft.id}/post`, {});
    written.purchases.push({
      id: posted.id,
      number: posted.number,
      label: body.kind === 'purchase_return' ? 'مردود شراء' : 'شراء',
    });
    return posted;
  };

  const sale = await postSale({
    label: 'البيع',
    partyId: customer.id,
    salesmanId: salesman.id,
    lines: [
      { itemId: fuel.id, quantity: '10', unitPrice: '100', taxRate: '15' },
      { itemId: jacket.id, quantity: '3', unitPrice: '50', taxRate: '15' },
    ],
  });
  check('🧾 فاتورة بيع مرحَّلة', sale.status === 'posted', `${sale.number} · ${money(sale.total)}`);

  // 💵 نقدي + 💳 شبكة — `inv.cash` و`inv.visa` عند الديسكتوب، نصف الفاتورة ونصفها.
  const accounts = list(await get('/accounts'));
  const cashAccount = accounts.find((row) => row.type === 'asset' && row.isPostable !== false) ?? accounts[0];
  const safe = await post('/cash-locations', { branchId, kind: 'safe', name: `خزينة ${stamp}`, accountId: cashAccount?.id });
  written.safeId = safe.id;
  await post(`/sales/invoices/${sale.id}/payments`, {
    method: 'cash',
    amount: '500',
    idempotencyKey: `verify-inv-cash-${stamp}`,
    cashLocationId: safe.id,
  });
  await post(`/sales/invoices/${sale.id}/payments`, {
    method: 'card',
    amount: '322.5',
    idempotencyKey: `verify-inv-card-${stamp}`,
  });
  check(
    '💵 نقدي 500 · 💳 شبكة 322.50 — «مدفوع جزئي»',
    (await get(`/sales/invoices/${sale.id}`)).paymentStatus === 'partial',
    '500.00 نقدي · 322.50 شبكة · مدفوع جزئي',
  );

  const draftReturn = await post(`/sales/invoices/${sale.id}/return`, {
    branchId,
    warehouseId,
    lines: [{ itemId: fuel.id, quantity: '2', unitPrice: '100', taxRate: '15' }],
  });
  const returned = await post(`/sales/invoices/${draftReturn.id}/post`, {});
  written.sales.push({ id: returned.id, number: returned.number, label: 'المرتجع' });
  check('↩️ مرتجع مرحَّل', returned.status === 'posted', `${returned.number} · ${money(returned.total)}`);

  const posInvoice = await postSale({
    label: 'نقطة البيع',
    cashCustomerName: `نقدي ${stamp}`,
    lines: [{ itemId: jacket.id, quantity: '1', unitPrice: '50', taxRate: '15' }],
  });
  check('🧾 فاتورة نقطة بيع', posInvoice.status === 'posted', `${posInvoice.number} · ${money(posInvoice.total)}`);

  // 📄 إشعار دائن — `inv_type = 22` in `frmRptInvNotfic`.
  const creditNote = await postSale({
    label: 'إشعار دائن',
    kind: 'credit_note',
    partyId: customer.id,
    referenceInvoiceId: sale.id,
    lines: [{ itemId: fuel.id, quantity: '1', unitPrice: '100', taxRate: '15' }],
  });
  check('📄 إشعار دائن مرحَّل', creditNote.status === 'posted', `${creditNote.number} · ${money(creditNote.total)}`);

  const purchase = await postPurchase({ lines: [{ itemId: fuel.id, quantity: '20', unitPrice: '60', taxRate: '15' }] });
  check('📥 فاتورة شراء مرحَّلة', purchase.status === 'posted', `${purchase.number} · ${money(purchase.total)}`);
  const purchaseReturn = await postPurchase({
    kind: 'purchase_return',
    referenceInvoiceId: purchase.id,
    lines: [{ itemId: fuel.id, quantity: '5', unitPrice: '60', taxRate: '15' }],
  });
  check('↩️ مردود شراء مرحَّل', purchaseReturn.status === 'posted', `${purchaseReturn.number} · ${money(purchaseReturn.total)}`);

  // ---------------------------------------------------------------------------
  console.log('\n4. 🧾 تقرير فواتير المبيعات — سطرٌ لكل فاتورة والعشر بطاقات');

  const run = await invoicesReport();
  const rows = mine(run);
  check('🧾 ثلاث فواتير — البيع والمرتجع ونقطة البيع', rows.length === 3, `${rows.length} سطر (من ${list(run.rows).length})`);

  const saleRow = rows.find((row) => Number(row.net) === 1322.5);
  check('📄 نوع الفاتورة — «فاتورة ضريبية»', saleRow?.invoice_type === 'فاتورة ضريبية', saleRow?.invoice_type ?? '—');
  check('💳 نوع الدفع — «متعدد» (نقد + شبكة)', saleRow?.payment_method === 'متعدد', saleRow?.payment_method ?? '—');
  check('💰 المدفوع 822.50', money(saleRow?.paid) === '822.50', money(saleRow?.paid));
  check('💵 نقدي 500 · شبكة 322.50', money(saleRow?.cash) === '500.00' && money(saleRow?.network) === '322.50', `${money(saleRow?.cash)} · ${money(saleRow?.network)}`);
  check('👤 العميل', saleRow?.customer === `عميل ${stamp}`, saleRow?.customer ?? '—');
  check('🧑‍💼 المندوب', saleRow?.salesman === `مندوب ${stamp}`, saleRow?.salesman ?? '—');
  check('🏪 المستودع · 🏬 الفرع · 👤 المستخدم', !!saleRow?.warehouse && !!saleRow?.branch && !!saleRow?.user_name, `${saleRow?.warehouse} · ${saleRow?.branch} · ${saleRow?.user_name}`);
  check('⏰ الوقت HH:mm:ss', /^\d{2}:\d{2}:\d{2}$/.test(String(saleRow?.time ?? '')), saleRow?.time ?? '—');
  check('📅 التاريخ', saleRow?.day === day, saleRow?.day ?? '—');
  check('🔢 المجموع 1150 · الخصم 0 · الإجمالي 1150', money(saleRow?.sum_price) === '1150.00' && money(saleRow?.discount) === '0.00' && money(saleRow?.subtotal) === '1150.00', `${money(saleRow?.sum_price)} · ${money(saleRow?.discount)} · ${money(saleRow?.subtotal)}`);
  check('🧾 الضريبة 172.50 · ضريبة إضافية 0 · إجمالي الضريبة 172.50', money(saleRow?.tax) === '172.50' && money(saleRow?.extra_tax) === '0.00' && money(saleRow?.total_tax) === '172.50', `${money(saleRow?.tax)} · ${money(saleRow?.extra_tax)} · ${money(saleRow?.total_tax)}`);

  check('🔗 رقم المرجع — «—» لفاتورةٍ لا تشير إلى غيرها', saleRow?.reference === '—', saleRow?.reference ?? '—');
  const returnRow = rows.find((row) => Number(row.net) === 230);
  check('🔗 رقم المرجع — رقم الفاتورة الأصل', returnRow?.reference === sale.number, returnRow?.reference ?? '—');
  check('📄 المرتجع — «إشعار دائن للفاتورة الضريبية»', returnRow?.invoice_type === 'إشعار دائن للفاتورة الضريبية', returnRow?.invoice_type ?? '—');
  check('💳 المرتجع — «آجل» بلا سداد', returnRow?.payment_method === 'آجل' && money(returnRow?.paid) === '0.00', `${returnRow?.payment_method} · ${money(returnRow?.paid)}`);

  const posRow = rows.find((row) => Number(row.net) === 57.5);
  check('📄 نقطة البيع — «فاتورة ضريبية مبسطة»', posRow?.invoice_type === 'فاتورة ضريبية مبسطة', posRow?.invoice_type ?? '—');
  check('👤 العميل النقدي', posRow?.customer === `نقدي ${stamp}`, posRow?.customer ?? '—');

  // 📊 ملخص النتائج — `Calc(x) = purchases.Sum(x) − returns.Sum(x)`
  check('💰 المجموع — 1150 − 200 + 50 = 1000', delta(cardOf(run, 's_sum_price'), cardOf(baseInvoices, 's_sum_price')) === 1000, money(delta(cardOf(run, 's_sum_price'), cardOf(baseInvoices, 's_sum_price'))));
  check('✂️ الخصم 0', delta(cardOf(run, 's_discount'), cardOf(baseInvoices, 's_discount')) === 0, money(delta(cardOf(run, 's_discount'), cardOf(baseInvoices, 's_discount'))));
  check('💰 الإجمالي 1000', delta(cardOf(run, 's_subtotal'), cardOf(baseInvoices, 's_subtotal')) === 1000, money(delta(cardOf(run, 's_subtotal'), cardOf(baseInvoices, 's_subtotal'))));
  check('🧾 الضريبة — 172.50 − 30 + 7.50 = 150', delta(cardOf(run, 's_tax'), cardOf(baseInvoices, 's_tax')) === 150, money(delta(cardOf(run, 's_tax'), cardOf(baseInvoices, 's_tax'))));
  check('🧾 إجمالي الضريبة 150', delta(cardOf(run, 's_total_tax'), cardOf(baseInvoices, 's_total_tax')) === 150, money(delta(cardOf(run, 's_total_tax'), cardOf(baseInvoices, 's_total_tax'))));
  check('💰 الصافي — 1322.50 − 230 + 57.50 = 1150', delta(cardOf(run, 's_net'), cardOf(baseInvoices, 's_net')) === 1150, money(delta(cardOf(run, 's_net'), cardOf(baseInvoices, 's_net'))));
  check('💵 نقدي 500', delta(cardOf(run, 's_cash'), cardOf(baseInvoices, 's_cash')) === 500, money(delta(cardOf(run, 's_cash'), cardOf(baseInvoices, 's_cash'))));
  check('💳 شبكة 322.50', delta(cardOf(run, 's_network'), cardOf(baseInvoices, 's_network')) === 322.5, money(delta(cardOf(run, 's_network'), cardOf(baseInvoices, 's_network'))));
  check('💰 المدفوع 822.50', delta(cardOf(run, 's_paid'), cardOf(baseInvoices, 's_paid')) === 822.5, money(delta(cardOf(run, 's_paid'), cardOf(baseInvoices, 's_paid'))));

  // ---------------------------------------------------------------------------
  console.log('\n5. 🔍 خيارات البحث — نوع الفاتورة · نوع العملية · حالة الدفع · نوع الدفع · الضريبة · المستودع · المندوب');

  const count = async (query) => mine(await invoicesReport(query)).length;
  check('🔄 نوع العملية — «مبيعات» 2', (await count('&procType=sale')) === 2, `${await count('&procType=sale')} سطر`);
  check('🔄 نوع العملية — «مرتجع» 1', (await count('&procType=return')) === 1, `${await count('&procType=return')} سطر`);
  check('💵 حالة الدفع — «مدفوع» 0', (await count('&paymentStatus=paid')) === 0, `${await count('&paymentStatus=paid')} سطر`);
  check('💵 حالة الدفع — «مدفوع جزئي» 1', (await count('&paymentStatus=partial')) === 1, `${await count('&paymentStatus=partial')} سطر`);
  check('💵 حالة الدفع — «غير مدفوع» 2', (await count('&paymentStatus=unpaid')) === 2, `${await count('&paymentStatus=unpaid')} سطر`);
  check('💳 نوع الدفع — «نقدية» 1', (await count('&payType=cash')) === 1, `${await count('&payType=cash')} سطر`);
  check('💳 نوع الدفع — «شبكة» 1', (await count('&payType=card')) === 1, `${await count('&payType=card')} سطر`);
  check('💳 نوع الدفع — «بنك» 0', (await count('&payType=bank')) === 0, `${await count('&payType=bank')} سطر`);
  check('💳 نوع الدفع — «آجلة» 2', (await count('&payType=credit')) === 2, `${await count('&payType=credit')} سطر`);
  check('🧾 الضريبة — «مع ضريبة» 3', (await count('&vat=with')) === 3, `${await count('&vat=with')} سطر`);
  check('🧾 الضريبة — «بدون ضريبة» 0', (await count('&vat=without')) === 0, `${await count('&vat=without')} سطر`);
  check('📄 نوع الفاتورة — «مبيعات» 2', (await count('&invType=sale')) === 2, `${await count('&invType=sale')} سطر`);
  check('📄 نوع الفاتورة — «نقطة بيع» 1', (await count('&invType=pos')) === 1, `${await count('&invType=pos')} سطر`);
  check('🏪 المستودع — «مستودع البحر» 0', (await count(`&warehouseId=${sea.id}`)) === 0, `${await count(`&warehouseId=${sea.id}`)} سطر`);
  check('🧑‍💼 المندوب — فاتورته وحدها', (await count(`&salesmanId=${salesman.id}`)) === 1, `${await count(`&salesmanId=${salesman.id}`)} سطر`);
  check('👥 العميل — فواتيره 2', (await count(`&partyId=${customer.id}`)) === 2, `${await count(`&partyId=${customer.id}`)} سطر`);

  // ---------------------------------------------------------------------------
  console.log('\n6. ⏰ «من وقت / إلى وقت» — HH:mm كما في الفترة الزمنية');

  const inDay = (query) => get(`/reports/sales-invoices-details?from=${day}&to=${day}${query}`);
  check('⏰ «من وقت 23:59» يفرغ الجدول', mine(await inDay('&fromTime=23:59')).length === 0, `${mine(await inDay('&fromTime=23:59')).length} سطر`);
  check('⏰ «إلى وقت 00:00» يفرغ الجدول', mine(await inDay('&toTime=00:00')).length === 0, `${mine(await inDay('&toTime=00:00')).length} سطر`);
  check('⏰ اليوم كله 00:00 → 23:59', mine(await inDay('&fromTime=00:00&toTime=23:59')).length === 3, `${mine(await inDay('&fromTime=00:00&toTime=23:59')).length} سطر`);

  // ---------------------------------------------------------------------------
  console.log('\n7. 🧾 تقرير مبيعات الفواتير — `inv.inv_type = 3` وحدها');

  const posRun = await posReport();
  const posRows = mine(posRun);
  check('🧾 نقطة البيع وحدها', posRows.length === 1, `${posRows.length} سطر`);
  check('📄 «فاتورة ضريبية مبسطة»', posRows[0]?.invoice_type === 'فاتورة ضريبية مبسطة', posRows[0]?.invoice_type ?? '—');
  check('💰 المجموع 50 · الضريبة 7.50 · الصافي 57.50', money(posRows[0]?.sum_price) === '50.00' && money(posRows[0]?.tax) === '7.50' && money(posRows[0]?.net) === '57.50', `${money(posRows[0]?.sum_price)} · ${money(posRows[0]?.tax)} · ${money(posRows[0]?.net)}`);
  check('💰 الصافي 57.50 في البطاقة', delta(cardOf(posRun, 's_net'), cardOf(basePos, 's_net')) === 57.5, money(delta(cardOf(posRun, 's_net'), cardOf(basePos, 's_net'))));
  check('💵 نقدي 0 — لا سداد', delta(cardOf(posRun, 's_cash'), cardOf(basePos, 's_cash')) === 0, money(delta(cardOf(posRun, 's_cash'), cardOf(basePos, 's_cash'))));

  // ---------------------------------------------------------------------------
  console.log('\n8. 📄 تقرير الإشعارات — `inv_type` 21 و22، والإشعار الدائن يخصم');

  const noteRun = await notificationsReport();
  const noteRows = mine(noteRun);
  check('📄 إشعار دائن واحد', noteRows.length === 1, `${noteRows.length} سطر`);
  check('📄 نوع الإشعار — «إشعار دائن»', noteRows[0]?.invoice_type === 'إشعار دائن', noteRows[0]?.invoice_type ?? '—');
  check('💰 المجموع 100 · الضريبة 15 · الصافي 115', money(noteRows[0]?.sum_price) === '100.00' && money(noteRows[0]?.tax) === '15.00' && money(noteRows[0]?.net) === '115.00', `${money(noteRows[0]?.sum_price)} · ${money(noteRows[0]?.tax)} · ${money(noteRows[0]?.net)}`);
  check('↩️ الإشعار الدائن يخصم — الصافي −115', delta(cardOf(noteRun, 's_net'), cardOf(baseNotifications, 's_net')) === -115, money(delta(cardOf(noteRun, 's_net'), cardOf(baseNotifications, 's_net'))));
  check('📄 «إشعار مدين» لا شيء منه', mine(await notificationsReport('&notificationType=debit')).length === 0, `${mine(await notificationsReport('&notificationType=debit')).length} سطر`);
  check('📄 «إشعار دائن» وحده', mine(await notificationsReport('&notificationType=credit')).length === 1, `${mine(await notificationsReport('&notificationType=credit')).length} سطر`);

  // ---------------------------------------------------------------------------
  console.log('\n9. 📥 تفاصيل فواتير المشتريات — «المدفوع» و«المتبقي»');

  const purchaseRun = await purchasesReport();
  const purchaseRows = mineSuppliers(purchaseRun);
  check('📥 فاتورتان — شراء ومردود', purchaseRows.length === 2, `${purchaseRows.length} سطر`);
  const buy = purchaseRows.find((row) => row.invoice_type === 'فاتورة مشتريات');
  check('🏢 المورد', buy?.supplier === `مورد ${stamp}`, buy?.supplier ?? '—');
  check('💰 المجموع 1200 · الإجمالي 1200 · الضريبة 180 · الصافي 1380', money(buy?.sum_price) === '1200.00' && money(buy?.subtotal) === '1200.00' && money(buy?.tax) === '180.00' && money(buy?.net) === '1380.00', `${money(buy?.sum_price)} · ${money(buy?.subtotal)} · ${money(buy?.tax)} · ${money(buy?.net)}`);
  check('💵 المدفوع 0 · المتبقي 1380', money(buy?.paid) === '0.00' && money(buy?.due) === '1380.00', `${money(buy?.paid)} · ${money(buy?.due)}`);
  const buyReturn = purchaseRows.find((row) => row.invoice_type === 'مردود مشتريات');
  check('↩️ مردود المشتريات — الصافي 345', money(buyReturn?.net) === '345.00', money(buyReturn?.net));
  check('🔗 رقم المرجع — فاتورة الشراء', buyReturn?.reference === buy?.number, buyReturn?.reference ?? '—');
  check('💳 نوع الدفع — «آجل» بلا سند صرف', buy?.payment_method === 'آجل', buy?.payment_method ?? '—');
  check('💰 المجموع — 1200 − 300 = 900', delta(cardOf(purchaseRun, 's_sum_price'), cardOf(basePurchases, 's_sum_price')) === 900, money(delta(cardOf(purchaseRun, 's_sum_price'), cardOf(basePurchases, 's_sum_price'))));
  check('🧾 الضريبة — 180 − 45 = 135', delta(cardOf(purchaseRun, 's_tax'), cardOf(basePurchases, 's_tax')) === 135, money(delta(cardOf(purchaseRun, 's_tax'), cardOf(basePurchases, 's_tax'))));
  check('💰 الصافي — 1380 − 345 = 1035', delta(cardOf(purchaseRun, 's_net'), cardOf(basePurchases, 's_net')) === 1035, money(delta(cardOf(purchaseRun, 's_net'), cardOf(basePurchases, 's_net'))));
  const returnsOnly = await purchasesReport('&procType=return');
  check(
    '🔄 «مرتجع» وحده — الصافي −345',
    delta(cardOf(returnsOnly, 's_net'), cardOf(basePurchaseReturns, 's_net')) === -345,
    money(delta(cardOf(returnsOnly, 's_net'), cardOf(basePurchaseReturns, 's_net'))),
  );
  check('🧾 «بدون ضريبة» لا شيء', mineSuppliers(await purchasesReport('&vat=without')).length === 0, `${mineSuppliers(await purchasesReport('&vat=without')).length} سطر`);

  // ---------------------------------------------------------------------------
  console.log('\n10. 📅 تقرير مبيعات حسب اليوم — اليوم باسمه ومجاميعه الثلاثة');

  const dailyRun = await dailySalesReport();
  const dailyRow = rowOfDay(dailyRun);
  check('📅 سطر اليوم', !!dailyRow, dailyRow ? `${dailyRow.day} · ${dailyRow.day_name}` : '—');
  check('📅 اليوم باسمه العربي', /^(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت)$/.test(String(dailyRow?.day_name ?? '')), dailyRow?.day_name ?? '—');
  check(
    '💰 الإجمالي قبل الضريبة — 1150 − 200 + 50 = 1000',
    delta(dailyRow?.before_tax, rowOfDay(baseDailySales)?.before_tax) === 1000,
    money(delta(dailyRow?.before_tax, rowOfDay(baseDailySales)?.before_tax)),
  );
  check('🧾 الضريبة 150', delta(dailyRow?.tax, rowOfDay(baseDailySales)?.tax) === 150, money(delta(dailyRow?.tax, rowOfDay(baseDailySales)?.tax)));
  check('💰 الإجمالي 1150', delta(dailyRow?.total, rowOfDay(baseDailySales)?.total) === 1150, money(delta(dailyRow?.total, rowOfDay(baseDailySales)?.total)));
  check('💰 بطاقة «الإجمالي الكلي» 1150', delta(cardOf(dailyRun, 'total'), cardOf(baseDailySales, 'total')) === 1150, money(delta(cardOf(dailyRun, 'total'), cardOf(baseDailySales, 'total'))));
  const posDaily = await dailySalesReport('&invType=pos');
  check(
    '📄 «فاتورة نقطة بيع» — الإجمالي 57.50 وحدها',
    delta(rowOfDay(posDaily)?.total, rowOfDay(baseDailyPos)?.total) === 57.5,
    money(delta(rowOfDay(posDaily)?.total, rowOfDay(baseDailyPos)?.total)),
  );
  check(
    '📄 «فاتورة نقطة بيع» — قبل الضريبة 50 · الضريبة 7.50',
    delta(rowOfDay(posDaily)?.before_tax, rowOfDay(baseDailyPos)?.before_tax) === 50 &&
      delta(rowOfDay(posDaily)?.tax, rowOfDay(baseDailyPos)?.tax) === 7.5,
    `${money(delta(rowOfDay(posDaily)?.before_tax, rowOfDay(baseDailyPos)?.before_tax))} · ${money(delta(rowOfDay(posDaily)?.tax, rowOfDay(baseDailyPos)?.tax))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n11. 🔄 تقرير الحركة اليومية — ست حركات بستة أسطر');

  const processRun = await dailyProcessReport();
  const operations = list(processRun.rows).map((row) => row.operation).join(' · ');
  check(
    '🔄 ست حركات بترتيبها',
    operations === 'مبيعات · مرتجع مبيعات · نقطة البيع · مرتجع نقطة البيع · مشتريات · مرتجع مشتريات',
    operations,
  );
  const movement = (name, field = 'total') =>
    delta(rowOfOperation(processRun, name)?.[field], rowOfOperation(baseDailyProcess, name)?.[field]);
  check('🧾 مبيعات — الإجمالي 1322.50', movement('مبيعات') === 1322.5, money(movement('مبيعات')));
  check('💵 مبيعات — نقدي 1322.50 · آجل 0 (`pay_type > 0`)', movement('مبيعات', 'cash') === 1322.5 && movement('مبيعات', 'credit') === 0, `${money(movement('مبيعات', 'cash'))} · ${money(movement('مبيعات', 'credit'))}`);
  check('↩️ مرتجع مبيعات — 230 آجل', movement('مرتجع مبيعات') === 230 && movement('مرتجع مبيعات', 'credit') === 230, `${money(movement('مرتجع مبيعات'))} · ${money(movement('مرتجع مبيعات', 'credit'))}`);
  check('🧾 نقطة البيع — 57.50 آجل', movement('نقطة البيع') === 57.5 && movement('نقطة البيع', 'credit') === 57.5, `${money(movement('نقطة البيع'))} · ${money(movement('نقطة البيع', 'credit'))}`);
  check('🚫 مرتجع نقطة البيع — 0', movement('مرتجع نقطة البيع') === 0, money(movement('مرتجع نقطة البيع')));
  check('📥 مشتريات — 1380 آجل', movement('مشتريات') === 1380 && movement('مشتريات', 'credit') === 1380, `${money(movement('مشتريات'))} · ${money(movement('مشتريات', 'credit'))}`);
  check('↩️ مرتجع مشتريات — 345', movement('مرتجع مشتريات') === 345, money(movement('مرتجع مشتريات')));
  check('🔢 عدد فواتير المبيعات', delta(rowOfOperation(processRun, 'مبيعات')?.invoices, rowOfOperation(baseDailyProcess, 'مبيعات')?.invoices) === 1, String(movement('مبيعات', 'invoices')));

  // ---------------------------------------------------------------------------
  console.log('\n12. 📊 تقرير تحليل المبيعات — المخزن · الصنف · المندوب');

  const analysisRun = await analysisReport();
  const stockRow = list(analysisRun.rows).find((row) => row.dimension === warehouseName);
  check('🏭 المخزن هو البعد الافتراضي', !!stockRow, stockRow ? `${stockRow.dimension}` : '—');
  check('🔢 صافي الكمية — 10 − 2 + 3 + 1 = 12', delta(stockRow?.net_quantity, list(baseAnalysis.rows).find((row) => row.dimension === warehouseName)?.net_quantity) === 12, money(stockRow?.net_quantity));
  check('💰 صافي الإجمالي 1000', delta(stockRow?.net_total, list(baseAnalysis.rows).find((row) => row.dimension === warehouseName)?.net_total) === 1000, money(stockRow?.net_total));
  check('💳 صافي التكلفة 480', delta(stockRow?.net_cost, list(baseAnalysis.rows).find((row) => row.dimension === warehouseName)?.net_cost) === 480, money(stockRow?.net_cost));
  check('📈 صافي الربح 520', delta(stockRow?.net_profit, list(baseAnalysis.rows).find((row) => row.dimension === warehouseName)?.net_profit) === 520, money(stockRow?.net_profit));
  check('📊 النسبتان محسوبتان لا فارغتان', Number(stockRow?.profit_to_cost ?? 0) >= 0 && Number(stockRow?.share_of_sales ?? 0) > 0, `${Number(stockRow?.profit_to_cost ?? 0).toFixed(2)}% · ${Number(stockRow?.share_of_sales ?? 0).toFixed(2)}%`);
  check('💰 بطاقة صافي الربح 520', delta(cardOf(analysisRun, 'net_profit'), cardOf(baseAnalysis, 'net_profit')) === 520, money(delta(cardOf(analysisRun, 'net_profit'), cardOf(baseAnalysis, 'net_profit'))));

  // 👥 «العميل» يقيد التحليل بفواتير هذا التشغيل وحدها، فتُقرأ النسبتان كما هي.
  const byItemRun = await analysisReport(`&dimension=item&partyId=${customer.id}`);
  const itemRows = mineItems(byItemRun);
  const fuelRow = itemRows.find((row) => row.dimension === `وقود ${stamp}`);
  const jacketRow = itemRows.find((row) => row.dimension === `سترة ${stamp}`);
  check('📦 صنفان', itemRows.length === 2, `${itemRows.length} سطر`);
  check('⛽ وقود — 8 وحدات · 800 · تكلفة 320 · ربح 480', Number(fuelRow?.net_quantity) === 8 && money(fuelRow?.net_total) === '800.00' && money(fuelRow?.net_cost) === '320.00' && money(fuelRow?.net_profit) === '480.00', `${fuelRow?.net_quantity} · ${money(fuelRow?.net_total)} · ${money(fuelRow?.net_cost)} · ${money(fuelRow?.net_profit)}`);
  check('📊 نسبة الربح للتكلفة 150%', money(fuelRow?.profit_to_cost) === '150.00', `${money(fuelRow?.profit_to_cost)}%`);
  check('📊 نسبة الاجمالي لإجمالي البيع 84.21%', money(fuelRow?.share_of_sales) === '84.21', `${money(fuelRow?.share_of_sales)}%`);
  check('📊 نسبة الربح لإجمالي الربح 94.12%', money(fuelRow?.share_of_profit) === '94.12', `${money(fuelRow?.share_of_profit)}%`);
  check('🧥 سترة — 3 وحدات · 150 · تكلفة 120 · ربح 30', Number(jacketRow?.net_quantity) === 3 && money(jacketRow?.net_total) === '150.00' && money(jacketRow?.net_profit) === '30.00', `${jacketRow?.net_quantity} · ${money(jacketRow?.net_total)} · ${money(jacketRow?.net_profit)}`);
  check('📊 نسبتا السترة — 15.79% و5.88%', money(jacketRow?.share_of_sales) === '15.79' && money(jacketRow?.share_of_profit) === '5.88', `${money(jacketRow?.share_of_sales)}% · ${money(jacketRow?.share_of_profit)}%`);

  const bySalesmanRun = await analysisReport('&dimension=salesman');
  const salesmanRow = list(bySalesmanRun.rows).find((row) => row.dimension === `مندوب ${stamp}`);
  check('🧑‍💼 مندوب البيع — 1150 وحده', money(salesmanRow?.net_total) === '1150.00', money(salesmanRow?.net_total));
  check('🚫 بلا مندوب — المرتجع ونقطة البيع −150', Number(list(bySalesmanRun.rows).find((row) => row.dimension === '—')?.net_total ?? 0) !== 0, money(list(bySalesmanRun.rows).find((row) => row.dimension === '—')?.net_total));

  const byDayRun = await analysisReport('&dimension=day');
  check('📅 اليوم — سطر واحد', list(byDayRun.rows).some((row) => row.dimension === day), list(byDayRun.rows).map((row) => row.dimension).join(' · '));
  const byCategoryRun = await analysisReport(`&dimension=category&categoryId=${gear.id}&partyId=${customer.id}`);
  check('🗂️ مجموعة الصنف — «معدات» وحدها', mineItems(byCategoryRun).length === 1, mineItems(byCategoryRun).map((row) => row.dimension).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n13. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر');

  const emptyPeriod = 'from=2001-01-01&to=2001-01-31';
  const emptyInvoices = await get(`/reports/sales-invoices-details?${emptyPeriod}`);
  check('🧾 لا فواتير', list(emptyInvoices.rows).length === 0, `${list(emptyInvoices.rows).length} سطر`);
  check('💰 الصافي صفر', Number(cardOf(emptyInvoices, 's_net')) === 0, money(cardOf(emptyInvoices, 's_net')));
  check('💰 المدفوع صفر', Number(cardOf(emptyInvoices, 's_paid')) === 0, money(cardOf(emptyInvoices, 's_paid')));
  const emptyDaily = await get(`/reports/daily-sales?${emptyPeriod}`);
  check('📅 لا أيام', list(emptyDaily.rows).length === 0, `${list(emptyDaily.rows).length} سطر`);
  check('💰 «الإجمالي الكلي» صفر', Number(cardOf(emptyDaily, 'total')) === 0, money(cardOf(emptyDaily, 'total')));
  const emptyProcess = await get(`/reports/daily-process?${emptyPeriod}`);
  check('🔄 الحركة اليومية — ستة أسطر ولو بلا حركة', list(emptyProcess.rows).length === 6, `${list(emptyProcess.rows).length} سطر`);
  check('🔄 كلها أصفار', list(emptyProcess.rows).every((row) => Number(row.total) === 0), list(emptyProcess.rows).map((row) => money(row.total)).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n14. 🖨️ طباعة — البطاقات في شريطٍ واحد');

  const printed = await get(`/reports/print/sales-invoices-details?from=${from}&to=${to}`);
  const html = String(printed.html ?? '');
  check('🖨️ صفحة HTML', html.startsWith('<!doctype html>'), `${html.length} حرفاً`);
  check('📄 عنوان التقرير', html.includes('تقرير فواتير المبيعات'), 'frmRptInvSalesDetails');
  check('📊 أعمدة الشبكة', html.includes('نوع الفاتورة') && html.includes('رقم المرجع') && html.includes('إجمالي الضريبة') && html.includes('الصافي'), 'RptInvSalesDetails.repx');
  check('👤 المستخدم', html.includes('المستخدم:'), 'Common.GetEmpName(EmpNo)');
  check('✍️ أعده · راجعه · المدير', html.includes('أعده') && html.includes('راجعه') && html.includes('المدير'), 'footer.repx');
  check('💰 البطاقات العشر مطبوعة', ['المجموع', 'الخصم', 'الإجمالي', 'الضريبة', 'إجمالي الضريبة', 'الصافي', 'نقدي', 'شبكة', 'المدفوع'].every((label) => html.includes(label)), 'UpdateSummaryCards');
  check('📅 الفترة', html.includes('الفترة: من'), 'FromDate · ToDate');

  const noteHtml = String((await get(`/reports/print/sales-notifications?from=${from}&to=${to}`)).html ?? '');
  check('📄 عنوان الإشعارات', noteHtml.includes('تقرير الإشعارات'), 'frmRptInvNotfic');
  const purchaseHtml = String((await get(`/reports/print/purchase-invoices-details?from=${from}&to=${to}`)).html ?? '');
  check('📥 عنوان المشتريات و«المتبقي»', purchaseHtml.includes('تفاصيل فواتير المشتريات') && purchaseHtml.includes('المتبقي'), 'frmRptInvPurchaseDetails');
  const dailyHtml = String((await get(`/reports/print/daily-sales?from=${from}&to=${to}`)).html ?? '');
  check('📅 «إجمالي قبل الضريبة» مطبوع', dailyHtml.includes('إجمالي قبل الضريبة'), 'SalesByDay');
  const analysisHtml = String((await get(`/reports/print/sales-inv-analysis?from=${from}&to=${to}`)).html ?? '');
  check('📊 «نسبة الربح للتكلفة» مطبوعة', analysisHtml.includes('نسبة الربح للتكلفة'), 'frmRptInvAnalysis');

  // ---------------------------------------------------------------------------
  console.log('\n15. التصدير — CSV وXLSX');

  const csv = await post(`/reports/sales-invoices-details/export?from=${from}&to=${to}`, { format: 'csv' });
  check('📄 CSV بالعناوين العربية', String(csv.content ?? '').includes('إجمالي الضريبة'), `${csv.rows} سطر`);
  const xlsx = await post(`/reports/sales-invoices-details/export?from=${from}&to=${to}`, { format: 'xlsx' });
  check('📗 XLSX', xlsx.encoding === 'base64' && String(xlsx.filename).endsWith('.xlsx'), xlsx.filename);
  const processCsv = await post(`/reports/daily-process/export?from=${from}&to=${to}`, { format: 'csv' });
  check('📄 CSV الحركة اليومية', String(processCsv.content ?? '').includes('عدد الفواتير'), `${processCsv.rows} سطر`);
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n16. التنظيف — لا أثر لهذا التشغيل');

  // المردودات أولاً: إلغاؤها يعيد الكميات قبل إلغاء أصولها.
  let voided = 0;
  for (const group of [
    { path: '/purchase-invoices', rows: [...written.purchases].reverse() },
    { path: '/sales/invoices', rows: [...written.sales].reverse() },
  ]) {
    for (const document of group.rows) {
      const result = await refused('post', `${group.path}/${document.id}/void`, { reason: `تحقق ${stamp}` });
      if (result.status === 200) voided += 1;
      // 💵 قاعدة الدفاتر: فاتورةٌ مسدَّدة لا تُلغى (`SALES_VOID_HAS_PAYMENTS`).
      else
        check(
          `↩️ ${document.label} — قاعدة الدفاتر`,
          result.status === 409 && result.code === 'SALES_VOID_HAS_PAYMENTS',
          `${result.status} ${result.code}`,
        );
    }
  }
  check('↩️ أُلغي ما يُلغى', voided === 5, `${voided} من ${written.sales.length + written.purchases.length}`);

  for (const id of written.itemIds) if (id) await del(`/organization/catalog/items/${id}`).catch(() => {});
  if (written.warehouseId) await del(`/warehouses/${written.warehouseId}`).catch(() => {});
  if (written.unitId) await del(`/organization/catalog/units/${written.unitId}`).catch(() => {});
  if (written.gearId) await del(`/organization/catalog/categories/${written.gearId}`).catch(() => {});
  if (written.rigId) await del(`/organization/catalog/categories/${written.rigId}`).catch(() => {});
  if (written.salesmanId) await del(`/sales/salesmen/${written.salesmanId}`).catch(() => {});
  if (written.safeId) await del(`/cash-locations/${written.safeId}`).catch(() => {});
  console.log('  ✓ الأصناف والمستودع والوحدة والمجموعتان والمندوب والخزينة');

  // الفاتورة المدفوعة وحدها تبقى — قاعدة الدفاتر تمنع إلغاءها، كما في جزءٍ أول.
  const numbers = new Set([...written.sales, ...written.purchases].map((document) => document.number));
  const left = list((await invoicesReport()).rows).filter((row) => numbers.has(row.number));
  check('لم يبقَ إلا الفاتورة المدفوعة', left.length === 1, left.map((row) => row.number).join(' · '));
  const leftNotes = mine(await notificationsReport());
  check('لا إشعار باقٍ', leftNotes.length === 0, leftNotes.map((row) => row.number).join(' · '));
}

console.log(`\n${failures === 0 ? '✔' : '✘'} 🧾 تقارير الفواتير والإشعارات والحركة اليومية — ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
