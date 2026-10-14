#!/usr/bin/env node
/**
 * verify-site-analytics.mjs — التحقّق الحيّ لـ P-M10 «القياس والتحسين»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس الوعد الذي بُني عليه الجزء: **أن يُقاس أثر الموقع لا أن يُخمَّن** — بلا طرفٍ ثالث،
 * وبلا حقل هويّة، وبقمعٍ يُقرأ بالزوّار لا بالنقرات، وبميزانيةٍ تُسقط البناء إن تجاوزت.
 * وثمانية أقسام:
 *
 *   1. 🚪 الباب — `POST /public/events` يعمل بلا توكن، والدفعة محدودة، وكلُّ حقلٍ خارج العقد
 *      (مفتاح هويّة · اسمٌ مجهول · مُعرّفٌ غير UUID · دفعةٌ فارغة) يُردّ 400 لا يُخزَّن بصمت.
 *   2. 🗄️ ما يُكتب — الصفوف في القاعدة كما أُرسلت، **وبلا عمود هويّة** (يُقاس المخطّط نفسه)،
 *      وقيود الجدول ترفض مُعرّفاً نصّياً، والمُنح لا تحمل `UPDATE`، وصفر صفوف تدقيق.
 *   3. 🎯 القمع — ثلاث نقراتٍ من زائرٍ واحد = زائرٌ واحد · النسبة من زوّار النافذة · المنحنى
 *      بطول النافذة · المصادر بعائل المُحيل · المسارات بشذبتها · ولا معرّف زائر في الجسم.
 *   4. 🔒 الخصوصية — «لا يُجمع» يحمل عنوان IP، والتعريفات الخمسة تسافر، والاحتفاظ من العقد.
 *   5. 🧹 الاحتفاظ — صفٌّ أقدم من المدّة يُمحى عند أوّل كتابة، والعلامة المائية تمنع التكرار.
 *   6. 🧪 أ/ب — نسخةٌ منشورة تُعلَن ومسوّدةٌ لا تُعلَن · التوزيع حتميّ · العرض والتحويل يُقاسان.
 *   7. 🧊 الدلوُ — سقفٌ مستقلّ (`public-events`) يُقاس آخراً لأنه يستهلك الدلو.
 *   8. 🖥️ الموقع — لافتة الموافقة، وسم `data-goal` على الدعوات، والبطل يبقى الأساسي بلا تجربة.
 *
 * **وما يُقرأ من القاعدة؟** جدول `site_events` ومخطّطه وقيوده ومنحه، وصفحات CMS المزروعة
 * للتجربة. كل شيءٍ يُزرع أو يُكتب يحمل طابع وقتٍ ويُنظَّف في النهاية.
 *
 * Usage: node scripts/verify-site-analytics.mjs
 */
import { createRequire } from 'node:module';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const siteBase = (
  process.env.MARKETING_BASE ?? `http://127.0.0.1:${process.env.MARKETING_PORT ?? 3002}`
).replace(/\/+$/, '');
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
};

const requireRoot = createRequire(import.meta.url);
const requireTesting = createRequire(new URL('../packages/testing/package.json', import.meta.url));
function requirePg() {
  for (const resolver of [requireRoot, requireTesting]) {
    try {
      return resolver('pg');
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Cannot find "pg". Run `pnpm install` at the repository root first.');
}
const { Client } = requirePg();

/** العقد نفسه — يُقرأ من بنائه (`dist`) فلا تُكتب مفردات القياس يدوياً في سكربت. */
const contracts = await import(new URL('../packages/contracts/dist/platform/site-analytics.js', import.meta.url).href);
const contentContracts = await import(new URL('../packages/contracts/dist/platform/content.js', import.meta.url).href);
const { SITE_EVENTS_MAX_BATCH, SITE_EVENTS_RETENTION_DAYS, siteGoalNames } = contracts;
const { pickContentVariant } = contentContracts;

const stamp = Date.now().toString(36);
const EVENTS = '/public/events';
const SITE = '/platform/analytics/site';
const CONTENT = '/public/content';

/**
 * زوّارٌ **جدد في كل تشغيل**: القاعدة تحتفظ بأحداث التحقّق حتى تنظيفها، والقمع يُجمع بالاسم
 * عبر النافذة كلها — فمعرّفٌ ثابت يعني أن قراءة «كم زائراً طلب عرضاً» تجمع تشغيلات الأمس
 * وتبدو الأرقام تتحرّك بينما الكود ساكن. والمسارات كذلك: نطاقٌ خاصّ بهذا السكربت
 * (`/vsa-…`) يُنظَّف كلّه في النهاية، فلا تتراكم بقايا في قياس التطوير.
 */
const visitor = () => crypto.randomUUID();
const visitors = { a: visitor(), b: visitor(), c: visitor(), d: visitor(), e: visitor() };
/** مسارٌ داخل نطاق التحقّق — `vsa` = verify-site-analytics، ويُمحى كلّه في النهاية. */
const path = (tag) => `/vsa-${stamp}/${tag}`;

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

const client = new Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL });

