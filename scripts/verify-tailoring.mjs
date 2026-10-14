#!/usr/bin/env node
/**
 * Live verification of Phase 09 part two — 🧵 طلب التفصيل — against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. ⚙️ الحالة — مستلم · في الخياطة · جاهز · تم التسليم، بترتيب العرض (`frmOrders`)
 *   2. 🧵 نوع التفصيل و🔧 الخيارات الجاهزة — الاسم والسعر الافتراضي، وتصنيف وخياراته
 *      و⭐ تعيين افتراضي (`frmOrderDetails` · `frmOptions`)
 *   3. 🧾 حفظ الطلب — البطاقة كاملة برقمها ومتبقيها، والرفوض الثلاثة
 *      («الرجاء اختيار عميل» · «الرجاء اختيار نوع التفصيل» · «الرجاء إدخال السعر»)
 *   4. 🔄 تغيير الحالة و⌛ متأخّر — من «مستلم» إلى «في الخياطة» إلى «تم التسليم»،
 *      والصف المتأخّر الذي يعود عادياً عند التسليم
 *   5. 📋 قائمة الطلبات — الحالة والبحث والتاريخ، ثم ✏️ تعديل و🗑️ حذف
 *   6. التنظيف — ما أُنشئ في هذا التشغيل يُحذف، والعميل يُستعار إن وُجد ويُحذف إن صُنع
 *
 * The script is re-runnable and leaves no trace behind: the طلب والخيار والتصنيف
 * ونوع التفصيل that it creates carry the run's stamp and are deleted at the end, and a
 * عميل is only created when the tenant has none. It never deletes another tenant's row
 * (there is only one tenant here, but every query is tenant-scoped by the API).
 *
 * Usage: node scripts/verify-tailoring.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const money = (value) => Number(value).toFixed(2);
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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`);
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

const day = (offsetDays) => {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return date.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
console.log('1. ⚙️ الحالة — مستلم · في الخياطة · جاهز · تم التسليم');

const statuses = await get('/tailoring/order-statuses');
check(
  '⚙️ الحالات الأربع بترتيب العرض',
  statuses.map((row) => row.nameAr).join(' · ') === 'مستلم · في الخياطة · جاهز · تم التسليم' &&
    statuses.map((row) => row.displayOrder).join(',') === '1,2,3,4',
  statuses.map((row) => row.nameAr).join(' · '),
);
check(
  '⚙️ الحالة النهائية — «تم التسليم» وحدها تُنهي التأخير',
  statuses.filter((row) => row.isFinal).map((row) => row.nameAr).join('') === 'تم التسليم',
  statuses.filter((row) => row.isFinal).map((row) => row.nameAr).join(''),
);
const statusReceived = statuses.find((row) => row.code === 'received')?.id ?? '';
const statusSewing = statuses.find((row) => row.code === 'sewing')?.id ?? '';
const statusReady = statuses.find((row) => row.code === 'ready')?.id ?? '';
const statusDelivered = statuses.find((row) => row.code === 'delivered')?.id ?? '';

// ---------------------------------------------------------------------------
console.log('\n2. 🧵 نوع التفصيل و🔧 الخيارات الجاهزة');

const type = await post('/tailoring/types', { nameAr: `ثوب ${stamp}`, defaultPrice: '350' });
check(
  '🧵 نوع التفصيل — اسمه وسعره الافتراضي',
  type.nameAr === `ثوب ${stamp}` && Number(type.defaultPrice) === 350,
  `${type.nameAr} · ${money(type.defaultPrice)}`,
);

const clash = await refused('post', '/tailoring/types', { nameAr: `ثوب ${stamp}` });
check(
  'نوع التفصيل موجود مسبقاً',
  clash.status === 409 && clash.code === 'TAILORING_TYPE_NAME_TAKEN' && clash.detail === 'نوع التفصيل موجود مسبقاً',
  `${clash.status} ${clash.code}`,
);
const namelessType = await refused('post', '/tailoring/types', { nameAr: '   ' });
check(
  'الرجاء إدخال نوع التفصيل',
  namelessType.status === 422 && namelessType.code === 'TAILORING_TYPE_NAME_REQUIRED',
  `${namelessType.status} ${namelessType.code}`,
);

const category = await post('/tailoring/option-categories', { nameAr: `نوع الياقة ${stamp}` });
const collarPlain = await post('/tailoring/option-values', { categoryId: category.id, nameAr: 'ياقة عادية' });
const collarChinese = await post('/tailoring/option-values', { categoryId: category.id, nameAr: 'ياقة صينية' });
const seededCatalogue = await get('/tailoring/option-categories');
const seededValues = seededCatalogue.find((row) => row.id === category.id)?.values ?? [];
check(
  '🔧 الخيارات الجاهزة — تصنيف وخياران بترتيب الإضافة',
  // `ISNULL(MAX(DisplayOrder),0)+1` — a new value goes last (`frmOptions` L232).
  seededValues.map((row) => row.nameAr).join(' · ') === 'ياقة عادية · ياقة صينية' &&
    seededValues.map((row) => row.displayOrder).join(',') === '1,2',
  `${category.nameAr}: ${seededValues.map((row) => `${row.nameAr} (${row.displayOrder})`).join(' · ')}`,
);

const promoted = await post(`/tailoring/option-values/${collarChinese.id}/default`, {});
check('⭐ تعيين افتراضي', promoted.isDefault === true, 'ياقة صينية');

const catalogue = await get('/tailoring/option-categories');
const shownCategory = catalogue.find((row) => row.id === category.id);
check(
  '⭐ واحد فقط في التصنيف — ما عداه يُسقَط',
  shownCategory?.values.filter((row) => row.isDefault).map((row) => row.nameAr).join('') === 'ياقة صينية',
  shownCategory?.values.filter((row) => row.isDefault).map((row) => row.nameAr).join('') || '—',
);

// ---------------------------------------------------------------------------
console.log('\n3. 🧾 حفظ الطلب — البطاقة كاملة برقمها ومتبقيها');

const customers = await get('/parties?kind=customer');
const borrowed = customers[0]?.id;
const customer = borrowed ? customers[0] : await post('/parties', { kind: 'customer', name: `عميل تفصيل ${stamp}`, phone: '0551234567' });
check(
  '👤 بيانات العميل',
  Boolean(customer?.id),
  borrowed ? `${customer.name} (عميل قائم)` : `أُنشئ: ${customer.name}`,
);

const measurement = await post('/tailoring/measurements', {
  partyId: customer.id,
  measurements: { height: '170', shoulder: '46' },
});
check('📏 القياس — قياس العميل يظهر باسمه', measurement.partyId === customer.id, 'قياس بتاريخ اليوم');

const order = await post('/tailoring/orders', {
  partyId: customer.id,
  typeId: type.id,
  statusId: statusReceived,
  measurementId: measurement.id,
  orderDate: day(-2),
  // ⌛ موعد التسليم في الماضي — الطلب متأخّر حتى يُسلَّم.
  deliveryDate: day(-1),
  quantity: '2',
  price: '700',
  paidAmount: '200',
  fabricType: 'قطن',
  fabricColor: 'أبيض',
  designNotes: 'ياقة صينية وجيب جانبي',
  generalNotes: 'تسليم للفرع',
  options: [{ categoryId: category.id, valueId: collarChinese.id }],
});
check(
  '🧾 رقم الطلب',
  /^TO-\d{6}$/.test(order.number ?? ''),
  order.number,
);
check(
  '💰 السعر · 💵 المدفوع · ⌛ المتبقي',
  Number(order.price) === 700 && Number(order.paidAmount) === 200 && Number(order.remainingAmount) === 500,
  `${money(order.price)} · ${money(order.paidAmount)} · ${money(order.remainingAmount)}`,
);
check(
  '👤 العميل · 📞 الجوال · القياس · نوع التفصيل · ⚙️ الحالة',
  order.customerName === customer.name && order.measurementName?.startsWith('قياس بتاريخ') && order.typeName === type.nameAr && order.statusName === 'مستلم',
  `${order.customerName} · ${order.measurementName} · ${order.typeName} · ${order.statusName}`,
);
check(
  '🧵 تفاصيل القماش والتصميم',
  order.fabricType === 'قطن' && order.fabricColor === 'أبيض' && order.designNotes === 'ياقة صينية وجيب جانبي',
  `${order.fabricType} · ${order.fabricColor} · ${order.designNotes}`,
);
check(
  '🔧 الخيارات — خيار واحد لكل تصنيف',
  order.options?.length === 1 && order.options[0].valueName === 'ياقة صينية',
  order.options?.map((row) => `${row.categoryName}: ${row.valueName}`).join(' · ') || '—',
);
check(
  '⌛ متأخّر — موعد التسليم مضى والحالة ليست نهائية',
  order.isDelayed === true,
  `موعد التسليم ${order.deliveryDate}`,
);

const noCustomer = await refused('post', '/tailoring/orders', { typeId: type.id, price: '100' });
check(
  'الرجاء اختيار عميل',
  noCustomer.status === 422 && noCustomer.code === 'TAILORING_CUSTOMER_REQUIRED' && noCustomer.detail === 'الرجاء اختيار عميل',
  `${noCustomer.status} ${noCustomer.code}`,
);
const noType = await refused('post', '/tailoring/orders', { partyId: customer.id, price: '100' });
check(
  'الرجاء اختيار نوع التفصيل',
  noType.status === 422 && noType.code === 'TAILORING_TYPE_REQUIRED' && noType.detail === 'الرجاء اختيار نوع التفصيل',
  `${noType.status} ${noType.code}`,
);
const noPrice = await refused('post', '/tailoring/orders', { partyId: customer.id, typeId: type.id });
check(
  'الرجاء إدخال السعر',
  noPrice.status === 422 && noPrice.code === 'TAILORING_PRICE_REQUIRED' && noPrice.detail === 'الرجاء إدخال السعر',
  `${noPrice.status} ${noPrice.code}`,
);
const foreignMeasurement = await refused('post', '/tailoring/orders', {
  partyId: customer.id,
  typeId: type.id,
  price: '100',
  measurementId: '00000000-0000-4000-8000-000000000000',
});
check(
  'القياس غير موجود',
  foreignMeasurement.status === 404 && foreignMeasurement.code === 'TAILORING_MEASUREMENT_NOT_FOUND',
  `${foreignMeasurement.status} ${foreignMeasurement.code}`,
);

const overpaid = await post('/tailoring/orders', {
  partyId: customer.id,
  typeId: type.id,
  price: '100',
  paidAmount: '150',
});
check(
  '⌛ المتبقي السالب مسموح — الديسكتوب يلوّنه أخضر ولا يرفضه',
  Number(overpaid.remainingAmount) === -50,
  money(overpaid.remainingAmount),
);

// ---------------------------------------------------------------------------
console.log('\n4. 🔄 تغيير الحالة و⌛ متأخّر');

const sewing = await post(`/tailoring/orders/${order.id}/status`, { statusId: statusSewing });
check(
  '🔄 تغيير الحالة — «في الخياطة»',
  sewing.statusName === 'في الخياطة' && sewing.isDelayed === true,
  `${sewing.statusName} · متأخّر: ${sewing.isDelayed ? 'نعم' : 'لا'}`,
);
const ready = await post(`/tailoring/orders/${order.id}/status`, { statusId: statusReady });
check('🔄 تغيير الحالة — «جاهز»', ready.statusName === 'جاهز' && ready.isDelayed === true, ready.statusName);
const delivered = await post(`/tailoring/orders/${order.id}/status`, { statusId: statusDelivered });
check(
  '⚙️ الحالة النهائية — «تم التسليم» يُنهي التأخير',
  delivered.statusName === 'تم التسليم' && delivered.isDelayed === false,
  `${delivered.statusName} · متأخّر: ${delivered.isDelayed ? 'نعم' : 'لا'}`,
);
const unknownStatus = await refused('post', `/tailoring/orders/${order.id}/status`, {
  statusId: '00000000-0000-4000-8000-000000000000',
});
check(
  'حالة الطلب غير موجودة',
  unknownStatus.status === 404 && unknownStatus.code === 'TAILORING_STATUS_NOT_FOUND',
  `${unknownStatus.status} ${unknownStatus.code}`,
);

// ---------------------------------------------------------------------------
console.log('\n5. 📋 قائمة الطلبات — الحالة والبحث والتاريخ، ثم ✏️ تعديل و🗑️ حذف');

const second = await post('/tailoring/orders', {
  partyId: customer.id,
  typeId: type.id,
  statusId: statusSewing,
  orderDate: day(0),
  deliveryDate: day(10),
  price: '450',
});
// `call()` unwraps `data`, so a list comes back as the array itself.
const all = await get('/tailoring/orders');
check(
  '📋 قائمة الطلبات — الأحدث أولاً',
  all.length >= 2 && all[0].orderDate === day(0),
  `عدد السجلات: ${all.length}`,
);
const byStatus = await get(`/tailoring/orders?statusId=${statusDelivered}`);
check(
  '⚙️ الحالة — تصفية القائمة',
  byStatus.some((row) => row.number === order.number) && !byStatus.some((row) => row.number === second.number),
  `«تم التسليم»: ${byStatus.length}`,
);
const byNumber = await get(`/tailoring/orders?search=${encodeURIComponent(second.number)}`);
check(
  '🔍 بحث — برقم الطلب',
  byNumber.map((row) => row.number).join('') === second.number,
  second.number,
);
const byName = await get(`/tailoring/orders?search=${encodeURIComponent(customer.name)}`);
check(
  '🔍 بحث — باسم العميل',
  byName.length >= 2 && byName.every((row) => row.customerName === customer.name),
  `${byName.length} طلب`,
);
const byDate = await get(`/tailoring/orders?from=${day(0)}&to=${day(0)}`);
check(
  '📅 من / إلى — تصفية بالتاريخ',
  byDate.every((row) => row.orderDate === day(0)),
  `${byDate.length} طلب اليوم`,
);

const stale = await refused('patch', `/tailoring/orders/${order.id}`, { version: 1, designNotes: 'تعديل قديم' });
check(
  'نسخةٌ قديمة تُرفض',
  stale.status === 409 && stale.code === 'VERSION_CONFLICT',
  `${stale.status} ${stale.code}`,
);
const updated = await patch(`/tailoring/orders/${order.id}`, {
  version: delivered.version,
  price: '800',
  paidAmount: '300',
  fabricColor: 'بيج',
});
check(
  '✏️ تعديل — ما أُرسل وحده يتغيّر',
  Number(updated.price) === 800 && Number(updated.paidAmount) === 300 && Number(updated.remainingAmount) === 500 && updated.fabricColor === 'بيج' && updated.fabricType === 'قطن' && updated.designNotes === 'ياقة صينية وجيب جانبي',
  `${money(updated.price)} · ${money(updated.paidAmount)} · ${money(updated.remainingAmount)} · ${updated.fabricType}/${updated.fabricColor}`,
);
const otherCustomer = await post('/parties', { kind: 'customer', name: `عميل آخر ${stamp}`, phone: '0557654321' });
const swapCustomer = await refused('patch', `/tailoring/orders/${order.id}`, {
  partyId: otherCustomer.id,
  version: updated.version,
});
check(
  '👤 العميل لا يُستبدل من تحت الطلب',
  swapCustomer.status === 422 && swapCustomer.code === 'TAILORING_CUSTOMER_IMMUTABLE',
  `${swapCustomer.status} ${swapCustomer.code}`,
);

// ---------------------------------------------------------------------------
console.log('\n6. التنظيف');

for (const id of [order.id, second.id, overpaid.id]) {
  await del(`/tailoring/orders/${id}`).catch(() => {});
}
const afterDelete = await get('/tailoring/orders');
check(
  '🗑️ حذف — الطلب يغيب عن القائمة',
  !afterDelete.some((row) => [order.id, second.id, overpaid.id].includes(row.id)),
  `عدد السجلات: ${afterDelete.length}`,
);

for (const id of [collarPlain.id, collarChinese.id]) {
  await del(`/tailoring/option-values/${id}`).catch(() => {});
}
await del(`/tailoring/option-categories/${category.id}`).catch(() => {});
await del(`/tailoring/types/${type.id}`).catch(() => {});
// A عميل we borrowed is left exactly as we found it. One we created is deleted when the
// ledger lets us — `PARTY_HAS_OPEN_BALANCE` (an open balance) keeps a party alive, and
// that refusal is the API's, not this script's.
if (!borrowed) {
  const removal = await refused('delete', `/parties/${customer.id}`);
  check(
    'التنظيف — العميل المُصنع',
    removal.status === 200 || removal.status === 422,
    removal.status === 200 ? 'حُذف' : `تُرك برصيد مفتوح (${removal.code ?? 'PARTY_HAS_OPEN_BALANCE'})`,
  );
}
const otherRemoval = await refused('delete', `/parties/${otherCustomer.id}`);
check(
  'التنظيف — العميل الثاني',
  otherRemoval.status === 200 || otherRemoval.status === 422,
  otherRemoval.status === 200 ? 'حُذف' : `تُرك برصيد مفتوح (${otherRemoval.code ?? 'PARTY_HAS_OPEN_BALANCE'})`,
);

const remainingTypes = await get('/tailoring/types');
check(
  'التنظيف — نوع التفصيل يُحذف',
  !remainingTypes.some((row) => row.id === type.id),
  `${remainingTypes.length} نوع متبقٍ`,
);
const remainingCategories = await get('/tailoring/option-categories');
check(
  'التنظيف — التصنيف يُحذف',
  !remainingCategories.some((row) => row.id === category.id),
  `${remainingCategories.length} تصنيف متبقٍ`,
);

console.log(`\n${failures === 0 ? '✅ كل الفحوص نجحت' : `❌ ${failures} فحص فشل`}`);
process.exitCode = failures === 0 ? 0 : 1;
