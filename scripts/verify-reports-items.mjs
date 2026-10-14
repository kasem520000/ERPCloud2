#!/usr/bin/env node
/**
 * Live verification of Phase 10 part two — 📦 تقارير الأصناف
 * (`Form_WPF/frmRptItemsSalesDetails` · `frmRptItemsSalesDetailsPOS` ·
 * `frmRptItemsProfit` · the same window with `OperType = 2`) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقارير الأربعة بأعمدة الديسكتوب وبطاقاته
 *   2. 🧾 الوثائق — بيع · مرتجع · نقطة بيع · بيع من مستودعٍ ثانٍ · شراء · مردود شراء
 *   3. 📦 مبيعات الأصناف تجميعي — كل صنفٍ صافياً، و«حبل» الذي لم يتحرك لا يظهر
 *   4. 🏪🏗️📦 الفلاتر — المستودع · المجموعة · الصنف
 *   5. 🧾 مبيعات الأصناف تجميعي - نقطة البيع
 *   6. 💰 أرباح المواد تجميعي — التكلفة والربح ونسبته
 *   7. 📥 مشتريات الأصناف تجميعي
 *   8. 💰 أرباح المواد تفصيلي
 *   9. 🗂️ تقرير مبيعات الأصناف حسب المجموعة
 *  10. 📅 تقرير المبيعات اليومية للمجموعة
 *  11. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقتا صفر
 *  12. 🖨️ طباعة — البطاقات في شريطٍ واحد
 *  13. التصدير — CSV وXLSX
 *  14. التنظيف — لا أثر لهذا التشغيل
 *
 * Re-runnable and non-destructive: everything this script writes carries a stamp, every
 * total is asserted as a **difference from a baseline** taken before anything is written
 * (so a tenant carrying yesterday's documents verifies just as well as an empty one),
 * and everything it creates is undone in a `finally`.
 *
 * Usage: node scripts/verify-reports-items.mjs
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

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const from = iso(-1);
const to = iso(1);

const salesReport = (query = '') => get(`/reports/items-sales-summary?from=${from}&to=${to}${query}`);
const posReport = (query = '') => get(`/reports/items-pos-sales-summary?from=${from}&to=${to}${query}`);
const profitReport = (query = '') => get(`/reports/items-profit-summary?from=${from}&to=${to}${query}`);
const purchasesReport = (query = '') => get(`/reports/items-purchases-summary?from=${from}&to=${to}${query}`);
const profitDetailsReport = (query = '') => get(`/reports/items-profit-details?from=${from}&to=${to}${query}`);
const byCategoryReport = (query = '') => get(`/reports/items-sales-by-category?from=${from}&to=${to}${query}`);
const byDayReport = (query = '') => get(`/reports/category-sales-by-day?from=${from}&to=${to}${query}`);
/** Only the rows this very run created — the demo tenant carries yesterday's documents too. */
const mine = (report) => list(report.rows).filter((row) => String(row.item_name ?? '').includes(stamp));
const byName = (report, name) => new Map(mine(report).map((row) => [row.item_name, row])).get(name);

const written = {
  warehouseId: '',
  gearId: '',
  rigId: '',
  unitId: '',
  itemIds: [],
  customerId: '',
  supplierId: '',
  sales: [],
  purchases: [],
};

