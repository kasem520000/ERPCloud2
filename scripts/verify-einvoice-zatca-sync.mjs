#!/usr/bin/env node
/**
 * Live verification of Phase 11 part three — 📊 حالة المزامنة
 * (`Desktop_ERP/SmartAuditERP/Form_WPF/frmInvsSyncStatusZatca.xaml` (559) + `.xaml.cs`
 * (1165)) against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` +
 * `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. 📖 القراءة — ما تعرضه النافذة قبل أن تُمسّ
 *   2. 🏗️ التهيئة — الأصناف والعميل والرصيد، والتأهيل إن لم يكن قد اكتمل
 *   3. 📋 الشبكة — كل فاتورةٍ مرحَّلة بسطر، والأحدث أولاً
 *   4. 🏷️ نوع الفاتورة — كما يسمّيها `InvoiceOper.GetInvoiceTypeAr`
 *   5. 🔄 حالة المزامنة — ✅ مرسل و❌ غير مرسل، والمرشّح الثلاثي
 *   6. 📅 الفترة الزمنية — من · إلى · 📌 كل الفترة
 *   7. 💰 المجاميع — الصافي = المبيعات ناقص المردودات
 *   8. 🔄 مزامنة ZATCA — المحدَّد، والمسوَّدة، والمُرسلة، والربط الموقوف
 *   9. 🖨️ الطباعة والتصدير — ورقةٌ من محرّك الطباعة، وملفٌ من الخادم
 *  10. 🔐 الصلاحيات — القراءة غير الكتابة، والكتابة غير التصدير
 *  11. 🧹 التنظيف — الإعدادات تعود إلى خطّ الأساس
 *
 * Re-runnable and non-destructive: the tenant's settings are snapshotted before anything is
 * written and restored at the end, and the onboarding ladder only runs the steps that have
 * not been done yet — ⚡ توليد is what revokes an old certificate, so it is not re-run on a
 * tenant that already has one. Everything is filed through the 🧪 Simulation gateway, so
 * nothing is registered with any authority.
 *
 * What it does add to the demo tenant: one unit, one category, one item, one customer, one
 * stock opening and the sales invoices themselves — the documents a filing needs.
 *
 * Usage: node scripts/verify-einvoice-zatca-sync.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';
const accountant = { email: process.env.DEMO_ACCOUNTANT_EMAIL ?? 'accountant@demo.test', password: process.env.DEMO_ACCOUNTANT_PASSWORD ?? '' };
const cashier = { email: process.env.DEMO_CASHIER_EMAIL ?? 'cashier@demo.test', password: process.env.DEMO_CASHIER_PASSWORD ?? '' };

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed.data ?? parsed;
}

async function refused(method, path, body) {
  try {
    await request(method, path, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

async function signIn(credentials) {
  // The platform throttles /auth/login per address, and a run signs in three times; a 429
  // is not a failed check, so wait the window out and ask again before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const next = login.accessToken ?? login.access_token ?? login.token;
      if (!next) throw new Error(`login failed for ${credentials.email}`);
      return next;
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const get = (path) => request('get', path);
const post = (path, body) => request('post', path, body);
const put = (path, body) => request('put', path, body);

token = await signIn({ email, password });
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

/** 🖨️ طباعة / 👁️ معاينة — `GET /reports/print/:key`, the same page the browser prints. */
const printPath = (params = {}) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined));
  return `/reports/print/einvoice-sync-status${search.toString() ? `?${search.toString()}` : ''}`;
};
/** 📊 تصدير Excel — `POST /reports/:key/export`, a real file built by the server. */
const exportPath = (params = {}) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined));
  return `/reports/einvoice-sync-status/export${search.toString() ? `?${search.toString()}` : ''}`;
};
const reportQuery = (params = {}) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined));
  return `/reports/einvoice-sync-status${search.toString() ? `?${search.toString()}` : ''}`;
};
const grid = (params = {}) => get(reportQuery(params));

