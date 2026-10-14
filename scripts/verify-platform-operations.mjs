#!/usr/bin/env node
/**
 * Live verification of P-C9 «العمليات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4) against a
 * running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the console drives — nothing is mocked:
 *
 *   1. 🔐 الأبواب — المالك يمرّ، ورمز العميل 403 على الطابور والصحة والملفات، والمجهول 401
 *   2. 📋 الطابور — الفهرس والترشيح، وأسماء الحمولة **بلا قيم**، ونبض العامل
 *   3. ⛔️ الإلغاء — صفٌّ حقيقي (من الطابور، أو مهمّةٌ يُنتجها مسارٌ حقيقي إن كان فارغاً)
 *      يصير ميتاً بسببه، وسببٌ أقصر من المسموح 400
 *   4. ♻️ الإعادة — الميت يعود معلَّقاً بمحاولاتٍ صفر وبلا خطأ ومستحقّاً الآن، والمعلَّق لا
 *      يُعاد (422) — ثم يُغلق الأثر: الصفّ يعود ميتاً والإعلان مسودّة (لا نشرَ خلفنا)
 *   5. 🩺 صحة الخدمة — ستّة مجسّات، والقاعدة سليمة، و«غير المهيّأ» ليس عطلاً
 *   6. 🚨 لافتة الحادث — من `platform.maintenance*`، وتُرفع وتُنزَل من إعدادات المنصة
 *   7. 🗂️ مدير الملفات — عبر المستأجرين، والترشيح، والعزل، و«لم يُفحص» ≠ «لم يُفحص فعلياً»
 *   8. 🔬 ملفٌ حقيقي — يرفعه العميل فيظهر على اللوحة **بحكم الماسح من التدقيق**، ثم يُفحص
 *      الآن ويُحجر، والميتاداتا تبقى بعد الحجر
 *   9. 🧾 التدقيق والعزل — الأفعال الأربعة مقيَّدة، وملفات كل عميل لا تُنسب لغيره
 *
 * **ولا يُنشئ عملاء**: يعمل على `demo` (عميل القياس) و`platform` (منشأة المشغّلين).
 *
 * ولهذا الجزء **رفعٌ واحد صغير مقصود** — لا ينشئ سكربت التحقّق ملفاً بنفسه على القرص: يطلب
 * العميل `POST /files/presign` ثم `finalize` باسم `verify-pc9-<stamp>.txt`، فيُصبح لدينا صفٌّ
 * حقيقي من المسار الحقيقي. وهذا هو بيت القصيد: **حكم الفحص يأتي من مسار التدقيق الذي كتبه
 * `finalize`** — لا من قيمة تخترعها اللوحة. أمّا صفوف `outbox_jobs` فلا تُختلق أبداً: الأفعال
 * تعمل على صفٍّ مأخوذ من الطابور نفسه.
 *
 * Re-runnable: كل تشغيل يضيف صفّ ملفٍ واحداً صغيراً (وصفاً لا بايتات) وصفوف تدقيق،
 * ولا يحذف شيئاً (والحجر لا يمحو: يوسم `deleted` ويُبقي الميتاداتا).
 *
 * Usage: node scripts/verify-platform-operations.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
};
const demo = {
  tenantCode: process.env.VERIFY_TENANT ?? 'demo',
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

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

function section(title) {
  console.log(`\n${title}`);
}

async function raw(method, path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

async function request(method, path, body, token) {
  const response = await raw(method, path, body, token);
  if (response.status >= 400) {
    const problem = response.body ?? {};
    const error = new Error(
      `${method} ${path} → ${response.status} ${problem.code ?? ''} ${problem.detail ?? problem.message ?? ''}`,
    );
    error.status = response.status;
    error.code = problem.code;
    error.problem = problem;
    throw error;
  }
  return response.body?.data ?? response.body;
}

/** A call whose status is part of the answer — success or refusal, with the real status. */
async function attempts(method, path, body, token) {
  const response = await raw(method, path, body, token);
  const data = response.body?.data ?? response.body;
  if (response.status < 400) return { status: response.status, code: 'OK', data, problem: {} };
  const problem = response.body ?? {};
  return { status: response.status, code: problem.code ?? '', data, problem };
}

