#!/usr/bin/env node
/**
 * Live verification of Phase 09 part four — 📏 القياسات — against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📏 خصائص القياسات — الطول · العرض · الكم بترتيبها و⚙️ حالتها، وترتيبٌ جديد
 *      يأخذ `ISNULL(MAX(DisplayOrder),0)+1`
 *   2. ➕ إضافة · ✏️ تعديل · 🔕 تعطيل · ▲▼ تحريك — وما ترفضه كلٌّ منها بنصّها
 *   3. 🔍 بحث — «العميل: …» «الجوال: …» بعد `mobile LIKE @Search OR name LIKE @Search`،
 *      و«الرجاء إدخال رقم الجوال أو اسم العميل» و«لم يتم العثور على عميل»
 *   4. 📏 بيانات القياس — 👤 الاسم و📅 التاريخ و📐 القيم وعددها، والصفر الذي لا يُكتب،
 *      ورفوض البطاقة («الرجاء إدخال اسم صاحب القياس» · «الرجاء إدخال قياس واحد على
 *      الأقل» · «الرجاء البحث عن عميل أولًا»)
 *   5. 📋 قائمة القياسات — الأحدث أولاً، و«👤 اسم صاحب القياس» الذي يصير
 *      «قياس بتاريخ …» حين لا اسم له
 *   6. ✏️ تعديل و🗑️ حذف، ثم التنظيف — ما أُنشئ في هذا التشغيل يُحذف، وما أُضيف من
 *      الخصائص يُعطَّل (لا زرَّ حذف في الديسكتوب)
 *
 * Re-runnable and non-destructive: the قياسات this script creates carry the run's stamp
 * and are deleted at the end, a عميل is only created when the tenant has none, the
 * خاصية it adds is reused on a second run instead of duplicated, and the 🔢 الترتيب
 * the ▲▼ test disturbs is restored before the script ends.
 *
 * Usage: node scripts/verify-measurements.mjs
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

/** `call()` unwraps `data`; the قائمة carries `meta.customer` beside it, so keep the body. */
async function callBody(method, path, token, body) {
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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed;
}

const login = await call('post', '/auth/login', undefined, { tenantCode, email, password });
const token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path, token);
const post = (path, body) => call('post', path, token, body);
const patch = (path, body) => call('patch', path, token, body);
const del = (path) => call('delete', path, token);
const listWithMeta = (path) => callBody('get', path, token);

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

const names = (rows) => rows.map((row) => row.nameAr).join(' · ');

// ---------------------------------------------------------------------------
console.log('1. 📏 خصائص القياسات — الطول · العرض · الكم');

let attributes = await get('/tailoring/measurement-attributes');
const seeded = attributes.filter((row) => ['الطول', 'العرض', 'الكم'].includes(row.nameAr));
check(
  'الخصائص الثلاث التي يسمّيها الديسكتوب في مثاله',
  seeded.map((row) => row.nameAr).join(' · ') === 'الطول · العرض · الكم',
  names(seeded),
);
check(
  '⚙️ الحالة — `CASE WHEN IsActive = 1 THEN \'نشط\' ELSE \'معطل\' END`',
  attributes.every((row) => row.statusText === (row.active ? 'نشط' : 'معطل')),
  names(attributes),
);
const attrLength = attributes.find((row) => row.nameAr === 'الطول');
const attrWidth = attributes.find((row) => row.nameAr === 'العرض');
const attrSleeve = attributes.find((row) => row.nameAr === 'الكم');

// A خاصية added by an earlier run of this script is reused, never duplicated.
const EXTRA = 'محيط الرقبة';
let extra = attributes.find((row) => row.nameAr === EXTRA);
if (extra && !extra.active) extra = await patch(`/tailoring/measurement-attributes/${extra.id}`, { active: true });
if (!extra) {
  extra = await post('/tailoring/measurement-attributes', { nameAr: EXTRA });
  check(
    '➕ إضافة — `ISNULL(MAX(DisplayOrder), 0) + 1`',
    extra.displayOrder === attributes.length + 1 && extra.statusText === 'نشط',
    `${extra.nameAr} (${extra.displayOrder})`,
  );
} else {
  check('➕ إضافة — خاصيةٌ من تشغيلٍ سابق تُعاد، لا تُكرَّر', true, `${EXTRA} (${extra.displayOrder})`);
}