// ══════════════════════════════════════════════════════ 1. 📖 القراءة
console.log('■ 1. 📖 القراءة — ما تعرضه النافذة قبل أن تُمسّ');
const baselineSettings = (await get('/einvoice/settings')).settings;
const baselineCsr = (await get('/einvoice/settings')).csr;
const baseline = await grid();
check('النافذة مسجّلة في فهرس التقارير', baseline.titleAr === 'مزامنة الفواتير - ZATCA', baseline.titleAr);
check('أعمدة النافذة نفسها', (baseline.columns ?? []).map((column) => column.labelAr).join(' · ') === 'م · ID · الفرع · نوع الفاتورة · رقم الفاتورة · التاريخ · العميل · المستخدم · الصافي · الرسالة · حالة المزامنة');
check('💰 ثلاث بطاقات لا واحدة', (baseline.grandTotal ?? []).map((card) => card.labelAr).join(' · ') === 'إجمالي الفواتير · إجمالي المرتجعات والإشعارات · الصافي');
check('🐘 لا شيء يظهر قبل المرشّح', typeof baseline.rowCount === 'number', `${baseline.rowCount} سطراً`);

// ══════════════════════════════════════════════════════ 2. 🏗️ التهيئة
console.log('\n■ 2. 🏗️ التهيئة — ما تحتاجه الشبكة');
const branches = await get('/branches');
const warehouses = await get('/warehouses');
const branchId = branches[0].id;
const warehouseId = warehouses[0].id;

