#!/usr/bin/env node
/**
 * Live verification of R2 — «مطابقة نافذة فاتورة البيع»
 * (`docs/roadmap/AUDIT_PHASES_01_04.md` §6، تكملة المرحلة 02) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * المصادر المكتبية التي تُقابلها كل نقطة:
 *   `Form_WPF/frmInvSale.xaml`                                — النافذة: الحقول والأزرار وجدول البنود
 *   `Form_WPF/frmInvSale.xaml.cs`                             — `btnSave/btnSavePrint/btnDelete` وشروط الحفظ
 *   `Class/ItemOper.cs` `CalcTotal` (L1533)                   — حساب المجموع والخصم قبل الضريبة
 *   `Class/InvoiceOper.cs` `SaveInvoice` (L1310) · `BindToEntry` (L2252) · `SendZatca` (L2209)
 *                                                             — الحفظ + القيد + الإرسال في نداءٍ واحد
 *
 * ما يقيسه هذا السكربت (أرقام §2F التي كانت ثابتةً في الوثيقة منذ 2026-09-10):
 *
 *   1. 📖 خطّ الأساس — ما تعرضه القاعدة قبل أن تُمسّ (فواتير، قيود، رصيد)
 *   2. 🧾 التهيئة — وحدةٌ وتصنيفٌ وصنفٌ برصيد 50 @40 وعميل
 *   3. 🧮 الحساب — 2×500 − 20 @15% ⇒ **980/147/1127**، والخصم يُوزَّع على السطور قبل الضريبة
 *   4. 🧾 الترحيل — الرقم التسلسلي بـ`SI-`، والقيد الخماسي بالحسابات، والمخزون 50⇒48 بتكلفة 80
 *   5. 💵 التحصيل — بيعٌ نقديّ يُقيَّد على الصندوق بدفعةٍ حقيقية (`paidTotal`)
 *   6. ↩️ المرتجع — يعيد المخزون بتكلفة الفاتورة الأصلية (`returnAtOriginalCost`)
 *   7. 🔗 سلسلة المستندات (R2) — لا إلغاء لفاتورةٍ عليها مستندٌ مشتقّ مُرحَّل، ولا ترحيلَ
 *      مستندٍ مشتقّ إلى فاتورةٍ ملغاة، وإلغاء المرتجع يفتح الباب
 *   8. 🚫 الرفض — فاتورةٌ مدفوعة لا تُلغى، وخدمةٌ بلا مستودع تُرحَّل
 *   9. 🧹 التنظيف — العدّادات تعود إلى خطّ أساسها والرصيد يُصفَّر
 *
 * Re-runnable and non-destructive: كل عدّادٍ بالفرق (لا رقم مطلق)، والأرقام التسلسلية تُقرأ
 * ولا تُفترض، والصنف والعميل يُنشآن ببادئة `-${stamp}`، وما لا يُحذف (فواتيرُ الفحص) يبقى
 * مرقّماً ولا يُفسد تشغيلاً لاحقاً.
 *
 * Usage: node scripts/verify-sales-engine.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const owner = {
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};

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
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail ?? parsed.message;
    error.errors = parsed.errors ?? [];
    throw error;
  }
  return parsed.data ?? parsed;
}

/** نداءٌ **يُتوقَّع** رفضه: حالته ورمزه هما الجواب. */
async function refused(method, path, body) {
  try {
    await request(method, path, body);
    return { status: 200, code: '', detail: '', errors: [] };
  } catch (error) {
    return {
      status: error.status ?? 0,
      code: error.code ?? '',
      detail: error.detail ?? '',
      errors: error.errors ?? [],
    };
  }
}