const nameless = await refused('post', '/tailoring/measurement-attributes', { nameAr: '   ' });
check(
  '«الرجاء إدخال اسم الخاصية»',
  nameless.status === 422 &&
    nameless.code === 'TAILORING_ATTRIBUTE_NAME_REQUIRED' &&
    nameless.detail === 'الرجاء إدخال اسم الخاصية',
  `${nameless.status} ${nameless.code} — ${nameless.detail}`,
);
const duplicate = await refused('post', '/tailoring/measurement-attributes', { nameAr: EXTRA });
check(
  '«اسم الخاصية موجود مسبقاً»',
  duplicate.status === 409 &&
    duplicate.code === 'TAILORING_ATTRIBUTE_NAME_TAKEN' &&
    duplicate.detail === 'اسم الخاصية موجود مسبقاً',
  `${duplicate.status} ${duplicate.code} — ${duplicate.detail}`,
);

// ---------------------------------------------------------------------------
console.log('\n2. ✏️ تعديل · 🔕 تعطيل · ▲▼ تحريك');

const stale = await refused('patch', `/tailoring/measurement-attributes/${extra.id}`, {
  version: 99,
  nameAr: 'رقبة',
});
check('نسخةٌ قديمة تُرفض', stale.status === 409 && stale.code === 'VERSION_CONFLICT', `${stale.status} ${stale.code}`);
const renamed = await patch(`/tailoring/measurement-attributes/${extra.id}`, { version: extra.version, nameAr: EXTRA });
check('✏️ تعديل — «تم التعديل بنجاح»', renamed.nameAr === EXTRA, renamed.nameAr);
const unknown = await refused('patch', '/tailoring/measurement-attributes/00000000-0000-4000-8000-000000000000', {
  nameAr: 'شيء',
});
check(
  '«الخاصية غير موجودة»',
  unknown.status === 404 && unknown.code === 'TAILORING_ATTRIBUTE_NOT_FOUND',
  `${unknown.status} ${unknown.code}`,
);

const disabled = await post(`/tailoring/measurement-attributes/${extra.id}/deactivate`, {});
check('🔕 تعطيل — ⚙️ الحالة «معطل»', disabled.active === false && disabled.statusText === 'معطل', disabled.statusText);
const activeOnly = await get('/tailoring/measurement-attributes?activeOnly=true');
check(
  '«سيتم إخفاؤها من القياسات الجديدة» — تخرج من القائمة المفعّلة وحدها',
  !activeOnly.some((row) => row.id === extra.id) && activeOnly.some((row) => row.nameAr === 'الطول'),
  names(activeOnly),
);
const revived = await patch(`/tailoring/measurement-attributes/${extra.id}`, { active: true });
check('تفعيلٌ من جديد — الطريق رجوعاً من «🔕 تعطيل»', revived.statusText === 'نشط', revived.statusText);

// 🔢 الترتيب كما بدأ، ليُعاد التشغيل بلا أثر.
const orderBefore = names(await get('/tailoring/measurement-attributes'));
const movedUp = await post(`/tailoring/measurement-attributes/${attrSleeve.id}/move`, { direction: 'up' });
check(
  '▲ تحريك للأعلى — الترتيب يُبدَّل مع السابق',
  movedUp.nameAr === 'الكم' && movedUp.displayOrder === 2,
  `الكم: ${attrSleeve.displayOrder} → ${movedUp.displayOrder}`,
);
const afterUp = names(await get('/tailoring/measurement-attributes'));
await post(`/tailoring/measurement-attributes/${attrSleeve.id}/move`, { direction: 'down' });
const afterDown = names(await get('/tailoring/measurement-attributes'));
check('▼ تحريك للأسفل — يعود إلى موضعه', afterDown === orderBefore, `${afterUp} → ${afterDown}`);
const atTop = await post(`/tailoring/measurement-attributes/${attrLength.id}/move`, { direction: 'up' });
check(
  'الطرف الأول لا يتحرك — لا جارَ له',
  atTop.displayOrder === 1 && names(await get('/tailoring/measurement-attributes')) === orderBefore,
  `الطول (${atTop.displayOrder})`,
);