const unitId = (await post('/organization/catalog/units', { code: `PCE-${Date.now().toString(36)}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `GEN-${Date.now().toString(36)}`, nameAr: 'عام' })).id;
const itemId = (await post('/organization/catalog/items', { sku: `RICE-${Date.now().toString(36)}`, nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' })).id;
const partyId = (await post('/parties', { kind: 'customer', name: 'مؤسسة النخبة — تحقق المزامنة', taxNo: '310000000000012' })).id;
await post('/inventory/ledger/record', {
  lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000031' }],
});
check('فرع ومستودع وصنف وعميل جاهزون', Boolean(branchId && warehouseId && itemId && partyId));

await put('/einvoice/settings', { environment: 'compliance', simulation: true, active: true });
let view = await get('/einvoice/settings');
const done = (key) => view.checklist.find((row) => row.key === key)?.done === true;
if (!done('csr')) {
  await post('/einvoice/settings/fill-from-company');
  await put('/einvoice/settings', { csr: { industry: 'تجارة التجزئة' } });
  await post('/einvoice/csr/generate');
}
view = await get('/einvoice/settings');
if (!done('compliance-csid')) await post('/einvoice/onboarding/compliance-csid', { otp: '123456' });
view = await get('/einvoice/settings');
if (!done('production-csid')) await post('/einvoice/onboarding/production-csid');
view = await get('/einvoice/settings');
check('خطوات التأهيل مكتملة', ['csr', 'compliance-csid', 'production-csid'].every((key) => view.checklist.find((row) => row.key === key)?.done === true));
check('🧪 المحاكاة مفعّلة — لا شيء يخرج إلى الهيئة', view.settings.simulation === true);

async function newInvoice(options = {}) {
  return post('/sales/invoices', {
    branchId,
    warehouseId,
    partyId: options.partyId,
    cashCustomerName: options.cashCustomerName,
    kind: options.kind,
    referenceInvoiceId: options.referenceInvoiceId,
    lines: [{ itemId, quantity: options.quantity ?? '2', unitPrice: '27.5', taxRate: '15' }],
  });
}

async function postedInvoice(options = {}) {
  const invoice = await newInvoice(options);
  await post(`/sales/invoices/${invoice.id}/post`, {});
  return get(`/sales/invoices/${invoice.id}`);
}

// ══════════════════════════════════════════════════════ 3. 📋 الشبكة
console.log('\n■ 3. 📋 الشبكة — كل فاتورةٍ مرحَّلة بسطر');
const draft = await newInvoice({ cashCustomerName: 'عميل نقدي — تحقق المزامنة' });
const cashSale = await postedInvoice({ cashCustomerName: 'عميل نقدي — تحقق المزامنة' });
const standardSale = await postedInvoice({ partyId, quantity: '3' });
const returned = await post(`/sales/invoices/${standardSale.id}/return`, { branchId, warehouseId, lines: [{ itemId, quantity: '1', unitPrice: '27.5', taxRate: '15' }] });
await post(`/sales/invoices/${returned.id}/post`, {});
const creditNote = await postedInvoice({ partyId, kind: 'credit_note', referenceInvoiceId: standardSale.id, quantity: '1' });

const rows = (await grid()).rows;
const ids = rows.map((row) => row.invoice_id);
check('المرحَّلة كلها حاضرة', [cashSale.id, standardSale.id, returned.id, creditNote.id].every((id) => ids.includes(id)), ids.length + ' سطراً');
check('المسوَّدة لا تُعرض — `IS_Deleted=0` وما يقابلها', !ids.includes(draft.id));
check('«م» يُرقّم من واحد بالترتيب المعروض', rows.every((row, index) => row.seq === String(index + 1)));
check('الأحدث أولاً — `ORDER BY date DESC`', rows.map((row) => Date.parse(row.issued_at.replace(' ', 'T') + 'Z')).every((time, index, all) => index === 0 || all[index - 1] >= time));
check('كل سطرٍ يعرف فاتورته', rows.every((row) => row.number && row.branch_name && row.user_name), rows[0].number);

// ══════════════════════════════════════════════════════ 4. 🏷️ نوع الفاتورة
console.log('\n■ 4. 🏷️ نوع الفاتورة — `InvoiceOper.GetInvoiceTypeAr`');
const byId = new Map((await grid()).rows.map((row) => [row.invoice_id, row]));
check('عميلٌ له رقم ضريبي ⇒ «فاتورة ضريبية»', byId.get(standardSale.id).kind_name === 'فاتورة ضريبية', byId.get(standardSale.id).kind_name);
check('بيعٌ نقدي ⇒ «فاتورة ضريبية مبسطة»', byId.get(cashSale.id).kind_name === 'فاتورة ضريبية مبسطة', byId.get(cashSale.id).kind_name);
check('المرتجع ⇒ «إشعار دائن للفاتورة الضريبية»', byId.get(returned.id).kind_name === 'إشعار دائن للفاتورة الضريبية', byId.get(returned.id).kind_name);
check('الإشعار الدائن ⇒ كذلك', byId.get(creditNote.id).kind_name === 'إشعار دائن للفاتورة الضريبية');
check('«العميل» من بطاقته، أو الاسم النقدي', byId.get(standardSale.id).party_name === 'مؤسسة النخبة — تحقق المزامنة' && byId.get(cashSale.id).party_name === 'عميل نقدي — تحقق المزامنة');

// ══════════════════════════════════════════════════════ 5. 🔄 حالة المزامنة
console.log('\n■ 5. 🔄 حالة المزامنة — ✅ مرسل و❌ غير مرسل');
check('ما لم يُرسل: ❌ لم يُرسل', byId.get(cashSale.id).sync_status === '❌ لم يُرسل', byId.get(cashSale.id).sync_status);
const filed = await post(`/sales-invoices/${cashSale.id}/einvoice/submit`, {});
check('بعد الترحيل: ✅ مرسل', filed.status === 'reported' && (await grid()).rows.find((row) => row.invoice_id === cashSale.id).sync_status === '✅ مرسل');
const sentRows = (await grid({ status: 'sent' })).rows.map((row) => row.invoice_id);
check('مرشّح «✅ مرسل»', sentRows.includes(cashSale.id) && !sentRows.includes(standardSale.id), `${sentRows.length} سطراً`);
const unsentRows = (await grid({ status: 'unsent' })).rows.map((row) => row.invoice_id);
check('مرشّح «❌ غير مرسل»', unsentRows.includes(standardSale.id) && !unsentRows.includes(cashSale.id), `${unsentRows.length} سطراً`);
check('🔵 الكل يجمعهما', (await grid()).rows.length === sentRows.length + unsentRows.length);

console.log('\n■ 5ب. 📋 نوع الفاتورة — مرشّح النافذة');
const noticeRows = (await grid({ kind: 'notice' })).rows.map((row) => row.invoice_id);
check('«إشعار» = الإشعارات وحدها', noticeRows.includes(creditNote.id) && !noticeRows.includes(cashSale.id), `${noticeRows.length} سطراً`);
const saleRows = (await grid({ kind: 'sale' })).rows.map((row) => row.invoice_id);
check('«مبيعات» = البيع ومرتجعه', saleRows.includes(cashSale.id) && saleRows.includes(returned.id) && !saleRows.includes(creditNote.id), `${saleRows.length} سطراً`);

// ══════════════════════════════════════════════════════ 6. 📅 الفترة الزمنية
console.log('\n■ 6. 📅 الفترة الزمنية — من · إلى · 📌 كل الفترة');
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const inside = await grid({ from: today, to: today });
check('«من/إلى» اليوم', inside.rowCount > 0 && inside.rows.every((row) => row.issued_at.startsWith(today)), `${inside.rowCount} سطراً`);
check('أمس: لا شيء', (await grid({ from: yesterday, to: yesterday })).rowCount === 0);
check('📌 كل الفترة = بلا مرشّح تاريخ', (await grid()).rowCount === (await grid({ from: '', to: '' })).rowCount);

// ══════════════════════════════════════════════════════ 7. 💰 المجاميع
console.log('\n■ 7. 💰 المجاميع — الصافي = المبيعات ناقص المردودات');
const totals = await grid();
const card = (key) => Number(totals.grandTotal.find((row) => row.key === key).amount);
const sumOf = (key) => totals.rows.reduce((total, row) => total + Number(row[key]), 0);
check('«إجمالي الفواتير» مجموع أعمدة الشبكة', card('net_sale').toFixed(2) === sumOf('net_sale').toFixed(2), String(card('net_sale')));
check('«إجمالي المرتجعات والإشعارات» كذلك', card('net_return').toFixed(2) === sumOf('net_return').toFixed(2), String(card('net_return')));
check('«الصافي» = `sum - sum1` (L1058)', card('net_signed').toFixed(2) === (card('net_sale') - card('net_return')).toFixed(2), String(card('net_signed')));

// ══════════════════════════════════════════════════════ 8. 🔄 مزامنة ZATCA
console.log('\n■ 8. 🔄 مزامنة ZATCA — ما اختاره الكاشير');
const empty = await refused('post', '/einvoice/sync', { ids: [] });
check('بلا تحديد: 422 «لا توجد صفوف محددة.»', empty.status === 422 && empty.code === 'EINVOICE_SYNC_EMPTY', `${empty.status} ${empty.code}`);
const tooMany = await refused('post', '/einvoice/sync', { ids: Array.from({ length: 201 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`) });
check('دفعةٌ أكبر من الحدّ تُرفض', tooMany.status === 422 && tooMany.code === 'EINVOICE_SYNC_TOO_MANY');

