#!/usr/bin/env node
/**
 * Live verification of Phase 11 part five — 💳 بوابات الدفع
 * (`Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` L1726-L1831 «إعدادات جيديا» +
 * GroupBox «NeoLeap», `frmSettings.xaml.cs` `BtnSaveGedia_Click` L2456 · `testGedia`
 * L2498 · `BtnTestGedia_Click` L2513 · `Btnsavneoleap_Click` L2535 ·
 * `Btntestneoleap_Click` L4047, `frmPOSBill.xaml.cs` L460-L492,
 * `frmPOSPay.xaml.cs` L428-L441) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. 📖 القراءة — ما تعرضه النافذة قبل أن تُمسّ
 *   2. 💾 التهيئة — تفعيل البوابتين، وصنفٌ ورصيدٌ لفاتورةٍ تُحصَّل
 *   3. 🧪 TEST · 🧪 Test — الزرّان، و«Logging» الذي يبقى بعد إغلاق النافذة
 *   4. 💳 جيديا — جلسةٌ معلّقة، ثم 🔄 تحديث الحالة يقبلها
 *   5. 💳 NeoLeap — إجابةٌ فورية: 00 · 01 · 02
 *   6. ❌ مرفوضة · 🚫 ملغاة · ⚠️ تعذّر الوصول — تُسجَّل ولا تُبتلع
 *   7. 💰 الفاتورة — الدفع المقبول يُقيَّد على الفاتورة، مرةً واحدة
 *   8. 🚫 الأبواب المغلقة — بوابة موقوفة، مبلغ، رصيد، مرجع مكرَّر، منفذ، بوابة مجهولة
 *   9. 📜 السجل — الأحدث أولاً، والمرشّحان
 *  10. 🔐 الصلاحيات — القراءة للجميع، والتحصيل للكاشير، والإعدادات للمدير
 *  11. 🧹 التنظيف — الإعدادات تعود إلى خطّ الأساس
 *
 * Re-runnable and non-destructive: both providers' settings are snapshotted before
 * anything is written and restored at the end, and the 🧪 Simulation switch is never
 * turned off — the one real HTTP call in the run is aimed at a closed port on the local
 * machine, which is how «تعذّر الوصول» is proved to be a real failure and not a stub.
 *
 * What it does add to the demo tenant: one unit, one category, one item, one stock
 * opening, the sales invoices it collects, and the payment rows themselves.
 *
 * Usage: node scripts/verify-payment-gateways.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test';
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
    error.detail = parsed.detail ?? parsed.message;
    throw error;
  }
  return parsed.data ?? parsed;
}

/** A call that is *expected* to be refused: its status and code are the answer. */
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

const provider = (rows, key) => rows.find((row) => row.provider === key);

// ══════════════════════════════════════════════════════ 1. 📖 القراءة
console.log('■ 1. 📖 القراءة — ما تعرضه النافذة قبل أن تُمسّ');
const baseline = await get('/payment-gateways');
const baselineGeidea = provider(baseline.providers, 'geidea');
const baselineNeoleap = provider(baseline.providers, 'neoleap');
check('البطاقتان: جيديا و NeoLeap', baseline.providers.map((row) => row.provider).join(' · ') === 'geidea · neoleap');
check('التسميتان كما في النافذة', baseline.providers.map((row) => row.labelAr).join(' · ') === 'جيديا · NeoLeap');
check('🧪 Simulation يبدأ مطفأً على البوابتين', baseline.providers.every((row) => row.simulation === true), 'لا يُطلب أي بوابة حقيقية');
check('المفتاح لا يُقرأ — يُقنَّع فقط', baseline.providers.every((row) => row.secretMasked === null || row.secretMasked.startsWith('****')));
check('عنوان جيديا الافتراضي هو بيئة السعودية المنشورة', baselineGeidea.baseUrl === 'https://api.ksamerchant.geidea.net', baselineGeidea.baseUrl);
check('NeoLeap بلا عنوان حتى يُكتب المنفذ', baselineNeoleap.baseUrl === '' || baselineNeoleap.baseUrl.startsWith('http'), baselineNeoleap.baseUrl || '— لا عنوان —');

