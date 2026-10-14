#!/usr/bin/env node
/**
 * Live verification of P-C5 «الاستخدام والحصص» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4)
 * against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed`
 * + `pnpm dev`).
 *
 * It drives the real HTTP API the three surfaces drive — nothing is mocked:
 *
 *   1. 🔐 الجلسة والأبواب — رمز المنصّة، ورمز العميل، والمجهول
 *   2. 🏢 العميل المقيس — لقطةٌ من ثمانية مقاييس لعميلٍ حقيقي (`demo`)
 *   3. 🔁 محرّك واحد — بطاقة العميل واللقطة والشاشة تقول الرقم نفسه
 *   4. 📊 الشبكة — كل العملاء، وترتيب «الأسوأ أولاً»، ومجاميع تُطابق صفوفها
 *   5. 🙋 سطح المستأجر — `GET /usage` بجلسة العميل: أرقامه وحدها
 *   6. 🔢 العدّاد يزيد — طلبات حقيقية تزيد `api_calls_per_day` بمقدارها
 *   7. 🚧 الحدّ الناعم — ٨٠٪: رايةٌ وإشعارٌ وسطر تدقيق واحد للفترة
 *   8. ⛔ الحدّ الصلب — ١٠٠٪: رفضٌ برمز `USAGE_LIMIT_REACHED` قبل أي كتابة
 *   9. 🧱 حارس الكتابة — فرعٌ يُرفض عند الحدّ ثم يمرّ بعد رفعه
 *  10. 🧾 التصدير والأبواب — CSV بـBOM، ودور العمليات يقرأ ولا يصدّر
 *  11. 🧹 التنظيف — الحدود المؤقّقة تُرفع، والحالة تعود
 *
 * Re-runnable: every limit it writes is a **temporary tenant override** that §11 clears,
 * and the branch it creates is deleted. Three residues are stated rather than hidden:
 *
 *   · **العدّاد اليومي يبقى مرتفعاً** — لأن الطلبات وقعت فعلاً؛ تصفيره يعني الكذب على
 *     العميل الذي سنحاسبه عليه.
 *   · **سطرا تدقيق يبقيان** (`usage.soft_limit` · `usage.limit_reached`) — سجلّ التدقيق
 *     لا يُمحى، وهو الدليل على أن الرفض لم يقع صامتاً.
 *   · **حدود المنصّة العامة** (إن وُجدت من تشغيلٍ سابق) لا تُلمس: المشغّل كتبها، والجزء
 *     يبدأ التطبيق عندها — وهذا مقصود، ويُطبع أيّها فعّال في §2.
 *
 * Usage: node scripts/verify-platform-usage.mjs
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
const fixtureCode = process.env.VERIFY_PC5_FIXTURE ?? process.env.VERIFY_PC4_TENANT ?? 'verify-pc4';

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

/** A raw response — the CSV is not JSON, and the problem body matters as much as the status. */
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
    error.detail = problem.detail ?? problem.message;
    error.problem = problem;
    throw error;
  }
  return response.body?.data ?? response.body;
}

/** A call that is *expected* to be refused: its status, code and detail are the answer. */
async function attempts(method, path, body, token) {
  try {
    const ok = await request(method, path, body, token);
    return { status: 200, code: 'OK', detail: '', data: ok };
  } catch (error) {
    return {
      status: error.status ?? 0,
      code: error.code ?? '',
      detail: error.detail ?? '',
      problem: error.problem ?? {},
    };
  }
}