const batch = await post('/einvoice/sync', { ids: [standardSale.id, creditNote.id] });
check('المحدَّد يُرسل سطراً سطراً', batch.requested === 2 && batch.sent === 2 && batch.failed === 0, batch.message);
check('«تمت العملية بنجاح ✅»', batch.message === 'تمت العملية بنجاح ✅');
// Both are `0100000` — the customer has a tax number — so both go to التخليص and come
// back cleared. A simplified invoice is the one that is merely reported (§5 above).
check('الضريبية تُخلَّص، وكذلك إشعارها الدائن', batch.results[0].status === 'cleared' && batch.results[1].status === 'cleared', `${batch.results[0].status} · ${batch.results[1].status}`);
check('الشبكة تُحدَّث بعد المزامنة', (await grid()).rows.find((row) => row.invoice_id === standardSale.id).sync_status === '✅ مرسل');

const mixed = await post('/einvoice/sync', { ids: [draft.id, standardSale.id] });
check('المسوَّدة صفٌّ مُتجاوَز لا فاشل', mixed.results[0].outcome === 'skipped' && mixed.results[0].message.includes('غير مرحَّلة'), mixed.results[0].message);
check('والمُرسلة كذلك', mixed.results[1].outcome === 'skipped' && mixed.results[1].message.includes('تم إرسال هذه الفاتورة مسبقاً'));
check('الدفعة كلها تُبلَّغ', mixed.sent === 0 && mixed.skipped === 2 && mixed.failed === 0, mixed.message);