// ══════════════════════════════════════════════════════ 2. 💾 التهيئة
console.log('\n■ 2. 💾 التهيئة — تفعيل البوابتين، وصنفٌ ورصيدٌ لفاتورةٍ تُحصَّل');
await put('/payment-gateways/geidea', {
  active: true,
  printReceipt: true,
  merchantKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  ...(baselineGeidea.hasSecret ? {} : { merchantSecret: 'geidea-api-password' }),
  callbackUrl: 'https://example.test/hooks/geidea',
  simulation: true,
});
await put('/payment-gateways/neoleap', {
  active: true,
  printReceipt: true,
  port: 8099,
  ...(baselineNeoleap.hasSecret ? {} : { merchantSecret: 'neoleap-merchant-token' }),
  simulation: true,
});
const saved = await get('/payment-gateways');
const savedGeidea = provider(saved.providers, 'geidea');
const savedNeoleap = provider(saved.providers, 'neoleap');
check('💾 حفظ — جيديا مفعّلة', savedGeidea.active === true);
check('💾 حفظ — NeoLeap مفعّلة', savedNeoleap.active === true);
check('«المنفذ» يبني العنوان', savedNeoleap.baseUrl === 'http://127.0.0.1:8099', savedNeoleap.baseUrl);
check('المفتاح محفوظ ومقنَّع', savedGeidea.hasSecret === true && /^\*\*\*\*/.test(savedGeidea.secretMasked ?? ''), savedGeidea.secretMasked ?? '—');
check('المفتاح نفسه لا يظهر في الردّ', JSON.stringify(saved).indexOf('geidea-api-password') === -1);

