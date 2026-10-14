#!/usr/bin/env node
/**
 * Live verification of Phase 11 part two — 🧾 الإرسال والتوقيع والسلسلة
 * (`Desktop_ERP/SmartAuditERP/Class/ZatcaService.cs` `IntegrateInvoice`, L371-L405,
 * `Class/InvoiceOper.cs` `SendZatca`, L2213-L2250, and the window
 * `Form_WPF/frmSentEinvoice.xaml` «🧾 الفواتير المرفوعة على موقع الضرائب») against a
 * running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. 📖 القراءة — خطّ الأساس: السلسلة قبل أي إرسال
 *   2. 🏗️ التهيئة — بطاقة المنشأة، والتأهيل إن لم يكن قد اكتمل
 *   3. 🧾 المبسّطة — فاتورة نقدية تُبلَّغ ولا تُصادَق
 *   4. 🧾 الضريبية — فاتورة لعميلٍ مسجَّل تُصادَق، وتعود بوثيقة الهيئة
 *   5. 🏷️ الوسوم الثمانية — رمز الاستجابة السريعة كما يقرأه المفتّش
 *   6. 🔗 السلسلة — التجزئة والعدّاد يمشيان معاً، خطوة خطوة
 *   7. 📄 الإشعار الدائن — 381 يسمّي الفاتورة التي يصحّحها
 *   8. ⏸ إيقاف الربط — تتوقف عند الوثيقة، و🔁 إعادة الإرسال يكملها
 *   9. 🚫 التكرار — المقبولة لا تُرسل مرتين
 *  10. 📋 الشبكة — صفحاتها، وتفاصيلها، وصلاحياتها
 *  11. 🧹 التنظيف — الإعدادات تعود إلى خط الأساس
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
 * Usage: node scripts/verify-einvoice-zatca-filing.mjs
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

const oneYearAfter = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year + 1, month - 1, day)).toISOString().slice(0, 10);
};

/** Decodes the QR the way a scanner does: one byte of tag, one byte of length, then the value. */
function qrTags(payload) {
  const bytes = Buffer.from(payload, 'base64');
  const found = [];
  let cursor = 0;
  while (cursor + 2 <= bytes.length) {
    const tag = bytes[cursor];
    const length = bytes[cursor + 1];
    found.push({ tag, value: bytes.subarray(cursor + 2, cursor + 2 + length) });
    cursor += 2 + length;
  }
  return found;
}

token = await signIn({ email, password });
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

// ══════════════════════════════════════════════════════ 1. 📖 القراءة
console.log('■ 1. 📖 القراءة — خطّ الأساس قبل أي إرسال');
const baselineSettings = (await get('/einvoice/settings')).settings;
const baselineCsr = (await get('/einvoice/settings')).csr;
const baselineChain = await get('/einvoice/chain');
const profile = await get('/company-profile');

check('السلسلة تبدأ بتجزئة التكوين (genesis)', baselineChain.counter === 0 ? baselineChain.lastHash.length === 88 : true, `العدّاد ${baselineChain.counter}`);
check('العدّاد التالي يزيد واحداً', baselineChain.nextCounter === baselineChain.counter + 1, `${baselineChain.counter} → ${baselineChain.nextCounter}`);
check('الربط مقروء قبل الإرسال', typeof baselineSettings.active === 'boolean' && typeof baselineSettings.simulation === 'boolean');
check('بطاقة المنشأة تحمل رقماً ضريبياً', /^3\d{13}3$/.test(String(profile.taxNo ?? '')), String(profile.taxNo));
let chain = baselineChain;

// ══════════════════════════════════════════════════════ 2. 🏗️ التهيئة
console.log('\n■ 2. 🏗️ التهيئة — ما يحتاجه الإرسال');
const branches = await get('/branches');
const warehouses = await get('/warehouses');
const branchId = branches[0].id;
const warehouseId = warehouses[0].id;

