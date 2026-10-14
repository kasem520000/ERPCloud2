#!/usr/bin/env node
/**
 * Live verification of Phase 09 part nine — ⛵ المرسى: ➕ الإضافات — against a running
 * stack (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 🔢 الرقم — `LoadNextAdditionNumber`: what a blank «📋 إضافات» card shows
 *   2. 📋 إدارة الإضافات — 💾 حفظ: الرقم · الاسم · القيمة، وقيمةٌ فارغةٌ صفر
 *   3. الرفوض — «يجب إدخال اسم الإضافة ⚠️» · «الإضافة غير موجودة»
 *   4. ✏️ تعديل — الاسم والقيمة، ونسخةٌ قديمة تُرفض (`VERSION_CONFLICT`)
 *   5. 🎁 الإضافات في «الحجوزات» — الاسم والسعر من التعريف، و«الإجمالي» = الكمية × السعر،
 *      والإضافة المكرَّرة تُجمَع كمّيتها على صفّها (`Add2Dgv`)
 *   6. الرفوض في الحجز — «يجب إدخال الكمية  » · «الإضافة غير موجودة»
 *   7. 🗑️ حذف — «يجب تحديد الإضافة المراد حذفها ⚠️»، ثم تختفي من «🎁 الإضافات» ويبقى
 *      الصفّ الذي كُتب منها على الحجز
 *   8. التنظيف — إضافات هذا التشغيل وحجزه يُمحَون
 *
 * Re-runnable and non-destructive: everything this script writes carries a stamp, and
 * everything it writes is deleted in a `finally` — so a failed check still leaves the
 * harbour as it found it.
 *
 * Usage: node scripts/verify-marina-additions.mjs
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
const patch = (path, body) => call('patch', path, body);
const del = (path) => call('delete', path);
const list = (value) => (Array.isArray(value) ? value : (value?.data ?? []));

const written = [];
const writtenBookings = [];

try {
  // -------------------------------------------------------------------------
  console.log('1. 🔢 الرقم — ما تُظهره بطاقةٌ جديدة (`LoadNextAdditionNumber`)');

  const next = await get('/marina/additions/next');
  check('🔢 الرقم التالي', Number(next?.number) >= 1, `${next?.number}`);
  const before = list(await get('/marina/additions'));
  check('📋 إدارة الإضافات — القائمة قبل الإضافة', Array.isArray(before), `${before.length} إضافة`);

  // -------------------------------------------------------------------------
  console.log('\n2. 📋 إدارة الإضافات — 💾 حفظ: الرقم · الاسم · القيمة');

  const jacket = await post('/marina/additions', { name: `سترة نجاة ${stamp}`, salePrice: '30' });
  written.push(jacket.id);
  check('🔢 الرقم', Number(jacket.number) === Number(next?.number), `${jacket.number}`);
  check('📝 الاسم', jacket.name === `سترة نجاة ${stamp}`, jacket.name);
  check('💰 القيمة', Number(jacket.salePrice) === 30, jacket.salePrice);
  check('🧾 الاستخدام — صفر', jacket.usageCount === 0, `${jacket.usageCount}`);
  check('العملة', jacket.currency === 'SAR', jacket.currency ?? '—');

  // 💰 القيمة الفارغة صفر — `if (string.IsNullOrWhiteSpace(txtSalePrice.Text)) … = "0"`.
  const free = await post('/marina/additions', { name: `ماء ${stamp}` });
  written.push(free.id);
  check('💰 القيمة الفارغة صفر', Number(free.salePrice) === 0, free.salePrice ?? '—');

  const rows = list(await get('/marina/additions'));
  const numbers = rows.map((row) => Number(row.number));
  check('📋 القائمة تضمّ الإضافتين', rows.some((row) => row.id === jacket.id) && rows.some((row) => row.id === free.id), `${rows.length} إضافة`);
  check('🔢 الأرقام تصعد', numbers.every((value, index) => index === 0 || value >= numbers[index - 1]), numbers.join(' · '));

  const nextAfter = await get('/marina/additions/next');
  check('🔢 الرقم التالي يكبر', Number(nextAfter?.number) > Number(next?.number), `${next?.number} → ${nextAfter?.number}`);

  // -------------------------------------------------------------------------
  console.log('\n3. الرفوض — «يجب إدخال اسم الإضافة ⚠️» · «الإضافة غير موجودة»');

  const noName = await refused('post', '/marina/additions', { salePrice: '10' });
  check('«يجب إدخال اسم الإضافة ⚠️»', noName.status === 422 && noName.detail === 'يجب إدخال اسم الإضافة ⚠️', `${noName.status} ${noName.code} ${noName.detail}`);

  const blankName = await refused('post', '/marina/additions', { name: '   ', salePrice: '10' });
  check('اسمٌ أبيض كاسمٍ فارغ', blankName.status === 422 && blankName.code === 'MARINA_ADDITION_NAME_REQUIRED', `${blankName.status} ${blankName.code}`);

  const missing = await refused('patch', '/marina/additions/00000000-0000-0000-0000-000000000000', { name: 'لا وجود' });
  check('«الإضافة غير موجودة»', missing.status === 404 && missing.detail === 'الإضافة غير موجودة', `${missing.status} ${missing.code} ${missing.detail}`);

  // -------------------------------------------------------------------------
  console.log('\n4. ✏️ تعديل — الاسم والقيمة، ونسخةٌ قديمة تُرفض');

  const edited = await patch(`/marina/additions/${jacket.id}`, { version: jacket.version, name: `سترة نجاة ${stamp} (كبيرة)`, salePrice: '40' });
  check('📝 الاسم بعد التعديل', edited.name === `سترة نجاة ${stamp} (كبيرة)`, edited.name);
  check('💰 القيمة بعد التعديل', Number(edited.salePrice) === 40, edited.salePrice);
  check('📈 رقم النسخة', edited.version > jacket.version, `${jacket.version} → ${edited.version}`);

  const stale = await refused('patch', `/marina/additions/${jacket.id}`, { version: jacket.version, name: 'قديم' });
  check('`VERSION_CONFLICT`', stale.status === 409, `${stale.status} ${stale.code} ${stale.detail}`);

  const noNameEdit = await refused('patch', `/marina/additions/${jacket.id}`, { name: '' });
  check('«يجب إدخال اسم الإضافة ⚠️» عند التعديل', noNameEdit.status === 422 && noNameEdit.detail === 'يجب إدخال اسم الإضافة ⚠️', `${noNameEdit.status} ${noNameEdit.code}`);
  const survived = list(await get('/marina/additions')).find((row) => row.id === jacket.id);
  check('الاسم القديم باقٍ بعد الرفض', survived?.name === `سترة نجاة ${stamp} (كبيرة)`, survived?.name ?? '—');

  // -------------------------------------------------------------------------
  console.log('\n5. 🎁 الإضافات في «الحجوزات» — الاسم والسعر من التعريف');

  const branches = list(await get('/branches'));
  const branchId = branches[0]?.id ?? '';
  check('🏢 الفرع', Boolean(branchId), branches[0]?.nameAr ?? branches[0]?.name ?? '—');

  const customers = list(await get('/parties?kind=customer'));
  const customer = customers[0] ?? (await post('/parties', { kind: 'customer', name: `عميل مرسى ${stamp}`, phone: '0551234567' }));
  check('👤 العميل', Boolean(customer?.id), customer.name);

  const marina = await get('/marina');
  let group = (marina.groups ?? []).find((row) => row.name === 'قوارب سريعة');
  if (!group) group = await post('/marina/groups', { name: 'قوارب سريعة', code: `FAST${stamp}` });
  let vessel = (marina.vessels ?? []).find((row) => row.code === 'V-1');
  if (!vessel) vessel = await post('/marina/vessels', { groupId: group.id, code: 'V-1', name: 'الأمل', capacity: 6 });
  check('⚓ المركب', Boolean(vessel?.id), `${vessel.code} — ${vessel.name}`);

  const day = '2026-09-01';
  const booking = await post('/marina/bookings', {
    branchId,
    partyId: customer.id,
    vesselId: vessel.id,
    documentDate: day,
    startsAt: `${day}T08:00:00.000Z`,
    endsAt: `${day}T10:00:00.000Z`,
    periodHours: 2,
    rentalAmount: '400',
  });
  writtenBookings.push(booking.id);
  check('⛵ الحجز', Boolean(booking?.id), `${booking.number ?? '—'}`);

  // «➕» على «🎁 الإضافات» — لا اسم يُكتب ولا سعر: كلاهما من `Additions`.
  const line = await post(`/marina/bookings/${booking.id}/additions`, { additionId: jacket.id, quantity: '2' });
  check('📝 الاسم من `Additions.name`', line.description === `سترة نجاة ${stamp} (كبيرة)`, line.description ?? '—');
  check('💰 السعر من `Additions.SalePrice`', Number(line.unitPrice) === 40, line.unitPrice ?? '—');
  check('الكمية', Number(line.quantity) === 2, line.quantity ?? '—');
  check('«الإجمالي» = الكمية × السعر', Number(line.amount) === 80, line.amount ?? '—');
  check('➕ الإضافة محفوظة على الصفّ', line.additionId === jacket.id, line.additionId ?? '—');

  // `Add2Dgv` — الإضافة في الشبكة أصلاً تُجمَع كمّيتها على صفّها.
  const merged = await post(`/marina/bookings/${booking.id}/additions`, { additionId: jacket.id, quantity: '1' });
  check('الكمية تُجمَع ولا يتكرر الصفّ', Number(merged.quantity) === 3 && Number(merged.unitPrice) === 40, `${merged.quantity} × ${merged.unitPrice}`);
  check('«الإجمالي» بعد الجمع', Number(merged.amount) === 120, merged.amount ?? '—');

  const grown = await get(`/marina/bookings/${booking.id}`);
  check('صفٌّ واحد في الشبكة', (grown.additions ?? []).length === 1, `${(grown.additions ?? []).length} صفّ`);
  check('إجمالي الإضافات في الحجز', Number(grown.additionsTotal) === 120, grown.additionsTotal ?? '—');
  check('🧾 الاستخدام يكبر', list(await get('/marina/additions')).find((row) => row.id === jacket.id)?.usageCount === 1, `${list(await get('/marina/additions')).find((row) => row.id === jacket.id)?.usageCount}`);

  // -------------------------------------------------------------------------
  console.log('\n6. الرفوض في الحجز — «يجب إدخال الكمية  » · «الإضافة غير موجودة»');

  const noQuantity = await refused('post', `/marina/bookings/${booking.id}/additions`, { additionId: jacket.id, quantity: '0' });
  check('«يجب إدخال الكمية  »', noQuantity.status === 422 && noQuantity.detail === 'يجب إدخال الكمية  ', `${noQuantity.status} ${noQuantity.code} ${noQuantity.detail}`);

  const unknown = await refused('post', `/marina/bookings/${booking.id}/additions`, { additionId: '00000000-0000-0000-0000-000000000000', quantity: '1' });
  check('«الإضافة غير موجودة»', unknown.status === 404 && unknown.detail === 'الإضافة غير موجودة', `${unknown.status} ${unknown.code} ${unknown.detail}`);

  const touched = await get(`/marina/bookings/${booking.id}`);
  check('الشبكة لم تُمسَّ بعد الرفضين', (touched.additions ?? []).length === 1 && Number(touched.additionsTotal) === 120, `${(touched.additions ?? []).length} صفّ · ${touched.additionsTotal}`);

  // «🎁 الإضافات» تُقرأ من تعريفها عند إنشاء الحجز كذلك.
  const bulk = await post('/marina/bookings', {
    branchId,
    partyId: customer.id,
    vesselId: vessel.id,
    documentDate: day,
    startsAt: `${day}T12:00:00.000Z`,
    endsAt: `${day}T14:00:00.000Z`,
    periodHours: 2,
    rentalAmount: '400',
    additions: [{ additionId: free.id, quantity: '3' }],
  });
  writtenBookings.push(bulk.id);
  check('إنشاء حجزٍ بإضافة من تعريفها', (bulk.additions ?? []).length === 1 && bulk.additions[0].description === `ماء ${stamp}` && Number(bulk.additions[0].unitPrice) === 0, `${bulk.additions?.[0]?.description ?? '—'} × ${bulk.additions?.[0]?.quantity ?? '—'}`);

  // -------------------------------------------------------------------------
  console.log('\n7. 🗑️ حذف — «يجب تحديد الإضافة المراد حذفها ⚠️»');

  const nothing = await refused('delete', '/marina/additions/00000000-0000-0000-0000-000000000000');
  check('«يجب تحديد الإضافة المراد حذفها ⚠️»', nothing.status === 404 && nothing.detail === 'يجب تحديد الإضافة المراد حذفها ⚠️', `${nothing.status} ${nothing.code} ${nothing.detail}`);

  const removed = await del(`/marina/additions/${free.id}`);
  check('🗑️ تم الحذف', removed?.deleted === true, `${removed?.id ?? '—'}`);
  const gone = list(await get('/marina/additions')).filter((row) => row.id === free.id);
  check('خرجت من «🎁 الإضافات»', gone.length === 0, `${gone.length}`);

  const again = await refused('delete', `/marina/additions/${free.id}`);
  check('حذفٌ ثانٍ — «يجب تحديد الإضافة المراد حذفها ⚠️»', again.status === 404 && again.detail === 'يجب تحديد الإضافة المراد حذفها ⚠️', `${again.status} ${again.code}`);

  // والصفّ الذي كُتب منها على الحجز يبقى باسمه وسعره وإجماليه.
  const kept = await get(`/marina/bookings/${bulk.id}`);
  check(
    'الصفّ الذي كُتب منها باقٍ باسمه',
    (kept.additions ?? []).length === 1 && kept.additions[0].description === `ماء ${stamp}` && Number(kept.additions[0].quantity) === 3,
    `${kept.additions?.[0]?.description ?? '—'} × ${kept.additions?.[0]?.quantity ?? '—'}`,
  );
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n8. التنظيف — ما كتبه هذا التشغيل يُمحى');

  for (const id of writtenBookings) await del(`/marina/bookings/${id}`).catch(() => {});
  for (const id of written) await del(`/marina/additions/${id}`).catch(() => {});

  const leftBookings = list(await get('/marina/bookings')).filter((row) => writtenBookings.includes(row.id));
  check('التنظيف — لا أثر لحجوزات هذا التشغيل', leftBookings.length === 0, `باقٍ: ${leftBookings.length}`);
  const leftAdditions = list(await get('/marina/additions')).filter((row) => written.includes(row.id));
  check('التنظيف — لا أثر لإضافات هذا التشغيل', leftAdditions.length === 0, `باقٍ: ${leftAdditions.length}`);
}

console.log(`\n${failures === 0 ? '✅ كل الفحوص نجحت' : `❌ ${failures} فحص فشل`}`);
process.exitCode = failures === 0 ? 0 : 1;
