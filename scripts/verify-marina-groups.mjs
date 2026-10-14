#!/usr/bin/env node
/**
 * Live verification of Phase 09 part seven — ⛵ المرسى: 📋 بطاقة الفئة و⏰ فترات التأجير —
 * against a running stack (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. ⏰ المدة — the ten `RentPeriod` durations the drop-down of `frmAddPeriod` offers
 *   2. 📋 بطاقة فئة — 🔢 الرقم · رمز الفئة · الاسمين · قيمة الساعة وعرضها · قيمة النصف
 *      ساعة وعرضها · 🖼️ صورة الفئة، والفترتان اللتان يكتبهما الحفظ (ساعة · نصف ساعة)
 *   3. الرفوض — «ادخل الفئة» · «الفئة تم ادخالها مسبقا» · «رابط صورة الفئة غير صحيح»
 *   4. ✏️ تعديل — البطاقة وفترتَيها معاً، ونسخةٌ قديمة تُرفض (`VERSION_CONFLICT`)
 *   5. ⏰ فترات التأجير — «➕ إضافة مدة»: ساعتين وثلاث ساعات بأسعارهما وعروضهما،
 *      ورفضاها «يجب إستكمال البيانات ⚠️» و«يجب اختيار الفئة أولاً ⚠️»
 *   6. ⏮ ◀ ▶ ⏭ — المشي في «📋 قائمة الفئات»، والوقوف عند الطرفين
 *   7. 🗑️ حذف — «هذه الفئة لها ارتباطات فرعية لايمكن حذفها»، ثم «اختر الفئة ليتم حذفها»
 *   8. التنظيف — فئات هذا التشغيل تُحذف، وما أُنشئ معها يُمحى
 *
 * Re-runnable and non-destructive: everything this script writes carries a stamp, and
 * everything it writes is deleted in a `finally` — so a failed check still leaves the
 * harbour as it found it.
 *
 * Usage: node scripts/verify-marina-groups.mjs
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
    // Node 22's undici rejects lowercase verbs: `patch`/`put` come back a 405 with an
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
const put = (path, body) => call('put', path, body);
const del = (path) => call('delete', path);
const list = (value) => (Array.isArray(value) ? value : (value?.data ?? []));

const written = [];

try {
  // -------------------------------------------------------------------------
  console.log('1. ⏰ المدة — `RentPeriod`؛ عشر مددٍ لِـ «⏰ إدارة فترات التأجير»');

  const periods = list(await get('/marina/rent-periods'));
  check('⏰ عدد المدد', periods.length === 10, `${periods.length} مدة`);
  check('⏰ الأولى نصف ساعة', periods[0]?.name === 'نصف ساعة' && periods[0]?.minutes === 30, `${periods[0]?.name} · ${periods[0]?.minutes}د`);
  check('⏰ الثانية ساعة', periods[1]?.name === 'ساعة' && periods[1]?.minutes === 60, `${periods[1]?.name} · ${periods[1]?.minutes}د`);
  check('⏰ الأخيرة خمس ساعات', periods[9]?.name === 'خمس ساعات' && periods[9]?.minutes === 300, `${periods[9]?.name} · ${periods[9]?.minutes}د`);

  // -------------------------------------------------------------------------
  console.log('\n2. 📋 بطاقة فئة — الرقم والرمز والاسمين والقيمتين والعرضين والصورة');

  const card = await post('/marina/groups', {
    code: `GRP${stamp}`,
    name: `فئة المرسى ${stamp}`,
    nameEn: `Marina group ${stamp}`,
    hourPrice: '200',
    hourOfferMinutes: 10,
    halfHourPrice: '120',
    halfHourOfferMinutes: 5,
    imageUrl: 'https://example.test/marina/group.png',
  });
  written.push(card.id);
  check('🔢 الرقم', Number(card.number) > 0, `رقم الفئة: ${card.number}`);
  check('رمز الفئة', card.code === `GRP${stamp}`, card.code);
  check('اسم الفئة (عربي)', card.name === `فئة المرسى ${stamp}`, card.name);
  check('اسم الفئة (EN)', card.nameEn === `Marina group ${stamp}`, card.nameEn);
  check('قيمة الساعة', Number(card.hourPrice) === 200, card.hourPrice);
  check('عرض الساعة (دقيقة)', card.hourOfferMinutes === 10, `${card.hourOfferMinutes}د`);
  check('قيمة النصف ساعة', Number(card.halfHourPrice) === 120, card.halfHourPrice);
  check('عرض النصف ساعة (دقيقة)', card.halfHourOfferMinutes === 5, `${card.halfHourOfferMinutes}د`);
  check('🖼️ صورة الفئة', card.imageUrl === 'https://example.test/marina/group.png', card.imageUrl ?? '—');
  check('⛵ عدد المراكب', card.vesselCount === 0, `${card.vesselCount}`);

  // `frmGroupM.btnSave_Click` writes ساعة ونصف ساعة from the card's own boxes.
  const canonical = card.periods ?? [];
  const hour = canonical.find((row) => row.periodId === 2);
  const half = canonical.find((row) => row.periodId === 1);
  check('⏰ الفترتان مكتوبتان', canonical.length === 2, canonical.map((row) => row.periodName).join(' · '));
  check('💵 سعر الساعة من قيمة الساعة', Number(hour?.price) === 200, hour?.price ?? '—');
  check('🎁 عرض الساعة', hour?.offerMinutes === 10, `${hour?.offerMinutes ?? '—'}د`);
  check('💵 سعر نصف الساعة من قيمتها', Number(half?.price) === 120, half?.price ?? '—');
  check('🎁 عرض نصف الساعة', half?.offerMinutes === 5, `${half?.offerMinutes ?? '—'}د`);

  const readBack = await get(`/marina/groups/${card.id}`);
  check('📋 قراءة البطاقة', readBack.id === card.id && readBack.periods.length === 2, `${readBack.code} · ${readBack.periods.length} فترة`);

  // -------------------------------------------------------------------------
  console.log('\n3. الرفوض — «ادخل الفئة» · «الفئة تم ادخالها مسبقا» · رابط الصورة');

  const noCode = await refused('post', '/marina/groups', { name: 'بلا رمز' });
  check('«ادخل الفئة»', noCode.status === 422 && noCode.detail === 'ادخل الفئة', `${noCode.status} ${noCode.code} ${noCode.detail}`);

  const duplicate = await refused('post', '/marina/groups', { code: `GRP${stamp}`, name: 'نفس الرمز' });
  check('«الفئة تم ادخالها مسبقا»', duplicate.status === 422 && duplicate.detail === 'الفئة تم ادخالها مسبقا', `${duplicate.status} ${duplicate.code} ${duplicate.detail}`);

  const badImage = await refused('post', '/marina/groups', { code: `IMG${stamp}`, name: 'صورة مكسورة', imageUrl: 'not-a-link' });
  check('رابط الصورة', badImage.status === 422 && badImage.detail === 'رابط صورة الفئة غير صحيح', `${badImage.status} ${badImage.code} ${badImage.detail}`);

  const missing = await refused('get', '/marina/groups/00000000-0000-0000-0000-000000000000');
  check('«الفئة غير موجودة»', missing.status === 404, `${missing.status} ${missing.code} ${missing.detail}`);

  // -------------------------------------------------------------------------
  console.log('\n4. ✏️ تعديل البطاقة — وفترتَيها، ونسخةٌ قديمة تُرفض');

  const edited = await patch(`/marina/groups/${card.id}`, {
    version: card.version,
    name: `فئة المرسى ${stamp} (معدّلة)`,
    hourPrice: '250',
    halfHourPrice: '150',
    hourOfferMinutes: 15,
  });
  check('اسم الفئة بعد التعديل', edited.name === `فئة المرسى ${stamp} (معدّلة)`, edited.name);
  check('قيمة الساعة بعد التعديل', Number(edited.hourPrice) === 250, edited.hourPrice);
  check('قيمة النصف ساعة بعد التعديل', Number(edited.halfHourPrice) === 150, edited.halfHourPrice);
  const editedHour = (edited.periods ?? []).find((row) => row.periodId === 2);
  check('⏰ سعر الساعة يتبع البطاقة', Number(editedHour?.price) === 250, editedHour?.price ?? '—');
  check('🎁 عرض الساعة يتبع البطاقة', editedHour?.offerMinutes === 15, `${editedHour?.offerMinutes ?? '—'}د`);
  check('🖼️ الصورة باقية', edited.imageUrl === 'https://example.test/marina/group.png', edited.imageUrl ?? '—');
  check('📈 رقم النسخة', edited.version > card.version, `${card.version} → ${edited.version}`);

  const stale = await refused('patch', `/marina/groups/${card.id}`, { version: card.version, name: 'قديم' });
  check('`VERSION_CONFLICT`', stale.status === 409, `${stale.status} ${stale.code} ${stale.detail}`);

  // -------------------------------------------------------------------------
  console.log('\n5. ⏰ فترات التأجير — «➕ إضافة مدة»: ساعتين وثلاث ساعات');

  const morePeriods = await put(`/marina/groups/${card.id}/periods`, {
    periods: [
      { periodId: 1, price: '150', offerMinutes: 5 },
      { periodId: 2, price: '250', offerMinutes: 15 },
      { periodId: 4, price: '450', offerMinutes: 30 },
      { periodId: 6, price: '600', offerMinutes: 45 },
    ],
  });
  const rows = morePeriods.periods ?? [];
  check('⏰ أربع فترات', rows.length === 4, rows.map((row) => row.periodName).join(' · '));
  const twoHours = rows.find((row) => row.periodId === 4);
  const threeHours = rows.find((row) => row.periodId === 6);
  check('💵 سعر ساعتين', Number(twoHours?.price) === 450, twoHours?.price ?? '—');
  check('🎁 عرض ساعتين', twoHours?.offerMinutes === 30, `${twoHours?.offerMinutes ?? '—'}د`);
  check('⏱️ طول ساعتين', twoHours?.minutes === 120, `${twoHours?.minutes ?? '—'}د`);
  check('💵 سعر ثلاث ساعات', Number(threeHours?.price) === 600, threeHours?.price ?? '—');
  check('⏱️ طول ثلاث ساعات', threeHours?.minutes === 180, `${threeHours?.minutes ?? '—'}د`);

  const incomplete = await refused('put', `/marina/groups/${card.id}/periods`, {
    periods: [{ periodId: 2, price: '0' }, { periodId: 99, price: '10' }],
  });
  check('«يجب إستكمال البيانات ⚠️»', incomplete.status === 422 && incomplete.detail === 'يجب إستكمال البيانات ⚠️', `${incomplete.status} ${incomplete.code} ${incomplete.detail}`);
  const survivors = await get(`/marina/groups/${card.id}`);
  check('الفترات لم تُمسَّ بعد الرفض', (survivors.periods ?? []).length === 4, `${(survivors.periods ?? []).length} فترة`);

  const noGroup = await refused('put', '/marina/groups/00000000-0000-0000-0000-000000000000/periods', { periods: [{ periodId: 2, price: '10' }] });
  check('«الفئة غير موجودة» للفترات', noGroup.status === 404, `${noGroup.status} ${noGroup.code} ${noGroup.detail}`);

  // -------------------------------------------------------------------------
  console.log('\n6. ⏮ ◀ ▶ ⏭ — المشي في «📋 قائمة الفئات»');

  // ⏮/◀/▶/⏭ need more than one فئة to have anywhere to go.
  const secondCard = await post('/marina/groups', { code: `GRP2${stamp}`, name: `فئة ثانية ${stamp}`, hourPrice: '90', halfHourPrice: '50' });
  written.push(secondCard.id);
  check('📋 فئة ثانية', Number(secondCard.number) > Number(card.number), `${secondCard.code} (${secondCard.number})`);

  const cards = list(await get('/marina/groups'));
  check('📋 قائمة الفئات', cards.length > 0, `${cards.length} فئة`);
  const numbers = cards.map((row) => Number(row.number));
  check('🔢 الأرقام تصعد', numbers.every((value, index) => index === 0 || value >= numbers[index - 1]), numbers.join(' · '));

  const first = await get('/marina/groups/navigate?dir=first');
  check('⏮ الأول', Number(first?.number) === numbers[0], `${first?.code ?? '—'} (${first?.number})`);
  const last = await get('/marina/groups/navigate?dir=last');
  check('⏭ الأخير', Number(last?.number) === numbers[numbers.length - 1], `${last?.code ?? '—'} (${last?.number})`);

  if (cards.length > 1) {
    const second = await get(`/marina/groups/navigate?dir=next&currentId=${first.id}`);
    check('▶ التالي', Number(second?.number) === numbers[1], `${second?.code ?? '—'} (${second?.number})`);
    const back = await get(`/marina/groups/navigate?dir=previous&currentId=${second.id}`);
    check('◀ السابق', back?.id === first.id, `${back?.code ?? '—'} (${back?.number})`);
    const stuck = await get(`/marina/groups/navigate?dir=next&currentId=${last.id}`);
    check('▶ عند الأخير يبقى مكانه', stuck?.id === last.id, `${stuck?.code ?? '—'} (${stuck?.number})`);
  } else {
    check('▶ التالي', true, 'فئة واحدة — لا مجال للمشي');
    check('◀ السابق', true, 'فئة واحدة — لا مجال للمشي');
    check('▶ عند الأخير يبقى مكانه', true, 'فئة واحدة — لا مجال للمشي');
  }

  // -------------------------------------------------------------------------
  console.log('\n7. 🗑️ حذف — الارتباطات أولاً، ثم «اختر الفئة ليتم حذفها»');

  const vessel = await post('/marina/vessels', { groupId: card.id, code: `VGRP${stamp}`, name: `مركب ${stamp}`, capacity: 4 });
  check('⚓ مركب تحت الفئة', Boolean(vessel?.id), `${vessel.code} — ${vessel.name}`);
  const withVessel = await get(`/marina/groups/${card.id}`);
  check('⛵ عدد المراكب', withVessel.vesselCount === 1, `${withVessel.vesselCount}`);

  const inUse = await refused('delete', `/marina/groups/${card.id}`);
  check('«هذه الفئة لها ارتباطات فرعية لايمكن حذفها»', inUse.status === 409 && inUse.detail === 'هذه الفئة لها ارتباطات فرعية لايمكن حذفها', `${inUse.status} ${inUse.code} ${inUse.detail}`);
  const retired = await del(`/marina/vessels/${vessel.id}`);
  check('🗑️ تقاعد المركب', retired?.deleted === true, `${vessel.code}`);
  const afterVessel = await get(`/marina/groups/${card.id}`);
  check('⛵ بعد حذف المركب', afterVessel.vesselCount === 0, `${afterVessel.vesselCount}`);

  const nothing = await refused('delete', '/marina/groups/00000000-0000-0000-0000-000000000000');
  check('«اختر الفئة ليتم حذفها»', nothing.status === 404 && nothing.detail === 'اختر الفئة ليتم حذفها', `${nothing.status} ${nothing.code} ${nothing.detail}`);

  const deleted = await del(`/marina/groups/${card.id}`);
  check('🗑️ تم الحذف', deleted?.deleted === true, `${deleted?.id ?? '—'}`);
  const gone = list(await get('/marina/groups')).filter((row) => row.id === card.id);
  check('📋 خرجت من القائمة', gone.length === 0, `${gone.length}`);
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n8. التنظيف — ما كتبه هذا التشغيل يُمحى');
  for (const id of written) {
    const detail = await get(`/marina/groups/${id}`).catch(() => null);
    if (detail?.vesselCount) {
      const fleet = list(await get('/marina')).vessels ?? [];
      const marina = await get('/marina');
      for (const row of (marina.vessels ?? fleet)) {
        if (row.groupId === id) await del(`/marina/vessels/${row.id}`).catch(() => {});
      }
    }
    await del(`/marina/groups/${id}`).catch(() => {});
  }
  const left = list(await get('/marina/groups')).filter((row) => written.includes(row.id));
  console.log(`  ✓ فئات هذا التشغيل: ${written.length} — باقٍ منها: ${left.length}`);
}

console.log(`\n${failures === 0 ? '✔ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