const pausedTarget = await postedInvoice({ cashCustomerName: 'عميل نقدي — تحقق المزامنة' });
await post('/einvoice/link/toggle');
const pausedSync = await post('/einvoice/sync', { ids: [pausedTarget.id] });
check('⏸ إيقاف الربط: صفٌّ مُتجاوَز بعبارةٍ تُقال', pausedSync.skipped === 1 && pausedSync.results[0].message.includes('الربط موقوف'), pausedSync.results[0].message);
check('لا وثيقة تُحفظ والربط موقوف', (await grid()).rows.find((row) => row.invoice_id === pausedTarget.id).sync_status === '❌ لم يُرسل');
await post('/einvoice/link/toggle');
const resumed = await post('/einvoice/sync', { ids: [pausedTarget.id] });
check('▶ تشغيل ثم 🔄 مزامنة يُكملها', resumed.sent === 1 && resumed.results[0].status === 'reported', resumed.message);

// ══════════════════════════════════════════════════════ 9. 🖨️ الطباعة والتصدير
console.log('\n■ 9. 🖨️ الطباعة والتصدير — ورقةٌ وملفٌّ من الخادم');
const printPage = await get(printPath({ status: 'sent' }));
check('🖨️ ورقةٌ كاملة من محرّك الطباعة', typeof printPage.html === 'string' && printPage.html.includes('مزامنة الفواتير - ZATCA') && printPage.html.includes('<table'));
check('👁️ تحمل بطاقات المجاميع', printPage.html.includes('إجمالي الفواتير') && printPage.html.includes('الصافي'));
const xlsx = await post(exportPath({ status: 'sent' }), { format: 'xlsx' });
check('📊 تصدير Excel — ملفٌّ حقيقي من الخادم', xlsx.encoding === 'base64' && xlsx.filename.endsWith('.xlsx') && xlsx.rows > 0, `${xlsx.filename} · ${xlsx.rows} سطراً`);
const csv = await post(exportPath({ status: 'sent' }), { format: 'csv' });
check('وتصدير CSV بالعناوين نفسها', csv.mimeType.startsWith('text/csv') && csv.content.split('\n')[0].includes('حالة المزامنة'));

// ══════════════════════════════════════════════════════ 10. 🔐 الصلاحيات
console.log('\n■ 10. 🔐 الصلاحيات — القراءة غير الكتابة، والكتابة غير التصدير');
const ownerToken = token;
if (accountant.password) {
  token = await signIn(accountant);
  const read = await refused('get', reportQuery({ status: 'sent' }));
  const write = await refused('post', '/einvoice/sync', { ids: [pausedTarget.id] });
  const exported = await refused('post', exportPath({ status: 'sent' }), { format: 'csv' });
  check('المحاسب يقرأ الشبكة', read.status === 200);
  check('ويُرسل (einvoice.submit)', write.status === 200 || write.status === 422, `${write.status}`);
  check('ولا يُصدّر (reporting.export.execute) — 403', exported.status === 403, `${exported.status}`);
}
if (cashier.password) {
  token = await signIn(cashier);
  const read = await refused('get', reportQuery());
  const write = await refused('post', '/einvoice/sync', { ids: [pausedTarget.id] });
  check('أمين الصندوق لا يقرأها — 403', read.status === 403, `${read.status}`);
  check('ولا يُرسل — 403', write.status === 403, `${write.status}`);
}
token = ownerToken;

// ══════════════════════════════════════════════════════ 11. 🧹 التنظيف
console.log('\n■ 11. 🧹 التنظيف — عودةٌ إلى خطّ الأساس');
await put('/einvoice/settings', {
  environment: baselineSettings.environment,
  simulation: baselineSettings.simulation,
  active: baselineSettings.active,
  syncManual: baselineSettings.syncManual,
  startDate: baselineSettings.startDate,
  csr: baselineCsr,
});
const restored = await get('/einvoice/settings');
check('الإعدادات عادت كما كانت', restored.settings.environment === baselineSettings.environment && restored.settings.simulation === baselineSettings.simulation && restored.settings.active === baselineSettings.active);
check('خصائص الشهادة عادت كما كانت', restored.csr.commonName === baselineCsr.commonName && restored.csr.serialNumber === baselineCsr.serialNumber);

console.log(`\n${failures === 0 ? '✔' : '✗'} ${checks - failures}/${checks} checks passed${failures === 0 ? '' : ` — ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