// ---------------------------------------------------------------------------
console.log('\n3. 🔍 بحث — «البحث برقم الجوال أو الاسم:»');

const blankSearch = await refused('get', `/tailoring/measurements?search=${encodeURIComponent('   ')}`);
check(
  '«الرجاء إدخال رقم الجوال أو اسم العميل»',
  blankSearch.status === 422 &&
    blankSearch.code === 'TAILORING_MEASUREMENT_SEARCH_REQUIRED' &&
    blankSearch.detail === 'الرجاء إدخال رقم الجوال أو اسم العميل',
  `${blankSearch.status} ${blankSearch.code} — ${blankSearch.detail}`,
);
const missingCustomer = await refused('get', '/tailoring/measurements?search=0000000000');
check(
  '«لم يتم العثور على عميل»',
  missingCustomer.status === 404 &&
    missingCustomer.code === 'TAILORING_CUSTOMER_NOT_FOUND' &&
    missingCustomer.detail === 'لم يتم العثور على عميل',
  `${missingCustomer.status} ${missingCustomer.code} — ${missingCustomer.detail}`,
);

const customers = await get('/parties?kind=customer');
const borrowed = customers[0]?.id;
const customer = borrowed
  ? customers[0]
  : await post('/parties', { kind: 'customer', name: `عميل قياس ${stamp}`, phone: '0551234567' });
check('👤 بيانات العميل', Boolean(customer?.id), borrowed ? `${customer.name} (عميل قائم)` : `أُنشئ: ${customer.name}`);

const byPhone = await listWithMeta(`/tailoring/measurements?search=${encodeURIComponent(customer.phone ?? '')}`);
check(
  '🔍 بحث بالجوال — `mobile LIKE @Search`، وأول صفٍّ هو العميل',
  byPhone.meta?.customer?.id === customer.id,
  `العميل: ${byPhone.meta?.customer?.name ?? '—'} · الجوال: ${byPhone.meta?.customer?.phone ?? '—'}`,
);
const byName = await listWithMeta(`/tailoring/measurements?search=${encodeURIComponent(customer.name)}`);
check('🔍 بحث بالاسم — `name LIKE @Search`', byName.meta?.customer?.id === customer.id, customer.name);

// ---------------------------------------------------------------------------
console.log('\n4. 📏 بيانات القياس — «👤 اسم صاحب القياس *» و«📐 قيم القياسات»');

// Every قياس this script writes is deleted in the `finally` below, even when a check
// throws — the run before this one is the reason that block exists.
const written = [];