const unitId = (await post('/organization/catalog/units', { code: `PCE-${Date.now().toString(36)}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `GEN-${Date.now().toString(36)}`, nameAr: 'عام' })).id;
const itemId = (await post('/organization/catalog/items', { sku: `RICE-${Date.now().toString(36)}`, nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' })).id;
const partyId = (await post('/parties', { kind: 'customer', name: 'مؤسسة النخبة — تحقق زاتكا', taxNo: '310000000000012' })).id;
await post('/inventory/ledger/record', {
  lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000021' }],
});
check('فرع ومستودع وصنف وعميل جاهزون', Boolean(branchId && warehouseId && itemId && partyId));

// 🧪 Simulation, and the ladder — but only the steps this tenant has not taken yet, because
// ⚡ توليد is the step that invalidates a certificate issued for an older key.
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
check('المفتاح والشهادة مقنّعان', /^\*\*\*\*/.test(String(view.credential.privateKeyMasked)) && /^\*\*\*\*/.test(String(view.credential.productionCsidMasked)));
check('🧪 المحاكاة مفعّلة — لا شيء يخرج إلى الهيئة', view.settings.simulation === true);

/**
 * Reads the QR out of a cleared document the way `ZatcaService.GetEncodedInvoiceQRCode`
 * does: the `AdditionalDocumentReference` block whose `cbc:ID` is `QR`, and nothing else —
 * a document carries the ICV and the PIH in blocks that look the same.
 */
function qrFromClearedInvoice(xml) {
  for (const block of xml.match(/<cac:AdditionalDocumentReference>[\s\S]*?<\/cac:AdditionalDocumentReference>/g) ?? []) {
    if (!/<cbc:ID[^>]*>\s*QR\s*<\/cbc:ID>/.test(block)) continue;
    const value = block.match(/<cbc:EmbeddedDocumentBinaryObject[^>]*>([\s\S]*?)<\/cbc:EmbeddedDocumentBinaryObject>/)?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

async function postedInvoice(options) {
  const invoice = await post('/sales/invoices', {
    branchId,
    warehouseId,
    partyId: options.partyId,
    cashCustomerName: options.cashCustomerName,
    lines: [{ itemId, quantity: options.quantity ?? '2', unitPrice: '27.5', taxRate: '15' }],
  });
  await post(`/sales/invoices/${invoice.id}/post`, {});
  // The document number is assigned when the invoice is posted, not when it is drafted.
  return get(`/sales/invoices/${invoice.id}`);
}

const submit = (invoiceId) => post(`/sales-invoices/${invoiceId}/einvoice/submit`, {});

// ══════════════════════════════════════════════════════ 3. 🧾 المبسّطة
console.log('\n■ 3. 🧾 المبسّطة — فاتورة نقدية تُبلَّغ ولا تُصادَق');
const cashInvoice = await postedInvoice({ cashCustomerName: 'عميل نقدي — تحقق زاتكا', quantity: '2' });
const simplified = await submit(cashInvoice.id);
check('الحالة «مُبلَّغ» وكلمة الهيئة REPORTED', simplified.status === 'reported' && simplified.authorityStatus === 'REPORTED', `${simplified.status}/${simplified.authorityStatus}`);
check('الصنف مبسّط (0200000)', simplified.response.profile === 'simplified' && simplified.requestPayload.xml.includes('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>'));
check('المبسّطة لا تُصادَق — لا وثيقة عائدة', simplified.clearedInvoice === null && !simplified.requestPayload.clearedXml);
check('🧪 المحاكاة لا تتصل بشيء', simplified.response.gateway === 'simulation' && simplified.response.endpoint === null);
check('الفاتورة تحمل التجزئة والرمز على صفّها', (await get(`/sales/invoices/${cashInvoice.id}`)).zatcaStatus === 'reported');

// ══════════════════════════════════════════════════════ 4. 🧾 الضريبية
console.log('\n■ 4. 🧾 الضريبية — فاتورة لعميلٍ مسجَّل تُصادَق');
const standardInvoice = await postedInvoice({ partyId, quantity: '3' });
const standard = await submit(standardInvoice.id);
check('الحالة «مُصادَق» وكلمة الهيئة CLEARED', standard.status === 'cleared' && standard.authorityStatus === 'CLEARED', `${standard.status}/${standard.authorityStatus}`);
check('الصنف ضريبي (0100000)', standard.requestPayload.xml.includes('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>'));
check('الهيئة أعادت وثيقة مُصادَقة', standard.clearedInvoice !== null && String(standard.requestPayload.clearedXml).includes('<cbc:ID>QR</cbc:ID>'));
const clearedQr = qrFromClearedInvoice(String(standard.requestPayload.clearedXml));
check('الرمز مقروء من الوثيقة المُصادَقة لا من وثيقتنا', Boolean(clearedQr) && clearedQr === standard.qrPayload);
check('الوثيقة المُصادَقة هي الأساس المحفوظ', Buffer.from(standard.clearedInvoice, 'base64').toString('utf8') === standard.requestPayload.clearedXml);

// ══════════════════════════════════════════════════════ 5. 🏷️ الوسوم الثمانية
console.log('\n■ 5. 🏷️ الوسوم الثمانية — رمز الاستجابة السريعة');
const tags = qrTags(standard.qrPayload);
check('ثمانية وسوم بالترتيب', tags.map((tag) => tag.tag).join(',') === '1,2,3,4,5,6,7,8', tags.map((tag) => tag.tag).join(','));
check('الوسم 1 = اسم المنشأة', tags[0].value.toString('utf8') === profile.nameAr, tags[0].value.toString('utf8'));
check('الوسم 2 = الرقم الضريبي', tags[1].value.toString('utf8') === String(profile.taxNo));
check('الوسمان 4 و5 = الإجمالي والضريبة', tags[3].value.toString('utf8') === Number(standardInvoice.total).toFixed(2) && tags[4].value.toString('utf8') === Number(standardInvoice.taxTotal).toFixed(2), `${tags[3].value.toString('utf8')} / ${tags[4].value.toString('utf8')}`);
check('الوسم 6 = تجزئة الفاتورة', tags[5].value.toString('utf8') === standard.hash);
check('الوسمان 7 و8 = التوقيع والمفتاح العام', tags[6].value.length > 60 && tags[7].value.length > 80, `${tags[6].value.length} و ${tags[7].value.length} بايت`);

// ══════════════════════════════════════════════════════ 6. 🔗 السلسلة
console.log('\n■ 6. 🔗 السلسلة — التجزئة والعدّاد');
check('تجزئة الثانية هي تجزئة الأولى', standard.previousHash === simplified.hash, `${String(simplified.hash).slice(0, 12)}… → ${String(standard.hash).slice(0, 12)}…`);
check('العدّاد يزيد واحداً لا اثنين', standard.chainIndex === simplified.chainIndex + 1, `${simplified.chainIndex} → ${standard.chainIndex}`);
check('الوثيقة تحمل تجزئة سابقتها', String(standard.requestPayload.xml).includes(simplified.hash));
chain = await get('/einvoice/chain');
check('السلسلة تسجّل آخر تجزئة وآخر عدّاد', chain.lastHash === standard.hash && chain.counter === standard.chainIndex, `العدّاد ${chain.counter}`);
check('التالي جاهز', chain.nextCounter === chain.counter + 1);

// ══════════════════════════════════════════════════════ 7. 📄 الإشعار الدائن
console.log('\n■ 7. 📄 الإشعار الدائن — 381 يسمّي ما يصحّحه');
const returned = await post(`/sales/invoices/${standardInvoice.id}/return`, { branchId, warehouseId, lines: [{ itemId, quantity: '1', unitPrice: '27.5', taxRate: '15' }] });
await post(`/sales/invoices/${returned.id}/post`, {});
const credit = await submit(returned.id);
check('النوع 381 لا 388', credit.requestPayload.xml.includes('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>'));
check('يسمّي الفاتورة الأصلية', credit.requestPayload.referenceNumber === standardInvoice.number, `${credit.requestPayload.referenceNumber} = ${standardInvoice.number}`);
check('وسيلة الدفع تقول «Refund.» كما في الديسكتوب', credit.requestPayload.xml.includes('<cbc:InstructionNote>Refund.</cbc:InstructionNote>'));
check('الإشعار يُصادَق كسائر الفواتير الضريبية', credit.status === 'cleared');

// ══════════════════════════════════════════════════════ 8. ⏸ الإيقاف و🔁 الإعادة
console.log('\n■ 8. ⏸ إيقاف الربط — تتوقف عند الوثيقة، و🔁 إعادة الإرسال يكملها');
await post('/einvoice/link/toggle');
const pausedInvoice = await postedInvoice({ cashCustomerName: 'عميل نقدي — تحقق زاتكا', quantity: '1' });
const paused = await submit(pausedInvoice.id);
check('الوثيقة موقّعة وتنتظر الربط', paused.status === 'signed' && paused.response.reason === 'LINK_PAUSED', paused.response.message);
await post('/einvoice/link/toggle');
const resumed = await post(`/einvoice/submissions/${paused.id}/retry`, {});
check('🔁 إعادة الإرسال يكملها', resumed.status === 'reported', resumed.status);
check('التجزئة لا تتحرك في الإعادة', resumed.hash === paused.hash);
check('المحاولات تُعدّ', Number(resumed.attempts) === 1 && Number(paused.attempts) === 0, `${paused.attempts} → ${resumed.attempts}`);

// ══════════════════════════════════════════════════════ 9. 🚫 التكرار
console.log('\n■ 9. 🚫 التكرار — المقبولة لا تُرسل مرتين');
const again = await refused('post', `/sales-invoices/${simplified.invoiceId}/einvoice/submit`, {});
check('إرسالٌ ثانٍ يُرفض 409', again.status === 409 && again.code === 'EINVOICE_ALREADY_ACCEPTED', `${again.status} ${again.code}`);
const retryAccepted = await refused('post', `/einvoice/submissions/${simplified.id}/retry`, {});
check('إعادة إرسال المقبولة تُرفض 409', retryAccepted.status === 409 && retryAccepted.code === 'EINVOICE_ALREADY_ACCEPTED');
const draft = await post('/sales/invoices', { branchId, warehouseId, cashCustomerName: 'عميل نقدي — تحقق زاتكا', lines: [{ itemId, quantity: '1', unitPrice: '10', taxRate: '15' }] });
const draftRefused = await refused('post', `/sales-invoices/${draft.id}/einvoice/submit`, {});
check('المسوّدة لا تُرسل', draftRefused.status === 409 && draftRefused.code === 'EINVOICE_INVOICE_NOT_POSTED');

// ══════════════════════════════════════════════════════ 10. 📋 الشبكة
console.log('\n■ 10. 📋 الشبكة — الفواتير المرفوعة');
const page = await get('/einvoice/filings?pageNo=1&pageSize=3');
check('🔍 عرض يصفّح بالصفحة والحجم', page.items.length === 3 && page.pageNo === 1 && page.pageSize === 3, `${page.items.length} من ${page.total}`);
check('الأحدث أولاً', page.items.map((row) => Date.parse(row.createdAt)).every((time, index, all) => index === 0 || all[index - 1] >= time));
check('كل صفٍّ يعرف فاتورته', page.items.every((row) => row.invoice.number && row.invoice.partyName && row.invoice.branchName && row.invoice.createdByName), page.items[0].invoice.number);
const filtered = await get('/einvoice/filings?status=cleared&pageSize=50');
check('🔄 حالة المزامنة تصفّي', filtered.items.length > 0 && filtered.items.every((row) => row.status === 'cleared'), `${filtered.items.length} مُصادَقة`);
const detail = await get(`/einvoice/filings/${standard.id}`);
check('📄 بيانات الفاتورة: الوثيقتان', Boolean(detail.document.xml) && Boolean(detail.document.clearedXml));
check('📄 بيانات الفاتورة: الوسوم بأسمائها', detail.qr.tags.length === 8 && detail.qr.tags[5].labelAr.includes('تجزئة الفاتورة'), detail.qr.tags[5].labelAr);
check('📄 بيانات الفاتورة: مكانها في السلسلة', detail.chain.previousHash === standard.previousHash && detail.document.counter === standard.chainIndex);

const ownerToken = token;
if (accountant.password) {
  token = await signIn(accountant);
  const read = await refused('get', '/einvoice/filings?pageNo=1&pageSize=1');
  const write = await refused('post', '/einvoice/csr/generate', {});
  check('المحاسب يقرأ الشبكة', read.status === 200);
  check('ولا يملك إدارة الشهادات — 403', write.status === 403, `${write.status}`);
}
if (cashier.password) {
  token = await signIn(cashier);
  const read = await refused('get', '/einvoice/filings?pageNo=1&pageSize=1');
  check('أمين الصندوق لا يقرأ الإرسال — 403', read.status === 403, `${read.status}`);
}
token = ownerToken;

// ══════════════════════════════════════════════════════ 11. 🧹 التنظيف
console.log('\n■ 11. 🧹 التنظيف — عودةٌ إلى خط الأساس');
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
check('📅 النهاية سنة بعد البداية', restored.settings.endDate === oneYearAfter(restored.settings.startDate), `${restored.settings.startDate} → ${restored.settings.endDate}`);

console.log(`\n${failures === 0 ? '✔' : '✗'} ${checks - failures}/${checks} checks passed${failures === 0 ? '' : ` — ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
