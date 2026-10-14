#!/usr/bin/env node
/**
 * Live verification of the journal entry navigation (R10) against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It walks the real HTTP API the way the entry card walks it — nothing is mocked. القيود التي
 * يكتبها **تبقى** في القاعدة (لا مسار حذف لقيدٍ مرحّل؛ عكسُه هو الطريق) — ولذلك كل توقّع في
 * السكربت **محسوبٌ من السجل نفسه** لا مرقومٌ بيد: يشغّله من يشغّله ولو عشر مرّات فيبقى أخضر،
 * وهو في الوقت نفسه يقابل ترتيبَ السجل بترتيب التنقّل فيكشف انفصالهما إن حدث.
 *
 *   ۱) ⏮ الأول و⏭ الأخير: طرفا النطاق
 *   ۲) ◀ السابق و▶ التالي: جارٌ مباشر — لا القيد نفسه ولا قفزة
 *   ۳) الموضع: عدٌّ من الأقدم يزيد واحداً في كل خطوة حتى آخر النطاق
 *   ۴) النطاق: الفترة تضيّق العدّ ولا يخرج السهم منها، وقيدٌ خارجها يُقال صريحاً
 *   ۵) إدخالٌ خارج نطاقه: الموضع صفر والسهمان يدلّان على النطاق
 *   ۶) الحالة تفصل · والحرّاس: 404 · 400 · 401
 *
 * Usage: node scripts/verify-journal-navigation.mjs
 *   API_BASE       (default http://127.0.0.1:3000/api/v1)
 *   VERIFY_TENANT  (default demo)
 *   VERIFY_EMAIL   (default owner@demo.test)
 *   DEMO_OWNER_PASSWORD (يُقرأ من `.env` عبر `loadEnvFiles`)
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = (process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, '');
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let checks = 0;
let failures = 0;
const skip = [];

function ok(message) {
  checks += 1;
  console.log(`✔ ${message}`);
}
function bad(message, detail) {
  checks += 1;
  failures += 1;
  console.log(`✘ ${message}${detail === undefined ? '' : ` — ${detail}`}`);
}
function assert(condition, message, detail) {
  if (condition) ok(message);
  else bad(message, detail);
}

async function raw(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function call(method, path, token, body) {
  const response = await raw(method, path, token, body);
  if (response.status >= 400) {
    const error = new Error(`${method} ${path} → ${response.status} ${response.body.code ?? ''}`);
    error.status = response.status;
    error.body = response.body;
    throw error;
  }
  return response.body;
}

const data = (payload) => payload?.data ?? payload;
const short = (id) => (id ? `${String(id).slice(0, 8)}…${String(id).slice(-4)}` : '—');
const row = (entry) => (entry ? `${short(entry.id)} (${entry.number ?? 'بلا رقم'})` : '—');

const main = async () => {
  const login = await call('post', '/auth/login', undefined, { tenantCode, email, password });
  const token = data(login).accessToken;
  console.log(`✔ signed in as ${email} @ ${tenantCode}`);

  const branchId = data(await call('get', '/branches?limit=1', token))[0]?.id;
  if (!branchId) throw new Error('لا فرع في هذه المنشأة — شغّل البذرة');

  // ─────────────────────────────────────────────── ۰. قيود الفحص: خمسة على خمسة أيام
  console.log('');
  console.log('۰) كتابة خمسة قيود فحص');
  const accounts = data(await call('get', '/accounts?type=expense', token));
  const postable = accounts.filter((row) => row.isPostable && row.allowManual);
  if (postable.length < 2) throw new Error('لا حسابان قابلان للترحيل في هذا الدليل');
  const [accountA, accountB] = postable;

  /**
   * خمسة أيام **لم يُكتب فيها قيد بعد**: فيبقى النطاق نظيفاً ويعمل السكربت مراراً بلا أن
   * تتغيّر أرقامه. تُمسح الأشهر ابتداءً من الشهر الجاري، فإن امتلأت السنة كلها أُعيد
   * استعمال نطاقٍ معروف وتُخطّى دعوتان تعتمدان على «لا قيود غيرنا في النطاق».
   */
  const year = new Date().getUTCFullYear();
  const ymd = (month, dayOfMonth) => `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
  const monthLength = (month) => [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const currentMonth = new Date().getUTCMonth() + 1;
  const monthsToScan = [...Array(12)].map((_, index) => ((currentMonth - 1 + index) % 12) + 1);

  let month = currentMonth;
  let firstDay = 0;
  let scanned = '';
  for (const candidateMonth of monthsToScan) {
    const length = monthLength(candidateMonth);
    const rows = data(
      await call('get', `/journal-entries?from=${ymd(candidateMonth, 1)}&to=${ymd(candidateMonth, length)}&limit=500`, token),
    );
    if (rows.length >= 500) continue;
    const used = new Set(rows.map((entry) => entry.date));
    scanned += `${scanned ? ' · ' : ''}${ymd(candidateMonth, 1).slice(0, 7)}:${used.size}`;
    for (let candidate = 1; candidate + 4 <= length; candidate += 1) {
      if ([0, 1, 2, 3, 4].every((offset) => !used.has(ymd(candidateMonth, candidate + offset)))) {
        month = candidateMonth;
        firstDay = candidate;
        break;
      }
    }
    if (firstDay) break;
  }
  const reused = firstDay === 0;
  if (reused) {
    month = currentMonth;
    firstDay = 10;
  }
  const day = (index) => ymd(month, firstDay + index);
  const window = (first, last) => `?from=${day(first)}&to=${day(last)}`;
  console.log(`  أيام الفحص ${day(0)}…${day(4)}${reused ? ' (استُعملت: السنة امتلأت)' : ' (بكر)'} — أيامٌ فيها قيود: ${scanned}`);

  const created = [];
  for (let index = 0; index < 5; index += 1) {
    const entry = await call('post', '/journal-entries', token, {
      branchId,
      date: day(index),
      description: `قيد فحص التنقّل ${index + 1}`,
      lines: [
        { accountId: accountA.id, debit: '10', credit: '0' },
        { accountId: accountB.id, debit: '0', credit: '10' },
      ],
    });
    created.push(data(entry).id);
  }
  const createdAgo = created.map((id) => { const [, ago] = id.split('-'); return ago; });
  console.log(`  ${created.map(short).join(' · ')}`);
  console.log(`  ${createdAgo[0] < createdAgo[4] ? 'ترتيب الإنشاء تصاعديّ كما يفترض UUIDv7' : '⚠️ ترتيب المعرّفات غير تصاعديّ!'}`);

  const neighbours = async (id, query = '') => data(await call('get', `/journal-entries/${id}/neighbours${query}`, token));
  /** السجل نفسه بالترتيب الذي يمشي به المتنقّل: `id` تصاعدياً = ترتيب الإنشاء. */
  const register = async (query = '') => {
    const rows = data(await call('get', `/journal-entries${query ? `${query}&` : '?'}limit=500`, token));
    if (rows.length === 500) throw new Error('السجل أطول من 500 صفّ — ارفع الحدّ في السكربت');
    return [...rows].sort((left, right) => (left.id < right.id ? -1 : 1));
  };

  /**
   * يقابل ما يردّه مسار الجيران بما يقرأه السجل **بالنطاق نفسه** — وهذا هو العقد:
   * لو انفصل نطاق التنقّل عن نطاق السجل، لظهر هنا قبل أن يقفز سهمٌ في يد مُدخِل.
   */
  /** مقارنةٌ لا تفرّق بين «لا جار» و«جارٌ بمعرّفٍ ما». */
  const same = (actual, expected, message, detail) => {
    const left = actual?.id ?? null;
    const right = expected?.id ?? null;
    assert(left === right, message, detail ?? `${row(actual)} ≠ ${row(expected)}`);
  };

  /**
   * يقابل ما يردّه مسار الجيران بما يقرأه السجل **بالنطاق نفسه** — وهذا هو العقد:
   * لو انفصل نطاق التنقّل عن نطاق السجل، لظهر هنا قبل أن يقفز سهمٌ في يد مُدخِل.
   * والمقارنة بترتيب `id` (ترتيب الإنشاء) لا بمكان الصفّ في الاستجابة.
   */
  const checkScope = async (label, query, focusId) => {
    const rows = await register(query);
    const index = rows.findIndex((entry) => entry.id === focusId);
    const before = rows.filter((entry) => entry.id < focusId);
    const after = rows.filter((entry) => entry.id > focusId);
    const nav = await neighbours(focusId, query);
    assert(nav.total === rows.length, `${label}: العدّ = ${rows.length}`, nav.total);
    same(nav.first, rows[0] ?? null, `${label}: «الأول» أقدمُ قيدٍ في النطاق`);
    same(nav.last, rows.at(-1) ?? null, `${label}: «الأخير» أحدثُ قيدٍ فيه`);
    same(nav.previous, before.at(-1) ?? null, `${label}: «السابق» آخرُ قيدٍ قبله في النطاق`);
    same(nav.next, after[0] ?? null, `${label}: «التالي» أوّلُ قيدٍ بعده في النطاق`);
    if (index < 0) {
      assert(nav.position === 0, `${label}: والموضع صفر (خارج النطاق المعروض)`, nav.position);
    } else {
      assert(nav.position === index + 1, `${label}: وموضعه ${index + 1} من ${rows.length}`, nav.position);
    }
    return { rows, index, nav, before, after };
  };

  // ─────────────────────────────────────────────── ۱. الطرفان
  console.log('');
  console.log('۱) ⏮ الأول و⏭ الأخير');
  const wholeWindow = window(0, 4);
  const windowRows = await register(wholeWindow);
  assert(
    created.every((id) => windowRows.some((entry) => entry.id === id)),
    'وقيود الفحص الخمسة كلها داخل النطاق',
    `${created.filter((id) => !windowRows.some((entry) => entry.id === id)).length} غائب`,
  );
  // طرفا النطاق يُقرآن من السجل لا من دفعة الفحص: تشغيلٌ ثانٍ يضيف قيوداً أقدم أو أحدث.
  const first = await checkScope('كل الأيام الخمسة عند أقدم قيد', wholeWindow, windowRows[0].id);
  const last = await checkScope('كل الأيام الخمسة عند أحدث قيد', wholeWindow, windowRows.at(-1).id);
  assert(first.nav.previous === null, 'أقدمُ قيدٍ في النطاق لا سابق له (الزرّ يُعطَّل)', String(first.nav.previous));
  assert(first.nav.position === 1, 'وموضعه 1', first.nav.position);
  assert(last.nav.next === null, 'وأحدثُ قيدٍ فيه لا تاليَ له', String(last.nav.next));
  assert(last.nav.position === last.nav.total, 'وموضعه آخرُ النطاق', `${last.nav.position}/${last.nav.total}`);

  // ─────────────────────────────────────────────── ۲. الجاران
  console.log('');
  console.log('۲) ◀ السابق و▶ التالي');
  const middle = await checkScope('وسط الأيام الخمسة', wholeWindow, created[2]);
  assert(middle.index >= 1, 'وللقيد الأوسط سابقٌ في السجل', middle.index);
  assert(middle.nav.previous?.id !== created[2] && middle.nav.next?.id !== created[2], 'ولا واحدٌ من الجارين القيد نفسه (عيب الدقّة الذي أوقف البناء)');

  // ─────────────────────────────────────────────── ۳. المشي
  console.log('');
  console.log('۳) المشي «التالي ← التالي» حتى آخر النطاق');
  let cursor = first.rows[0].id;
  let walked = 0;
  for (;;) {
    const nav = await neighbours(cursor, wholeWindow);
    walked += 1;
    if (nav.position !== walked) {
      bad(`الموضع ${walked} عند ${short(cursor)}`, nav.position);
      break;
    }
    if (!nav.next) {
      ok(`مشينا ${walked} قيداً من الأقدم إلى الأحدث والموضع يتصاعد +1 في كل خطوة`);
      assert(nav.position === nav.total, 'وتوقّفنا عند آخر قيدٍ في النطاق لا في وسطه', `${nav.position}/${nav.total}`);
      break;
    }
    cursor = nav.next.id;
    if (walked > 200) throw new Error('التنقّل لا ينتهي — حلقة');
  }
  assert(walked === first.rows.length, 'وعدد الخطوات = عدد قيود النطاق', `${walked} ≠ ${first.rows.length}`);

  // ─────────────────────────────────────────────── ۴. النطاق
  console.log('');
  console.log('۴) النطاق يضيّق العدّ ولا يخرج السهم منه');
  const oneDay = await checkScope('نطاق يومٍ واحد', `?from=${day(2)}&to=${day(2)}`, created[2]);
  assert(
    oneDay.rows.every((entry) => entry.date === day(2)),
    'ولا يدخل فيه قيدُ يومٍ آخر',
    oneDay.rows.map((entry) => entry.date).join(' · '),
  );
  if (oneDay.rows.length === 1) {
    assert(oneDay.nav.previous === null && oneDay.nav.next === null, 'ويومٌ فيه قيدٌ واحد ⇒ لا جيران (الزرّان مُعطَّلان)');
  } else if (reused) {
    skip.push(`يوم ${day(2)} فيه ${oneDay.rows.length} قيود (الشهر امتلأ) — تُخطّي دعوى «قيدٌ واحد»`);
  } else {
    bad('يومٌ من أيام الفحص الجديدة ضمّ أكثر من قيد', oneDay.rows.length);
  }
  const twoDays = await checkScope('نطاق يومين', window(0, 1), created[1]);
  assert(twoDays.rows.length <= first.rows.length, 'والنطاق الأضيق لا يزيد صفوفاً', `${twoDays.rows.length} ≤ ${first.rows.length}`);
  const outside = await checkScope('قيدٌ من الأيام الأولى داخل نطاق الأيام الأخيرة', window(3, 4), created[0]);
  assert(outside.index < 0 && outside.nav.position === 0, 'والعدّ يعدّ النطاق والقيد فيه ليس له موضع', `${outside.nav.position}/${outside.nav.total}`);
  const ghostScope = await neighbours(created[2], '?from=1999-01-01&to=1999-12-31');
  assert(ghostScope.total === 0 && ghostScope.previous === null && ghostScope.next === null, 'ونطاقٌ بلا قيود ⇒ 0 بلا جيران');

  // ─────────────────────────────────────────────── ۵. إدخالٌ خارج النطاق
  console.log('');
  console.log('۵) قيدٌ يُفتح خارج نطاقه (رابطٌ مباشر): الموضع صفر والسهمان يدلّان على النطاق');
  const lastRun = created[0];
  const stray = await checkScope('قيدٌ من الأيام الأولى', window(2, 4), lastRun);
  assert(stray.index < 0, 'وهو فعلاً خارج النطاق', stray.index);
  assert(stray.nav.position === 0, 'فموضعه صفر لا رقمٌ كاذب', stray.nav.position);
  assert(
    stray.before.length + stray.after.length === stray.rows.length,
    `وكل قيود النطاق إمّا قبله (${stray.before.length}) وإمّا بعده (${stray.after.length}) — فهو خارجه`,
  );
  assert(stray.nav.next === null || stray.after.length > 0, 'و«التالي» لا يدلّ إلا على قيدٍ في النطاق');
  assert(stray.nav.previous === null || stray.before.length > 0, 'و«السابق» كذلك');
  const strayInside = await checkScope('نطاقٌ أقصر وقيدُنا خارجه', window(1, 2), lastRun);
  assert(strayInside.nav.position === 0, `ونطاقٌ فيه ${strayInside.rows.length} قيود وقيدُنا خارجه ⇒ 0 منها`, `${strayInside.nav.position}/${strayInside.nav.total}`);

  // ─────────────────────────────────────────────── ۶. الحالة والحرّاس
  console.log('');
  console.log('۶) الحالة والحرّاس');
  /**
   * الحالة تفصل القيود: `POST /journal-entries` يُرحّل دائماً (لا مسار مسودّة يدويّ)، فما
   * في القاعدة من مسودّات يأتي من تدفّقات أخرى — ولذلك تُقاس الدعوى على ما يوجد فعلاً.
   */
  const draftScope = `${window(0, 4)}&status=draft`;
  const draftRows = await register(draftScope);
  const postedRows = await register(`${window(0, 4)}&status=posted`);
  assert(
    draftRows.length + postedRows.length === first.rows.length,
    `حالةٌ وحالةٌ يجمعان النطاق كله (${draftRows.length} مسودّة + ${postedRows.length} مرحّلة)`,
    first.rows.length,
  );
  if (draftRows.length) {
    const nav = await neighbours(draftRows[0].id, draftScope);
    assert(nav.total === draftRows.length, 'ونطاق المسودّات يعدّ مسودّاته وحده', nav.total);
    assert(nav.position === 1, 'وأولها موضعه 1 فيه', nav.position);
  } else {
    skip.push('لا مسودّات في هذا النطاق (المسار يُرحّل دائماً) — تُخطّي دعوى المسودّة');
  }
  const mixed = await neighbours(created[4], wholeWindow);
  assert(mixed.total === first.rows.length, 'ونطاقٌ بلا حالة يعدّ الحالتين معاً', mixed.total);
  const voided = await neighbours(created[4], `${wholeWindow}&status=voided`);
  assert(voided.total === 0 && voided.position === 0, 'ونطاقُ حالةٍ بلا مطابق ⇒ 0 وموضعُ صفر', `${voided.position}/${voided.total}`);

  const ghost = await raw('get', '/journal-entries/01a0c600-0000-7000-8000-000000000999/neighbours', token);
  assert(ghost.status === 404 && ghost.body.code === 'NOT_FOUND', 'قيدٌ مجهول ⇒ 404 NOT_FOUND', `${ghost.status} ${ghost.body.code ?? ''}`);
  const malformed = await raw('get', '/journal-entries/not-a-uuid/neighbours', token);
  assert(malformed.status === 400 && malformed.body.code === 'INVALID_ID', 'معرّفٌ بلا صيغة ⇒ 400 INVALID_ID', `${malformed.status} ${malformed.body.code ?? ''}`);
  const anonymous = await raw('get', `/journal-entries/${created[0]}/neighbours`);
  assert(anonymous.status === 401, 'وبلا رمز جلسة ⇒ 401', anonymous.status);
  const strangerEntry = await raw('get', '/journal-entries/01a0c600-0000-7000-8000-000000000001', token);
  assert(strangerEntry.status === 404, 'ومعرّفٌ يخصّ منشأةً أخرى لا يُرى ⇒ 404', strangerEntry.status);

  // ─────────────────────────────────────────────── ۷. النتيجة
  console.log('');
  console.log(`${checks - failures}/${checks} فحصاً ناجحاً${skip.length ? ` (${skip.join(' · ')})` : ''}`);
  if (failures) console.log('ℹ️  القيود تبقى في القاعدة للتفتيش (شهر ۰۶ من السنة الحالية).');
  process.exitCode = failures ? 1 : 0;
};

main().catch((error) => {
  console.error(`✘ توقّف الفحص: ${error.message}`);
  process.exitCode = 1;
});