async function signIn(tenantCode, credentials) {
  // The platform throttles /auth/login per address; a 429 is not a failed check.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return { token, user: login.user };
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const ownerSession = await signIn(platformTenant, operator);
const ownerToken = ownerSession.token;
console.log(`✔ logged in to ${platformTenant} as ${operator.email}\n`);

const get = (path, token = ownerToken) => request('get', path, undefined, token);
const post = (path, body, token = ownerToken) => request('post', path, body, token);
const put = (path, body, token = ownerToken) => request('put', path, body, token);
const del = (path, token = ownerToken) => request('delete', path, undefined, token);

const usageOf = (token) => get('/usage', token);
const snapshotOf = (tenantId, token = ownerToken) => get(`/platform/usage?tenantId=${tenantId}`, token);
const limitOf = (tenantId, metric) => snapshotOf(tenantId).then((s) => s.metrics.find((m) => m.key === metric));
const setLimit = (tenantId, key, value) =>
  put(`/platform/tenants/${tenantId}/settings/${key}`, { value }, ownerToken);

const METRIC_KEYS = [
  'users',
  'branches',
  'items',
  'invoices_per_month',
  'storage_mb',
  'api_calls_per_day',
  'whatsapp_per_month',
  'email_sends_per_month',
];
const STATE_RANK = { unlimited: 0, ok: 1, soft: 2, hard: 3 };

// ═══════════════════════════════════════════════ 1. 🔐 الجلسة والأبواب
console.log('■ 1. 🔐 الجلسة والأبواب — من يقرأ الحصص');
const demoSession = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const demoToken = demoSession.token;
check('جلسة العميل لا تدخل شبكة المنصّة', (await attempts('get', '/platform/usage', undefined, demoToken)).status === 403);
check(
  'ولا تصدّر بيان المنصّة',
  (await attempts('get', '/platform/usage/export.csv', undefined, demoToken)).status === 403,
);
check('وبلا جلسة: 401', (await attempts('get', '/platform/usage', undefined, '')).status === 401);
check('وطلبات المستأجر بلا جلسة: 401', (await attempts('get', '/usage', undefined, '')).status === 401);

// ═══════════════════════════════════════════ 2. 🏢 العميل المقيس
console.log('\n■ 2. 🏢 العميل المقيس — لقطةٌ من ثمانية مقاييس');
const tenants = await get(`/platform/tenants?search=${demo.tenantCode}`);
const demoRow = tenants.find((tenant) => tenant.code === demo.tenantCode);
check('عميل القياس موجود', Boolean(demoRow?.id), demoRow?.id ?? '—');
const tenantId = demoRow.id;

const snapshot = await snapshotOf(tenantId);
check('اللقطة تُقرأ', snapshot.tenantCode === demo.tenantCode && snapshot.tenantId === tenantId);
check('والفهرس ثمانية', snapshot.metrics.length === 8, `${snapshot.metrics.length} مقياساً`);
check('وبترتيبه المعلن', snapshot.metrics.map((m) => m.key).join(',') === METRIC_KEYS.join(','));
check(
  'وكل مقياس باسمه ووحدته وأين يقع الرفض',
  snapshot.metrics.every((m) => m.labelAr.length > 0 && m.unitAr.length > 0 && m.enforcedAtAr.length > 0),
);
check(
  'والحالة من العقد',
  snapshot.metrics.every((m) => ['ok', 'soft', 'hard', 'unlimited'].includes(m.state)),
);
check('والفترة شهرٌ حالٍ', /^\d{4}-\d{2}$/.test(snapshot.period) && snapshot.periodStart < snapshot.periodEnd);
check('وسلسلة الاستدعاءات ثلاثون يوماً', snapshot.apiCallsPerDay.length === 30);
check(
  'وتنتهي اليوم',
  snapshot.apiCallsPerDay.at(-1).day === new Date().toISOString().slice(0, 10),
  snapshot.apiCallsPerDay.at(-1).day,
);
const enforcedKeys = snapshot.metrics.filter((m) => m.enforced).map((m) => m.key);
const reportedKeys = snapshot.metrics.filter((m) => !m.enforced).map((m) => m.key);
console.log(`  · يُطبَّق الآن: ${enforcedKeys.join(' · ') || 'لا شيء'}`);
console.log(`  · يُبلَّغ عنه فقط: ${reportedKeys.join(' · ') || 'لا شيء'}`);
check(
  'والمغلّف الافتراضي لا يمنع (قرار معلَن)',
  snapshot.metrics
    .filter((m) => m.limitSource === 'default')
    .every((m) => m.enforced === false),
);
check(
  'والحدّ المكتوب يُطبَّق',
  snapshot.metrics
    .filter((m) => m.limitSource !== 'default' && m.limit !== null)
    .every((m) => m.enforced === true),
);
check(
  'والنسبة تُحسب أو تُترك فراغاً',
  snapshot.metrics.every((m) => (m.limit === null ? m.percentUsed === null : m.percentUsed >= 0)),
);

// ═══════════════════════════════════════════ 3. 🔁 محرّك واحد
console.log('\n■ 3. 🔁 محرّك واحد — البطاقة والشاشة تقولان الرقم نفسه');
const card = await get(`/platform/tenants/${tenantId}/usage`);
check('بطاقة العميل تُقرأ', card.metrics.length === 8, `${card.metrics.length} مقياساً`);
check(
  'وبنفس مفاتيح اللقطة',
  card.metrics.map((m) => m.key).join(',') === snapshot.metrics.map((m) => m.key).join(','),
);
check(
  'وبنفس الأرقام والحدود',
  card.metrics.every((metric) => {
    const own = snapshot.metrics.find((m) => m.key === metric.key);
    return own && own.used === metric.used && own.limit === metric.limit && own.limitSource === metric.limitSource;
  }),
);
check(
  'وبحالة وأين-يقع-الرفض كذلك',
  card.metrics.every((metric) => {
    const own = snapshot.metrics.find((m) => m.key === metric.key);
    return own && own.state === metric.state && own.enforced === metric.enforced;
  }),
);
check('ورسم الفواتير يبقى على البطاقة', card.invoicesPerDay.length === 30);

// ═══════════════════════════════════════════════ 4. 📊 الشبكة
console.log('\n■ 4. 📊 الشبكة — كل العملاء، والأسوأ أولاً');
const grid = await get('/platform/usage');
check('الشبكة تُقرأ', Array.isArray(grid.tenants) && grid.tenants.length >= 2, `${grid.tenants.length} عميلاً`);
check('وفيها عميل القياس', grid.tenants.some((row) => row.tenantId === tenantId));
check('وكل صفٍّ ثمانية مقاييس', grid.tenants.every((row) => row.metrics.length === 8));
check('وكل صفٍّ يحمل أسوأ حالاته', grid.tenants.every((row) => STATE_RANK[row.worst] >= Math.max(...row.metrics.map((m) => STATE_RANK[m.state]))));
check('ومجموع العملاء يُطابق الصفوف', grid.totals.tenants === grid.tenants.length);
check(
  'ومجموع الناعم والصلب يُطابق الصفوف',
  grid.totals.soft === grid.tenants.reduce((acc, row) => acc + row.softCount, 0) &&
    grid.totals.hard === grid.tenants.reduce((acc, row) => acc + row.hardCount, 0),
  `soft ${grid.totals.soft} · hard ${grid.totals.hard}`,
);
check(
  'ومجموع استدعاءات اليوم مجموعُ الصفوف',
  grid.totals.apiCallsToday ===
    grid.tenants.reduce((acc, row) => acc + row.metrics.find((m) => m.key === 'api_calls_per_day').used, 0),
  String(grid.totals.apiCallsToday),
);
check(
  'والترتيب: لا صفٌّ أسوأ يسبقه صفٌّ أخفّ',
  grid.tenants.every((row, index) => index === 0 || STATE_RANK[grid.tenants[index - 1].worst] >= STATE_RANK[row.worst]),
);
check('والفترة في الشبكة هي فترة اللقطة', grid.period === snapshot.period);

// ═══════════════════════════════════════════════ 5. 🙋 سطح المستأجر
console.log('\n■ 5. 🙋 سطح المستأجر — أرقامه وحدها');
const own = await usageOf(demoToken);
// اللقطة تُعاد قراءتها **بعد** قراءة العميل: كل طلبٍ من سطح المستأجر يزيد العدّاد، فالقراءة
// الآنيّة قبله كانت ستُقارن رقماً قبل الزيادة برقمٍ بعدها. (والمنصّة لا تُحتسب.)
const mirror = await snapshotOf(tenantId);
check('العميل يقرأ استخدامه', own.tenantCode === demo.tenantCode && own.tenantId === tenantId);
check('وبنفس الثمانية', own.metrics.length === 8);
check(
  'وبنفس أرقام المنصّة له',
  own.metrics.every((metric) => {
    const platform = mirror.metrics.find((m) => m.key === metric.key);
    return platform && platform.used === metric.used && platform.limit === metric.limit;
  }),
);
check('ورسم الاستدعاءات ثلاثون نقطة', own.apiCallsPerDay.length === 30);
check(
  'ولا منشأة أخرى في الردّ',
  JSON.stringify(own).includes(tenantId) && !JSON.stringify(own).includes(fixtureCode),
);

// ═══════════════════════════════════════════════ 6. 🔢 العدّاد يزيد
console.log('\n■ 6. 🔢 العدّاد يزيد — القياس واقع لا لقطة ثابتة');
const beforeCalls = (await limitOf(tenantId, 'api_calls_per_day')).used;
for (let index = 0; index < 3; index += 1) await get('/me', demoToken);
const afterCalls = (await limitOf(tenantId, 'api_calls_per_day')).used;
check('ثلاثة طلبات = ثلاث استدعاءات', afterCalls === beforeCalls + 3, `${beforeCalls} → ${afterCalls}`);
check(
  'وآخر نقطة في السلسلة هي العدّاد',
  (await snapshotOf(tenantId)).apiCallsPerDay.at(-1).count === afterCalls,
);
const afterGrid = await get('/platform/usage');
check(
  'وطلبات المنصّة لا تُحتسب على عميل',
  afterGrid.totals.apiCallsToday ===
    afterGrid.tenants.reduce((acc, row) => acc + row.metrics.find((m) => m.key === 'api_calls_per_day').used, 0) &&
    afterGrid.tenants.find((row) => row.tenantId === tenantId).metrics.find((m) => m.key === 'api_calls_per_day').used ===
      afterCalls,
  `استدعاءات العميل ${afterCalls}`,
);

// ═══════════════════════════════════════════ 7. 🚧 الحدّ الناعم
console.log('\n■ 7. 🚧 الحدّ الناعم — ٨٠٪: رايةٌ وإشعار');
const softLimit = afterCalls + 6;
check(
  'حدٌّ مؤقّت يُكتب للعميل',
  (await setLimit(tenantId, 'limits.max_api_calls_per_day', softLimit)).settings.find(
    (setting) => setting.key === 'limits.max_api_calls_per_day',
  )?.source === 'tenant',
  String(softLimit),
);
for (let index = 0; index < 5; index += 1) await get('/me', demoToken);
const soft = await limitOf(tenantId, 'api_calls_per_day');
check('الحدّ صار مُطبَّقاً ومصدره العميل', soft.enforced === true && soft.limitSource === 'tenant');
check('والحالة «ناعم» عند ٨٠٪ فأكثر', soft.state === 'soft', `${soft.percentUsed}٪`);
check('والإشعار نصٌّ عربي من العقد', typeof soft.noticeAr === 'string' && soft.noticeAr.length > 0);
check('والنسبة ≥ ٨٠', soft.percentUsed >= 80, `${soft.percentUsed}٪`);
const softAudit = await get(
  `/platform/audit?limit=5&filter[tenantId]=${tenantId}&filter[action]=usage.soft_limit`,
);
check('وسطر تدقيق واحد للفترة', softAudit.total >= 1, `${softAudit.total} سطر`);
check(
  'وفيه المقياس والنسبة',
  softAudit.items.some(
    (item) => (item.after ?? {}).metric === 'api_calls_per_day' && (item.after ?? {}).percent >= 80,
  ),
);

// ═══════════════════════════════════════════ 8. ⛔ الحدّ الصلب
console.log('\n■ 8. ⛔ الحدّ الصلب — ١٠٠٪: رفضٌ صريح');
await get('/me', demoToken); // value == limit: مسموح، والحالة تصير صلبة
const atLimit = await limitOf(tenantId, 'api_calls_per_day');
check('بلغ الحدّ والحالة صلبة', atLimit.state === 'hard' && atLimit.used === softLimit, `${atLimit.used} من ${atLimit.limit}`);
const refusedCall = await attempts('get', '/me', undefined, demoToken);
check('والطلب التالي يُرفض', refusedCall.status === 409, String(refusedCall.status));
check('برمز صريح', refusedCall.code === 'USAGE_LIMIT_REACHED');
check('وبمقياسٍ معلَن', (refusedCall.problem.errors ?? [])[0]?.metric === 'api_calls_per_day');
check('ورسالة عربية تُسمّي الحدّ', refusedCall.detail.includes('استدعاءات'), refusedCall.detail);
const hardAudit = await get(
  `/platform/audit?limit=5&filter[tenantId]=${tenantId}&filter[action]=usage.limit_reached`,
);
check('والرفض مُبلَّغ عنه في التدقيق', hardAudit.total >= 1, `${hardAudit.total} سطر`);
check(
  'ولم يتضاعف السطر مع كل محاولة',
  hardAudit.items.filter((item) => (item.meta ?? {}).metric === 'api_calls_per_day').length === 1,
);
await attempts('get', '/me', undefined, demoToken); // محاولة ثانية: تُرفض بلا سطرٍ جديد
const hardAuditAgain = await get(
  `/platform/audit?limit=5&filter[tenantId]=${tenantId}&filter[action]=usage.limit_reached`,
);
check('والسطر يبقى واحداً', hardAuditAgain.total === hardAudit.total, `${hardAuditAgain.total} سطر`);
check('والحدّ المؤقّت يُرفع', (await setLimit(tenantId, 'limits.max_api_calls_per_day', null)).tenantId === tenantId);
check('والعميل يقرأ من جديد', (await attempts('get', '/me', undefined, demoToken)).status === 200);

// ═══════════════════════════════════════════ 9. 🧱 حارس الكتابة
console.log('\n■ 9. 🧱 حارس الكتابة — فرعٌ يُرفض ثم يمرّ');
const branchesBefore = (await limitOf(tenantId, 'branches')).used;
check(
  'حدّ الفروع يُضبط على المستهلك الحالي',
  (await setLimit(tenantId, 'limits.max_branches', branchesBefore)).tenantId === tenantId,
  `${branchesBefore} فرعاً`,
);
const blockedBranch = await attempts(
  'post',
  '/branches',
  { code: `P-C5-${Date.now().toString().slice(-5)}`, nameAr: 'فرع اختبار الحصص' },
  demoToken,
);
check('الإنشاء يُرفض عند الحدّ', blockedBranch.status === 409, String(blockedBranch.status));
check('برمز الحصص نفسه', blockedBranch.code === 'USAGE_LIMIT_REACHED');
check('وبمقياس الفروع', (blockedBranch.problem.errors ?? [])[0]?.metric === 'branches');
const branchAudit = await get(
  `/platform/audit?limit=5&filter[tenantId]=${tenantId}&filter[action]=usage.limit_reached`,
);
check(
  'والرفض مُبلَّغ عنه بمقياس الفروع',
  branchAudit.items.some((item) => (item.meta ?? {}).metric === 'branches'),
);
check('ورفعُ الحدّ يفتح الباب', (await setLimit(tenantId, 'limits.max_branches', branchesBefore + 1)).tenantId === tenantId);
const createdBranch = await post(
  '/branches',
  { code: `P-C5-${Date.now().toString().slice(-5)}`, nameAr: 'فرع اختبار الحصص' },
  demoToken,
);
check('والفرع يُنشأ بعد الرفع', Boolean(createdBranch.id), createdBranch.code);
const branchesAfter = (await limitOf(tenantId, 'branches')).used;
check('والعدّاد يزيد واحداً', branchesAfter === branchesBefore + 1, `${branchesBefore} → ${branchesAfter}`);
check('والمقياس مصدره العميل الآن', (await limitOf(tenantId, 'branches')).limitSource === 'tenant');
await del(`/branches/${createdBranch.id}`, demoToken);
check('والفرع يُحذف', (await limitOf(tenantId, 'branches')).used === branchesBefore);
check(
  'وتُرفع التجاوزات المؤقّتة',
  (await setLimit(tenantId, 'limits.max_branches', null)).tenantId === tenantId,
);

// ═══════════════════════════════════════════ 10. 🧾 التصدير والأبواب
console.log('\n■ 10. 🧾 التصدير والأبواب — بيانٌ يخرج كما يظهر');
const csv = await raw('get', '/platform/usage/export.csv', undefined, ownerToken);
check('الملف يُنزَّل', csv.status === 200, String(csv.status));
check('بنوعه الصحيح', String(csv.headers.get('content-type')).includes('text/csv'));
// `response.text()` يُسقِط BOM في فكّ الترميز، فالفحص على البايتات لا على النصّ.
const csvBytes = new Uint8Array(
  await (await fetch(`${base}/platform/usage/export.csv`, { headers: { authorization: `Bearer ${ownerToken}` } })).arrayBuffer(),
);
check(
  'ومترمّز BOM ليقرأه إكسل',
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  [csvBytes[0], csvBytes[1], csvBytes[2]].map((byte) => byte.toString(16)).join(' '),
);
const lines = csv.text.replace(/^\uFEFF/, '').trim().split('\r\n');
check('وعدد السطور = العملاء × ٨ + رأس', lines.length === 1 + grid.tenants.length * 8, `${lines.length} سطراً`);
check(
  'والرأس أحد عشر عموداً',
  lines[0] === 'period,tenantCode,tenantName,metric,labelAr,used,limit,limitSource,percentUsed,state,enforced',
  lines[0],
);
check('وفيه عميل القياس', lines.some((line) => line.includes(demo.tenantCode)));
check('وأسماء المقاييس بالعربية', lines.some((line) => line.includes('استدعاءات الـAPI')));
check(
  'وسطرٌ لكل مقياسٍ من الثمانية',
  METRIC_KEYS.every((key) => lines.some((line) => line.split(',')[3] === key)),
);

// دور العمليات مؤقّتاً: يقرأ الحصص ولا يصدّرها (console.billing.manage للمال وحده).
const demoUser = (await get(`/platform/tenants/${tenantId}`)).members.find((member) => member.isOwner);
const granted = await post(
  `/platform/users/${demoUser.userId}/roles`,
  { roleCode: 'platform_support', reason: 'تحقّق P-C5: بوابة التصدير' },
  ownerToken,
);
check('دور الدعم يُمنح مؤقّتاً', granted.roleCode === 'platform_support', granted.roleCode);
const supportSession = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const supportToken = supportSession.token;
check('الدعم يقرأ الشبكة', (await attempts('get', '/platform/usage', undefined, supportToken)).status === 200);
const supportExport = await attempts('get', '/platform/usage/export.csv', undefined, supportToken);
check('ولا يصدّر البيان المالي', supportExport.status === 403, String(supportExport.status));
check('والسبب مُعلَن', supportExport.detail === 'platform permission console.billing.manage required', supportExport.detail);
const revoked = await del(`/platform/users/${demoUser.userId}/roles/platform_support`, ownerToken);
check('والدور يُسحب', Boolean(revoked.revokedAt), String(revoked.roleCode ?? ''));

// ═══════════════════════════════════════════════ 11. 🧹 التنظيف
console.log('\n■ 11. 🧹 التنظيف — الحالة كما كانت');
const finalSnapshot = await snapshotOf(tenantId);
const finalCalls = finalSnapshot.metrics.find((m) => m.key === 'api_calls_per_day');
const finalBranches = finalSnapshot.metrics.find((m) => m.key === 'branches');
check('حدّ الاستدعاءات عاد إلى ما قبل الجلسة', finalCalls.limitSource !== 'tenant', finalCalls.limitSource);
check('وحدّ الفروع عاد إلى ما قبل الجلسة', finalBranches.limitSource !== 'tenant', finalBranches.limitSource);
check('وعدد الفروع كما كان', finalBranches.used === branchesBefore, String(finalBranches.used));
check('والعدّاد اليومي محفوظ (طلبات وقعت فعلاً)', finalCalls.used >= softLimit, String(finalCalls.used));
check('وسطح العميل ما زال يعمل', (await attempts('get', '/usage', undefined, demoToken)).status === 200);
check('والشبكة ما زالت 200', (await attempts('get', '/platform/usage', undefined, ownerToken)).status === 200);

console.log(`\nنقاط التحقّق: ${checks} · نجحت: ${checks - failures} · فشلت: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