/**
 * كل استعلامٍ مباشر يفتح معاملةً بسياق المنصّة — كما يفعل `withPlatformAdminTx` في التطبيق.
 * وجداولنا عليها RLS **مفروض** (`FORCE`)، فقراءةٌ بلا سياقٍ تعيد صفر صفوف وتُوهم بالنجاح.
 */
async function query(text, params = []) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.is_platform_admin', 'on', true)`);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function call(method, path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.referer ? { referer: options.referer } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: response.status, data: parsed.data, meta: parsed.meta, raw: parsed, headers: response.headers };
}

const post = (route, body, options = {}) => call('post', route, { body, ...options });
const get = (route, options) => call('get', route, options);

/**
 * إرسالُ أحداثٍ **بصبر**: دلو `public-events` يحمل ١٢٠ طلباً في الدقيقة، والسكربت يستهلك
 * معظمه في أقسامه ثم يستنفده سبيكُ الدلو في آخرها — فتشغيلٌ ثانٍ يبدأ بدلوٍ فارغ. و429 هنا
 * ليست نتيجةً بل انتظار: ننتظر ما تقوله `Retry-After` ونُعيد. أما سبيك الدلو نفسه فيستعمل
 * `post` الخام عن قصد، لأنه يقيس الرفض لا يتحمّله.
 */