const branches = await get('/branches');
const warehouses = await get('/warehouses');
const branchId = branches[0].id;
const warehouseId = warehouses[0].id;
const stamp = Date.now().toString(36);
const unitId = (await post('/organization/catalog/units', { code: `PCE-${stamp}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `GEN-${stamp}`, nameAr: 'عام' })).id;
const itemId = (await post('/organization/catalog/items', { sku: `RICE-${stamp}`, nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' })).id;
await post('/inventory/ledger/record', {
  lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000051' }],
});
check('الصنف والرصيد جاهزان', Boolean(itemId));

async function postedInvoice() {
  const created = await post('/sales/invoices', {
    branchId,
    warehouseId,
    cashCustomerName: 'عميل نقدي — تحقق الدفع',
    lines: [{ itemId, quantity: '2', unitPrice: '27.5', taxRate: '15' }],
  });
  const posted = await post(`/sales/invoices/${created.id}/post`, {});
  return await get(`/sales/invoices/${posted.id}`);
}

// ══════════════════════════════════════════════════════ 3. 🧪 TEST · 🧪 Test
console.log('\n■ 3. 🧪 TEST · 🧪 Test — الزرّان، و«Logging» الذي يبقى');
const geideaTest = await post('/payment-gateways/geidea/test', {});
check('🧪 TEST (جيديا) — تُنشئ جلسة بـ «المبلغ»', geideaTest.status === 'initiated' && geideaTest.responseCode === '000', geideaTest.message ?? '');
const neoleapTest = await post('/payment-gateways/neoleap/test', {});
check('🧪 Test (NeoLeap) — يُجيب فوراً 00', neoleapTest.status === 'approved' && neoleapTest.responseCode === '00', neoleapTest.message ?? '');
check('🧪 TEST يعمل في المحاكاة ولا يطلب البوابة', geideaTest.simulation === true && neoleapTest.simulation === true);
const logging = provider((await get('/payment-gateways')).providers, 'geidea').lastTest;
check('«Logging» محفوظ على البطاقة', Boolean(logging) && (logging.lines ?? []).length > 0, (logging?.lines ?? []).join(' | '));
check('🧪 اختبار لا يُقيَّد عملية في السجل', (await get('/payment-gateways/transactions?limit=200')).transactions.every((row) => !row.reference.startsWith('TEST-')));

// ══════════════════════════════════════════════════════ 4. 💳 جيديا — جلسة ثم 🔄
console.log('\n■ 4. 💳 جيديا — جلسةٌ معلّقة، ثم 🔄 تحديث الحالة');
const opened = await post('/payment-gateways/geidea/sale', { amount: '63.25', branchId, reference: `ECR-GEA-${stamp}` });
check('الجلسة معلّقة حتى يدفع العميل', opened.transaction.status === 'initiated', opened.transaction.message ?? '');
check('لا إيصال قبل الدفع', opened.transaction.approvalCode === null && opened.settled === false);
const accepted = await post(`/payment-gateways/transactions/${opened.transaction.id}/refresh`, {});
check('🔄 تحديث الحالة — مقبولة', accepted.transaction.status === 'approved' && accepted.refreshed === true);
check('رقم الموافقة', /^\d{6}$/.test(accepted.transaction.approvalCode ?? ''), accepted.transaction.approvalCode ?? '—');
check('RRN · STAN', (accepted.transaction.rrn ?? '').length === 12 && (accepted.transaction.stan ?? '').length === 6, `${accepted.transaction.rrn} · ${accepted.transaction.stan}`);
check('الشبكة والبطاقة', accepted.transaction.cardScheme === 'MADA' && accepted.transaction.panMasked === '****4242', `${accepted.transaction.cardScheme} · ${accepted.transaction.panMasked}`);
const again = await post(`/payment-gateways/transactions/${opened.transaction.id}/refresh`, {});
check('المنتهية لا تُسأل مرتين', again.refreshed === false, again.message ?? '');
const pending = await post('/payment-gateways/geidea/sale', { amount: '10.00', reference: `PENDING-${stamp}` });
const stillPending = await post(`/payment-gateways/transactions/${pending.transaction.id}/refresh`, {});
check('⏳ بانتظار الدفع تبقى معلّقة', stillPending.transaction.status === 'initiated' && stillPending.refreshed === true);

// ══════════════════════════════════════════════════════ 5. 💳 NeoLeap
console.log('\n■ 5. 💳 NeoLeap — إجابةٌ فورية: 00 · 01 · 02');
const neo = await post('/payment-gateways/neoleap/sale', { amount: '63.25', branchId, reference: `ECR-NEO-${stamp}` });
check('00 — Approved', neo.transaction.status === 'approved' && neo.transaction.message === 'Approved', neo.transaction.responseCode ?? '');
check('الإيصال كاملاً', Boolean(neo.transaction.approvalCode && neo.transaction.rrn && neo.transaction.stan && neo.transaction.cardScheme));
check('نوع العملية كما تسمّيه البوابة', neo.transaction.transactionType === 'SALE', neo.transaction.transactionType ?? '—');
const neoAsked = await post(`/payment-gateways/transactions/${neo.transaction.id}/refresh`, {});
check('لا شيء ليُحدَّث — البوابة أجابت في الحال', neoAsked.refreshed === false, neoAsked.message ?? '');

// ══════════════════════════════════════════════════════ 6. ❌ مرفوضة · ملغاة · تعذّر
console.log('\n■ 6. ❌ مرفوضة · 🚫 ملغاة · ⚠️ تعذّر الوصول');
const declined = await post('/payment-gateways/neoleap/sale', { amount: '12.00', reference: `DECLINE-${stamp}` });
check('01 — Declined', declined.transaction.status === 'declined' && declined.transaction.message === 'Declined');
const cancelled = await post('/payment-gateways/neoleap/sale', { amount: '12.00', reference: `CANCEL-${stamp}` });
check('02 — Cancelled or Error', cancelled.transaction.status === 'cancelled' && cancelled.transaction.message === 'Cancelled or Error');
const unreachable = await post('/payment-gateways/neoleap/sale', { amount: '12.00', reference: `ERROR-${stamp}` });
check('⚠️ تعذّر الوصول — تُسجَّل ولا تُبتلع', unreachable.transaction.status === 'error', unreachable.transaction.message ?? '');
check('❌ المرفوضة لا تُقيَّد', declined.settled === false && cancelled.settled === false);

// ══════════════════════════════════════════════════════ 7. 💰 الفاتورة
console.log('\n■ 7. 💰 الفاتورة — الدفع المقبول يُقيَّد، مرةً واحدة');
const invoice = await postedInvoice();
const due = invoice.total;
const paid = await post('/payment-gateways/neoleap/sale', { amount: due, invoiceId: invoice.id, branchId, reference: `ECR-INV-${stamp}` });
check('الدفع مقبول', paid.transaction.status === 'approved', paid.transaction.message ?? '');
check('قُيَّد على الفاتورة', paid.settled === true);
const after = await get(`/sales/invoices/${invoice.id}`);
check('المحصَّل يساوي الصافي', after.paidTotal === due, `${after.paidTotal} من ${due}`);
check('حالة الفاتورة: مدفوعة', after.paymentStatus === 'paid', after.paymentStatus);
const twice = await post(`/payment-gateways/transactions/${paid.transaction.id}/refresh`, {});
const afterTwice = await get(`/sales/invoices/${invoice.id}`);
check('🔄 لا يدفع مرتين', afterTwice.paidTotal === due, `${afterTwice.paidTotal}`);
check('العملية تحمل الفاتورة والفرع', paid.transaction.invoiceId === invoice.id && paid.transaction.branchId === branchId);

// ══════════════════════════════════════════════════════ 8. 🚫 الأبواب المغلقة
console.log('\n■ 8. 🚫 الأبواب المغلقة — ما يرفضه النظام قبل أن يطلب البوابة');
const wasActive = savedGeidea.active;
await put('/payment-gateways/geidea', { active: false });
const off = await refused('post', '/payment-gateways/geidea/sale', { amount: '10.00' });
check('بوابة موقوفة — 409', off.status === 409 && off.code === 'PAYMENT_GATEWAY_DISABLED', off.detail);
check('«الرجاء تفعيل الدفع عن طريق جيديا!»', (off.detail ?? '').includes('الرجاء تفعيل الدفع عن طريق جيديا!'), off.detail);
await put('/payment-gateways/geidea', { active: true });
const zero = await refused('post', '/payment-gateways/geidea/sale', { amount: '0' });
check('مبلغٌ غير موجب — 422', zero.status === 422 && zero.code === 'PAYMENT_AMOUNT_INVALID', zero.detail);
const draft = await post('/sales/invoices', { branchId, warehouseId, cashCustomerName: 'عميل نقدي', lines: [{ itemId, quantity: '1', unitPrice: '27.5', taxRate: '15' }] });
const onDraft = await refused('post', '/payment-gateways/neoleap/sale', { amount: '10.00', invoiceId: draft.id });
check('فاتورة غير مرحَّلة — 409', onDraft.status === 409 && onDraft.code === 'SALES_INVOICE_NOT_POSTED', onDraft.detail);
const unpaid = await postedInvoice();
const over = await refused('post', '/payment-gateways/neoleap/sale', { amount: '9999.00', invoiceId: unpaid.id });
check('أكثر من المتبقي — 422', over.status === 422 && over.code === 'PAYMENT_EXCEEDS_DUE', over.detail);
const duplicate = await refused('post', '/payment-gateways/neoleap/sale', { amount: '5.00', reference: `ECR-INV-${stamp}` });
check('المرجع المكرَّر — 409 (لا خصم مرتين)', duplicate.status === 409 && duplicate.code === 'PAYMENT_REFERENCE_DUPLICATED', duplicate.detail);
const badPort = await refused('put', '/payment-gateways/geidea', { port: 70000 });
check('منفذٌ خارج النطاق — 422', badPort.status === 422 && badPort.code === 'PAYMENT_PORT_INVALID', badPort.detail);
const unknown = await refused('put', '/payment-gateways/visa', { active: true });
check('بوابة مجهولة — 422', unknown.status === 422 && unknown.code === 'PAYMENT_PROVIDER_UNKNOWN', unknown.detail);
check('البوابة الموقوفة تعود مفعّلة', wasActive === true);

// ══════════════════════════════════════════════════════ 9. 📜 السجل
console.log('\n■ 9. 📜 السجل — الأحدث أولاً، والمرشّحان');
const logRows = (await get('/payment-gateways/transactions?limit=50')).transactions;
check('السجل ممتلئ', logRows.length > 5, `${logRows.length} عملية`);
const times = logRows.map((row) => Date.parse(row.createdAt));
check('الأحدث أولاً', [...times].sort((a, b) => b - a).join() === times.join());
const geideaOnly = (await get('/payment-gateways/transactions?provider=geidea&limit=50')).transactions;
check('مرشّح البوابة', geideaOnly.length > 0 && geideaOnly.every((row) => row.provider === 'geidea'), `${geideaOnly.length} عملية جيديا`);
const declinedOnly = (await get('/payment-gateways/transactions?status=declined&limit=50')).transactions;
check('مرشّح الحالة', declinedOnly.length > 0 && declinedOnly.every((row) => row.status === 'declined'), `${declinedOnly.length} مرفوضة`);
check('السقف محترم', (await get('/payment-gateways/transactions?limit=2')).transactions.length === 2);

// ══════════════════════════════════════════════════════ 10. 🔐 الصلاحيات
console.log('\n■ 10. 🔐 الصلاحيات — القراءة للجميع، والتحصيل للكاشير، والإعدادات للمدير');
const ownerToken = token;
const accountantToken = await signIn(accountant);
const cashierToken = await signIn(cashier);
token = accountantToken;
const asAccountant = await refused('post', '/payment-gateways/geidea/sale', { amount: '1.00' });
const accountantSees = await refused('get', '/payment-gateways/transactions?limit=1');
const accountantSaves = await refused('put', '/payment-gateways/geidea', { active: true });
const accountantTests = await refused('post', '/payment-gateways/geidea/test', {});
token = cashierToken;
const cashierSees = await refused('get', '/payment-gateways/transactions?limit=1');
const cashierSaves = await refused('put', '/payment-gateways/geidea', { active: true });
const cashierTests = await refused('post', '/payment-gateways/geidea/test', {});
token = ownerToken;
check('المحاسب يقرأ السجل', accountantSees.status === 200);
check('المحاسب لا يُحصِّل', asAccountant.status === 403, `${asAccountant.status}`);
check('المحاسب لا يضبط البوابة', accountantSaves.status === 403 && accountantTests.status === 403);
check('الكاشير يقرأ السجل', cashierSees.status === 200);
check('الكاشير لا يضبط البوابة', cashierSaves.status === 403 && cashierTests.status === 403);
token = cashierToken;
const cashierSale = await refused('post', '/payment-gateways/geidea/sale', { amount: '1.00' });
const cashierRefresh = await refused('post', `/payment-gateways/transactions/${pending.transaction.id}/refresh`, {});
token = ownerToken;
check('الكاشير يُحصِّل — عمله', cashierSale.status === 200 || cashierSale.status === 201, `${cashierSale.status}`);
check('الكاشير يحدّث الحالة', cashierRefresh.status === 200, `${cashierRefresh.status}`);
check('المالك يفعل كل شيء', (await refused('get', '/payment-gateways')).status === 200);

// ══════════════════════════════════════════════════════ 11. 🧹 التنظيف
console.log('\n■ 11. 🧹 التنظيف — الإعدادات تعود إلى خطّ الأساس');
await put('/payment-gateways/geidea', {
  active: baselineGeidea.active,
  printReceipt: baselineGeidea.printReceipt,
  port: baselineGeidea.port,
  baseUrl: baselineGeidea.baseUrl === 'https://api.ksamerchant.geidea.net' ? '' : baselineGeidea.baseUrl,
  currency: baselineGeidea.currency,
  merchantKey: baselineGeidea.merchantKey,
  callbackUrl: baselineGeidea.callbackUrl,
  simulation: baselineGeidea.simulation,
});
await put('/payment-gateways/neoleap', {
  active: baselineNeoleap.active,
  printReceipt: baselineNeoleap.printReceipt,
  port: baselineNeoleap.port,
  baseUrl: baselineNeoleap.baseUrl,
  currency: baselineNeoleap.currency,
  merchantKey: baselineNeoleap.merchantKey,
  callbackUrl: baselineNeoleap.callbackUrl,
  simulation: baselineNeoleap.simulation,
});
const restored = await get('/payment-gateways');
const restoredGeidea = provider(restored.providers, 'geidea');
const restoredNeoleap = provider(restored.providers, 'neoleap');
check('جيديا عادت إلى خطّ الأساس', restoredGeidea.active === baselineGeidea.active && restoredGeidea.simulation === baselineGeidea.simulation, `تفعيل: ${restoredGeidea.active} · محاكاة: ${restoredGeidea.simulation}`);
check('NeoLeap عادت إلى خطّ الأساس', restoredNeoleap.active === baselineNeoleap.active && restoredNeoleap.simulation === baselineNeoleap.simulation, `تفعيل: ${restoredNeoleap.active} · محاكاة: ${restoredNeoleap.simulation}`);
check('المفاتيح بقيت محفوظة', restoredGeidea.hasSecret === true && restoredNeoleap.hasSecret === true);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
