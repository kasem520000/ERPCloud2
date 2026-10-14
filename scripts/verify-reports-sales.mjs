#!/usr/bin/env node
/**
 * Live verification of Phase 10 part one — 📊 تقارير المبيعات: «حركة المبيعات»
 * (`Form_WPF/frmRptSalesInPeriod`) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقريران يظهران بأعمدة الديسكتوب نفسها
 *   2. 🧾 الوثائق — بيع · مرتجع · نقطة بيع، كلها مرحَّلة
 *   3. 📊 إجمالي المبيعات — كل صنفٍ صافياً من المرتجع، و«حبل» الذي لم يُبع لا يظهر
 *   4. 🧾 عرض الفواتير — البيع والمرتجع والوقت ونقدي وشبكة وآجل
 *   5. 💰 إجمالي المبيعات — المبيعات − المردودات (بفارقٍ عن خطّ الأساس)
 *   6. 🧾 نوع الفاتورة — «مبيعات نقطة البيع» عن «مبيعات عادية»
 *   7. ⏰ الوقت (HH:mm:ss) — يضيّق الفترة، ووقتٌ مستحيل يُرفض
 *   8. 🖨️ طباعة — الرأس والشبكة والتوقيعات
 *   9. التصدير — CSV وXLSX يُبنيان في الخادم
 *  10. التنظيف — ما يُلغى يُلغى، والفاتورة المدفوعة تُرفض بقاعدة الدفاتر
 *
 * Re-runnable and non-destructive: everything this script writes carries a stamp, every
 * number is asserted as a **difference from a baseline** taken before anything is written
 * (so a tenant with yesterday's documents verifies just as well as an empty one), and
 * everything voidable is undone in a `finally`.
 *
 * Usage: node scripts/verify-reports-sales.mjs
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

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const from = iso(-1);
const to = iso(1);

const itemsReport = (query = '') => get(`/reports/sales-movement-items?from=${from}&to=${to}${query}`);
const invoicesReport = (query = '') => get(`/reports/sales-movement-invoices?from=${from}&to=${to}${query}`);

const written = { itemId: '', posItemId: '', unsoldId: '', unitId: '', categoryId: '', safeId: '', documents: [] };

try {
  // ---------------------------------------------------------------------------
  console.log('1. 📚 السجل — التقريران بأعمدة `frmRptSalesInPeriod`');

  const catalog = list(await get('/reports'));
  check('📚 سجل التقارير', catalog.length > 0, `${catalog.length} تقرير`);

  const items = catalog.find((row) => row.key === 'sales-movement-items');
  const invoices = catalog.find((row) => row.key === 'sales-movement-invoices');
  check('📊 «إجمالي المبيعات» مسجَّل', Boolean(items), items?.titleAr ?? '—');
  check('🧾 «عرض الفواتير» مسجَّل', Boolean(invoices), invoices?.titleAr ?? '—');
  check(
    '📊 الأعمدة الأربعة — رقم الصنف · الصنف · الكمية · الإجمالي',
    (items?.columns ?? []).map((column) => column.labelAr).join(' · ') === 'رقم الصنف · الصنف · الكمية · الإجمالي',
    (items?.columns ?? []).map((column) => column.labelAr).join(' · '),
  );
  check(
    '🧾 الأعمدة الاثنا عشر',
    (invoices?.columns ?? []).map((column) => column.labelAr).join(' · ') ===
      'رقم الحركة · رقم الفاتورة · نوع الفاتورة · التاريخ · الوقت · آجل · نقدي · شبكة · الإجمالي · الضريبة · الخصم · الصافي',
    `${(invoices?.columns ?? []).length} عمود`,
  );
  const kind = (invoices?.params ?? []).find((param) => param.name === 'invType');
  check(
    '🧾 نوع الفاتورة — «مبيعات نقطة البيع» · «مبيعات عادية»',
    (kind?.options ?? []).map((option) => option.labelAr).join(' · ') === 'مبيعات نقطة البيع · مبيعات عادية',
    (kind?.options ?? []).map((option) => option.labelAr).join(' · '),
  );
  check(
    '⏰ الوقت (HH:mm:ss) — صندوقٌ لكل تاريخ',
    (invoices?.params ?? []).filter((param) => param.name.endsWith('Time')).length === 2,
    (invoices?.params ?? []).filter((param) => param.name.endsWith('Time')).map((param) => param.name).join(' · '),
  );

  // خطّ الأساس — every number below is asserted as a difference from here.
  const baseItems = await itemsReport();
  const baseInvoices = await invoicesReport();
  const baseItemsTotal = cardOf(baseItems, 'total');
  const baseInvoicesTotal = cardOf(baseInvoices, 'net_signed');
  check('📏 خطّ الأساس', true, `الأصناف ${money(baseItemsTotal)} · الفواتير ${money(baseInvoicesTotal)}`);

  // ---------------------------------------------------------------------------
  console.log('\n2. 🧾 الوثائق — بيع · مرتجع · نقطة بيع');

  const branches = list(await get('/branches'));
  const warehouses = list(await get('/warehouses'));
  const branchId = branches[0]?.id;
  const warehouseId = warehouses[0]?.id;

  const category = await post('/organization/catalog/categories', { code: `RC${stamp}`, nameAr: `مجموعة ${stamp}` });
  written.categoryId = category.id;
  const unit = await post('/organization/catalog/units', { code: `RU${stamp}`, nameAr: 'حبة' });
  written.unitId = unit.id;

  const makeItem = (sku, nameAr) =>
    post('/organization/catalog/items', { sku, nameAr, categoryId: category.id, baseUnitId: unit.id, salePrice: '100.0000' });
  const sold = await makeItem(`RSOLD${stamp}`, `وقود ${stamp}`);
  written.itemId = sold.id;
  const posItem = await makeItem(`RPOS${stamp}`, `سترة ${stamp}`);
  written.posItemId = posItem.id;
  // An صنف لا يُباع أبداً — `if (qty == 0.0) continue;` at the desktop.
  const unsold = await makeItem(`RNONE${stamp}`, `حبل ${stamp}`);
  written.unsoldId = unsold.id;

  await post('/inventory/ledger/record', {
    lines: [sold, posItem, unsold].map((item, index) => ({
      itemId: item.id,
      warehouseId,
      qty: '100',
      unitCost: '40',
      direction: 'in',
      docType: 'opening',
      docId: `00000000-0000-0000-000${index}-${stamp.padStart(12, '0')}`,
    })),
  });

  const party = await post('/parties', { kind: 'customer', name: `عميل ${stamp}` });
  written.partyId = party.id;

  const sale = await post('/sales/invoices', {
    branchId,
    warehouseId,
    partyId: party.id,
    lines: [{ itemId: sold.id, quantity: '10', unitPrice: '100', taxRate: '15' }],
  });
  const postedSale = await post(`/sales/invoices/${sale.id}/post`, {});
  written.documents.push({ id: postedSale.id, number: postedSale.number, label: 'البيع' });
  check('🧾 فاتورة بيع مرحَّلة', postedSale.status === 'posted', `${postedSale.number} · ${money(postedSale.total)}`);

  // 💵 نقدي + 💳 شبكة — `inv.cash` و`inv.visa` عند الديسكتوب.
  const accounts = list(await get('/accounts'));
  const cashAccount = accounts.find((row) => row.type === 'asset' && row.isPostable !== false) ?? accounts[0];
  const safe = await post('/cash-locations', { branchId, kind: 'safe', name: `خزينة ${stamp}`, accountId: cashAccount?.id });
  written.safeId = safe.id;
  await post(`/sales/invoices/${postedSale.id}/payments`, {
    method: 'cash',
    amount: '500',
    idempotencyKey: `rpt-cash-${stamp}`,
    cashLocationId: safe.id,
  });
  await post(`/sales/invoices/${postedSale.id}/payments`, {
    method: 'card',
    amount: '150',
    idempotencyKey: `rpt-card-${stamp}`,
  });
  check('💵 نقدي و💳 شبكة', true, '500.00 نقدي · 150.00 شبكة');

  const draftReturn = await post(`/sales/invoices/${postedSale.id}/return`, {
    branchId,
    warehouseId,
    lines: [{ itemId: sold.id, quantity: '2', unitPrice: '100', taxRate: '15' }],
  });
  const postedReturn = await post(`/sales/invoices/${draftReturn.id}/post`, {});
  written.documents.push({ id: postedReturn.id, number: postedReturn.number, label: 'المرتجع' });
  check('↩️ مرتجع مرحَّل', postedReturn.status === 'posted', `${postedReturn.number} · ${money(postedReturn.total)}`);

  const pos = await post('/sales/invoices', {
    branchId,
    warehouseId,
    cashCustomerName: `نقدي ${stamp}`,
    lines: [{ itemId: posItem.id, quantity: '1', unitPrice: '50', taxRate: '15' }],
  });
  const postedPos = await post(`/sales/invoices/${pos.id}/post`, {});
  written.documents.push({ id: postedPos.id, number: postedPos.number, label: 'نقطة البيع' });
  check('🧾 مبيعات نقطة البيع', postedPos.status === 'posted', `${postedPos.number} · ${money(postedPos.total)}`);

  // ---------------------------------------------------------------------------
  console.log('\n3. 📊 إجمالي المبيعات — كل صنفٍ صافياً من المرتجع');

  const rows = list((await itemsReport()).rows);
  const mine = rows.filter((row) => String(row.item_name ?? '').includes(stamp));
  const byName = new Map(mine.map((row) => [row.item_name, row]));
  const soldRow = byName.get(`وقود ${stamp}`);
  const posRow = byName.get(`سترة ${stamp}`);

  check('📊 سطران — صنفا هذا التشغيل', mine.length === 2, `${mine.length} سطر (من ${rows.length})`);
  check('🔢 الكمية الصافية — 10 − 2 = 8', Number(soldRow?.quantity) === 8, soldRow?.quantity ?? '—');
  check('💰 الإجمالي الصافي — 1150 − 230 = 920', money(soldRow?.total) === '920.00', money(soldRow?.total));
  check('🔢 نقطة البيع — كمية 1', Number(posRow?.quantity) === 1, posRow?.quantity ?? '—');
  check('💰 نقطة البيع — 57.50', money(posRow?.total) === '57.50', money(posRow?.total));
  check('🚫 «حبل» الذي لم يُبع لا يظهر', !byName.has(`حبل ${stamp}`), mine.map((row) => row.item_name).join(' · '));
  check('🔢 رقم الصنف من بطاقة الصنف', soldRow?.item_code === `RSOLD${stamp}`, soldRow?.item_code ?? '—');

  const saleItems = list((await itemsReport('&invType=sale')).rows).filter((row) => String(row.item_name ?? '').includes(stamp));
  check('🧾 «مبيعات عادية» — صنف البيع وحده', saleItems.length === 1 && saleItems[0]?.item_name === `وقود ${stamp}`, saleItems.map((row) => row.item_name).join(' · '));
  const posItems = list((await itemsReport('&invType=pos')).rows).filter((row) => String(row.item_name ?? '').includes(stamp));
  check('🧾 «مبيعات نقطة البيع» — صنفها وحده', posItems.length === 1 && posItems[0]?.item_name === `سترة ${stamp}`, posItems.map((row) => row.item_name).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n4. 🧾 عرض الفواتير — البيع والمرتجع والوقت والسداد وآجل');

  const all = list((await invoicesReport()).rows);
  const numbers = new Set(written.documents.map((document) => document.number));
  const mineInvoices = all.filter((row) => numbers.has(row.number));
  const byNumber = new Map(mineInvoices.map((row) => [row.number, row]));
  const saleRow = byNumber.get(postedSale.number);
  const returnRow = byNumber.get(postedReturn.number);
  const posInvoiceRow = byNumber.get(postedPos.number);

  check('🧾 الفواتير الثلاث', mineInvoices.length === 3, mineInvoices.map((row) => row.number).join(' · '));
  check('«بيع»', saleRow?.kind_name === 'بيع', saleRow?.kind_name ?? '—');
  check('«مرتجع»', returnRow?.kind_name === 'مرتجع', returnRow?.kind_name ?? '—');
  check('⏰ الوقت بصيغة HH:mm:ss', /^\d{2}:\d{2}:\d{2}$/.test(String(saleRow?.time ?? '')), String(saleRow?.time ?? '—'));
  check('📅 التاريخ', /^\d{4}-\d{2}-\d{2}$/.test(String(saleRow?.day ?? '')), String(saleRow?.day ?? '—'));
  check('💵 نقدي', money(saleRow?.cash) === '500.00', money(saleRow?.cash));
  check('💳 شبكة', money(saleRow?.network) === '150.00', money(saleRow?.network));
  check('💰 الإجمالي', money(saleRow?.subtotal) === '1000.00', money(saleRow?.subtotal));
  check('🧾 الضريبة', money(saleRow?.tax) === '150.00', money(saleRow?.tax));
  check('✂️ الخصم', money(saleRow?.discount) === '0.00', money(saleRow?.discount));
  check('🧮 الصافي', money(saleRow?.net) === '1150.00', money(saleRow?.net));
  check('آجل — الفاتورة المسدَّدة', saleRow?.postponed === '—', saleRow?.postponed ?? '—');
  check('آجل — المرتجع غير المسدَّد', returnRow?.postponed === 'نعم', returnRow?.postponed ?? '—');
  check('رقم الحركة = معرّف الفاتورة', saleRow?.movement_no === postedSale.id, String(saleRow?.movement_no ?? '—'));
  check('الصافي موجب في الشبكة (بلا إشارة)', money(returnRow?.net) === '230.00', money(returnRow?.net));

  // ---------------------------------------------------------------------------
  console.log('\n5. 💰 إجمالي المبيعات — المبيعات ناقص المردودات');

  const afterItems = await itemsReport();
  const afterInvoices = await invoicesReport();
  check(
    '💰 إجمالي المبيعات — الأصناف (920 + 57.50)',
    (afterItems.grandTotal ?? []).some((total) => total.labelAr === 'إجمالي المبيعات') &&
      delta(cardOf(afterItems, 'total'), baseItemsTotal) === 977.5,
    `${money(baseItemsTotal)} → ${money(cardOf(afterItems, 'total'))}`,
  );
  check(
    '💰 إجمالي المبيعات — الفواتير (1150 − 230 + 57.50)',
    delta(cardOf(afterInvoices, 'net_signed'), baseInvoicesTotal) === 977.5,
    `${money(baseInvoicesTotal)} → ${money(cardOf(afterInvoices, 'net_signed'))}`,
  );
  check(
    '🧮 «صافي الحركة» محسوب لا معروض',
    !afterInvoices.columns.some((column) => column.key === 'net_signed'),
    afterInvoices.columns.map((column) => column.key).join(' · '),
  );

  // ---------------------------------------------------------------------------
  console.log('\n6. 🧾 نوع الفاتورة — نقطة البيع عن المبيعات العادية');

  const posOnly = list((await invoicesReport('&invType=pos')).rows).filter((row) => numbers.has(row.number));
  check('نقطة البيع — الفاتورة النقدية وحدها', posOnly.length === 1 && posOnly[0]?.number === postedPos.number, posOnly.map((row) => row.number).join(' · '));
  const saleOnly = list((await invoicesReport('&invType=sale')).rows).filter((row) => numbers.has(row.number));
  check(
    'المبيعات العادية — البيع والمرتجع',
    saleOnly.length === 2 && saleOnly.every((row) => row.number !== postedPos.number),
    saleOnly.map((row) => row.number).join(' · '),
  );

  // ---------------------------------------------------------------------------
  console.log('\n7. ⏰ الوقت (HH:mm:ss) — يضيّق الفترة، ووقتٌ مستحيل يُرفض');

  const wholeDay = list((await invoicesReport('&fromTime=00:00:00&toTime=23:59:59')).rows);
  check('⏰ اليوم كله', wholeDay.length === all.length, `${wholeDay.length} سطر`);
  const narrow = list((await get(`/reports/sales-movement-invoices?from=${iso(0)}&to=${iso(0)}&fromTime=00:00:00&toTime=00:00:01`)).rows);
  check('⏰ «إلى تاريخ» 00:00:01 — لا شيء', narrow.length === 0, `${narrow.length} سطر`);
  const badTime = await refused('get', `/reports/sales-movement-invoices?from=${from}&to=${to}&fromTime=99:99`);
  check('⏰ وقتٌ مستحيل يُرفض 422', badTime.status === 422 && badTime.code === 'VALIDATION_FAILED', `${badTime.status} ${badTime.code}`);

  // ---------------------------------------------------------------------------
  console.log('\n8. 🖨️ طباعة — الرأس والشبكة والتوقيعات');

  const printed = await get(`/reports/print/sales-movement-items?from=${from}&to=${to}`);
  const html = String(printed.html ?? '');
  check('🖨️ صفحة HTML', html.startsWith('<!doctype html>'), `${html.length} حرفاً`);
  check('🏢 رأس المنشأة', html.includes('الرقم الضريبي') || html.includes('class="company"'), 'header.repx');
  check('📄 عنوان التقرير', html.includes('حركة المبيعات'), 'InventoryType');
  check('📊 أعمدة الشبكة', html.includes('رقم الصنف') && html.includes('الإجمالي'), 'RptSalesInPeriod1');
  check('👤 المستخدم', html.includes('المستخدم:'), 'Common.GetEmpName(EmpNo)');
  check('✍️ أعده · راجعه · المدير', html.includes('أعده') && html.includes('راجعه') && html.includes('المدير'), 'footer.repx');
  check('💰 إجمالي المبيعات', html.includes('إجمالي المبيعات'), 'txtSumSale');
  check('📅 الفترة', html.includes('الفترة: من'), 'FromDate · ToDate');

  const emptyPrint = await get('/reports/print/sales-movement-invoices?from=2001-01-01&to=2001-01-31');
  check('«لا توجد عمليات بالجدول»', String(emptyPrint.html ?? '').includes('لا توجد عمليات بالجدول'), 'PrintDevexpress');

  // ---------------------------------------------------------------------------
  console.log('\n9. التصدير — CSV وXLSX');

  const csv = await post(`/reports/sales-movement-items/export?from=${from}&to=${to}`, { format: 'csv' });
  check('📄 CSV بالعناوين العربية', String(csv.content ?? '').includes('رقم الصنف'), `${csv.rows} سطر`);
  const xlsx = await post(`/reports/sales-movement-invoices/export?from=${from}&to=${to}`, { format: 'xlsx' });
  check('📗 XLSX', xlsx.encoding === 'base64' && xlsx.filename.endsWith('.xlsx'), xlsx.filename);
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n10. التنظيف — لا أثر لهذا التشغيل');

  let voided = 0;
  for (const document of written.documents) {
    const result = await refused('post', `/sales/invoices/${document.id}/void`, { reason: `تحقق ${stamp}` });
    if (result.status === 200) voided += 1;
    else check(`↩️ ${document.label} — قاعدة الدفاتر`, result.status === 409 && result.code === 'SALES_VOID_HAS_PAYMENTS', `${result.status} ${result.code}`);
  }
  check('↩️ أُلغي ما يُلغى', voided === 2, `${voided} من ${written.documents.length}`);

  if (written.safeId) await del(`/cash-locations/${written.safeId}`).catch(() => {});
  for (const id of [written.unsoldId, written.itemId, written.posItemId]) if (id) await del(`/organization/catalog/items/${id}`).catch(() => {});
  if (written.unitId) await del(`/organization/catalog/units/${written.unitId}`).catch(() => {});
  if (written.categoryId) await del(`/organization/catalog/categories/${written.categoryId}`).catch(() => {});
  console.log('  ✓ الخزينة والأصناف والوحدة والمجموعة');

  const leftInvoices = list((await invoicesReport()).rows).filter((row) => written.documents.some((document) => document.number === row.number));
  check(
    'لم يبقَ إلا الفاتورة المدفوعة (المردودات أُلغيت)',
    leftInvoices.length === 1,
    leftInvoices.map((row) => row.number).join(' · '),
  );
}

console.log(`\n${failures === 0 ? '✔' : '✘'} 📊 حركة المبيعات — ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