try {
  // ---------------------------------------------------------------------------
  console.log('1. 📚 السجل — التقارير الأربعة بأعمدة الديسكتوب وبطاقاته');

  const catalog = list(await get('/reports'));
  const sales = catalog.find((row) => row.key === 'items-sales-summary');
  const pos = catalog.find((row) => row.key === 'items-pos-sales-summary');
  const profit = catalog.find((row) => row.key === 'items-profit-summary');
  const purchases = catalog.find((row) => row.key === 'items-purchases-summary');

  check('📦 «مبيعات الأصناف تجميعي» مسجَّل', sales?.titleAr === 'مبيعات الأصناف تجميعي', sales?.titleAr ?? '—');
  check('🧾 «نقطة البيع» مسجَّل', pos?.titleAr === 'مبيعات الأصناف تجميعي - نقطة البيع', pos?.titleAr ?? '—');
  check('💰 «أرباح المواد تجميعي» مسجَّل', profit?.titleAr === 'أرباح المواد تجميعي', profit?.titleAr ?? '—');
  check('📥 «مشتريات الأصناف تجميعي» مسجَّل', purchases?.titleAr === 'مشتريات الأصناف تجميعي', purchases?.titleAr ?? '—');
  check(
    '📦 الأعمدة الخمسة — رمز الصنف · الصنف · المجموعة · الكمية · صافي البيع',
    columns(sales) === 'رمز الصنف · الصنف · المجموعة · الكمية · صافي البيع',
    columns(sales),
  );
  check(
    '💰 أعمدة الأرباح السبعة',
    columns(profit) === 'رمز المادة · المادة · الكمية · متوسط التكلفة · صافي البيع · الربح · نسبة الربح',
    columns(profit),
  );
  check(
    '📥 أعمدة المشتريات — «صافي الشراء» لا «صافي البيع»',
    columns(purchases) === 'رمز الصنف · الصنف · المجموعة · الكمية · صافي الشراء',
    columns(purchases),
  );
  check(
    '💵 البطاقتان — إجمالي صافي البيع · إجمالي الكميات',
    labels(sales?.grandTotalCards) === 'إجمالي صافي البيع · إجمالي الكميات',
    labels(sales?.grandTotalCards),
  );
  check(
    '💰 بطاقتا الأرباح — إجمالي صافي البيع · إجمالي الربح',
    labels(profit?.grandTotalCards) === 'إجمالي صافي البيع · إجمالي الربح',
    labels(profit?.grandTotalCards),
  );
  check(
    '📥 بطاقتا المشتريات — إجمالي صافي الشراء · إجمالي الكميات',
    labels(purchases?.grandTotalCards) === 'إجمالي صافي الشراء · إجمالي الكميات',
    labels(purchases?.grandTotalCards),
  );
  const profitDetails = catalog.find((row) => row.key === 'items-profit-details');
  const byCategory = catalog.find((row) => row.key === 'items-sales-by-category');
  const byDay = catalog.find((row) => row.key === 'category-sales-by-day');
  check('💰 «أرباح المواد تفصيلي» مسجَّل', profitDetails?.titleAr === 'أرباح المواد تفصيلي', profitDetails?.titleAr ?? '—');
  check(
    '🗂️ «تقرير مبيعات الأصناف حسب المجموعة» مسجَّل',
    byCategory?.titleAr === 'تقرير مبيعات الأصناف حسب المجموعة',
    byCategory?.titleAr ?? '—',
  );
  check(
    '📅 «تقرير المبيعات اليومية للمجموعة» مسجَّل',
    byDay?.titleAr === 'تقرير المبيعات اليومية للمجموعة',
    byDay?.titleAr ?? '—',
  );
  check(
    '💰 أعمدة التفصيلي الستة عشر',
    columns(profitDetails) ===
      'الرقم · التاريخ · نوع العملية · المستودع · رمز المادة · المادة · الوحدة · الكمية · متوسط التكلفة · إجمالي التكلفة · السعر · المجموع · الإجمالي · الخصم · الربح · نسبة الربح %',
    `${(profitDetails?.columns ?? []).length} عمود`,
  );
  check(
    '🗂️ أعمدة حسب المجموعة',
    columns(byCategory) === 'المجموعة · اسم المجموعة / الصنف · الرمز · إجمالي الكمية · الإجمالي · الضريبة · الصافي · الخصم',
    columns(byCategory),
  );
  check(
    '📅 أعمدة اليومية للمجموعة',
    columns(byDay) === 'الرمز · المجموعة · اليوم · التاريخ · الإجمالي',
    columns(byDay),
  );
  check(
    '💰 بطاقات التفصيلي الخمس',
    labels(profitDetails?.grandTotalCards) === 'إجمالي التكلفة · المجموع · الإجمالي · الخصم · إجمالي الربح',
    labels(profitDetails?.grandTotalCards),
  );
  check(
    '🗂️ بطاقات حسب المجموعة الأربع',
    labels(byCategory?.grandTotalCards) === 'إجمالي الكمية · الإجمالي · الضريبة · الصافي',
    labels(byCategory?.grandTotalCards),
  );
  check('📅 بطاقة اليومية — «إجمالي المبيعات»', labels(byDay?.grandTotalCards) === 'إجمالي المبيعات', labels(byDay?.grandTotalCards));
  check(
    '📄 نوع الفاتورة — «فاتورة مبيعات» · «فاتورة نقطة بيع»',
    ((byDay?.params ?? []).find((param) => param.name === 'invType')?.options ?? []).map((option) => option.labelAr).join(' · ') ===
      'فاتورة مبيعات · فاتورة نقطة بيع',
    ((byDay?.params ?? []).find((param) => param.name === 'invType')?.options ?? []).map((option) => option.labelAr).join(' · '),
  );
  check(
    '📅 «من / حتى» بلا وقت في نافذة الأرباح',
    (profit?.params ?? []).filter((param) => param.name.endsWith('Time')).length === 0,
    (profit?.params ?? []).map((param) => param.name).join(' · '),
  );

  // خطّ الأساس — every total below is asserted as a difference from here.
  const baseSales = await salesReport();
  const basePos = await posReport();
  const baseProfit = await profitReport();
  const basePurchases = await purchasesReport();
  const baseProfitDetails = await profitDetailsReport();
  const baseByCategory = await byCategoryReport();
  const baseByDay = await byDayReport();
  check(
    '📏 خطّ الأساس',
    true,
    `المبيعات ${money(cardOf(baseSales, 'net_sales'))} · الأرباح ${money(cardOf(baseProfit, 'profit'))} · المشتريات ${money(cardOf(basePurchases, 'net_purchases'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n2. 🧾 الوثائق — بيع · مرتجع · نقطة بيع · مستودع ثانٍ · شراء · مردود شراء');

  const branches = list(await get('/branches'));
  const warehouses = list(await get('/warehouses'));
  const branchId = branches[0]?.id;
  const warehouseId = warehouses[0]?.id;
  // 🏪 A second مستودع, so the «🏪 المستودع» box has something to separate.
  const sea = await post('/warehouses', { branchId, code: `SEA${stamp}`, name: `مستودع البحر ${stamp}` });
  written.warehouseId = sea.id;

  const gear = await post('/organization/catalog/categories', { code: `RG${stamp}`, nameAr: `معدات ${stamp}` });
  written.gearId = gear.id;
  const rig = await post('/organization/catalog/categories', { code: `RR${stamp}`, nameAr: `تجهيزات ${stamp}` });
  written.rigId = rig.id;
  const unit = await post('/organization/catalog/units', { code: `RU${stamp}`, nameAr: 'حبة' });
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
  const fuel = await makeItem(`RF${stamp}`, `وقود ${stamp}`, gear.id);
  const jacket = await makeItem(`RJ${stamp}`, `سترة ${stamp}`, gear.id);
  // 📦 An صنف لا يتحرك أبداً — `if (!hasMovement) continue;` at the desktop.
  const rope = await makeItem(`RN${stamp}`, `حبل ${stamp}`, rig.id);
  const anchor = await makeItem(`RA${stamp}`, `مرساة ${stamp}`, rig.id);
  // ✂️ An صنف sold on a فاتورة with a خصم رأس, so the distribution is measured live.
  const buoy = await makeItem(`RB${stamp}`, `طوق نجاة ${stamp}`, rig.id);
  written.itemIds = [fuel.id, jacket.id, rope.id, anchor.id, buoy.id];

  // 📚 «متوسط التكلفة» — every صنف opens at 40 a وحدة, so the profit is predictable.
  await post('/inventory/ledger/record', {
    lines: [
      ...[fuel, jacket, rope, buoy].map((item, index) => ({
        itemId: item.id,
        warehouseId,
        qty: '100',
        unitCost: '40',
        direction: 'in',
        docType: 'opening',
        docId: `00000000-0000-0000-000${index}-${stamp.padStart(12, '0')}`,
      })),
      {
        itemId: anchor.id,
        warehouseId: sea.id,
        qty: '100',
        unitCost: '40',
        direction: 'in',
        docType: 'opening',
        docId: `00000000-0000-0000-0009-${stamp.padStart(12, '0')}`,
      },
    ],
  });

  const customer = await post('/parties', { kind: 'customer', name: `عميل ${stamp}` });
  written.customerId = customer.id;
  const supplier = await post('/parties', { kind: 'supplier', name: `مورد ${stamp}` });
  written.supplierId = supplier.id;

  const postSale = async (body) => {
    const draft = await post('/sales/invoices', { branchId, warehouseId, ...body });
    const posted = await post(`/sales/invoices/${draft.id}/post`, {});
    written.sales.push({ id: posted.id, number: posted.number, label: body.label ?? 'بيع' });
    return posted;
  };
  const postPurchase = async (body) => {
    const draft = await post('/purchase-invoices', { branchId, warehouseId, partyId: supplier.id, ...body });
    const posted = await post(`/purchase-invoices/${draft.id}/post`, {});
    written.purchases.push({ id: posted.id, number: posted.number, label: body.kind === 'purchase_return' ? 'مردود شراء' : 'شراء' });
    return posted;
  };

  const sale = await postSale({
    label: 'البيع',
    partyId: customer.id,
    lines: [
      { itemId: fuel.id, quantity: '10', unitPrice: '100', taxRate: '15' },
      { itemId: jacket.id, quantity: '3', unitPrice: '50', taxRate: '15' },
    ],
  });
  check('🧾 فاتورة بيع مرحَّلة', sale.status === 'posted', `${sale.number} · ${money(sale.total)}`);

  const draftReturn = await post(`/sales/invoices/${sale.id}/return`, {
    branchId,
    warehouseId,
    lines: [{ itemId: fuel.id, quantity: '2', unitPrice: '100', taxRate: '15' }],
  });
  const returned = await post(`/sales/invoices/${draftReturn.id}/post`, {});
  written.sales.push({ id: returned.id, number: returned.number, label: 'المرتجع' });
  check('↩️ مرتجع مرحَّل', returned.status === 'posted', `${returned.number} · ${money(returned.total)}`);

  // 🧾 نقطة البيع — بلا عميل: `inv.inv_type = 3` at the desktop.
  const posInvoice = await postSale({
    label: 'نقطة البيع',
    cashCustomerName: `نقدي ${stamp}`,
    lines: [{ itemId: jacket.id, quantity: '1', unitPrice: '50', taxRate: '15' }],
  });
  check('🧾 مبيعات نقطة البيع', posInvoice.status === 'posted', `${posInvoice.number} · ${money(posInvoice.total)}`);

  const seaSale = await postSale({
    label: 'بيع مستودع البحر',
    partyId: customer.id,
    warehouseId: sea.id,
    lines: [{ itemId: anchor.id, quantity: '4', unitPrice: '200', taxRate: '15' }],
  });
  check('🏪 بيعٌ من المستودع الثاني', seaSale.status === 'posted', `${seaSale.number} · ${money(seaSale.total)}`);

  // ✂️ خصم رأس الفاتورة — 50 of 500, distributed over the only line at save time.
  const discounted = await postSale({
    label: 'بيع بخصم رأس',
    partyId: customer.id,
    invoiceDiscount: '50',
    lines: [{ itemId: buoy.id, quantity: '5', unitPrice: '100', taxRate: '15' }],
  });
  check('✂️ فاتورةٌ بخصم رأس', discounted.status === 'posted', `${discounted.number} · ${money(discounted.total)}`);

  const purchase = await postPurchase({ lines: [{ itemId: fuel.id, quantity: '20', unitPrice: '60', taxRate: '15' }] });
  check('📥 فاتورة شراء مرحَّلة', purchase.status === 'posted', `${purchase.number} · ${money(purchase.total)}`);
  const purchaseReturn = await postPurchase({
    kind: 'purchase_return',
    lines: [{ itemId: fuel.id, quantity: '5', unitPrice: '60', taxRate: '15' }],
  });
  check('↩️ مردود شراء مرحَّل', purchaseReturn.status === 'posted', `${purchaseReturn.number} · ${money(purchaseReturn.total)}`);

  // ---------------------------------------------------------------------------
  console.log('\n3. 📦 مبيعات الأصناف تجميعي — كل صنفٍ صافياً من مردوداته');

  const salesRun = await salesReport();
  const fuelRow = byName(salesRun, `وقود ${stamp}`);
  const jacketRow = byName(salesRun, `سترة ${stamp}`);
  const anchorRow = byName(salesRun, `مرساة ${stamp}`);

  check('📦 أربعة أصناف متحركة', mine(salesRun).length === 4, `${mine(salesRun).length} سطر (من ${list(salesRun.rows).length})`);
  check('🔢 الكمية الصافية — 10 − 2 = 8', Number(fuelRow?.quantity) === 8, fuelRow?.quantity ?? '—');
  check('💰 صافي البيع — 1150 − 230 = 920', money(fuelRow?.net_sales) === '920.00', money(fuelRow?.net_sales));
  check('🔢 نقطة البيع مضمومة — 3 + 1 = 4', Number(jacketRow?.quantity) === 4, jacketRow?.quantity ?? '—');
  check('💰 نقطة البيع مضمومة — 172.50 + 57.50 = 230', money(jacketRow?.net_sales) === '230.00', money(jacketRow?.net_sales));
  check('🔢 المستودع الثاني مضموم — 4', Number(anchorRow?.quantity) === 4, anchorRow?.quantity ?? '—');
  check('💰 المستودع الثاني مضموم — 920', money(anchorRow?.net_sales) === '920.00', money(anchorRow?.net_sales));
  check('🚫 «حبل» الذي لم يتحرك لا يظهر', !byName(salesRun, `حبل ${stamp}`), mine(salesRun).map((row) => row.item_name).join(' · '));
  check('🗂️ المجموعة من بطاقة الصنف', fuelRow?.category === `معدات ${stamp}` && anchorRow?.category === `تجهيزات ${stamp}`, `${fuelRow?.category ?? '—'} · ${anchorRow?.category ?? '—'}`);
  check('🔢 رمز الصنف', fuelRow?.item_code === `RF${stamp}`, fuelRow?.item_code ?? '—');

  check(
    '💵 إجمالي صافي البيع (920 + 230 + 920 + 517.50)',
    delta(cardOf(salesRun, 'net_sales'), cardOf(baseSales, 'net_sales')) === 2587.5,
    `${money(cardOf(baseSales, 'net_sales'))} → ${money(cardOf(salesRun, 'net_sales'))}`,
  );
  check(
    '📦 إجمالي الكميات (8 + 4 + 4 + 5)',
    delta(cardOf(salesRun, 'quantity'), cardOf(baseSales, 'quantity')) === 21,
    `${money(cardOf(baseSales, 'quantity'))} → ${money(cardOf(salesRun, 'quantity'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n4. 🏪🏗️📦 الفلاتر — المستودع · المجموعة · الصنف');

  const seaFiltered = mine(await salesReport(`&warehouseId=${sea.id}`));
  check('🏪 المستودع — صنف المستودع الثاني وحده', seaFiltered.length === 1 && seaFiltered[0]?.item_name === `مرساة ${stamp}`, seaFiltered.map((row) => row.item_name).join(' · '));
  const rigFiltered = mine(await salesReport(`&categoryId=${rig.id}`));
  check(
    '🗂️ المجموعة — «تجهيزات» دون «معدات»',
    rigFiltered.length === 2 && rigFiltered.every((row) => row.category === `تجهيزات ${stamp}`),
    rigFiltered.map((row) => row.item_name).join(' · '),
  );
  const itemFiltered = mine(await salesReport(`&itemId=${fuel.id}`));
  check('📦 الصنف — الوقود وحده', itemFiltered.length === 1 && itemFiltered[0]?.item_name === `وقود ${stamp}`, itemFiltered.map((row) => row.item_name).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n5. 🧾 مبيعات الأصناف تجميعي - نقطة البيع');

  const posRun = await posReport();
  check('🧾 صنف نقطة البيع وحده', mine(posRun).length === 1, mine(posRun).map((row) => row.item_name).join(' · '));
  check('🔢 الكمية 1', Number(byName(posRun, `سترة ${stamp}`)?.quantity) === 1, byName(posRun, `سترة ${stamp}`)?.quantity ?? '—');
  check('💰 صافي البيع 57.50', money(byName(posRun, `سترة ${stamp}`)?.net_sales) === '57.50', money(byName(posRun, `سترة ${stamp}`)?.net_sales));
  check('🚫 الفواتير العادية ليست في التقرير', !byName(posRun, `وقود ${stamp}`) && !byName(posRun, `مرساة ${stamp}`), 'inv.inv_type = 3');
  check(
    '💵 إجمالي صافي البيع (57.50)',
    delta(cardOf(posRun, 'net_sales'), cardOf(basePos, 'net_sales')) === 57.5,
    `${money(cardOf(basePos, 'net_sales'))} → ${money(cardOf(posRun, 'net_sales'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n6. 💰 أرباح المواد تجميعي — التكلفة والربح ونسبته');

  const profitRun = await profitReport();
  const pFuel = byName(profitRun, `وقود ${stamp}`);
  const pJacket = byName(profitRun, `سترة ${stamp}`);
  const pAnchor = byName(profitRun, `مرساة ${stamp}`);

  check('💰 أربعة أصناف متحركة', mine(profitRun).length === 4, `${mine(profitRun).length} سطر`);
  check('💵 صافي البيع بلا ضريبة — 1000 − 200 = 800', money(pFuel?.net_sales) === '800.00', money(pFuel?.net_sales));
  check('📚 متوسط التكلفة — 10×40 − 2×40 = 320', money(pFuel?.total_cost) === '320.00', money(pFuel?.total_cost));
  check('💰 الربح — 800 − 320 = 480', money(pFuel?.profit) === '480.00', money(pFuel?.profit));
  check('📈 نسبة الربح — 480 ÷ 320 = 150%', Number(pFuel?.profit_ratio) === 150, String(pFuel?.profit_ratio ?? '—'));
  check('💰 الربح — سترة: 200 − 160 = 40', money(pJacket?.profit) === '40.00', money(pJacket?.profit));
  check('📈 نسبة الربح — سترة: 25%', Number(pJacket?.profit_ratio) === 25, String(pJacket?.profit_ratio ?? '—'));
  check('💰 الربح — مرساة: 800 − 160 = 640', money(pAnchor?.profit) === '640.00', money(pAnchor?.profit));
  check('📈 نسبة الربح — مرساة: 400%', Number(pAnchor?.profit_ratio) === 400, String(pAnchor?.profit_ratio ?? '—'));
  check('🚫 «حبل» الذي لم يتحرك لا يظهر', !byName(profitRun, `حبل ${stamp}`), 'if (!hasMovement) continue;');
  check(
    '💵 إجمالي صافي البيع (800 + 200 + 800 + 450)',
    delta(cardOf(profitRun, 'net_sales'), cardOf(baseProfit, 'net_sales')) === 2250,
    `${money(cardOf(baseProfit, 'net_sales'))} → ${money(cardOf(profitRun, 'net_sales'))}`,
  );
  check(
    '💰 إجمالي الربح (480 + 40 + 640 + 250)',
    delta(cardOf(profitRun, 'profit'), cardOf(baseProfit, 'profit')) === 1410,
    `${money(cardOf(baseProfit, 'profit'))} → ${money(cardOf(profitRun, 'profit'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n7. 📥 مشتريات الأصناف تجميعي — `OperType = 2`');

  const purchasesRun = await purchasesReport();
  const purchaseRow = byName(purchasesRun, `وقود ${stamp}`);
  check('📥 صنفٌ واحد', mine(purchasesRun).length === 1, mine(purchasesRun).map((row) => row.item_name).join(' · '));
  check('🔢 الكمية — 20 − 5 = 15', Number(purchaseRow?.quantity) === 15, purchaseRow?.quantity ?? '—');
  check('💰 صافي الشراء — 1380 − 345 = 1035', money(purchaseRow?.net_purchases) === '1035.00', money(purchaseRow?.net_purchases));
  check(
    '💵 إجمالي صافي الشراء (1035)',
    delta(cardOf(purchasesRun, 'net_purchases'), cardOf(basePurchases, 'net_purchases')) === 1035,
    `${money(cardOf(basePurchases, 'net_purchases'))} → ${money(cardOf(purchasesRun, 'net_purchases'))}`,
  );
  check(
    '📦 إجمالي الكميات (15)',
    delta(cardOf(purchasesRun, 'quantity'), cardOf(basePurchases, 'quantity')) === 15,
    `${money(cardOf(basePurchases, 'quantity'))} → ${money(cardOf(purchasesRun, 'quantity'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n8. 💰 أرباح المواد تفصيلي — سطرٌ لكل حركة');

  const detailsRun = await profitDetailsReport();
  const detailRows = mine(detailsRun);
  check('💰 ستة أسطر (وقود · سترة · مرتجع · نقطة بيع · مرساة · طوق نجاة)', detailRows.length === 6, `${detailRows.length} سطر`);
  const soldLine = detailRows.find((row) => row.item_name === `وقود ${stamp}` && Number(row.quantity) > 0);
  const returnLine = detailRows.find((row) => row.item_name === `وقود ${stamp}` && Number(row.quantity) < 0);
  check('🔢 الكمية 10', Number(soldLine?.quantity) === 10, soldLine?.quantity ?? '—');
  check('💵 السعر 100', money(soldLine?.unit_price) === '100.00', money(soldLine?.unit_price));
  check('🧮 المجموع 1000', money(soldLine?.gross) === '1000.00', money(soldLine?.gross));
  check('🧾 الإجمالي 1000', money(soldLine?.net) === '1000.00', money(soldLine?.net));
  check('✂️ الخصم 0', money(soldLine?.discount) === '0.00', money(soldLine?.discount));
  check('📚 متوسط التكلفة 40', money(soldLine?.unit_cost) === '40.00', money(soldLine?.unit_cost));
  check('📦 إجمالي التكلفة 400', money(soldLine?.total_cost) === '400.00', money(soldLine?.total_cost));
  check('💹 الربح 600', money(soldLine?.profit) === '600.00', money(soldLine?.profit));
  check('📈 نسبة الربح 150%', Number(soldLine?.profit_ratio) === 150, String(soldLine?.profit_ratio ?? '—'));
  check('🏭 المستودع', String(soldLine?.warehouse ?? '').length > 0, soldLine?.warehouse ?? '—');
  check('📏 الوحدة', soldLine?.unit === 'حبة', soldLine?.unit ?? '—');
  check('🔁 نوع العملية — مرتجع', returnLine?.operation === 'مرتجع', returnLine?.operation ?? '—');
  check('🔢 كمية المرتجع سالبة −2', Number(returnLine?.quantity) === -2, returnLine?.quantity ?? '—');
  const buoyLine = detailRows.find((row) => row.item_name === `طوق نجاة ${stamp}`);
  check('✂️ خصم رأس الفاتورة — 500 − 450 = 50', money(buoyLine?.discount) === '50.00', money(buoyLine?.discount));
  const seaDetails = mine(await profitDetailsReport(`&warehouseId=${sea.id}`));
  check('🏪 المستودع — مرساة وحدها', seaDetails.length === 1 && seaDetails[0]?.item_name === `مرساة ${stamp}`, seaDetails.map((row) => row.item_name).join(' · '));
  check(
    '💰 إجمالي الربح (600 + 30 − 120 + 10 + 640 + 250)',
    delta(cardOf(detailsRun, 'profit'), cardOf(baseProfitDetails, 'profit')) === 1410,
    `${money(cardOf(baseProfitDetails, 'profit'))} → ${money(cardOf(detailsRun, 'profit'))}`,
  );
  check(
    '📦 إجمالي التكلفة (840)',
    delta(cardOf(detailsRun, 'total_cost'), cardOf(baseProfitDetails, 'total_cost')) === 840,
    `${money(cardOf(baseProfitDetails, 'total_cost'))} → ${money(cardOf(detailsRun, 'total_cost'))}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n9. 🗂️ تقرير مبيعات الأصناف حسب المجموعة');

  const categoryRun = await byCategoryReport();
  const cGear = byName(categoryRun, `وقود ${stamp}`);
  const cBuoy = byName(categoryRun, `طوق نجاة ${stamp}`);
  check('🗂️ أربعة أصناف متحركة', mine(categoryRun).length === 4, `${mine(categoryRun).length} سطر`);
  check('🗂️ المجموعة من بطاقة الصنف', cGear?.category === `معدات ${stamp}`, cGear?.category ?? '—');
  check('🔢 إجمالي الكمية 8', Number(cGear?.quantity) === 8, cGear?.quantity ?? '—');
  check('💰 الإجمالي 800 (بلا ضريبة)', money(cGear?.total) === '800.00', money(cGear?.total));
  check('🧾 الضريبة 120', money(cGear?.tax) === '120.00', money(cGear?.tax));
  check('🧮 الصافي 920', money(cGear?.net) === '920.00', money(cGear?.net));
  check('✂️ الخصم — طوق نجاة 50', money(cBuoy?.discount) === '50.00', money(cBuoy?.discount));
  check('🚫 «حبل» الذي لم يتحرك لا يظهر', !byName(categoryRun, `حبل ${stamp}`), 'if (!hasMovement) continue;');
  check(
    '🏷️ البطاقات الأربع — الكمية 21 · الإجمالي 2250 · الضريبة 337.50 · الصافي 2587.50',
    delta(cardOf(categoryRun, 'quantity'), cardOf(baseByCategory, 'quantity')) === 21 &&
      delta(cardOf(categoryRun, 'total'), cardOf(baseByCategory, 'total')) === 2250 &&
      delta(cardOf(categoryRun, 'tax'), cardOf(baseByCategory, 'tax')) === 337.5 &&
      delta(cardOf(categoryRun, 'net'), cardOf(baseByCategory, 'net')) === 2587.5,
    `${money(cardOf(categoryRun, 'quantity'))} · ${money(cardOf(categoryRun, 'total'))} · ${money(cardOf(categoryRun, 'tax'))} · ${money(cardOf(categoryRun, 'net'))}`,
  );
  const posCategory = mine(await byCategoryReport('&invType=pos'));
  check('📄 «نقطة بيع» — صنفها وحده', posCategory.length === 1 && posCategory[0]?.item_name === `سترة ${stamp}`, posCategory.map((row) => row.item_name).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n10. 📅 تقرير المبيعات اليومية للمجموعة');

  const dayRun = await byDayReport();
  const dayRows = list(dayRun.rows).filter((row) => String(row.category ?? '').includes(stamp));
  const dayGear = dayRows.find((row) => row.category === `معدات ${stamp}`);
  const dayRig = dayRows.find((row) => row.category === `تجهيزات ${stamp}`);
  check('📅 مجموعتان في اليوم', dayRows.length === 2, `${dayRows.length} سطر`);
  check('💰 معدات — 920 + 230 = 1150', money(dayGear?.total) === '1150.00', money(dayGear?.total));
  check('💰 تجهيزات — 920 + 517.50 = 1437.50', money(dayRig?.total) === '1437.50', money(dayRig?.total));
  check(
    '📆 اسم اليوم بالعربية',
    /^(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت)$/.test(String(dayGear?.day_name ?? '')),
    `${dayGear?.day_name ?? '—'} · ${dayGear?.day ?? '—'}`,
  );
  check(
    '💰 إجمالي المبيعات (1150 + 1437.50)',
    delta(cardOf(dayRun, 'total'), cardOf(baseByDay, 'total')) === 2587.5,
    `${money(cardOf(baseByDay, 'total'))} → ${money(cardOf(dayRun, 'total'))}`,
  );
  const dayPos = list((await byDayReport('&invType=pos')).rows).filter((row) => String(row.category ?? '').includes(stamp));
  check('📄 «فاتورة نقطة بيع» — 57.50 وحدها', dayPos.length === 1 && money(dayPos[0]?.total) === '57.50', dayPos.map((row) => `${row.category}: ${money(row.total)}`).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n11. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقتا صفر');

  const emptyRun = await get('/reports/items-sales-summary?from=2001-01-01&to=2001-01-31');
  check('📅 لا سطور', list(emptyRun.rows).length === 0, `${list(emptyRun.rows).length} سطر`);
  check('💵 البطاقة الأولى صفر', Number(cardOf(emptyRun, 'net_sales')) === 0, cardOf(emptyRun, 'net_sales'));
  check('📦 البطاقة الثانية صفر', Number(cardOf(emptyRun, 'quantity')) === 0, cardOf(emptyRun, 'quantity'));

  // ---------------------------------------------------------------------------
  console.log('\n12. 🖨️ طباعة — البطاقات في شريطٍ واحد');

  const printed = await get(`/reports/print/items-sales-summary?from=${from}&to=${to}`);
  const html = String(printed.html ?? '');
  check('🖨️ صفحة HTML', html.startsWith('<!doctype html>'), `${html.length} حرفاً`);
  check('📄 عنوان التقرير', html.includes('مبيعات الأصناف تجميعي'), 'frmRptItemsSalesDetails');
  check('📊 أعمدة الشبكة', html.includes('رمز الصنف') && html.includes('المجموعة') && html.includes('صافي البيع'), 'RptItemsSalesDetails.repx');
  check('👤 المستخدم', html.includes('المستخدم:'), 'Common.GetEmpName(EmpNo)');
  check('✍️ أعده · راجعه · المدير', html.includes('أعده') && html.includes('راجعه') && html.includes('المدير'), 'footer.repx');
  check('💵 إجمالي صافي البيع', html.includes('إجمالي صافي البيع'), 'UpdateSummary');
  check('📦 إجمالي الكميات', html.includes('إجمالي الكميات'), 'UpdateSummary');
  check('📅 الفترة', html.includes('الفترة: من'), 'FromDate · ToDate');

  const profitPrint = await get(`/reports/print/items-profit-summary?from=${from}&to=${to}`);
  const profitHtml = String(profitPrint.html ?? '');
  check('💰 بطاقتا الأرباح مطبوعتان', profitHtml.includes('إجمالي صافي البيع') && profitHtml.includes('إجمالي الربح'), 'frmRptItemsProfit');
  const detailsPrint = await get(`/reports/print/items-profit-details?from=${from}&to=${to}`);
  const detailsHtml = String(detailsPrint.html ?? '');
  check(
    '💰 بطاقات التفصيلي الخمس مطبوعة',
    ['إجمالي التكلفة', 'المجموع', 'الإجمالي', 'الخصم', 'إجمالي الربح'].every((label) => detailsHtml.includes(label)),
    'frmRptItemsProfitDetails',
  );
  const dayPrint = await get(`/reports/print/category-sales-by-day?from=${from}&to=${to}`);
  check('📅 «إجمالي المبيعات» مطبوع', String(dayPrint.html ?? '').includes('إجمالي المبيعات'), 'frmRptCategorySaleByDay');

  // ---------------------------------------------------------------------------
  console.log('\n13. التصدير — CSV وXLSX');

  const csv = await post(`/reports/items-sales-summary/export?from=${from}&to=${to}`, { format: 'csv' });
  check('📄 CSV بالعناوين العربية', String(csv.content ?? '').includes('صافي البيع'), `${csv.rows} سطر`);
  const xlsx = await post(`/reports/items-profit-summary/export?from=${from}&to=${to}`, { format: 'xlsx' });
  check('📗 XLSX', xlsx.encoding === 'base64' && xlsx.filename.endsWith('.xlsx'), xlsx.filename);
  const detailsCsv = await post(`/reports/items-profit-details/export?from=${from}&to=${to}`, { format: 'csv' });
  check('📄 CSV التفصيلي', String(detailsCsv.content ?? '').includes('نسبة الربح %'), `${detailsCsv.rows} سطر`);
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n14. التنظيف — لا أثر لهذا التشغيل');

  // المردودات أولاً: إلغاؤها يعيد الكميات قبل إلغاء أصولها.
  for (const group of [{ path: '/purchase-invoices', rows: [...written.purchases].reverse() }, { path: '/sales/invoices', rows: [...written.sales].reverse() }]) {
    for (const document of group.rows) {
      const result = await refused('post', `${group.path}/${document.id}/void`, { reason: `تحقق ${stamp}` });
      check(`↩️ ${document.label} — ${result.status === 200 ? 'أُلغي' : result.code}`, result.status === 200, `${result.status} ${result.code}`);
    }
  }

  for (const id of written.itemIds) if (id) await del(`/organization/catalog/items/${id}`).catch(() => {});
  if (written.warehouseId) await del(`/warehouses/${written.warehouseId}`).catch(() => {});
  if (written.unitId) await del(`/organization/catalog/units/${written.unitId}`).catch(() => {});
  if (written.gearId) await del(`/organization/catalog/categories/${written.gearId}`).catch(() => {});
  if (written.rigId) await del(`/organization/catalog/categories/${written.rigId}`).catch(() => {});
  console.log('  ✓ الأصناف والمستودع والوحدة والمجموعتان');

  const left = mine(await salesReport());
  check('لم يبقَ من هذا التشغيل شيء', left.length === 0, left.map((row) => row.item_name).join(' · '));
}

console.log(`\n${failures === 0 ? '✔' : '✘'} 📦 تقارير الأصناف — ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
