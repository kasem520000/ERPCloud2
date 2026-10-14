#!/usr/bin/env node
/**
 * Live verification of Phase 09 part three — 🧾 فاتورة التفصيل — against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 👔 نوع الثوب — سعودي · بحريني · اماراتي · كويتي بترتيب القائمة (`AddNewSizes`
 *      L423), و📐 المقاسات — سجلّ الحقول التسعة والثلاثين بأسماء `Inv_Sub_Tailor`
 *      وتسميات الشاشة
 *   2. 🧾 حفظ الفاتورة — البطاقة كاملة برقمها `TI-000001`، وإجماليها 💵، وصافيها
 *      بالضريبة 💳، وباقيها ⏳، والرفضان «برجاء اختيار العميل» و«يرجي إدخال السعر»
 *   3. 📌 الحالة — من «مستلم» إلى «جاهز» إلى «تم التسليم» (`GetStateText` L119)
 *   4. 💵 إستلام دفعة — بلا صندوق وبصندوق، والسند الذي يربط الدفعة بالخزينة
 *      («تم استلام دفعة من عملية رقم {code}», L683)
 *   5. 📋 عرض الطلبات — البحث بالجوال أو بالاسم («🔍 الهاتف أو اسم العميل...») و«النتائج»
 *   6. ✏️ تعديل و🗑️ حذف، ثم التنظيف — ما أُنشئ في هذا التشغيل يُحذف
 *
 * Re-runnable and non-destructive: the فاتورة this script creates carries the run's
 * stamp and is deleted at the end, a عميل is only created when the tenant has none, and
 * nothing that already existed is touched. The سند قبض the payment creates is a real
 * voucher in the treasury — it is left alone, never deleted with the فاتورة.
 *
 * Usage: node scripts/verify-tailoring-invoices.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const money = (value) => Number(value).toFixed(2);
const round = (value) => Number(value.toFixed(4));
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    // Node 22's undici rejects lowercase verbs: `patch` comes back a 405 with an empty
    // body, and `JSON.parse('')` then throws instead of reporting the real problem.
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
    error.detail = parsed.detail;
    throw error;
  }
  return parsed.data ?? parsed;
}

const login = await call('post', '/auth/login', undefined, { tenantCode, email, password });
const token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path, token);
const post = (path, body) => call('post', path, token, body);
const patch = (path, body) => call('patch', path, token, body);
const del = (path) => call('delete', path, token);

/** A refusal is a result, not a crash — the desktop shows the sentence to the operator. */
async function refused(method, path, body) {
  try {
    await call(method, path, token, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

const day = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
console.log('1. 👔 نوع الثوب و📐 المقاسات');

const garments = await get('/tailoring/garment-types');
check(
  '👔 أنواع الثوب بترتيب القائمة — `typeCB` L423',
  garments.map((row) => row.nameAr).join(' · ') === 'سعودي · بحريني · اماراتي · كويتي' &&
    garments.map((row) => row.displayOrder).join(',') === '1,2,3,4',
  garments.map((row) => row.nameAr).join(' · '),
);
const garmentSaudi = garments.find((row) => row.code === 'saudi')?.id ?? '';

const fields = await get('/tailoring/measurement-fields');
const fieldByKey = (key) => fields.find((row) => row.key === key);
check(
  '📐 سجلّ المقاسات — 39 حقلاً كما في `Inv_Sub_Tailor`',
  fields.length === 39,
  `${fields.length} حقلاً`,
);
check(
  '📐 المجموعات الثلاث — `📐 المقاسات · ✨ الأشكال والتفاصيل · 📏 مقاسات إضافية`',
  new Set(fields.map((row) => row.group)).size === 3 &&
    fields.filter((row) => row.group === 'shapes').length > 0,
  [...new Set(fields.map((row) => row.group))].join(' · '),
);
check(
  '📐 التسميات من الشاشة — `الطول (س)` · `الكتف` · `شكل اليد` · `أسفل`',
  fieldByKey('height1')?.label === 'الطول (س)' &&
    fieldByKey('shoulder')?.label === 'الكتف' &&
    fieldByKey('handShape')?.label === 'شكل اليد' &&
    fieldByKey('down')?.label === 'أسفل',
  [fieldByKey('height1')?.label, fieldByKey('shoulder')?.label, fieldByKey('handShape')?.label, fieldByKey('down')?.label].join(' · '),
);
check(
  '✨ شكل اليد — خيارات `cmbHandShape` الستة',
  (fieldByKey('handShape')?.options ?? []).join(' · ') ===
    'يد ساده · يد ساده مثل الكبك · كبك قلاب · كبك مربع · كبك مشتول · كبك مدور',
  (fieldByKey('handShape')?.options ?? []).join(' · '),
);

// ---------------------------------------------------------------------------
console.log('\n2. 🧾 حفظ الفاتورة — البطاقة كاملة');

const statuses = await get('/tailoring/order-statuses');
const statusReceived = statuses.find((row) => row.code === 'received')?.id ?? '';
const statusReady = statuses.find((row) => row.code === 'ready')?.id ?? '';
const statusDelivered = statuses.find((row) => row.code === 'delivered')?.id ?? '';

const customers = await get('/parties?kind=customer');
const borrowed = customers[0]?.id;
const customer = borrowed
  ? customers[0]
  : await post('/parties', { kind: 'customer', name: `عميل تفصيل ${stamp}`, phone: '0551234567' });
check('👤 بيانات العميل', Boolean(customer?.id), borrowed ? `${customer.name} (عميل قائم)` : `أُنشئ: ${customer.name}`);

const invoice = await post('/tailoring/invoices', {
  partyId: customer.id,
  customerName: customer.name,
  phone: customer.phone ?? '0551234567',
  invoiceDate: day(0),
  quantity: '2',
  unitPrice: '500',
  statusId: statusReceived,
  garmentTypeId: garmentSaudi,
  measurements: { height1: '170', shoulder: '46', handShape: 'كبك مربع', trangle: 'true', down: '60' },
  notes: 'ياقة صينية',
});
check('📋 رقم الفاتورة', /^TI-\d{6}$/.test(invoice.number ?? ''), invoice.number);
check(
  '💵 الإجمالي = 💰 السعر × 🔢 العدد (`CalculateTotalPrice` L860)',
  Number(invoice.total) === 1000,
  `${money(invoice.unitPrice)} × ${Number(invoice.quantity)} = ${money(invoice.total)}`,
);
check(
  '💳 الصافي (مع الضريبة) = الإجمالي × 1.05 (`CreateInvoice` L419)',
  round(Number(invoice.totalWithTax)) === 1050,
  money(invoice.totalWithTax),
);
check(
  '⏳ الباقي = الصافي − المدفوع، ولا مدفوع بعد',
  round(Number(invoice.remainingAmount)) === 1050 && Number(invoice.paidAmount) === 0,
  `${money(invoice.remainingAmount)} · ${money(invoice.paidAmount)}`,
);
check(
  '👤 الاسم · 📱 الجوال · 👔 نوع الثوب · 📌 الحالة',
  invoice.customerName === customer.name &&
    invoice.garmentTypeName === 'سعودي' &&
    invoice.statusName === 'مستلم',
  `${invoice.customerName} · ${invoice.garmentTypeName} · ${invoice.statusName}`,
);
check(
  '📐 المقاسات — ما كُتب يعود كما كُتب',
  invoice.measurements?.height1 === '170' &&
    invoice.measurements?.handShape === 'كبك مربع' &&
    invoice.measurements?.trangle === 'true' &&
    invoice.notes === 'ياقة صينية',
  `الطول ${invoice.measurements?.height1} · شكل اليد ${invoice.measurements?.handShape} · ${invoice.notes}`,
);

const noCustomer = await refused('post', '/tailoring/invoices', { customerName: '   ', unitPrice: '100' });
check(
  '«برجاء اختيار العميل» (`btnSave_Click` L197)',
  noCustomer.status === 422 &&
    noCustomer.code === 'TAILORING_INVOICE_CUSTOMER_REQUIRED' &&
    noCustomer.detail === 'برجاء اختيار العميل',
  `${noCustomer.status} ${noCustomer.code} — ${noCustomer.detail}`,
);
const noPrice = await refused('post', '/tailoring/invoices', { customerName: customer.name });
check(
  '«يرجي إدخال السعر» (L193 — الإجمالي صفر)',
  noPrice.status === 422 &&
    noPrice.code === 'TAILORING_INVOICE_PRICE_REQUIRED' &&
    noPrice.detail === 'يرجي إدخال السعر',
  `${noPrice.status} ${noPrice.code} — ${noPrice.detail}`,
);
const zeroQuantity = await refused('post', '/tailoring/invoices', {
  customerName: customer.name,
  unitPrice: '100',
  quantity: '0',
});
check(
  'العدد صفر إجماليه صفر — نفس الرفض',
  zeroQuantity.status === 422 && zeroQuantity.code === 'TAILORING_INVOICE_PRICE_REQUIRED',
  `${zeroQuantity.status} ${zeroQuantity.code}`,
);
const unknownField = await refused('post', '/tailoring/invoices', {
  customerName: customer.name,
  unitPrice: '100',
  measurements: { height9: '1' },
});
check(
  '📐 قياس مجهول الاسم لا يُحفظ',
  unknownField.status === 422 &&
    unknownField.code === 'TAILORING_MEASUREMENT_FIELD_UNKNOWN' &&
    unknownField.detail === 'قياس غير معروف: height9',
  `${unknownField.status} ${unknownField.code} — ${unknownField.detail}`,
);

// ---------------------------------------------------------------------------
console.log('\n3. 📌 الحالة — `GetStateText` L119');

const ready = await post(`/tailoring/invoices/${invoice.id}/status`, { statusId: statusReady });
check('🔄 تغيير الحالة — «جاهز»', ready.statusName === 'جاهز', ready.statusName);
const delivered = await post(`/tailoring/invoices/${invoice.id}/status`, { statusId: statusDelivered });
check('🔄 تغيير الحالة — «تم التسليم»', delivered.statusName === 'تم التسليم', delivered.statusName);
const unknownStatus = await refused('post', `/tailoring/invoices/${invoice.id}/status`, {
  statusId: '00000000-0000-4000-8000-000000000000',
});
check(
  'حالة الفاتورة غير موجودة',
  unknownStatus.status === 404 && unknownStatus.code === 'TAILORING_STATUS_NOT_FOUND',
  `${unknownStatus.status} ${unknownStatus.code}`,
);

// ---------------------------------------------------------------------------
console.log('\n4. 💵 إستلام دفعة — `frmSandQ` بـ `ISTailor = true`');

const cashless = await post(`/tailoring/invoices/${invoice.id}/payments`, { amount: '400', date: day(0) });
check(
  '✅ المدفوع يكبر و⏳ الباقي ينقص',
  Number(cashless.paidAmount) === 400 && round(Number(cashless.remainingAmount)) === 650,
  `${money(cashless.paidAmount)} · ${money(cashless.remainingAmount)}`,
);
const cashlessLine = (cashless.payments ?? []).find((row) => !row.voucherId);
check(
  '📝 «تم استلام دفعة من عملية رقم {code}» (L683)',
  cashlessLine?.note === `تم استلام دفعة من عملية رقم ${invoice.number}`,
  cashlessLine?.note ?? '—',
);
const zeroPayment = await refused('post', `/tailoring/invoices/${invoice.id}/payments`, { amount: '0' });
check(
  'دفعة بلا مبلغ مرفوضة',
  zeroPayment.status === 422 && zeroPayment.code === 'TAILORING_PAYMENT_AMOUNT_INVALID',
  `${zeroPayment.status} ${zeroPayment.code}`,
);

const safes = await get('/cash-locations');
const branches = await get('/branches');
const safe = safes.find((row) => row.isDefault) ?? safes[0];
const branch = branches.find((row) => row.isDefault) ?? branches[0];
check(
  '💵 الصندوق والفرع',
  Boolean(safe?.id) && Boolean(branch?.id),
  safe && branch ? `${safe.name} · ${branch.nameAr ?? branch.name ?? branch.code}` : 'لا صندوق أو فرع',
);

let voucherId = '';
if (safe?.id) {
  const paid = await post(`/tailoring/invoices/${invoice.id}/payments`, {
    amount: '250',
    date: day(0),
    cashLocationId: safe.id,
    branchId: branch?.id,
    method: 'cash',
    note: 'دفعة نقدية',
  });
  check(
    '✅ المدفوع تراكمي — 400 + 250',
    Number(paid.paidAmount) === 650 && round(Number(paid.remainingAmount)) === 400,
    `${money(paid.paidAmount)} · ${money(paid.remainingAmount)}`,
  );
  const linked = (paid.payments ?? []).find((row) => row.note === 'دفعة نقدية');
  check('سند قبض مربوط بالدفعة', Boolean(linked?.voucherId), linked?.voucherId ?? '—');
  if (linked?.voucherId) {
    const voucher = await get(`/vouchers/${linked.voucherId}`);
    voucherId = voucher.id ?? '';
    check(
      '🧾 السند في الخزينة — سند قبض من العميل',
      voucher.kind === 'receipt' && voucher.subtype === 'customer' && Number(voucher.amount) === 250,
      // A سند is numbered when it is posted; until then the draft carries no number.
      `${voucher.number ?? 'مسودة'} · ${voucher.kind}/${voucher.subtype} · ${money(voucher.amount)} · ${voucher.status}`,
    );
  }
} else {
  check('💵 إستلام دفعة بصندوق', false, 'لا يوجد صندوق في هذه المؤسسة');
}

const invoiceAfterPayments = await get(`/tailoring/invoices/${invoice.id}`);
check(
  '📋 الفاتورة تحمل دفعاتها عند عرضها',
  invoiceAfterPayments.payments?.length === 2,
  `${invoiceAfterPayments.payments?.length ?? 0} دفعة`,
);

// ---------------------------------------------------------------------------
console.log('\n5. 📋 عرض الطلبات — «🔍 الهاتف أو اسم العميل...»');

const second = await post('/tailoring/invoices', {
  customerName: `زبون ${stamp}`,
  phone: '0557654321',
  quantity: '1',
  unitPrice: '300',
  statusId: statusReceived,
});
const all = await get('/tailoring/invoices');
check('📋 القائمة تعرض الفواتير', all.length >= 2, `النتائج: ${all.length}`);
const byPhone = await get(`/tailoring/invoices?search=${encodeURIComponent('0557654321')}`);
check(
  '🔍 بحث بالجوال — `phone_num LIKE @search` (L64)',
  byPhone.length === 1 && byPhone[0].number === second.number,
  byPhone.map((row) => row.number).join(' · ') || '—',
);
const byName = await get(`/tailoring/invoices?search=${encodeURIComponent(customer.name)}`);
check(
  '🔍 بحث بالاسم — `name LIKE @search`',
  byName.some((row) => row.number === invoice.number) && !byName.some((row) => row.number === second.number),
  byName.map((row) => row.number).join(' · ') || '—',
);
const byStatus = await get(`/tailoring/invoices?statusId=${statusDelivered}`);
check(
  '📌 الحالة — تصفية القائمة',
  byStatus.some((row) => row.number === invoice.number) && !byStatus.some((row) => row.number === second.number),
  `«تم التسليم»: ${byStatus.length}`,
);
check(
  '💰 الإجمالي في الشبكة هو الصافي بضريبته (L88)',
  byName.find((row) => row.number === invoice.number) &&
    round(Number(byName.find((row) => row.number === invoice.number).totalWithTax)) === 1050,
  money(byName.find((row) => row.number === invoice.number)?.totalWithTax ?? '0'),
);

// ---------------------------------------------------------------------------
console.log('\n6. ✏️ تعديل و🗑️ حذف، ثم التنظيف');

const stale = await refused('patch', `/tailoring/invoices/${invoice.id}`, { version: 1, notes: 'تعديل قديم' });
check(
  'نسخةٌ قديمة تُرفض',
  stale.status === 409 && stale.code === 'VERSION_CONFLICT',
  `${stale.status} ${stale.code}`,
);
const updated = await patch(`/tailoring/invoices/${invoice.id}`, {
  version: invoiceAfterPayments.version,
  unitPrice: '600',
  quantity: '3',
  notes: 'تعديل لاحق',
});
check(
  '✏️ تعديل — 💵 الإجمالي يُعاد حسابه',
  Number(updated.total) === 1800 && round(Number(updated.totalWithTax)) === 1890 && updated.notes === 'تعديل لاحق',
  `${money(updated.total)} · ${money(updated.totalWithTax)} · ${updated.notes}`,
);
check(
  '⏳ الباقي يتبع التعديل — 1890 − 650',
  round(Number(updated.remainingAmount)) === 1240,
  money(updated.remainingAmount),
);
check(
  '👤 الاسم و📱 الجوال و📐 المقاسات لم تتغيّر',
  updated.customerName === customer.name &&
    updated.measurements?.height1 === '170' &&
    updated.garmentTypeName === 'سعودي',
  `${updated.customerName} · الطول ${updated.measurements?.height1} · ${updated.garmentTypeName}`,
);

const doomed = await post('/tailoring/invoices', { customerName: `مؤقت ${stamp}`, unitPrice: '50' });
await del(`/tailoring/invoices/${doomed.id}`);
const gone = await refused('get', `/tailoring/invoices/${doomed.id}`);
check(
  '🗑️ حذف — الفاتورة تغيب',
  gone.status === 404 && gone.code === 'TAILORING_INVOICE_NOT_FOUND',
  `${gone.status} ${gone.code}`,
);

for (const id of [invoice.id, second.id]) {
  await del(`/tailoring/invoices/${id}`).catch(() => {});
}
const afterDelete = await get('/tailoring/invoices');
check(
  'التنظيف — لا أثر لفواتير هذا التشغيل',
  !afterDelete.some((row) => [invoice.id, second.id, doomed.id].includes(row.id)),
  `النتائج: ${afterDelete.length}`,
);
if (voucherId) {
  const survivor = await refused('get', `/vouchers/${voucherId}`);
  check(
    'التنظيف — سند القبض باقٍ في الخزينة لا يُحذف مع الفاتورة',
    survivor.status === 200,
    survivor.status === 200 ? `بقي السند ${voucherId}` : `${survivor.status}`,
  );
}
if (!borrowed) {
  const removal = await refused('delete', `/parties/${customer.id}`);
  check(
    'التنظيف — العميل المُصنع',
    removal.status === 200 || removal.status === 422,
    removal.status === 200 ? 'حُذف' : `تُرك برصيد مفتوح (${removal.code ?? 'PARTY_HAS_OPEN_BALANCE'})`,
  );
}

console.log(`\n${failures === 0 ? '✅ كل الفحوص نجحت' : `❌ ${failures} فحص فشل`}`);
process.exitCode = failures === 0 ? 0 : 1;