async function signIn(credentials) {
  // المنصّة تخنق `/auth/login` لكل عنوان، والتشغيل يسجّل دخولاً واحداً؛ والـ429 ليس فشلاً.
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
const list = (path) => get(path).then((view) => view.data ?? view);

token = await signIn(owner);
console.log(`✔ logged in to ${tenantCode} as ${owner.email}\n`);

// ══════════════════════════════════════════════════════ 1. 📖 خطّ الأساس
console.log('■ 1. 📖 خطّ الأساس — القاعدة كما هي قبل أن تُمسّ');
const branches = await list('/branches');
const warehouses = await list('/warehouses');
const branchId = branches[0]?.id;
const warehouseId = warehouses[0]?.id;
const accounts = await list('/accounts?limit=200');
const accountByCode = new Map(accounts.map((row) => [row.code, row]));
const baselineInvoices = (await list('/sales/invoices')).length;
const baselineEntries = (await list('/journal-entries?limit=200')).length;
check('فرعٌ ومستودع في مستأجر العرض', Boolean(branchId && warehouseId), `${branches[0]?.code} · ${warehouses[0]?.name}`);
const NEEDED = {
  12310001: 'عميل عام',
  4100001: 'المبيعات',
  4100002: 'مردودات المبيعات',
  4100003: 'خصم ممنوح',
  2222001: 'ضريبة القيمة المضافة',
  3200004: 'تكلفة المبيعات',
  1270001: 'حساب بضاعة آخر المدة',
};
const missing = Object.keys(NEEDED).filter((code) => !accountByCode.get(code)?.isPostable);
check(
  'حسابات القيد الخماسي موجودةٌ وقابلةٌ للترحيل',
  missing.length === 0,
  missing.length ? `ناقص: ${missing.join('، ')}` : Object.keys(NEEDED).join('، '),
);
check(
  'العدّادان يُقرآن — وكل فحصٍ لاحقٍ بالفرق لا بالرقم المطلق',
  Number.isInteger(baselineInvoices) && Number.isInteger(baselineEntries),
  `${baselineInvoices} فاتورة · ${baselineEntries} قيد`,
);

// ══════════════════════════════════════════════════════ 2. 🧾 التهيئة
console.log('\n■ 2. 🧾 التهيئة — صنفٌ برصيد 50 @40 وعميل');
const stamp = Date.now().toString(36).toUpperCase();
const unitId = (await post('/organization/catalog/units', { code: `SU-${stamp}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `SC-${stamp}`, nameAr: 'عام' })).id;
const item = await post('/organization/catalog/items', {
  sku: `SVAR-${stamp}`,
  nameAr: 'صنف تحقّق محرّك البيع',
  categoryId,
  baseUnitId: unitId,
  kind: 'stock',
  salePrice: '500',
});
await post('/inventory/ledger/record', {
  lines: [
    {
      itemId: item.id,
      warehouseId,
      qty: '50',
      unitCost: '40',
      direction: 'in',
      docType: 'opening',
      docId: '00000000-0000-4000-8000-0000000000b2',
    },
  ],
});
const party = await post('/parties', { kind: 'customer', name: 'عميل تحقّق محرّك البيع' });
const levels = async () => {
  const rows = await list(`/inventory/levels?warehouse_id=${warehouseId}&item_id=${item.id}`);
  return String(rows[0]?.quantity ?? '0');
};
check('الصنف أُنشئ بسعر 500', item.salePrice === '500.0000', `${item.sku} · ${item.salePrice}`);
check('الرصيد الافتتاحي 50 @40', (await levels()) === '50.0000', await levels());

/** فاتورة 2×500 بخصم رأس: الحالة المرجعية في §2F. */
const caseInvoice = (discount, extra = {}) =>
  post('/sales/invoices', {
    branchId,
    warehouseId,
    partyId: party.id,
    invoiceDiscount: discount,
    lines: [{ itemId: item.id, quantity: '2', unitPrice: '500', taxRate: '15' }],
    ...extra,
  });

// ══════════════════════════════════════════════════════ 3. 🧮 الحساب
console.log('\n■ 3. 🧮 الحساب — خصمٌ قبل الضريبة، موزَّعٌ على السطور (بديل `CalcTotal`)');
const draft = await caseInvoice('20');
check(
  '2×500 − 20 @15% ⇒ 980 / 147 / 1127',
  draft.subtotal === '980.0000' && draft.taxTotal === '147.0000' && draft.total === '1127.0000',
  `${draft.subtotal} · ${draft.taxTotal} · ${draft.total}`,
);
const line = draft.lines[0];
check(
  'والسطر يحمل الصافي بعد نصيبه من الخصم لا قبله',
  line.net === '980.0000' && line.tax === '147.0000' && line.total === '1127.0000',
  `${line.quantity}×${line.unitPrice} ⇒ صافٍ ${line.net} · ضريبة ${line.tax} · إجمالي ${line.total}`,
);
check('والمسودّة بلا رقمٍ رسميّ بعد', draft.status === 'draft' && draft.number === null, `${draft.status} · ${draft.number}`);

// قاعدة الديسكتوب `CalcTotal` (L1558): نصيب السطر من خصم الرأس = الخصم × إجمالي السطر ÷
// إجمالي الفاتورة — فتختلف الأنصبة باختلاف السطور، وهذا ما لا يظهر في فاتورةٍ بسطرٍ واحد.
const proRata = await post('/sales/invoices', {
  branchId,
  warehouseId,
  partyId: party.id,
  invoiceDiscount: '40',
  lines: [
    { itemId: item.id, quantity: '1', unitPrice: '500', taxRate: '15' },
    { itemId: item.id, quantity: '3', unitPrice: '500', taxRate: '15' },
  ],
});
check(
  'خصم الرأس يُوزَّع على السطور بنسبة إجمالي كل سطر (1×500 · 3×500 بخصم 40)',
  proRata.lines[0]?.net === '490.0000' && proRata.lines[1]?.net === '1470.0000',
  `${proRata.lines[0]?.net} · ${proRata.lines[1]?.net}`,
);
check(
  'فالضريبة تُحسب على الصافي بعد الخصم لكل سطر',
  proRata.lines[0]?.tax === '73.5000' && proRata.lines[1]?.tax === '220.5000' && proRata.total === '2254.0000',
  `${proRata.lines[0]?.tax} · ${proRata.lines[1]?.tax} · إجمالي ${proRata.total}`,
);

// ══════════════════════════════════════════════════════ 4. 🧾 الترحيل
console.log('\n■ 4. 🧾 الترحيل — `SaveInvoice` + `BindToEntry` في معاملةٍ واحدة');
const posted = await post(`/sales/invoices/${draft.id}/post`, {});
check('الفاتورة صارت `posted` برقم SI-', posted.status === 'posted' && /^SI-\d{6}$/.test(posted.number ?? ''), `${posted.status} · ${posted.number}`);
check('المخزون 50 ⇒ 48', (await levels()) === '48.0000', await levels());
check('تكلفة السطر مُهرَّت بمتوسط 40 ⇒ 80', posted.lines[0]?.costTotal === '80.0000', `${posted.lines[0]?.costTotal}`);

const entriesList = await list('/journal-entries?limit=200');
const entry = entriesList.find((row) => row.description === `Sales invoice ${posted.number}` && row.kind !== 'reversal');
check('قيد الفاتورة كُتب تلقائياً', Boolean(entry), entry?.kind ?? '—');
const entryDetail = entry ? await get(`/journal-entries/${entry.id}`) : { lines: [] };
const legs = (entryDetail.lines ?? [])
  .map((row) => {
    const code = [...accountByCode.entries()].find(([, account]) => account.id === row.accountId)?.[0] ?? row.accountId;
    return `${row.debit !== '0.0000' ? 'Dr' : 'Cr'} ${code} ${row.debit !== '0.0000' ? row.debit : row.credit}`;
  })
  .sort();
const expectedLegs = [
  'Cr 1270001 80.0000',
  'Cr 2222001 147.0000',
  'Cr 4100001 1000.0000',
  'Dr 12310001 1127.0000',
  'Dr 3200004 80.0000',
  'Dr 4100003 20.0000',
].sort();
check(
  'القيد الخماسي بحساباته هو هو (§2F)',
  JSON.stringify(legs) === JSON.stringify(expectedLegs),
  legs.join(' · '),
);

// ══════════════════════════════════════════════════════ 5. 💵 التحصيل
console.log('\n■ 5. 💵 التحصيل — بيعٌ نقديّ بدفعةٍ حقيقية لا بعلمٍ فقط');
const cashLocations = await list('/cash-locations');
const cashLocation = cashLocations.find((row) => row.kind === 'cash') ?? cashLocations[0];
check('موقع نقديّ للتحصيل موجود', Boolean(cashLocation), `${cashLocation?.name ?? '—'} (${cashLocation?.kind ?? '—'})`);
const cashDraft = await post('/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: 'عميل نقدي — محرّك البيع',
  cashCustomerMobile: '0555555555',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '100', taxRate: '15' }],
});
const settlement = cashLocation.kind === 'cash' ? 'cash' : 'bank';
const cashPosted = await post(`/sales/invoices/${cashDraft.id}/post`, {
  settlement,
  settlementAccountId: cashLocation.accountId,
  settlementCashLocationId: cashLocation.id,
});
check(
  'فاتورةٌ نقدية 100 @15% ⇒ 115 مدفوعةٌ كاملة',
  cashPosted.total === '115.0000' && cashPosted.paidTotal === '115.0000' && cashPosted.paymentStatus === 'paid',
  `${cashPosted.total} · ${cashPosted.paidTotal} · ${cashPosted.paymentStatus}`,
);
const cashDetail = await get(`/sales/invoices/${cashPosted.id}`);
check('ولها صفّ دفعةٍ بالصندوق', Array.isArray(cashDetail.payments) && cashDetail.payments.length === 1, `${(cashDetail.payments ?? []).length} دفعة · ${cashDetail.payments?.[0]?.method ?? '—'}`);

// ══════════════════════════════════════════════════════ 6. ↩️ المرتجع
console.log('\n■ 6. ↩️ المرتجع — يعيد المخزون بتكلفة الفاتورة الأصلية');
const returnedDraft = await post(`/sales/invoices/${draft.id}/return`, {
  branchId,
  warehouseId,
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '500' }],
});
const returned = await post(`/sales/invoices/${returnedDraft.id}/post`, {});
check('المرتجع مُرحَّلٌ برقم SR-', returned.status === 'posted' && /^SR-\d{6}$/.test(returned.number ?? ''), `${returned.status} · ${returned.number}`);
// بيعُ §5 النقدي أخذ وحدةً أيضاً ⇒ 50 − 2 − 1 = 47 قبل المرتجع.
check('والمخزون عاد 47 ⇒ 48', (await levels()) === '48.0000', await levels());
check('ويشير إلى فاتورته الأصلية', returned.referenceInvoiceId === draft.id, `${returned.referenceInvoiceId?.slice(0, 8)}…`);
const overReturn = await refused('post', `/sales/invoices/${draft.id}/return`, {
  branchId,
  warehouseId,
  lines: [{ itemId: item.id, quantity: '2', unitPrice: '500' }],
});
check(
  'والإرجاع فوق المُرتجَع يُرفض («الفاتورة تم إرجاعها سابقاً أو بعض الأصناف»)',
  overReturn.status === 422 && overReturn.code === 'SALES_RETURN_QUANTITY_EXCEEDED',
  `${overReturn.status} ${overReturn.code}`,
);

// ══════════════════════════════════════════════════════ 7. 🔗 سلسلة المستندات
console.log('\n■ 7. 🔗 سلسلة المستندات — لا مرجعٌ معلّق إلى فاتورةٍ ملغاة');
const blockedVoid = await refused('post', `/sales/invoices/${draft.id}/void`, { reason: 'إلغاءٌ والمرتجع قائم' });
check(
  'إلغاء فاتورةٍ عليها مرتجعٌ مُرحَّل يُرفض 409',
  blockedVoid.status === 409 && blockedVoid.code === 'SALES_VOID_HAS_RETURNS',
  `${blockedVoid.status} ${blockedVoid.code}`,
);
check(
  'والرفض يسمّي المستندات التي تحجب',
  blockedVoid.errors?.[0]?.count === 1 && blockedVoid.errors?.[0]?.references?.[0]?.id === returned.id,
  `${blockedVoid.errors?.[0]?.count} مستند · ${blockedVoid.errors?.[0]?.references?.[0]?.number ?? '—'}`,
);
const untouched = await get(`/sales/invoices/${draft.id}`);
check('والفاتورة لم تُمسّ — الرفض قبل أي كتابة', untouched.status === 'posted', untouched.status);

// الوجه الآخر: مسودّةٌ لا تمنع الإلغاء (أثرها صفر)، لكن ترحيلها بعده ممنوع.
const lateDraft = await post('/sales/invoices', {
  branchId,
  warehouseId,
  partyId: party.id,
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '500', taxRate: '15' }],
});
await post(`/sales/invoices/${lateDraft.id}/post`, {});
const lateReturn = await post(`/sales/invoices/${lateDraft.id}/return`, {
  branchId,
  warehouseId,
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '500' }],
});
const levelBeforeLateVoid = await levels();
const lateVoid = await post(`/sales/invoices/${lateDraft.id}/void`, { reason: 'إلغاءٌ والمرتجع مسودّة' });
check(
  'وإلغاء الفاتورة يمرّ ما دام المرتجع مسودّة (لا أثر لها)',
  lateVoid.status === 'voided',
  `${lateVoid.status} · الرصيد ${levelBeforeLateVoid} ⇒ ${await levels()}`,
);
const latePost = await refused('post', `/sales/invoices/${lateReturn.id}/post`, {});
check(
  'لكن ترحيل المرتجع بعد إلغاء الفاتورة يُرفض 409',
  latePost.status === 409 && latePost.code === 'SALES_REFERENCE_VOIDED',
  `${latePost.status} ${latePost.code}`,
);
const lateReturnAfter = await get(`/sales/invoices/${lateReturn.id}`);
check('والمسودّة بقيت مسودّة (لا قيد ولا مخزون)', lateReturnAfter.status === 'draft', lateReturnAfter.status);

// وإلغاء المرتجع يفتح باب إلغاء الفاتورة — لا حبسَ مقصوداً في الحاجز.
const voidedReturn = await post(`/sales/invoices/${returned.id}/void`, { reason: 'إلغاء المرتجع أولاً' });
check('إلغاء المرتجع يمرّ', voidedReturn.status === 'voided', voidedReturn.status);
const voidedInvoice = await post(`/sales/invoices/${draft.id}/void`, { reason: 'لم يبقَ مستندٌ مشتقّ' });
check('وإلغاء الفاتورة يمرّ بعده', voidedInvoice.status === 'voided', voidedInvoice.status);
// عكس المرتجع (+1) وعكس الفاتورة الأصلية (+2) يقابلان ما نُقص، ويبقى نقصُ وحدةٍ واحدة من
// بيع §5 النقدي: 50 −2 −1 +1 −1 +1 −1 +2 = 49.
check('والمخزون استقرّ على 49 — الوحدةُ المتبقية هي بيع §5 النقدي', (await levels()) === '49.0000', await levels());

// ══════════════════════════════════════════════════════ 8. 🚫 الرفض
console.log('\n■ 8. 🚫 الرفض — أبوابٌ مغلقة بعبارات الديسكتوب');
const paidVoid = await refused('post', `/sales/invoices/${cashPosted.id}/void`, { reason: 'طالبَ العميل إلغاءها' });
check(
  'فاتورةٌ مدفوعة لا تُلغى — تُردّ الدفعة أولاً',
  paidVoid.status === 409 && paidVoid.code === 'SALES_VOID_HAS_PAYMENTS',
  `${paidVoid.status} ${paidVoid.code}`,
);
const noReason = await refused('post', `/sales/invoices/${cashPosted.id}/void`, { reason: '   ' });
check('وبلا سببٍ مكتوب لا إلغاء', noReason.status === 422 && noReason.code === 'SALES_VOID_REASON_REQUIRED', `${noReason.status} ${noReason.code}`);

const serviceItem = await post('/organization/catalog/items', {
  sku: `SSVC-${stamp}`,
  nameAr: 'خدمة تحقّق محرّك البيع',
  categoryId,
  baseUnitId: unitId,
  kind: 'service',
  salePrice: '200',
});
const serviceDraft = await post('/sales/invoices', {
  branchId,
  partyId: party.id,
  lines: [{ itemId: serviceItem.id, quantity: '1', unitPrice: '200', taxRate: '15' }],
});
const servicePosted = await post(`/sales/invoices/${serviceDraft.id}/post`, {});
check('فاتورة خدمةٍ بلا مستودع تُرحَّل', servicePosted.status === 'posted', `${servicePosted.number} · ${servicePosted.total}`);
const serviceVoided = await post(`/sales/invoices/${servicePosted.id}/void`, { reason: 'خدمةٌ بلا مخزون' });
check('وتُلغى بلا أثرٍ مخزني', serviceVoided.status === 'voided', serviceVoided.status);

// إعادة الترحيل ليست رفضاً: `postInTx` تردّ المستند كما هو (idempotent) بلا قيدٍ ثانٍ.
const entriesBeforeTwice = (await list('/journal-entries?limit=200')).length;
const twice = await post(`/sales/invoices/${cashPosted.id}/post`, {});
const sameNumber = twice.number === cashPosted.number && twice.status === 'posted';
const entriesAfterTwice = (await list('/journal-entries?limit=200')).length;
check(
  'وفاتورةٌ مرّحّلة لا تُرحَّل مرّتين — نفس الرقم ولا قيدَ ثانٍ',
  sameNumber && entriesAfterTwice === entriesBeforeTwice,
  `${twice.number ?? twice.code} · القيود ${entriesBeforeTwice} ⇒ ${entriesAfterTwice}`,
);

// ══════════════════════════════════════════════════════ 9. 🧹 التنظيف
console.log('\n■ 9. 🧹 التنظيف — العدّادات والرصيد إلى خطّ أساسها');
const finalInvoices = (await list('/sales/invoices')).length;
const finalEntries = (await list('/journal-entries?limit=200')).length;
// الرصيد لا يعود 50 لأنّ بيع §5 النقدي يبقى مُرحَّلاً (مدفوعٌ لا يُلغى — §8).
check('الرصيد استقرّ على 49 لا 50 (§5 النقدي قائم)', (await levels()) === '49.0000', await levels());
const all = await list('/sales/invoices');
const byId = new Map(all.map((row) => [row.id, row]));
const danglingPosted = all.filter((row) => {
  if (!row.referenceInvoiceId || row.status !== 'posted') return false;
  return byId.get(row.referenceInvoiceId)?.status === 'voided';
});
check(
  'ولا مستندَ مُرحَّلاً يشير إلى فاتورةٍ ملغاة',
  danglingPosted.length === 0,
  danglingPosted.map((row) => row.number).join('، ') || `فُحص ${all.length} مستنداً`,
);
check('الفواتير التي أُنشئت للفحص بقيت مرقّمةً (لا حذف)', finalInvoices > baselineInvoices, `${finalInvoices} بعد ${baselineInvoices} قبل`);
check('والقيود زادت بمقدار ما رُحّل', finalEntries > baselineEntries, `${finalEntries} بعد ${baselineEntries} قبل`);

console.log(
  `\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