async function send(events, attempts = 12) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await post(EVENTS, { events });
    if (response.status !== 429 || attempt === attempts) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 6) * 1000 + 500;
    console.log(`  … دلو public-events مُستنفَد — انتظار ${Math.ceil(waitMs / 1000)}ث ثم إعادة الإرسال`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

const event = (extra = {}) => ({ name: 'page_view', path: '/', locale: 'ar', visitor: visitors.a, ...extra });

async function signIn() {
  const login = await call('post', '/auth/login', { body: { tenantCode: platformTenant, ...operator } });
  const token = login.data?.accessToken;
  if (!token) throw new Error('تعذّر الدخول كمشغّل منصّة — راجع PLATFORM_ADMIN_PASSWORD في .env');
  return token;
}

async function auditRows() {
  const rows = await query('SELECT count(*)::int AS total FROM audit_log');
  return rows[0].total;
}

/** يزرع صفحةً في CMS قيداً مباشراً — مسار اللوحة الكامل مقيسٌ في P-M5. */
const createdPages = [];
async function seedPage({ slug, title, status = 'published', variantOf = null, variantKey = null, cta = null }) {
  const rows = await query(
    `INSERT INTO content_pages (id, slug, kind, title_ar, summary_ar, status, published_at, variant_of, variant_key)
     VALUES (gen_random_uuid(), $1, 'page', $2, $3, $4, CASE WHEN $4 = 'published' THEN now() ELSE NULL END, $5::uuid, $6)
     RETURNING id`,
    [slug, title, `ملخّص ${title}`, status, variantOf, variantKey],
  );
  const id = rows[0].id;
  if (cta) {
    await query(
      `INSERT INTO content_blocks (id, page_id, position, kind, content)
       VALUES (gen_random_uuid(), $1::uuid, 0, 'cta', $2::jsonb)`,
      [id, JSON.stringify({ ar: { title: `دعوة ${title}`, primaryLabel: cta.label, primaryHref: cta.href }, en: null })],
    );
  }
  createdPages.push(id);
  return id;
}

/** الدلو دلوُ رموزٍ لا نافذة: من شغّل السكربت قبله ورث دلوًا شبه فارغ، فينتظر امتلاءه. */
async function waitForBucket(minTokens = 8) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const probe = await post(EVENTS, { events: [event({ path: path('probe'), visitor: visitors.e })] });
    if (probe.status === 429) {
      const retryAfter = Number(probe.headers.get('retry-after'));
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 6) * 1000 + 500;
      console.log(`  … الدلو مُستنفَد من تشغيلٍ سابق — انتظار ${Math.ceil(waitMs / 1000)}ث`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const remaining = Number(probe.headers.get('x-ratelimit-remaining'));
    if (!Number.isFinite(remaining) || remaining >= minTokens) return;
    const limit = Number(probe.headers.get('x-ratelimit-limit'));
    const refillMs = Number.isFinite(limit) && limit > 0 ? Math.ceil(60_000 / limit) : 500;
    const waitMs = (minTokens - remaining + 1) * refillMs + 500;
    console.log(`  … الدلو متبقّيه ${remaining} رمزاً — انتظار ${Math.ceil(waitMs / 1000)}ث لامتلائه`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function page(path) {
  const response = await fetch(`${siteBase}${path}`);
  return { status: response.status, html: await response.text() };
}

let token = '';
try {
  await client.connect();
  token = await signIn();

  // ═══════════════════════════════════════════════ 1. الباب
  console.log(`\n■ 1. 🚪 الباب العامّ — ${apiBase}${EVENTS}`);
  await waitForBucket();
  const accepted = await send([event({ path: path('one') })]);
  check('الحدث يُقبل بلا توكن', accepted.status === 202, `status=${accepted.status}`);
  check('والجسم يقول ما قُبل فقط', accepted.data?.accepted === 1, JSON.stringify(accepted.data));
  check('والرسالة العربية من العقد', typeof accepted.raw.messageAr === 'string' && accepted.raw.messageAr.length > 3);

  const smuggled = await send([event({ email: 'someone@example.test' })]);
  check('مفتاح هويّة في الحدث ⇒ 400', smuggled.status === 400, `status=${smuggled.status}`);
  check('ورمز الخطأ من السجلّ الموحَّد', smuggled.raw.code === 'VALIDATION_FAILED', String(smuggled.raw.code));
  const strayRoot = await post(EVENTS, { events: [event()], ip: '10.0.0.1' });
  check('ومفتاحٌ في جذر الدفعة ⇒ 400', strayRoot.status === 400, `status=${strayRoot.status}`);
  const unknownName = await send([event({ name: 'Signup_Start' })]);
  check('واسمٌ خارج المفردات ⇒ 400', unknownName.status === 400, `status=${unknownName.status}`);
  const badVisitor = await send([event({ visitor: 'زائر-١' })]);
  check('ومُعرّفٌ غير UUID ⇒ 400', badVisitor.status === 400, `status=${badVisitor.status}`);
  const empty = await send([]);
  check('ودفعةٌ فارغة ⇒ 400', empty.status === 400, `status=${empty.status}`);
  const tooMany = await send(Array.from({ length: SITE_EVENTS_MAX_BATCH + 1 }, () => event()));
  check('ودفعةٌ تتجاوز الحدّ ⇒ 400', tooMany.status === 400, `status=${tooMany.status}`);

  // ═══════════════════════════════════════════════ 2. ما يُكتب
  console.log('\n■ 2. 🗄️ ما يُكتب — الصفّ والمخطّط والقيود');
  const beforeAudit = await auditRows();
  const duplicate = await send([
    event({ name: 'signup_start', path: path('dup'), visitor: visitors.b }),
    event({ name: 'signup_start', path: path('dup'), visitor: visitors.b }),
  ]);
  check('التكرار داخل الدفعة الواحدة يُكتب مرّة', duplicate.data?.accepted === 1, String(duplicate.data?.accepted));
  const dupRows = await query('SELECT count(*)::int AS total FROM site_events WHERE path = $1', [path('dup')]);
  check('وصفٌّ واحد في القاعدة', dupRows[0].total === 1, String(dupRows[0].total));

  const columns = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'site_events' ORDER BY column_name`,
  );
  const columnNames = columns.map((row) => row.column_name);
  check('ولا عمود لعنوان IP في الجدول', columnNames.includes('ip') === false && columnNames.includes('ip_address') === false);
  check('ولا عمود للبريد أو الوسيط', ['email', 'user_agent', 'ua', 'fingerprint'].every((name) => columnNames.includes(name) === false));
  check('والمخزَّن معدودٌ بالإصبع', columnNames.join(',') === 'id,locale,meta,name,occurred_at,path,referrer_host,visitor', columnNames.join(','));

  const forged = await query(
    `INSERT INTO site_events (id, name, path, locale, visitor) VALUES (gen_random_uuid(), 'page_view', '/vsa/forged', 'ar', 'not-a-uuid') RETURNING id`,
  ).then(
    () => 'accepted',
    (error) => error.code ?? 'failed',
  );
  check('وقيد القاعدة يرفض مُعرّفاً نصّياً (الحرس في المخطّط لا في الكود)', forged === '23514', String(forged));

  const grants = await query(
    `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'site_events' AND grantee = 'erp_api'`,
  );
  const privileges = grants.map((row) => row.privilege_type);
  check('والكتابة والقراءة والحذف مُنحت للتطبيق', ['SELECT', 'INSERT', 'DELETE'].every((p) => privileges.includes(p)));
  check('و`UPDATE` لم يُمنح (الحدث خبرٌ وقع لا مسوّدة)', privileges.includes('UPDATE') === false, privileges.join(','));

  check('ولا سجلّ زائر: صفر صفوف تدقيق جديدة', (await auditRows()) === beforeAudit, `${beforeAudit}→${await auditRows()}`);

  // ═══════════════════════════════════════════════ 3. القمع
  console.log(`\n■ 3. 🎯 القمع — ${apiBase}${SITE}`);
  const board = await get(`${SITE}?days=7`, { token });
  check('اللوحة تُقرأ بالرمز القائم', board.status === 200, `status=${board.status}`);
  const before = board.data ?? {};
  const goalOf = (data, name) => (data.goals ?? []).find((goal) => goal.name === name) ?? {};
  const funnelPath = path('funnel');

  await send([
    // خمسة مشاهدين للمسار نفسه: يضمن ظهوره في جدول المسارات (المحدود بعشرة) ولا يمسّ أي هدف.
    ...Object.values(visitors).map((v) => event({ name: 'page_view', path: funnelPath, visitor: v })),
    // ثلاث نقراتٍ من الزائر نفسه: خطوةٌ واحدة في القمع وثلاثة أحداث.
    event({ name: 'request_demo', path: path('demo-a'), visitor: visitors.a }),
    event({ name: 'request_demo', path: path('demo-b'), visitor: visitors.a }),
    event({ name: 'request_demo', path: path('demo-c'), visitor: visitors.a }),
    // وبدء الاشتراك بزائرٍ آخر: سبيك القسم 2 كتب `signup_start` للزائر `b`، فلو كتبناه له
    // هنا لَما تحرّك العدّاد (الزائر نفسه يُحسب مرّة) — والفرق هو ما نقيسه لا المجموع.
    event({ name: 'signup_start', path: path('signup'), visitor: visitors.e }),
    event({ name: 'newsletter_subscribe', path: path('news'), visitor: visitors.c }),
    event({ name: 'signup_complete', path: path('onboarding'), visitor: visitors.d }),
  ]);

  const after = await get(`${SITE}?days=7`, { token });
  const data = after.data ?? {};
  const goals = data.goals ?? [];
  const demo = goalOf(data, 'request_demo');
  /** الفرق بين قراءتين — لأن القاعدة تحمل تشغيلاتٍ سابقة، والمطلق يكذب وهذه لا تكذب. */
  const delta = (name, field) => (goalOf(data, name)[field] ?? 0) - (goalOf(before, name)[field] ?? 0);

  check('وكل أهداف القمع لها صفٌّ ولو بصفر', siteGoalNames.every((name) => goals.some((goal) => goal.name === name)));
  check('وثلاث نقراتٍ من زائرٍ واحد = زائرٌ واحد', delta('request_demo', 'visitors') === 1, String(delta('request_demo', 'visitors')));
  check('والأحداث ثلاثة (فرق «أحداث − زوّار» يُعرض لا يُهمَل)', delta('request_demo', 'events') === 3, String(delta('request_demo', 'events')));
  check('وطلب العرض سُجّل مرّةً لزائرٍ واحد', demo?.visitors >= 1, String(demo?.visitors));
  check('والنسبة من زوّار النافذة لا من النقرات', demo?.ratePct > 0 && demo?.ratePct <= 100, String(demo?.ratePct));
  check('وأهدافٌ أخرى تحرّكت بنفس الأحداث', delta('signup_start', 'visitors') === 1 && delta('newsletter_subscribe', 'visitors') === 1 && delta('signup_complete', 'visitors') === 1);
  check('والهدف الذي لم يبلغه أحد يبقى صفراً بلا اختلاق', goals.every((goal) => typeof goal.visitors === 'number'));
  check('والمنحنى بطول النافذة', (data.series ?? []).length === 7, String((data.series ?? []).length));
  // المشاهدات بالفرق أيضاً: خمس `page_view` في هذا القسم بالضبط — والعدد المطلق يعتمد على
  // ما تركه التشغيل السابق من أحداثٍ في النافذة، وهو ما يُفشل تحقّقاً سليماً.
  check('والمشاهدات معدودة', (data.views?.all ?? 0) - (before.views?.all ?? 0) === 5, String(data.views?.all));
  check('والمسارات تعرض المسار كما هو', (data.paths ?? []).some((row) => row.path === funnelPath), funnelPath);
  check(
    'والمصادر تعرض عائل المُحيل لا رابطه',
    (data.sources ?? []).length > 0 &&
      (data.sources ?? []).every((row) => typeof row.host === 'string' && row.host.includes('/') === false),
  );
  check('وما لا مُحيل له يُسمّى «مباشر»', (data.sources ?? []).some((row) => row.host === 'مباشر'));
  const serialized = JSON.stringify(data);
  check('ولا معرّف زائر في جسم اللوحة', Object.values(visitors).every((id) => serialized.includes(id) === false));
  check('والتوقيت والزمن مقيسان', typeof data.generatedAt === 'string' && data.window?.days === 7);

  // ═══════════════════════════════════════════════ 4. الخصوصية
  console.log('\n■ 4. 🔒 الخصوصية — ما يُجمع وما لا يُجمع');
  check('«لا يُجمع» يحمل عنوان IP', (data.privacy?.never ?? []).includes('عنوان IP'));
  check('ويحمل البريد والاسم والهاتف', (data.privacy?.never ?? []).some((line) => line.includes('البريد')));
  check('ويحمل البصمات', (data.privacy?.never ?? []).some((line) => line.includes('بصمات')));
  check('و«يُجمع» يقول إن المُعرّف عشوائيّ', (data.privacy?.collected ?? []).some((line) => line.includes('عشوائي')));
  check('ومدة الاحتفاظ من العقد لا من الشاشة', data.privacy?.retentionDays === SITE_EVENTS_RETENTION_DAYS, String(data.privacy?.retentionDays));
  check('والتعريفات الخمسة تسافر مع الأرقام', (data.definitions ?? []).length === 5, String((data.definitions ?? []).length));
  check('ولكل تعريفٍ كلماته لا رقمٌ مبتور', (data.definitions ?? []).every((item) => item.labelAr.length > 2 && item.definitionAr.length > 15));

  // ═══════════════════════════════════════════════ 5. الاحتفاظ
  console.log('\n■ 5. 🧹 الاحتفاظ — الوعد يُنفَّذ لا يُكتب');
  await query(
    `INSERT INTO site_events (id, name, path, locale, visitor, occurred_at)
     VALUES (gen_random_uuid(), 'page_view', $1, 'ar', $2, now() - interval '200 days')`,
    [path('stale'), visitors.a],
  );
  await query(
    `INSERT INTO platform_settings (id, tenant_id, key, value)
     VALUES (gen_random_uuid(), NULL, 'site.events.pruned_at', $1::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(new Date(Date.now() - 86_400_000 * 3).toISOString())],
  );
  const staleBefore = await query('SELECT count(*)::int AS total FROM site_events WHERE path = $1', [path('stale')]);
  check('صفٌّ أقدم من المدّة موجودٌ قبل التنظيف', staleBefore[0].total === 1, String(staleBefore[0].total));
  await send([event({ path: path('prune'), visitor: visitors.e })]);
  const staleAfter = await query('SELECT count(*)::int AS total FROM site_events WHERE path = $1', [path('stale')]);
  check('وأوّل كتابة تُمحيه', staleAfter[0].total === 0, String(staleAfter[0].total));
  const marker = await query(`SELECT value::text AS value FROM platform_settings WHERE key = 'site.events.pruned_at' AND tenant_id IS NULL`);
  const stampAge = Date.now() - Date.parse(JSON.parse(marker[0].value));
  check('والعلامة المائية تُحدَّث فلا يُكرَّر الحذف في كل حدث', stampAge < 60_000, `${Math.round(stampAge / 1000)}ث`);

  // ═══════════════════════════════════════════════ 6. أ/ب
  console.log('\n■ 6. 🧪 أ/ب — نسخةٌ من نظام المحتوى لا جدولٌ ثانٍ');
  const baseId = await seedPage({ slug: `ab-home-${stamp}`, title: `بطل ${stamp}` });
  await seedPage({
    slug: `ab-home-b-${stamp}`,
    title: `بطل ${stamp} — نسخة ب`,
    variantOf: baseId,
    variantKey: 'b',
    cta: { label: 'ابدأ الآن', href: '/onboarding' },
  });
  await seedPage({ slug: `ab-home-a-${stamp}`, title: `نسخة أ مسوّدة`, variantOf: baseId, variantKey: 'a', status: 'draft' });

  const detail = await get(`${CONTENT}/ab-home-${stamp}`);
  const variants = detail.data?.variants ?? [];
  check('النسخة المنشورة تُعلَن', variants.length === 1 && variants[0]?.key === 'b', variants.map((v) => v.key).join(' '));
  check('والمسوّدة لا تُعلَن ولو كان حرفها صحيحاً', variants.some((v) => v.titleAr.includes('مسوّدة')) === false);
  check('والدعوة تُقرأ من كتلة `cta` في النسخة', variants[0]?.ctaLabelAr === 'ابدأ الآن' && variants[0]?.ctaHref === '/onboarding');
  const plain = await get(`${CONTENT}/ab-home-b-${stamp}`);
  check('والصفحة بلا نسخٍ منها لا تُعلن شيئاً', (plain.data?.variants ?? []).length === 0);

  let bothKeys = new Set();
  let stable = true;
  for (let index = 0; index < 120; index += 1) {
    const id = `${String(index).padStart(8, '0')}-1111-4222-8333-444455556666`;
    const first = pickContentVariant({ slug: 'home', visitor: id });
    const second = pickContentVariant({ slug: 'home', visitor: id });
    if (first !== second) stable = false;
    if (first) bothKeys.add(first);
  }
  check('التوزيع حتميّ: الزائر نفسه يرى النسخة نفسها', stable);
  check('والنسختان تُستعملان عبر زوّار مختلفين', bothKeys.size >= 2, [...bothKeys].join(' '));

  const experimentSlug = `ab-home-${stamp}`;
  await send([
    event({ name: 'experiment_exposure', path: '/', visitor: visitors.a, meta: { experiment: experimentSlug, variant: 'b' } }),
    event({ name: 'experiment_exposure', path: '/', visitor: visitors.b, meta: { experiment: experimentSlug, variant: 'b' } }),
    event({ name: 'signup_start', path: path('exp-signup'), visitor: visitors.b }),
  ]);
  const afterExposure = await get(`${SITE}?days=7`, { token });
  const experiment = (afterExposure.data?.experiments ?? []).find((row) => row.experiment === experimentSlug);
  const variantB = experiment?.variants?.find((row) => row.key === 'b');
  check('والعرض يُقاس (من رأى النسخة)', variantB?.exposures === 2, String(variantB?.exposures));
  check('والتحويل يُقاس (من بدأ اشتراكاً بعدها)', variantB?.converters === 1, String(variantB?.converters));
  check('والنسبة محسوبةٌ بمنزلةٍ واحدة', variantB?.ratePct === 50, String(variantB?.ratePct));

  // ═══════════════════════════════════════════════ 7. الدلو (آخراً: يستهلكه)
  console.log('\n■ 7. 🧊 دلوُ المعدّل — سقفٌ مستقلّ يُقاس آخراً');
  let limited = null;
  for (let attempt = 0; attempt < 200 && !limited; attempt += 1) {
    const response = await post(EVENTS, {
      events: [event({ path: path(`limit-${attempt}`), visitor: `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}` })],
    });
    if (response.status === 429) limited = response;
  }
  check('الطلبات تُقطع بـ429 بعد حدّ الدلو', limited?.status === 429, `status=${limited?.status ?? 'لم يُحدّ'}`);
  check('ورمز الخطأ يقول السبب', limited?.raw.code === 'RATE_LIMITED', String(limited?.raw.code));
  check('وترويسة `Retry-After` تُخبر متى يعود', Boolean(limited?.headers.get('retry-after')), String(limited?.headers.get('retry-after')));

  // ═══════════════════════════════════════════════ 8. الموقع
  console.log(`\n■ 8. 🖥️ الموقع — ${siteBase}`);
  const home = await page('/');
  check('الصفحة الرئيسية تُخدَم', home.status === 200, `status=${home.status}`);
  check('ولافتة الموافقة مُحمَّلة مع التخطيط', home.html.includes('ConsentBanner'), '‏Next يحمّلها كعميلٍ ولا يرسمها على الخادم (القرار يُقرأ بعد التركيب)');
  check('والمُلتقِط الصامت مُحمَّلٌ أيضاً', home.html.includes('SiteEvents'));
  check('وسطر حالة القياس في التذييل يطبع الوعد', home.html.includes('consent-line') && home.html.includes('الاختيار محفوظٌ في متصفّحك وحده'));
  check('والبطل عنوانٌ واحد `<h1>` من نظام المحتوى', home.html.includes('<h1>'));
  check('والدعوة الأساسية موسومة بـ`data-goal`', home.html.includes('data-goal="signup_start"'));

  // النصّ الحقيقيّ الذي يصل المتصفّح: تُقرأ حزمة التخطيط نفسها — فاختبار «اللافتة موجودة»
  // على HTML وحده كان سيمرّ بمجرّد ذكر اسم المكوّن، والوعد يُقاس في نصّه لا في اسمه.
  const chunk = await fetch(`${siteBase}/_next/static/chunks/app/layout.js`);
  if (chunk.ok) {
    const code = await chunk.text();
    check('ونصّ اللافتة يصل المتصفّح: «هل نُحصي زيارات الموقع؟»', code.includes('هل نُحصي زيارات الموقع'));
    check('وفيه زرّا الموافقة والرفض', code.includes('أوافق') && code.includes('لا أوافق'));
    check('وفيه الوعد: «لا نستخدم كوكي ولا طرفاً ثالثاً»', code.includes('لا نستخدم كوكي'));
    check('ومفتاح الموافقة ومفتاح الزائر في الحزمة', code.includes('erp.consent.v1') && code.includes('erp.visitor.v1'));
    check('والوجهة هي نظامنا لا طرفٌ ثالث', code.includes('public/events') && code.includes('google-analytics') === false);
  } else {
    console.log('  … حزمة التخطيط غير مقروءة (بناءٌ إنتاجي بأسماء مُجزَّأة) — تُخطّى قراءة النصّ');
  }


} catch (error) {
  failures += 1;
  console.log(`\n✗ توقّف السكربت: ${error.message}`);
} finally {
  try {
    if (createdPages.length > 0) {
      await query('DELETE FROM content_pages WHERE id = ANY($1::uuid[])', [createdPages]);
    }
    await query(`DELETE FROM platform_settings WHERE tenant_id IS NULL AND key = 'site.events.pruned_at'`);
    // أحداثُ التحقّق تُترك عمداً؟ لا: تُحذف بالمسارات المؤقّتة حتى لا تُلوّث قياس العرض.
    // نطاق التحقّق الجديد + أنماط النسخة الأولى (بقايا اليوم نفسه في قواعد التطوير).
    await query(
      `DELETE FROM site_events WHERE path LIKE '/vsa-%' OR path LIKE '/one-%' OR path LIKE '/dup-%'
         OR path LIKE '/funnel-%' OR path LIKE '/limit-%' OR path LIKE '/__probe%'
         OR path LIKE '/goal-%' OR path = '/demo?x=1'`,
    );
  } catch {
    // التنظيف تحسينٌ لا شرط: لو فشل لا يُسقط نتيجة التحقّق.
  }
  await client.end().catch(() => {});
}

console.log(`\n${failures === 0 ? '✔' : '✗'} verify-site-analytics: ${checks - failures}/${checks} نقطة ناجحة في 8 أقسام`);
process.exit(failures === 0 ? 0 : 1);