async function signIn(tenantCode, credentials) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return token;
    } catch (error) {
      if (error.status === 429 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/** الغلاف كاملاً (`{data, meta}`) — كي تُقرأ المجاميع لا الصفوف وحدها. */
const envelope = (path, token) => raw('get', path, undefined, token);

const reason = `تحقّق P-C9 ${stamp}`;

async function main() {
  const ownerToken = await signIn(platformTenant, operator);
  const demoToken = await signIn(demo.tenantCode, demo);

  // ─────────────────────────────────────────────── 1
  section('1. 🔐 الأبواب والصلاحيات');
  const me = await request('get', '/me', undefined, ownerToken);
  check('مالك المنصة يدخل', Boolean(me.user?.id), me.user?.email ?? '');
  const demoMe = await request('get', '/me', undefined, demoToken);
  const demoTenantId = demoMe.membership?.tenantId;
  check('وعميل القياس أيضًا', Boolean(demoTenantId), demoMe.membership?.tenantCode ?? '');

  const anonymous = await attempts('get', '/platform/jobs');
  check('المجهول لا يرى الطابور (401)', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const asClient = await attempts('get', '/platform/jobs', undefined, demoToken);
  check('ورمز العميل لا يفتح سطح المنصة (403)', asClient.status === 403, `HTTP ${asClient.status}`);
  const clientOnHealth = await attempts('get', '/platform/health/detailed', undefined, demoToken);
  check('ولا يقرأ مجسّات المنصة (403)', clientOnHealth.status === 403, `HTTP ${clientOnHealth.status}`);

  const asClientFiles = await attempts('get', '/platform/files', undefined, demoToken);
  check('ولا مدير ملفات المنصة (403)', asClientFiles.status === 403, `HTTP ${asClientFiles.status}`);

  // ─────────────────────────────────────────────── 2
  section('2. 📋 الطابور: الفهرس والحمولة ونبض العامل');
  const listed = await envelope('/platform/jobs?limit=200', ownerToken);
  check('يُقرأ الطابور عبر كل العملاء', listed.status === 200, `HTTP ${listed.status}`);
  const jobs = (listed.body?.data ?? []).filter(Boolean);
  const total = listed.body?.meta?.total ?? 0;
  check('ومعه العدد الكلي', Number.isInteger(total) && total >= jobs.length, `${jobs.length} من ${total}`);
  check(
    'وكل صفّ يحمل عميله وحالته ومحاولاته',
    jobs.every(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.tenantId === 'string' &&
        ['pending', 'published', 'dead'].includes(row.status) &&
        Number.isInteger(row.attempts),
    ),
    jobs.length > 0 ? `${jobs.length} صفاً` : 'لا صفوف بعد',
  );
  check(
    'والحمولة **مفاتيحها فقط** — لا قيم على اللوحة',
    jobs.every((row) => Array.isArray(row.payloadKeys) && !('payload' in row)),
  );

  const filtered = await envelope('/platform/jobs?limit=200&filter[status]=pending', ownerToken);
  const pendingRows = filtered.body?.data ?? [];
  check(
    'والترشيح بالحالة مضبوط',
    filtered.status === 200 && pendingRows.every((row) => row.status === 'pending'),
    `${pendingRows.length} معلَّقة`,
  );
  const filteredOut = await attempts('get', '/platform/jobs?filter[status]=exploded', undefined, ownerToken);
  check('والمرشِّح خارج الفهرس 400 لا صفر نتائج', filteredOut.status === 400, `HTTP ${filteredOut.status}`);
  const filteredKey = await attempts('get', '/platform/jobs?filter[subject]=x', undefined, ownerToken);
  check('والمفتاح المجهول أيضًا 400', filteredKey.status === 400, `HTTP ${filteredKey.status}`);

  const heartbeat = await request('get', '/platform/jobs/heartbeat', undefined, ownerToken);
  check(
    'ونبض العامل ثلاثة أرقام صادقة',
    typeof heartbeat.running === 'boolean' &&
      typeof heartbeat.enabled === 'boolean' &&
      (heartbeat.oldestPendingAgeSeconds === null || heartbeat.oldestPendingAgeSeconds >= 0),
    `running=${heartbeat.running} enabled=${heartbeat.enabled} oldest=${heartbeat.oldestPendingAgeSeconds ?? '—'}`,
  );

  // ─────────────────────────────────────────────── 3
  section('3. ⛔️ الإلغاء: وسمٌ بسببه لا محوٌ لصفّه');
  // **السكربت يصنع مهمّته ولا يمسّ مهامّ غيره.** المهام تُنتجها معاملات العمل لا استدعاء HTTP،
  // فالمسار الحقيقي هو جدولة إعلانٍ في المستقبل (`POST /platform/announcements` بـ`publishAt`)
  // ⇒ صفٌّ واحد `announcement.publish` بموعده — وهو ما يفعله المشغّل ليصنع مهمّة، والسكربت
  // يقرؤه من الطابور كما تقرؤه اللوحة. ولماذا **لا** نأخذ صفاً موجوداً؟ لأنّ مهامّ الطابور
  // يحرسها غيرنا: مهمّة `email.send` معلَّقة يتوقّع سكربت البريد أن تبقى معلَّقة، وإلغاؤها
  // تُفسد قياسه. الفعلُ على صفٍّ نصنعه بأنفسنا لا يكسر قياس أحد، ويُكرَّر السكربت بلا انحراف.
  const publishAt = new Date(Date.now() + 3_600_000);
  const draft = await attempts(
    'post',
    '/platform/announcements',
    {
      titleAr: `إعلان تحقّق P-C9 ${stamp}`,
      titleEn: `P-C9 verification ${stamp}`,
      bodyAr: 'إعلانٌ مجدول صنع مهمّةً حقيقية في الطابور ليُختبر عليها الفعل — ثم أُلغيت جدولته.',
      bodyEn: 'A scheduled announcement produced a real queue row for the action test.',
      channels: ['in_app'],
      publishAt: publishAt.toISOString(),
      reason: `${reason} — إنتاج مهمّة`,
    },
    ownerToken,
  );
  check('تُصنع مهمّةٌ حقيقية من مسارها (جدولة إعلان)', draft.status === 201, `HTTP ${draft.status}`);
  const scheduledAnnouncementId = draft.data?.id ?? null;
  const requeued = await envelope('/platform/jobs?limit=200', ownerToken);
  const target = (requeued.body?.data ?? []).find(
    (row) => row.type === 'announcement.publish' && new Date(row.runAt).getTime() === publishAt.getTime(),
  );
  check(
    'وتظهر في الطابور بموعدها المضبوط',
    Boolean(target) && target.status === 'pending',
    target ? `${target.status} · ${target.runAt}` : '—',
  );

  if (!target) {
    check('لا صفّ في الطابور لتُختبر عليه دورة الحياة', false, 'تعذّر إنتاج مهمّة');
  } else {
    const shortReason = await attempts(
      'post',
      `/platform/jobs/${target.id}/cancel`,
      { reason: 'لا' },
      ownerToken,
    );
    check('رفض سببٍ أقصر من المسموح (400)', shortReason.status === 400, `HTTP ${shortReason.status}`);

    const ghost = await attempts(
      'post',
      '/platform/jobs/00000000-0000-0000-0000-000000000000/retry',
      { reason },
      ownerToken,
    );
    check('ومهمّةٌ لا وجود لها 404', ghost.status === 404, `HTTP ${ghost.status}`);

    const cancelled = await attempts(
      'post',
      `/platform/jobs/${target.id}/cancel`,
      { reason: `${reason} — إلغاء` },
      ownerToken,
    );
    check('تُلغى المهمّة', cancelled.status === 201, `HTTP ${cancelled.status}`);
    const dead = cancelled.data ?? {};
    check('فتصير ميتة', dead.status === 'dead', dead.status);
    check('ووقت المعالجة يُكتب', Boolean(dead.processedAt), dead.processedAt ?? '—');
    check('والصفّ لا يُمحى: المعرّف نفسه', dead.id === target.id);
    check(
      'والسبب يُكتب في خطأ الصفّ لا في مكانٍ خفيّ',
      typeof dead.lastError === 'string' && dead.lastError.includes('إلغاء'),
      dead.lastError ?? '—',
    );

    // ─────────────────────────────────────────────── 4
    section('4. ♻️ الإعادة: من الميت إلى الطابور، ثم الرفض');
    const revived = await attempts(
      'post',
      `/platform/jobs/${target.id}/retry`,
      { reason: `${reason} — إعادة` },
      ownerToken,
    );
    check('تُعاد الميتة', revived.status === 201, `HTTP ${revived.status}`);
    const back = revived.data ?? {};
    check('فتصير معلَّقة', back.status === 'pending', back.status);
    check('بمحاولاتٍ مصفَّرة', back.attempts === 0, `${back.attempts}`);
    check('وبلا خطأ سابق', back.lastError === null, back.lastError ?? '—');
    check('ووقت المعالجة يُمحى مع الإعادة', back.processedAt === null, back.processedAt ?? '—');
    check(
      'وإعادتها تجعلها مستحقّةً الآن',
      new Date(back.runAt).getTime() >= Date.now() - 5_000,
      back.runAt ?? '—',
    );

    const again = await attempts(
      'post',
      `/platform/jobs/${target.id}/retry`,
      { reason: `${reason} — إعادة ثانية` },
      ownerToken,
    );
    check('وإعادة المعلَّقة مرفوضة (422)', again.status === 422, `HTTP ${again.status}`);

    const publishedRow = jobs.find((row) => row.status === 'published');
    if (publishedRow) {
      const refusePublished = await attempts(
        'post',
        `/platform/jobs/${publishedRow.id}/retry`,
        { reason: `${reason} — إعادة منفَّذة` },
        ownerToken,
      );
      check(
        'والمهمّة المنفَّذة لا تُمسّ (422)',
        refusePublished.status === 422,
        `HTTP ${refusePublished.status}`,
      );
    } else {
      check('لا مهام منفَّذة في الطابور الآن — تُقاس نهاية الدورة على ما هو موجود', true, 'لا منفَّذة');
    }

    // ── الإغلاق: لا يُترك صفٌّ معلَّق خلفنا. إعادةُ المحاولة جعلت المهمّة مستحقّةً **الآن**،
    // فلو تركناها معلَّقة ثم شُغّل العامل لنُفِّذت المهمّة فعلاً — والإعلان المجدول يجب أن
    // يبقى بلا نشر. فيُعاد وسمها `dead`، وتُلغى جدولة الإعلان (يعود مسودّة). وهذا هو الحال
    // الذي يوثّقه ذيل السكربت: رواسبٌ من وسمٍ لا محو.
    const reclosed = await attempts(
      'post',
      `/platform/jobs/${target.id}/cancel`,
      { reason: `${reason} — إغلاق أثر التحقّق` },
      ownerToken,
    );
    check(
      'ويُغلق الأثر: الصفّ يبقى ميتاً بعد التحقّق',
      reclosed.status === 201 && reclosed.data?.status === 'dead',
      `HTTP ${reclosed.status} · ${reclosed.data?.status}`,
    );
    if (scheduledAnnouncementId !== null) {
      const unscheduled = await attempts(
        'patch',
        `/platform/announcements/${scheduledAnnouncementId}`,
        { publishAt: null, reason: `${reason} — إلغاء الجدولة بعد التحقّق` },
        ownerToken,
      );
      check(
        'والإعلان يعود مسودّةً فلا يُنشر شيء',
        unscheduled.status === 200 && unscheduled.data?.status === 'draft',
        `HTTP ${unscheduled.status} · ${unscheduled.data?.status}`,
      );
    }
  }

  // ─────────────────────────────────────────────── 5
  section('5. 🩺 صحة الخدمة: ستّة مجسّات لا جملةٌ واحدة');
  const health = await request('get', '/platform/health/detailed', undefined, ownerToken);
  const names = (health.probes ?? []).map((probe) => probe.name).sort();
  check(
    'المجسّات الستّة حاضرة',
    JSON.stringify(names) === JSON.stringify(['database', 'email', 'queue', 'redis', 'storage', 'worker']),
    names.join(' · '),
  );
  const database = (health.probes ?? []).find((probe) => probe.name === 'database');
  check('وقاعدة البيانات سليمة', database?.status === 'up', `${database?.status} · ${database?.latencyMs}ms`);
  check('بزمن استجابة مقيس لا مُقدَّر', typeof database?.latencyMs === 'number' && database.latencyMs >= 0);
  const storage = (health.probes ?? []).find((probe) => probe.name === 'storage');
  check(
    'والتخزين غير المهيّأ يُعلن كذلك لا «متوقّفاً»',
    ['up', 'not_configured'].includes(storage?.status),
    storage?.status ?? '—',
  );
  check(
    'والنتيجة الإجمالية أسوأ حالةٍ بين المجسّات',
    ['ok', 'degraded', 'down'].includes(health.status) &&
      (health.probes ?? []).some((probe) => probe.status === 'down') === (health.status === 'down'),
    health.status,
  );

  check(
    'وعدّادات الطلبات مقيسة (عدد · 5xx · نسبة · p95)',
    health.requests?.count > 0 &&
      health.requests.errors >= 0 &&
      health.requests.errorRate >= 0 &&
      health.requests.errorRate <= 1 &&
      health.requests.p95Ms >= 0,
    `${health.requests?.count} طلباً · ${health.requests?.errors} خطأ · p95 ${health.requests?.p95Ms}ms`,
  );
  check(
    'وحجم الطابور مجمَّعٌ بالحالة',
    health.backlog &&
      health.backlog.pending + health.backlog.published + health.backlog.dead >= 0 &&
      (health.backlog.oldestPendingAgeSeconds === null || health.backlog.oldestPendingAgeSeconds >= 0),
    `معلَّق ${health.backlog?.pending} · ميت ${health.backlog?.dead}`,
  );
  check(
    'وعمر التشغيل مقيس',
    health.uptimeSeconds >= 0 && Boolean(health.startedAt),
    `${health.uptimeSeconds} ثانية`,
  );

  // ─────────────────────────────────────────────── 6
  section('6. 🚨 لافتة الحادث من الإعدادات لا من الشاشة');
  const settingsBefore = await request('get', '/platform/settings', undefined, ownerToken);
  const before = Object.fromEntries((settingsBefore.settings ?? []).map((row) => [row.key, row.value]));
  const raised = await attempts(
    'put',
    '/platform/settings',
    {
      values: {
        'platform.maintenance': true,
        'platform.maintenance_message': `صيانة تحقّق ${stamp}`,
      },
    },
    ownerToken,
  );
  check('تُرفع لافتة الحادث', raised.status === 200, `HTTP ${raised.status}`);
  try {
    const during = await request('get', '/platform/health/detailed', undefined, ownerToken);
    check('فتظهر في الصحة', during.incident?.active === true, String(during.incident?.active));
    check(
      'وبنصّها المكتوب في الإعدادات',
      typeof during.incident?.message === 'string' && during.incident.message.includes(stamp),
      during.incident?.message ?? '—',
    );
  } finally {
    const lowered = await attempts(
      'put',
      '/platform/settings',
      {
        values: {
          'platform.maintenance': before['platform.maintenance'] ?? false,
          'platform.maintenance_message': before['platform.maintenance_message'] ?? '',
        },
      },
      ownerToken,
    );
    check('وتُنزَل وتُعاد القيمة السابقة', lowered.status === 200, `HTTP ${lowered.status}`);
  }
  const afterLowering = await request('get', '/platform/health/detailed', undefined, ownerToken);
  check(
    'فلا تبقى لافتة كاذبة',
    afterLowering.incident?.active === false,
    String(afterLowering.incident?.active),
  );

  // ─────────────────────────────────────────────── 7
  section('7. 🗂️ مدير الملفات: العزل والترشيح');
  const filesPage = await envelope('/platform/files?limit=200', ownerToken);
  check('تُقرأ الملفات عبر المستأجرين', filesPage.status === 200, `HTTP ${filesPage.status}`);
  const allFiles = filesPage.body?.data ?? [];
  check(
    'وكل صفّ يحمل عميله وحالته وحجمه ورافعه',
    allFiles.every(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.tenantId === 'string' &&
        ['pending', 'ready', 'deleted'].includes(row.status) &&
        typeof row.sizeBytes === 'number',
    ),
    `${allFiles.length} ملفاً · الإجمالي ${filesPage.body?.meta?.total ?? 0}`,
  );
  check(
    'وحكم الفحص إما كائنٌ معلَن أو `null` — لا تخمين',
    allFiles.every(
      (row) =>
        row.scan === null ||
        (['clean', 'infected', 'skipped'].includes(row.scan.verdict) && typeof row.scan.scanner === 'string'),
    ),
    `${allFiles.filter((row) => row.scan).length} مفروز من ${allFiles.length}`,
  );
  const badScan = await attempts('get', '/platform/files?filter[scan]=maybe', undefined, ownerToken);
  check('ومرشِّح فحصٍ خارج الفهرس 400', badScan.status === 400, `HTTP ${badScan.status}`);
  const scannedFilter = await envelope('/platform/files?limit=200&filter[scan]=skipped', ownerToken);
  check(
    'والترشيح بحكم الفحص مضبوط',
    scannedFilter.status === 200 &&
      (scannedFilter.body?.data ?? []).every((row) => row.scan?.verdict === 'skipped'),
    `${(scannedFilter.body?.data ?? []).length} مفروز`,
  );
  const demoTenantOnly = await envelope(
    `/platform/files?limit=200&filter[tenantId]=${demoTenantId}`,
    ownerToken,
  );
  check(
    'وعزل العميل محترم: كل صفّ يحمل عميل المرشّح',
    (demoTenantOnly.body?.data ?? []).every((row) => row.tenantId === demoTenantId),
    `${(demoTenantOnly.body?.data ?? []).length} ملفاً للعميل`,
  );

  // ─────────────────────────────────────────────── 8
  section('8. 🔬 ملفٌ حقيقي من العميل: حكمه يأتي من التدقيق');
  // «لم يُفحص» ≠ «لم يُفحص فعلياً»: الأول صفٌّ أنشأه `presign` ولم يمرّ على الماسح بعد (لا سطر
  // تدقيق)، والثاني مرّ على `finalize` فقال الماسح المُهيّأ إنه لا يفحص. والفرق لا يُدَّعى:
  // يُصنع هنا بالترتيب — presign ثم قراءة، ثم finalize ثم قراءة.
  const fileName = `verify-pc9-${stamp}.txt`;
  const presigned = await attempts(
    'post',
    '/files/presign',
    { name: fileName, mime: 'text/plain', sizeBytes: 42 },
    demoToken,
  );
  check('العميل يحجز ملفاً عبر واجهته', presigned.status === 201, `HTTP ${presigned.status}`);
  const fileId = presigned.data?.fileId;
  check('ويعود المعرّف ونقطة الرفع', typeof fileId === 'string' && Boolean(presigned.data?.uploadUrl));

  const beforeFinalize = await envelope(
    `/platform/files?limit=200&q=${encodeURIComponent(fileName)}`,
    ownerToken,
  );
  const pendingFile = (beforeFinalize.body?.data ?? []).find((row) => row.id === fileId);
  check('فيظهر على اللوحة قبل الرفع', Boolean(pendingFile), `HTTP ${beforeFinalize.status}`);
  check('بحالة «بانتظار الرفع»', pendingFile?.status === 'pending', pendingFile?.status ?? '—');
  check('و**بلا حكم فحص** — لا سطر تدقيق بعد', pendingFile?.scan === null);
  const noneFilter = await envelope('/platform/files?limit=200&filter[scan]=none', ownerToken);
  check(
    'ومرشّح «لم يُفحص» يعمّم ذلك على كل الصفوف',
    noneFilter.status === 200 && (noneFilter.body?.data ?? []).every((row) => row.scan === null),
    `${(noneFilter.body?.data ?? []).length} بلا فحص`,
  );

  const finalized = await attempts(
    'post',
    `/files/${fileId}/finalize`,
    { checksum: 'deadbeefdeadbeef' },
    demoToken,
  );
  check('ثم يُنهي العميل الرفع', finalized.status === 201, `HTTP ${finalized.status}`);
  const afterFinalize = await envelope(
    `/platform/files?limit=200&q=${encodeURIComponent(fileName)}`,
    ownerToken,
  );
  const readyFile = (afterFinalize.body?.data ?? []).find((row) => row.id === fileId);
  check('فيصير جاهزاً على اللوحة', readyFile?.status === 'ready', readyFile?.status ?? '—');
  check(
    'و**حكم الماسح يظهر فوراً** — لأنه كُتب في مسار التدقيق',
    ['clean', 'infected', 'skipped'].includes(readyFile?.scan?.verdict) && Boolean(readyFile?.scan?.scanner),
    `${readyFile?.scan?.verdict} · ${readyFile?.scan?.scanner}`,
  );

  const scanned = await attempts('post', `/platform/files/${fileId}/scan`, {}, ownerToken);
  check('ويُشغَّل الفحص الآن من اللوحة', scanned.status === 201, `HTTP ${scanned.status}`);
  check(
    'والحكم يُعاد كما خرج من الماسح',
    ['clean', 'infected', 'skipped'].includes(scanned.data?.verdict) && Boolean(scanned.data?.scanner),
    `${scanned.data?.verdict} · ${scanned.data?.scanner}`,
  );
  check('وبوقت الفحص', Boolean(scanned.data?.scannedAt), scanned.data?.scannedAt ?? '—');

  const ghostScan = await attempts(
    'post',
    '/platform/files/00000000-0000-0000-0000-000000000000/scan',
    {},
    ownerToken,
  );
  check('وملفٌّ لا وجود له 404', ghostScan.status === 404, `HTTP ${ghostScan.status}`);

  const shortFileReason = await attempts('delete', `/platform/files/${fileId}`, { reason: 'لا' }, ownerToken);
  check(
    'ورفض سبب حجرٍ أقصر من المسموح (400)',
    shortFileReason.status === 400,
    `HTTP ${shortFileReason.status}`,
  );

  const quarantined = await attempts(
    'delete',
    `/platform/files/${fileId}`,
    { reason: `${reason} — حجر` },
    ownerToken,
  );
  check('ويُحجر الملف', quarantined.status === 200, `HTTP ${quarantined.status}`);
  check('فيوسم محجوراً', quarantined.data?.status === 'deleted', quarantined.data?.status);
  check('ووقت الحجر يُكتب', Boolean(quarantined.data?.deletedAt), quarantined.data?.deletedAt ?? '—');

  const second = await attempts(
    'delete',
    `/platform/files/${fileId}`,
    { reason: `${reason} — ثانية` },
    ownerToken,
  );
  check('وحجرٌ ثانٍ مرفوض (422)', second.status === 422, `HTTP ${second.status}`);

  const afterQuarantine = await envelope(
    `/platform/files?limit=200&q=${encodeURIComponent(fileName)}`,
    ownerToken,
  );
  const stillThere = (afterQuarantine.body?.data ?? []).find((row) => row.id === fileId);
  check(
    'والميتاداتا باقية بعد الحجر — الصفّ لا يُمحى',
    Boolean(stillThere) && stillThere.status === 'deleted' && stillThere.name === fileName,
    stillThere ? `${stillThere.name} · ${stillThere.status}` : 'الصفّ اختفى!',
  );
  const clientStillSees = await attempts('get', `/files/${fileId}`, undefined, demoToken);
  check(
    'ووصول العميل إلى الملف المحجور مقطوع',
    [403, 404, 409, 410, 422].includes(clientStillSees.status),
    `HTTP ${clientStillSees.status}`,
  );

  // ─────────────────────────────────────────────── 9
  section('9. 🧾 التدقيق والعزل');
  const auditPage = await envelope(
    `/platform/audit?limit=200&filter[action]=${encodeURIComponent('platform.job.retry')}`,
    ownerToken,
  );
  const jobRetries = auditPage.body?.data?.items ?? [];
  check(
    'إعادة المحاولة مسجَّلة في التدقيق',
    auditPage.status === 200 && jobRetries.some((row) => row.entity === 'outbox_jobs'),
    `${jobRetries.length} صفّاً`,
  );
  const cancellationAudit = await envelope(
    `/platform/audit?limit=200&filter[action]=${encodeURIComponent('platform.job.cancel')}`,
    ownerToken,
  );
  check(
    'والإلغاء كذلك',
    (cancellationAudit.body?.data?.items ?? []).some((row) => row.entity === 'outbox_jobs'),
    `${(cancellationAudit.body?.data?.items ?? []).length} صفّاً`,
  );
  const scanAudit = await envelope(
    `/platform/audit?limit=200&filter[action]=${encodeURIComponent('platform.file.scan')}`,
    ownerToken,
  );
  check(
    'وفحص الملفات كذلك',
    (scanAudit.body?.data?.items ?? []).some((row) => row.entity === 'files'),
    `${(scanAudit.body?.data?.items ?? []).length} صفّاً`,
  );

  // منشأة المشغّلين لا تحمل ملفات عملاء — القياس نفسه الذي تقيسه بقية أسطح المنصة.
  const platformTenantId = (await request('get', '/platform/tenants?limit=100', undefined, ownerToken)).find(
    (row) => row.code === platformTenant,
  )?.id;
  const operatorFiles = await envelope(
    `/platform/files?limit=200&filter[tenantId]=${platformTenantId}`,
    ownerToken,
  );
  check(
    'وملفات منشأة المشغّلين لا تحمل ملفات العميل',
    (operatorFiles.body?.data ?? []).every((row) => row.tenantId !== demoTenantId),
    `${(operatorFiles.body?.data ?? []).length} ملفاً للمشغّلين`,
  );

  console.log('\n──────────────────────────────────────────────');
  console.log(`النتيجة: ${checks - failures}/${checks} نقطة ناجحة (${failures} فشلاً)`);
  console.log('رواسب مقصودة: صفوف `audit_log` (لا تُمحى أصلاً) وحالة الملف المحجور');
  console.log('(`deleted` بالميتاداتا — الحجر لا يمحو)، وإعلانٌ مسودّة + مهمّةٌ واحدة `dead`');
  console.log('صنعهما السكربت نفسه ليقيس عليهما الفعل (ولا يمسّ مهامّ غيره) — والوسم لا المحو.');
  console.log(`(عميل القياس: ${demo.tenantCode} · منشأة المشغّلين: ${platformTenant})`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\n✗ توقّف التحقّق:', error?.message ?? error);
  if (error?.problem) console.error(JSON.stringify(error.problem));
  process.exit(1);
});