try {
  const measurement = await post('/tailoring/measurements', {
    partyId: customer.id,
    name: `قياس ${stamp}`,
    measurementDate: day(0),
    notes: 'قياس الصيف',
    values: [
      { attributeId: attrLength.id, value: '170' },
      { attributeId: attrWidth.id, value: '46' },
      // A value of zero is not a value: `decimal.TryParse` then `val > 0`.
      { attributeId: attrSleeve.id, value: '0' },
    ],
  });
  written.push(measurement.id);
  check(
    '👤 اسم صاحب القياس · 📅 التاريخ · 📝 الملاحظات',
    measurement.name === `قياس ${stamp}` && measurement.measurementDate === day(0) && measurement.notes === 'قياس الصيف',
    `${measurement.displayName} · ${measurement.measurementDate} · ${measurement.notes}`,
  );
  check(
    '📐 قيم القياسات — صندوقٌ لكل خاصية مفعّلة، بترتيبها',
    measurement.values.map((row) => `${row.attributeName}=${row.value}`).join(' · ') === 'الطول=170 · العرض=46',
    measurement.values.map((row) => `${row.attributeName}=${row.value}`).join(' · '),
  );
  check(
    '📐 عدد المقاسات — الصفر لا يُكتب',
    measurement.measurementCount === 2,
    `${measurement.measurementCount} (الكم «0» لم يُحفظ)`,
  );

  const noCustomer = await refused('post', '/tailoring/measurements', {
    values: [{ attributeId: attrLength.id, value: '1' }],
  });
  check(
    '«الرجاء البحث عن عميل أولًا»',
    noCustomer.status === 422 &&
      noCustomer.code === 'TAILORING_MEASUREMENT_CUSTOMER_REQUIRED' &&
      noCustomer.detail === 'الرجاء البحث عن عميل أولًا',
    `${noCustomer.status} ${noCustomer.code} — ${noCustomer.detail}`,
  );
  const nameless2 = await refused('post', '/tailoring/measurements', {
    partyId: customer.id,
    name: '   ',
    values: [{ attributeId: attrLength.id, value: '1' }],
  });
  check(
    '«الرجاء إدخال اسم صاحب القياس»',
    nameless2.status === 422 &&
      nameless2.code === 'TAILORING_MEASUREMENT_NAME_REQUIRED' &&
      nameless2.detail === 'الرجاء إدخال اسم صاحب القياس',
    `${nameless2.status} ${nameless2.code} — ${nameless2.detail}`,
  );
  const noValue = await refused('post', '/tailoring/measurements', {
    partyId: customer.id,
    name: `قياس ${stamp}`,
    values: [],
  });
  check(
    '«الرجاء إدخال قياس واحد على الأقل»',
    noValue.status === 422 &&
      noValue.code === 'TAILORING_MEASUREMENT_VALUE_REQUIRED' &&
      noValue.detail === 'الرجاء إدخال قياس واحد على الأقل',
    `${noValue.status} ${noValue.code} — ${noValue.detail}`,
  );
  const foreignAttribute = await refused('post', '/tailoring/measurements', {
    partyId: customer.id,
    name: `قياس ${stamp}`,
    values: [{ attributeId: '00000000-0000-4000-8000-000000000000', value: '5' }],
  });
  check(
    '«الخاصية غير موجودة»',
    foreignAttribute.status === 404 && foreignAttribute.code === 'TAILORING_ATTRIBUTE_NOT_FOUND',
    `${foreignAttribute.status} ${foreignAttribute.code}`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n5. 📋 قائمة القياسات — الأحدث أولاً، و«قياس بتاريخ …»');

  const newer = await post('/tailoring/measurements', {
    partyId: customer.id,
    name: `قياس ${stamp} — الشتاء`,
    measurementDate: day(1),
    values: [{ attributeId: attrLength.id, value: '172' }],
  });
  written.push(newer.id);
  const mine = await listWithMeta(`/tailoring/measurements?search=${encodeURIComponent(customer.phone ?? '')}`);
  check(
    '📅 التاريخ — الأحدث أولاً (`ORDER BY cm.MeasurementDate DESC`)',
    mine.data.slice(0, 2).map((row) => row.id).join(',') === `${newer.id},${measurement.id}`,
    mine.data.map((row) => `${row.displayName} (${row.measurementDate})`).join(' · '),
  );
  check(
    '📋 القائمة مرتّبة تنازلياً كلها، لا صفانا وحدهما',
    mine.data.every((row, index) => index === 0 || mine.data[index - 1].measurementDate >= row.measurementDate),
    mine.data.map((row) => row.measurementDate).join(' ≥ '),
  );

  // The endpoint existed before 👤 اسم صاحب القياس, and `frmCustomers` «📐 المقاسات»
  // stores its own fixed columns as keys — so an unnamed قياس is still accepted, and the
  // grid's fallback is the desktop's own sentence.
  const legacy = await post('/tailoring/measurements', {
    partyId: customer.id,
    measurements: { height: '170', shoulder: '46' },
  });
  written.push(legacy.id);
  check(
    '👤 بلا اسم — «قياس بتاريخ …» (`frmOrderDetails` L259)',
    legacy.name === null && legacy.displayName === `قياس بتاريخ ${legacy.measurementDate}`,
    legacy.displayName,
  );
  check(
    '📐 مفاتيحٌ حرّة قديمة («الطول» · «كتف») تبقى كما كُتبت',
    legacy.measurements?.height === '170' && legacy.measurements?.shoulder === '46' && legacy.values.length === 0,
    Object.entries(legacy.measurements ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(' · '),
  );

  // ---------------------------------------------------------------------------
  console.log('\n6. ✏️ تعديل و🗑️ حذف');

  const staleMeasurement = await refused('patch', `/tailoring/measurements/${measurement.id}`, {
    version: 99,
    notes: 'تعديل قديم',
  });
  check(
    'نسخةٌ قديمة تُرفض',
    staleMeasurement.status === 409 && staleMeasurement.code === 'VERSION_CONFLICT',
    `${staleMeasurement.status} ${staleMeasurement.code}`,
  );
  const updated = await patch(`/tailoring/measurements/${measurement.id}`, {
    version: measurement.version,
    name: `قياس ${stamp} — معدّل`,
    notes: 'بعد التعديل',
    values: [
      { attributeId: attrLength.id, value: '175' },
      // العرض صار صفراً: `DELETE FROM MeasurementValues` ثم ما فوق الصفر وحده.
      { attributeId: attrWidth.id, value: '0' },
      { attributeId: attrSleeve.id, value: '60' },
    ],
  });
  check(
    '✏️ تعديل — `DELETE` ثم إعادة الإدراج: العرض غاب والكم ظهر',
    updated.values.map((row) => row.attributeName).join(' · ') === 'الطول · الكم' && updated.measurementCount === 2,
    updated.values.map((row) => `${row.attributeName}=${row.value}`).join(' · '),
  );
  check(
    '👤 الاسم و📝 الملاحظات و📅 التاريخ',
    updated.name === `قياس ${stamp} — معدّل` && updated.notes === 'بعد التعديل' && updated.measurementDate === day(0),
    `${updated.displayName} · ${updated.notes} · ${updated.measurementDate}`,
  );

  const removed = await del(`/tailoring/measurements/${measurement.id}`);
  check('🗑️ حذف — «تم الحذف بنجاح»', removed?.deleted === true, `#${removed?.id ?? ''}`);
  const gone = await refused('get', `/tailoring/measurements/${measurement.id}`);
  check(
    '«القياس غير موجود»',
    gone.status === 404 && gone.code === 'TAILORING_MEASUREMENT_NOT_FOUND',
    `${gone.status} ${gone.code}`,
  );
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n7. التنظيف');

  for (const id of written) {
    await del(`/tailoring/measurements/${id}`).catch(() => {});
  }
  const afterDelete = await listWithMeta(`/tailoring/measurements?search=${encodeURIComponent(customer.phone ?? '')}`);
  check(
    'التنظيف — لا أثر لقياسات هذا التشغيل',
    !afterDelete.data.some((row) => written.includes(row.id)),
    `عدد السجلات: ${afterDelete.data.length}`,
  );

  // لا زرَّ حذف في «📏 إدارة خصائص القياسات»: التعطيل هو أقصى ما يفعله الديسكتوب.
  await post(`/tailoring/measurement-attributes/${extra.id}/deactivate`, {}).catch(() => {});
  attributes = await get('/tailoring/measurement-attributes');
  check(
    'التنظيف — الخاصية المضافة تُعطَّل (لا تُحذف)',
    attributes.find((row) => row.id === extra.id)?.statusText === 'معطل' &&
      names(attributes).startsWith('الطول · العرض · الكم'),
    names(attributes),
  );

  if (!borrowed) {
    const removal = await refused('delete', `/parties/${customer.id}`);
    check(
      'التنظيف — العميل المُصنع',
      removal.status === 200 || removal.status === 422,
      removal.status === 200 ? 'حُذف' : `تُرك برصيد مفتوح (${removal.code ?? 'PARTY_HAS_OPEN_BALANCE'})`,
    );
  }
}

console.log(`\n${failures === 0 ? '✅ كل الفحوص نجحت' : `❌ ${failures} فحص فشل`}`);
process.exitCode = failures === 0 ? 0 : 1;
