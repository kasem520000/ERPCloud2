#!/usr/bin/env node
/**
 * Live verification of Phase 09 part six — ⛵ المرسى: الحجوزات والمخالفات — against a
 * running stack (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📋 بيانات الحجوزات — 🔢 الرقم و🔖 الحالة و🚢 النوع و⏱️ المدة، ومجاميع `CalcuAll`
 *      الأربعة: «إجمالي الإضافات · الإجمالي · ضريبة 15% · الصافي»
 *   2. الرفوض — «يجب تحديد مدة الحجز» · «نوع الحجز غير معروف» · «الحجز غير موجود»
 *   3. 🎁 الإضافات — «✔» يضيف صفاً (العدد × السعر) و«🗑️ حذف» يمحوه
 *   4. ✏️ تعديل — الحجز وإضافاته معاً (`delete` ثم `insert`)، ونسخةٌ قديمة تُرفض
 *   5. 🔍 البحث — بالرقم وبالعميل وبالتاريخين
 *   6. ⚠️ المخالفات — النوع والمدة والرقم، وثلاثة رفوض بترتيب النافذة
 *   7. ✏️ تعديل المخالفة و🗑️ حذفها — و«اختر المخالفة ليتم حذفها»
 *   8. 🧾 فاتورة التأجير — القيمة والإضافات والتأمين والضريبة والصافي، ثم
 *      «🔍 خيارات البحث»: العميل · التاريخان · الصافي من/إلى
 *   9. التنظيف — حجوزات هذا التشغيل ومخالفاته تُحذف، وفاتورته تُرافق حجزها
 *
 * Re-runnable and non-destructive: the group, vessel and customer are reused when the
 * tenant already has them, and everything this script writes is deleted in a `finally` —
 * so a failed check still leaves the harbour as it found it.
 *
 * Usage: node scripts/verify-marina.mjs
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

async function request(method, path, body) {
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

let token = '';
const login = await call('post', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path);
const post = (path, body) => call('post', path, body);
const patch = (path, body) => call('patch', path, body);
const del = (path) => call('delete', path);

const day = '2026-09-01';
const list = (value) => (Array.isArray(value) ? value : ((value?.data ?? []) ));

// ---------------------------------------------------------------------------
console.log('1. 📋 بيانات الحجوزات — الرقم والحالة والنوع والمدة والمجاميع');

const branches = list(await get('/branches'));
const branchId = branches[0]?.id ?? '';
check('🏢 الفرع', Boolean(branchId), branches[0] ? `الفرع: ${branches[0].nameAr ?? branches[0].name ?? branches[0].id}` : 'لا فرع');

const customers = list(await get('/parties?kind=customer'));
const borrowedCustomer = customers[0]?.id;
const customer = borrowedCustomer ? customers[0] : await post('/parties', { kind: 'customer', name: `عميل مرسى ${stamp}`, phone: '0551234567' });
check('👤 العميل', Boolean(customer?.id), borrowedCustomer ? `${customer.name} (عميل قائم)` : `أُنشئ: ${customer.name}`);

// 📋 الفئة و⚓ المركب — reused when a previous run (or the tenant) already has them.
const marina = await get('/marina');
let group = (marina.groups ?? []).find((row) => row.name === 'قوارب سريعة');
if (!group) group = await post('/marina/groups', { name: 'قوارب سريعة', code: `FAST${stamp}` });
check('📋 الفئة', Boolean(group?.id), group.name);
await post(`/marina/groups/${group.id}/pricing`, { periodKind: 'hour', price: '200' }).catch(() => {});

let vessel = (marina.vessels ?? []).find((row) => row.code === 'V-1');
if (!vessel) vessel = await post('/marina/vessels', { groupId: group.id, code: 'V-1', name: 'الأمل', capacity: 6 });
check('⚓ المركب', Boolean(vessel?.id), `${vessel.code} — ${vessel.name}`);

const writtenBookings = [];
const writtenViolations = [];

try {
  const booking = await post('/marina/bookings', {
    branchId,
    partyId: customer.id,
    vesselId: vessel.id,
    documentDate: day,
    startsAt: `${day}T08:00:00.000Z`,
    endsAt: `${day}T10:00:00.000Z`,
    periodHours: 2,
    periodMinutes: 30,
    rentalAmount: '400',
    insuranceAmount: '100',
    bookingType: 'بحر مفتوح',
    status: 'غير مؤكد',
    additions: [
      { description: 'سترة نجاة', quantity: '2', unitPrice: '25' },
      { description: 'وقود', quantity: '1', unitPrice: '50' },
    ],
  });
  writtenBookings.push(booking.id);

  check(
    '🔢 الرقم — تسلسل الحجوزات',
    typeof booking.number === 'string' && booking.number.length > 0,
    `${booking.number}`,
  );
  check(
    '🔖 حالة الحجز و🚢 نوع الحجز — بنصّهما كما في `cmbBookingStatu` و`rbNormal`',
    booking.status === 'غير مؤكد' && booking.statusText === 'غير مؤكد' && booking.bookingType === 'بحر مفتوح',
    `${booking.statusText} · ${booking.bookingType}`,
  );
  check(
    '⏱️ المدة ساعة/دقيقة — و`RentPeriod` = الساعة + الدقيقة ÷ 60',
    booking.periodHours === 2 && booking.periodMinutes === 30 && Math.abs(booking.rentalPeriod - 2.5) < 1e-6,
    `${booking.periodHours}س ${booking.periodMinutes}د (${booking.rentalPeriod})`,
  );
  check(
    '🎁 الإضافات — العدد × السعر = الإجمالي',
    booking.additions.map((line) => `${line.description}=${Number(line.amount)}`).join(' · ') === 'سترة نجاة=50 · وقود=50',
    booking.additions.map((line) => `${line.description}=${Number(line.amount)}`).join(' · '),
  );
  check(
    'المجاميع — إجمالي الإضافات · الإجمالي · ضريبة 15% · الصافي (`CalcuAll`)',
    Number(booking.additionsTotal) === 100 && Number(booking.total) === 600 && Number(booking.taxAmount) === 90 && Number(booking.netAmount) === 690,
    `${Number(booking.additionsTotal)} · ${Number(booking.total)} · ${Number(booking.taxAmount)} · ${Number(booking.netAmount)}`,
  );
  check('📅 التاريخ و👤 العميل و⚓ المركب', booking.documentDate === day && booking.customerName === customer.name && booking.vesselName === vessel.name, `${booking.documentDate} · ${booking.customerName} · ${booking.vesselName}`);

  // -------------------------------------------------------------------------
  console.log('\n2. الرفوض — «يجب تحديد مدة الحجز» وأخواتها');

  const noPeriod = await refused('post', '/marina/bookings', {
    branchId, partyId: customer.id, vesselId: vessel.id,
    startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T08:00:00.000Z`,
    periodHours: 0, periodMinutes: 0,
  });
  check(
    '«يجب تحديد مدة الحجز»',
    noPeriod.status === 422 && noPeriod.code === 'MARINA_BOOKING_PERIOD_REQUIRED' && noPeriod.detail === 'يجب تحديد مدة الحجز',
    `${noPeriod.status} ${noPeriod.code} — ${noPeriod.detail}`,
  );
  const badType = await refused('post', '/marina/bookings', {
    branchId, partyId: customer.id, vesselId: vessel.id,
    startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T09:00:00.000Z`,
    bookingType: 'رحلة صيد',
  });
  check(
    '«نوع الحجز غير معروف»',
    badType.status === 422 && badType.code === 'MARINA_BOOKING_TYPE_UNKNOWN',
    `${badType.status} ${badType.code} — ${badType.detail}`,
  );
  const unknownBooking = await refused('get', '/marina/bookings/00000000-0000-4000-8000-000000000000');
  check(
    '«الحجز غير موجود»',
    unknownBooking.status === 404 && unknownBooking.code === 'MARINA_BOOKING_NOT_FOUND',
    `${unknownBooking.status} ${unknownBooking.code}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n3. 🎁 الإضافات — «✔» و«🗑️ حذف»');

  const addition = await post(`/marina/bookings/${booking.id}/additions`, { description: 'كابتن', quantity: '1', unitPrice: '120' });
  check(
    '«✔» — صفٌّ جديد بإجماليه',
    Number(addition.amount) === 120 && Number(addition.quantity) === 1 && Number(addition.unitPrice) === 120,
    `${addition.description}: ${Number(addition.quantity)} × ${Number(addition.unitPrice)} = ${Number(addition.amount)}`,
  );
  const grown = await get(`/marina/bookings/${booking.id}`);
  check('الإجمالي يكبر معه', Number(grown.additionsTotal) === 220 && Number(grown.netAmount) === 828, `${Number(grown.additionsTotal)} · ${Number(grown.netAmount)}`);

  const removedAddition = await del(`/marina/bookings/${booking.id}/additions/${addition.id}`);
  check('«🗑️ حذف» — الصفّ يغيب', removedAddition?.deleted === true, `#${removedAddition?.id ?? ''}`);
  const shrunk = await get(`/marina/bookings/${booking.id}`);
  check('الإجمالي يعود إلى ما كان', Number(shrunk.additionsTotal) === 100, `${Number(shrunk.additionsTotal)}`);

  // -------------------------------------------------------------------------
  console.log('\n4. ✏️ تعديل — الحجز وإضافاته، ونسخةٌ قديمة تُرفض');

  const stale = await refused('patch', `/marina/bookings/${booking.id}`, { version: 99, rentalAmount: '999' });
  check('نسخةٌ قديمة تُرفض', stale.status === 409 && stale.code === 'VERSION_CONFLICT', `${stale.status} ${stale.code}`);

  const updated = await patch(`/marina/bookings/${booking.id}`, {
    version: booking.version,
    status: 'مؤكد',
    periodHours: 3,
    periodMinutes: 0,
    rentalAmount: '500',
    additions: [{ description: 'رسو', quantity: '1', unitPrice: '80' }],
  });
  check(
    'الحجز يتغيّر — «مؤكد» و3 ساعات و500',
    updated.status === 'مؤكد' && updated.statusText === 'مؤكد' && updated.rentalPeriod === 3 && Number(updated.rentalAmount) === 500,
    `${updated.statusText} · ${updated.rentalPeriod}س · ${Number(updated.rentalAmount)}`,
  );
  check(
    '«delete then insert» — الإضافات القديمة تُستبدل كلها',
    updated.additions.length === 1 && updated.additions[0].description === 'رسو' && Number(updated.additionsTotal) === 80,
    updated.additions.map((line) => line.description).join(' · ') || '—',
  );
  check('النسخة تتقدّم', updated.version === booking.version + 1, `${booking.version} → ${updated.version}`);

  // -------------------------------------------------------------------------
  console.log('\n5. 🔍 البحث — بالرقم وبالعميل وبالتاريخين');

  const byNumber = list(await get(`/marina/bookings?number=${encodeURIComponent(booking.number)}`));
  check('رقم الحجز', byNumber.map((row) => row.id).join(',') === booking.id, `${booking.number}`);
  const byCustomer = list(await get(`/marina/bookings?customer=${encodeURIComponent(customer.phone ?? customer.name)}`));
  check('اسم العميل أو جواله', byCustomer.some((row) => row.id === booking.id), customer.phone ?? customer.name);
  const inRange = list(await get(`/marina/bookings?from=${day}&to=${day}`));
  check('من تاريخ/إلى تاريخ', inRange.some((row) => row.id === booking.id), `${day}`);
  const outside = list(await get('/marina/bookings?from=2020-01-01&to=2020-01-02'));
  check('يومٌ بلا حجوزات — فارغ لا كامل', outside.length === 0, `${outside.length} سطر`);

  // -------------------------------------------------------------------------
  console.log('\n6. ⚠️ المخالفات — النوع والمدة، وثلاثة رفوض بترتيبها');

  const vesselMissing = await refused('post', '/marina/violations', { violationDate: day, violationType: 'تأخير', periodDays: '2' });
  check(
    '«يجب اختيار المركب»',
    vesselMissing.status === 422 && vesselMissing.detail === 'يجب اختيار المركب',
    `${vesselMissing.status} ${vesselMissing.code} — ${vesselMissing.detail}`,
  );
  const daysMissing = await refused('post', '/marina/violations', { violationDate: day, vesselId: vessel.id, violationType: 'تأخير' });
  check(
    '«يجب تحديد مدة المخالفة»',
    daysMissing.status === 422 && daysMissing.detail === 'يجب تحديد مدة المخالفة',
    `${daysMissing.status} ${daysMissing.code} — ${daysMissing.detail}`,
  );
  const typeMissing = await refused('post', '/marina/violations', { violationDate: day, vesselId: vessel.id, periodDays: '2' });
  check(
    '«يجب تحديد نوع المخالفة»',
    typeMissing.status === 422 && typeMissing.detail === 'يجب تحديد نوع المخالفة',
    `${typeMissing.status} ${typeMissing.code} — ${typeMissing.detail}`,
  );

  const violation = await post('/marina/violations', {
    violationDate: day,
    vesselId: vessel.id,
    partyId: customer.id,
    violationType: 'تأخير',
    periodDays: '2',
    description: 'تأخر عن الرصيف',
  });
  writtenViolations.push(violation.id);
  check(
    '🔢 الرقم و⚠️ النوع و⏱️ المدة (يوم) و⚙️ الحالة «مفتوحة»',
    Boolean(violation.number) && violation.violationType === 'تأخير' && Number(violation.periodDays) === 2 && violation.statusText === 'مفتوحة',
    `${violation.number} · ${violation.violationType} · ${Number(violation.periodDays)} يوم · ${violation.statusText}`,
  );
  check('⛵ المركب و📝 الملاحظة', violation.vesselName === vessel.name && violation.description === 'تأخر عن الرصيف', `${violation.vesselName} · ${violation.description}`);
  const byType = list(await get(`/marina/violations?type=${encodeURIComponent('تأخير')}`));
  check('«⚠️ قائمة المخالفات» — البحث بالنوع', byType.some((row) => row.id === violation.id), `${byType.length} مخالفة`);

  // -------------------------------------------------------------------------
  console.log('\n7. ✏️ تعديل المخالفة و🗑️ حذفها');

  const closed = await patch(`/marina/violations/${violation.id}`, {
    version: violation.version,
    periodDays: '5',
    status: 'closed',
    description: 'تأخر يومين إضافيين',
  });
  check('✏️ تعديل — 5 أيام و«مغلقة»', Number(closed.periodDays) === 5 && closed.statusText === 'مغلقة', `${Number(closed.periodDays)} يوم · ${closed.statusText}`);

  const removedViolation = await del(`/marina/violations/${violation.id}`);
  check('🗑️ حذف — «تم الحذف»', removedViolation?.deleted === true, `#${removedViolation?.id ?? ''}`);
  const goneViolation = await refused('get', `/marina/violations/${violation.id}`);
  check(
    '«اختر المخالفة ليتم حذفها»',
    goneViolation.status === 404 && goneViolation.detail === 'اختر المخالفة ليتم حذفها',
    `${goneViolation.status} ${goneViolation.code} — ${goneViolation.detail}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n8. 🧾 فاتورة التأجير — القيمة والإضافات والضريبة والصافي، ثم «🔍 خيارات البحث»');

  const rental = await post(`/marina/bookings/${booking.id}/rental-invoice`, {});
  check(
    '💰 القيمة · 🎁 الإضافات · 🛡️ التأمين · الإجمالي · ضريبة 15% · الصافي',
    Number(rental.periodAmount) === 500 && Number(rental.additionsAmount) === 80 && Number(rental.insuranceAmount) === 100 &&
      Number(rental.total) === 680 && Number(rental.taxAmount) === 102 && Number(rental.netAmount) === 782,
    `${Number(rental.periodAmount)} · ${Number(rental.additionsAmount)} · ${Number(rental.insuranceAmount)} · ${Number(rental.total)} · ${Number(rental.taxAmount)} · ${Number(rental.netAmount)}`,
  );
  check('📅 التاريخ — من الحجز', rental.documentDate === day, rental.documentDate);

  const invoices = list(await get('/marina/rental-invoices'));
  check(
    '«🧾 قائمة الفواتير» — الرقم · 👤 العميل · 💰 الصافي · 📱 الجوال',
    invoices.some((row) => row.id === rental.id && row.number && row.customerName && Number(row.netAmount) === 782),
    invoices.map((row) => `${row.number} · ${row.customerName} · ${Number(row.netAmount)}`).join(' | ') || '—',
  );
  const byNet = list(await get('/marina/rental-invoices?minNet=700&maxNet=800'));
  check('الصافي من/إلى', byNet.some((row) => row.id === rental.id), `${byNet.length} فاتورة`);
  const tooRich = list(await get('/marina/rental-invoices?minNet=99999'));
  check('صافٍ أعلى من كل الفواتير — لا شيء', tooRich.length === 0, `${tooRich.length} فاتورة`);
  const byRange = list(await get(`/marina/rental-invoices?from=${day}&to=${day}`));
  check('التاريخ من/إلى', byRange.some((row) => row.id === rental.id), `${byRange.length} فاتورة`);
  const invoiceByCustomer = list(await get(`/marina/rental-invoices?customer=${encodeURIComponent(customer.phone ?? customer.name)}`));
  check('العميل أو جواله', invoiceByCustomer.some((row) => row.id === rental.id), `${invoiceByCustomer.length} فاتورة`);

  // -------------------------------------------------------------------------
  console.log('\n9. 🗑️ حذف الحجز');

  const removedBooking = await del(`/marina/bookings/${booking.id}`);
  check('🗑️ حذف — «تم الحذف»', removedBooking?.deleted === true, `#${removedBooking?.id ?? ''}`);
  const goneBooking = await refused('get', `/marina/bookings/${booking.id}`);
  check('«الحجز غير موجود» بعد الحذف', goneBooking.status === 404 && goneBooking.code === 'MARINA_BOOKING_NOT_FOUND', `${goneBooking.status} ${goneBooking.code}`);
} finally {
  // -------------------------------------------------------------------------
  console.log('\n10. التنظيف');

  for (const id of writtenBookings) await del(`/marina/bookings/${id}`).catch(() => {});
  for (const id of writtenViolations) await del(`/marina/violations/${id}`).catch(() => {});

  const leftBookings = list(await get('/marina/bookings'));
  check(
    'التنظيف — لا أثر لحجوزات هذا التشغيل',
    !leftBookings.some((row) => writtenBookings.includes(row.id)),
    `عدد الحجوزات: ${leftBookings.length}`,
  );
  const leftViolations = list(await get('/marina/violations'));
  check(
    'التنظيف — لا أثر لمخالفات هذا التشغيل',
    !leftViolations.some((row) => writtenViolations.includes(row.id)),
    `عدد المخالفات: ${leftViolations.length}`,
  );
}

console.log(`\n${failures === 0 ? '✅ كل الفحوص نجحت' : `❌ ${failures} فحص فشل`}`);
process.exitCode = failures === 0 ? 0 : 1;
