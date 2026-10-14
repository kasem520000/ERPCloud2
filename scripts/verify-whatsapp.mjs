#!/usr/bin/env node
/**
 * Live verification of Phase 11 part six — 📱 واتساب
 * (`Desktop_ERP/SmartAuditERP/Form_WPF/frmInvSale.xaml` L1190 «💬 واتساب» and its handler
 * `frmInvSale.xaml.cs` L3130-L3195, behind `Class/WhatsAppSender.cs` (267) and
 * `Class/Session.cs` L12-L31) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. 📖 القراءة — ما تعرضه الشاشة قبل أن تُمسّ
 *   2. 💾 التهيئة — الرقم والرمز ورمز الدولة، وصنفٌ ورصيدٌ وعميلٌ له جوال
 *   3. 🧪 اختبار — هل هذا الرقم لنا؟ و Logging الذي يبقى بعد إغلاق النافذة
 *   4. 💬 واتساب — التحية كما كتبتها النسخة المكتبية، والرقم كما صاغته
 *   5. 📎 المرفق — الفاتورة تخرج مع الرسالة، أو الكلمات وحدها
 *   6. 🔢 الأرقام — جوال العميل، جوال النقدي، ورمز دولةٍ آخر
 *   7. 🚫 الأبواب المغلقة — مسوَّدة، بلا جوال، رقمٌ تالف، بوابة موقوفة، فاتورة مجهولة
 *   8. ❌ الرقم غير مرتبط بواتساب — تُسجَّل ولا تُبتلع
 *   9. 📜 السجل — الأحدث أولاً، والمرشّحان
 *  10. 🔐 الصلاحيات — الإعدادات للمالك، و«💬 واتساب» لمن يرى الفاتورة
 *  11. 🧹 التنظيف — الإعدادات تعود إلى خطّ الأساس
 *
 * Re-runnable and non-destructive: the settings row is snapshotted before anything is
 * written and restored at the end, and 🧪 محاكاة is never switched off — no message is
 * ever dialled, because a WhatsApp number that is not ours cannot be reached from a test.
 * What the run does add to the demo tenant: one unit, one category, one item, one stock
 * opening, the parties and sales invoices it sends, and the message rows themselves.
 *
 * Usage: node scripts/verify-whatsapp.mjs
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

const settings = () => get('/whatsapp/settings').then((view) => view.settings);
const log = (query = '') => get(`/whatsapp/messages${query ? `?${query}` : ''}`).then((view) => view.messages);

// ══════════════════════════════════════════════════════ 1. 📖 القراءة
console.log('■ 1. 📖 القراءة — ما تعرضه الشاشة قبل أن تُمسّ');
const baseline = await settings();
check('البوابة تبدأ موقوفة', baseline.active === false, `تفعيل: ${baseline.active}`);
check('🧪 محاكاة تبدأ مفعّلة — لا تُطلب بوابة حقيقية', baseline.simulation === true);
check('رمز الدولة الافتراضي 966 — ما كان ثابتاً في النسخة المكتبية', baseline.defaultCountryCode === '966', baseline.defaultCountryCode);
check('📎 إرفاق الفاتورة يبدأ مفعّلاً — النسخة المكتبية كانت تُرفق دائماً', baseline.attachDocument === true);
check('لا يظهر الرمز إلا مقنَّعاً', baseline.tokenMasked === null || baseline.tokenMasked.startsWith('****'), baseline.tokenMasked ?? '— بلا رمز —');
check('العنوان هو WhatsApp Cloud API', baseline.baseUrl === 'https://graph.facebook.com', baseline.baseUrl);

// ══════════════════════════════════════════════════════ 2. 💾 التهيئة
console.log('\n■ 2. 💾 التهيئة — الرقم والرمز، وصنفٌ ورصيدٌ وعميلٌ له جوال');
await put('/whatsapp/settings', {
  active: true,
  phoneNumberId: '109357128475620',
  ...(baseline.hasToken ? {} : { accessToken: 'wa-verify-token-0001' }),
  defaultCountryCode: '966',
  attachDocument: true,
  simulation: true,
});
const saved = await settings();
check('💾 حفظ — مفعّلة', saved.active === true);
check('عنوان الواتساب محفوظ', saved.phoneNumberId === '109357128475620', saved.phoneNumberId);
check('الرمز محفوظ ومقنَّع', saved.hasToken === true && /^\*\*\*\*/.test(saved.tokenMasked ?? ''), saved.tokenMasked ?? '—');
check('الرمز نفسه لا يظهر في الردّ', JSON.stringify(saved).indexOf('wa-verify-token-0001') === -1);

const branches = await get('/branches');
const warehouses = await get('/warehouses');
const branchId = branches[0].id;
const warehouseId = warehouses[0].id;
const stamp = Date.now().toString(36);
const unitId = (await post('/organization/catalog/units', { code: `PCE-${stamp}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `GEN-${stamp}`, nameAr: 'عام' })).id;
const itemId = (await post('/organization/catalog/items', { sku: `RICE-${stamp}`, nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' })).id;
await post('/inventory/ledger/record', {
  lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000065' }],
});
const customerId = (await post('/parties', { kind: 'customer', name: 'مؤسسة النخبة', phone: '0551234567' })).id;
const noPhoneId = (await post('/parties', { kind: 'customer', name: 'عميل بلا جوال' })).id;
const profile = await get('/company-profile');
const companyName = profile.nameAr ?? profile.name ?? '';
check('الصنف والرصيد والعميل جاهزون', Boolean(itemId && customerId), `المنشأة: ${companyName}`);

async function newInvoice(extra = {}) {
  return post('/sales/invoices', {
    branchId,
    warehouseId,
    lines: [{ itemId, quantity: '2', unitPrice: '27.5', taxRate: '15' }],
    ...extra,
  });
}

async function postedInvoice(extra = {}) {
  const created = await newInvoice(extra);
  await post(`/sales/invoices/${created.id}/post`, {});
  return get(`/sales/invoices/${created.id}`);
}

// ══════════════════════════════════════════════════════ 3. 🧪 اختبار
console.log('\n■ 3. 🧪 اختبار — هل هذا الرقم لنا؟ و Logging الذي يبقى');
const beforeTest = (await log('limit=200')).length;
const tested = await post('/whatsapp/test', {});
check('🧪 اختبار يجيب', tested.ok === true, `${tested.displayPhoneNumber ?? '—'} · ${tested.verifiedName ?? ''}`);
check('🧪 يعمل في المحاكاة', tested.simulation === true);
check('الرقم معروض كما تعرضه ميتا', /^\+?[\d ]{8,}$/.test(tested.displayPhoneNumber ?? ''), tested.displayPhoneNumber ?? '—');
const logging = (await settings()).lastTest;
check('«Logging» محفوظ على الإعدادات', Boolean(logging) && (logging.lines ?? []).length > 0, (logging?.lines ?? []).join(' | ').slice(0, 90));
check('🧪 اختبار لا يُسجَّل رسالة', (await log('limit=200')).length === beforeTest);

// ══════════════════════════════════════════════════════ 4. 💬 واتساب
console.log('\n■ 4. 💬 واتساب — التحية كما كتبتها النسخة المكتبية، والرقم كما صاغته');
const invoice = await postedInvoice({ partyId: customerId });
const sent = await post('/whatsapp/send', { invoiceId: invoice.id });
check('الحالة: أُرسلت', sent.message.status === 'sent', sent.message.status);
check('الرقم: 0551234567 → 966551234567', sent.message.phone === '966551234567', `${sent.message.phone} — WhatsAppSender.cs L113-L116`);
check(
  'التحية: «🧾 مرحباً … هذه فاتورتك رقم … من …»',
  sent.message.message === `🧾 مرحباً مؤسسة النخبة، هذه فاتورتك رقم INV${invoice.number} من ${companyName}`,
  sent.message.message,
);
check('معرّف ميتا محفوظ', (sent.message.providerMessageId ?? '').startsWith('wamid.'), sent.message.providerMessageId ?? '—');
check('🧪 محاكاة — لم تُطلب شبكة', sent.message.simulation === true);
check('الرسالة تُحمل الفاتورة والعميل', sent.message.invoiceId === invoice.id && sent.message.partyId === customerId, invoice.number ?? '—');
const afterSend = await log(`invoiceId=${invoice.id}`);
check('الرسالة في السجل', afterSend.length === 1 && afterSend[0].id === sent.message.id);

// ══════════════════════════════════════════════════════ 5. 📎 المرفق
console.log('\n■ 5. 📎 المرفق — الفاتورة تخرج مع الرسالة، أو الكلمات وحدها');
const withSheet = await postedInvoice({ partyId: customerId }).then((doc) => post('/whatsapp/send', { invoiceId: doc.id }));
check('📎 أُرفقت', withSheet.attachment === 'sent' && withSheet.message.attachmentStatus === 'sent', withSheet.attachment);
check('اسم المرفق: «فاتورة-INV…txt»', withSheet.message.attachmentName === `فاتورة-INV${invoice.number}.txt` || /^فاتورة-INV.+\.txt$/.test(withSheet.message.attachmentName ?? ''), withSheet.message.attachmentName ?? '—');
check('معرّف المرفق محفوظ', (withSheet.message.attachmentMessageId ?? '').startsWith('wamid.'), withSheet.message.attachmentMessageId ?? '—');
check('بلا خطأ في الإرفاق', (withSheet.attachmentError ?? null) === null);
const wordsOnly = await postedInvoice({ partyId: customerId }).then((doc) => post('/whatsapp/send', { invoiceId: doc.id, attach: false }));
check('الكلمات وحدها — بلا مرفق', wordsOnly.attachment === 'none' && wordsOnly.message.attachmentName === null, wordsOnly.attachment);
check('📎 لا يمنع الرسالة نفسها', wordsOnly.message.status === 'sent');
const custom = await postedInvoice({ partyId: customerId }).then((doc) => post('/whatsapp/send', { invoiceId: doc.id, message: 'فاتورتك جاهزة — نشكرك على تعاملك معنا.' }));
check('نصٌّ يكتبه المستخدم يُرسل كما هو', custom.message.message === 'فاتورتك جاهزة — نشكرك على تعاملك معنا.');

// ══════════════════════════════════════════════════════ 6. 🔢 الأرقام
console.log('\n■ 6. 🔢 الأرقام — جوال العميل، جوال النقدي، ورمز دولةٍ آخر');
const cashInvoice = await postedInvoice({ cashCustomerName: 'عميل نقدي — تحقق واتساب', cashCustomerMobile: '0559876543' });
const cashSent = await post('/whatsapp/send', { invoiceId: cashInvoice.id });
check('الفاتورة النقدية تقرأ جوالها', cashSent.message.phone === '966559876543', cashSent.message.phone);
check('اسم العميل النقدي في التحية', cashSent.message.message.includes('عميل نقدي — تحقق واتساب'), cashSent.message.message);
const spaced = await postedInvoice({ partyId: customerId }).then((doc) => post('/whatsapp/send', { invoiceId: doc.id, to: '+966 55 123 4567' }));
check('المسافات والـ + لا تُفسد الرقم', spaced.message.phone === '966551234567', spaced.message.phone);
const prefixed = await postedInvoice({ partyId: customerId }).then((doc) => post('/whatsapp/send', { invoiceId: doc.id, to: '966551234567' }));
check('الرقم المكتمل لا يُكرَّر رمزه', prefixed.message.phone === '966551234567', prefixed.message.phone);
await put('/whatsapp/settings', { defaultCountryCode: '967' });
const yemen = await postedInvoice({ partyId: customerId }).then((doc) => post('/whatsapp/send', { invoiceId: doc.id, to: '0771234567' }));
check('رمز دولةٍ آخر — 967', yemen.message.phone === '967771234567', yemen.message.phone);
await put('/whatsapp/settings', { defaultCountryCode: '966' });
check('رمز الدولة يعود 966', (await settings()).defaultCountryCode === '966');

// ══════════════════════════════════════════════════════ 7. 🚫 الأبواب المغلقة
console.log('\n■ 7. 🚫 الأبواب المغلقة — ما يرفضه النظام قبل أن يطلب الشبكة');
const draft = await newInvoice({ partyId: customerId });
const onDraft = await refused('post', '/whatsapp/send', { invoiceId: draft.id });
check('مسوَّدة — 409 SALES_INVOICE_NOT_POSTED', onDraft.status === 409 && onDraft.code === 'SALES_INVOICE_NOT_POSTED', onDraft.detail);
check('«لا يمكن إرسال الفاتورة قبل ترحيلها — رحّلها أولاً.»', (onDraft.detail ?? '').includes('لا يمكن إرسال الفاتورة قبل ترحيلها'), onDraft.detail);
const noPhone = await postedInvoice({ partyId: noPhoneId });
const onNoPhone = await refused('post', '/whatsapp/send', { invoiceId: noPhone.id });
check('عميل بلا جوال — 422 WHATSAPP_PHONE_MISSING', onNoPhone.status === 422 && onNoPhone.code === 'WHATSAPP_PHONE_MISSING', onNoPhone.detail);
check('«❌ لا يوجد رقم جوال للعميل»', (onNoPhone.detail ?? '').includes('لا يوجد رقم جوال للعميل'), onNoPhone.detail);
const badNumber = await postedInvoice({ partyId: customerId });
const onBad = await refused('post', '/whatsapp/send', { invoiceId: badNumber.id, to: '12' });
check('رقمٌ تالف — 422 WHATSAPP_PHONE_INVALID', onBad.status === 422 && onBad.code === 'WHATSAPP_PHONE_INVALID', onBad.detail);
const onMissing = await refused('post', '/whatsapp/send', { invoiceId: '00000000-0000-4000-8000-000000000066' });
check('فاتورة غير موجودة — 404', onMissing.status === 404, onMissing.detail);
await put('/whatsapp/settings', { active: false });
const off = await postedInvoice({ partyId: customerId }).then((doc) => refused('post', '/whatsapp/send', { invoiceId: doc.id }));
check('بوابة موقوفة — 409 WHATSAPP_DISABLED', off.status === 409 && off.code === 'WHATSAPP_DISABLED', off.detail);
check('«الرجاء تفعيل الإرسال عبر واتساب.»', (off.detail ?? '').includes('الرجاء تفعيل الإرسال عبر واتساب.'), off.detail);
await put('/whatsapp/settings', { active: true });
check('البوابة تعود مفعّلة', (await settings()).active === true);

// ══════════════════════════════════════════════════════ 8. ❌ الرقم غير مرتبط بواتساب
console.log('\n■ 8. ❌ الرقم غير مرتبط بواتساب — تُسجَّل ولا تُبتلع');
// 🧪 Simulation decides «not on WhatsApp» from the number itself — the only way a run can
// ask for it. The words are the desktop's own (`WhatsAppSender.cs` L142).
const undelivered = await postedInvoice({ cashCustomerName: 'عميل بلا واتساب', cashCustomerMobile: '0550000000' }).then((doc) =>
  post('/whatsapp/send', { invoiceId: doc.id }),
);
check('الحالة: لم تُرسل', undelivered.message.status === 'failed', undelivered.message.status);
check(
  '«❌ الرقم غير مرتبط بحساب WhatsApp أو لم يتم تحميل المحادثة.»',
  (undelivered.message.error ?? '').includes('الرقم غير مرتبط بحساب WhatsApp'),
  undelivered.message.error ?? '—',
);
check('لا مُرفق بعد فشل الرسالة', undelivered.attachment === 'none' && undelivered.message.attachmentName === null);
check('لا مُحاولة إرفاق بعد فشل النص', undelivered.message.attachmentStatus === 'none');
const failedRows = await log('status=failed');
check('الفاشلة في السجل — «هل وصلت؟» يُجاب من هنا', failedRows.some((row) => row.id === undelivered.message.id), `${failedRows.length} فاشلة`);

// ══════════════════════════════════════════════════════ 9. 📜 السجل
console.log('\n■ 9. 📜 السجل — الأحدث أولاً، والمرشّحان');
const rows = await log('limit=200');
check('السجل ممتلئ', rows.length > 8, `${rows.length} رسالة`);
const times = rows.map((row) => Date.parse(row.createdAt));
check('الأحدث أولاً', [...times].sort((a, b) => b - a).join() === times.join());
const sentRows = await log('status=sent&limit=200');
check('مرشّح الحالة: sent', sentRows.length > 0 && sentRows.every((row) => row.status === 'sent'), `${sentRows.length} مُرسلة`);
const failedOnly = await log('status=failed&limit=200');
check('مرشّح الحالة: failed', failedOnly.length > 0 && failedOnly.every((row) => row.status === 'failed'), `${failedOnly.length} فاشلة`);
const forInvoice = await log(`invoiceId=${invoice.id}&limit=200`);
check('مرشّح الفاتورة', forInvoice.length > 0 && forInvoice.every((row) => row.invoiceId === invoice.id), `${forInvoice.length} رسالة على ${invoice.number ?? '—'}`);
check('السقف محترم', (await log('limit=3')).length === 3);
check('كل سطرٍ يحمل الرقم', rows.every((row) => (row.phone ?? '').length >= 8));
check('المُرسلة تحمل معرّف ميتا', sentRows.every((row) => (row.providerMessageId ?? '').length > 0));
check('الفاشلة تحمل سببها', failedOnly.every((row) => (row.error ?? '').length > 0));

// ══════════════════════════════════════════════════════ 10. 🔐 الصلاحيات
console.log('\n■ 10. 🔐 الصلاحيات — الإعدادات للمالك، و«💬 واتساب» لمن يرى الفاتورة');
// The invoices are the owner's: neither the accountant nor the cashier may post one, and
// this section is not about posting.
const accountantInvoice = await postedInvoice({ partyId: customerId });
const cashierInvoice = await postedInvoice({ partyId: customerId });
const ownerToken = token;
const accountantToken = await signIn(accountant);
const cashierToken = await signIn(cashier);
token = accountantToken;
const accountantInbox = await refused('get', '/whatsapp/messages?limit=1');
const accountantSettings = await refused('get', '/whatsapp/settings');
const accountantSave = await refused('put', '/whatsapp/settings', { active: true });
const accountantTest = await refused('post', '/whatsapp/test', {});
const accountantSend = await refused('post', '/whatsapp/send', { invoiceId: accountantInvoice.id });
token = cashierToken;
const cashierInbox = await refused('get', '/whatsapp/messages?limit=1');
const cashierSettings = await refused('get', '/whatsapp/settings');
const cashierSend = await refused('post', '/whatsapp/send', { invoiceId: cashierInvoice.id });
token = ownerToken;
check('المحاسب يقرأ السجل', accountantInbox.status === 200);
check('المحاسب يُرسل — من يرى الفاتورة يُرسلها', accountantSend.status === 200 || accountantSend.status === 201, `${accountantSend.status}`);
check('المحاسب لا يضبط الاتصال', accountantSettings.status === 403 && accountantSave.status === 403 && accountantTest.status === 403);
check('الكاشير يقرأ السجل', cashierInbox.status === 200);
check('الكاشير يُرسل', cashierSend.status === 200 || cashierSend.status === 201, `${cashierSend.status}`);
check('الكاشير لا يضبط الاتصال', cashierSettings.status === 403);
check('المالك يفعل كل شيء', (await refused('get', '/whatsapp/settings')).status === 200);

// ══════════════════════════════════════════════════════ 11. 🧹 التنظيف
console.log('\n■ 11. 🧹 التنظيف — الإعدادات تعود إلى خطّ الأساس');
await put('/whatsapp/settings', {
  active: baseline.active,
  phoneNumberId: baseline.phoneNumberId,
  defaultCountryCode: baseline.defaultCountryCode,
  attachDocument: baseline.attachDocument,
  simulation: baseline.simulation,
});
const restored = await settings();
check('التفعيل عاد إلى خطّ الأساس', restored.active === baseline.active, `تفعيل: ${restored.active}`);
check('عنوان الواتساب عاد إلى خطّ الأساس', restored.phoneNumberId === baseline.phoneNumberId, restored.phoneNumberId || '— بلا عنوان —');
check('رمز الدولة و 📎 عادا', restored.defaultCountryCode === baseline.defaultCountryCode && restored.attachDocument === baseline.attachDocument, `${restored.defaultCountryCode} · 📎 ${restored.attachDocument}`);
check('🧪 محاكاة بقيت مفعّلة — لا تُطلب شبكة في أي تشغيل', restored.simulation === true);
check('الرمز بقي محفوظاً ومقنَّعاً', restored.hasToken === true && /^\*\*\*\*/.test(restored.tokenMasked ?? ''), restored.tokenMasked ?? '—');

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
