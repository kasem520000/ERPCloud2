#!/usr/bin/env node
/**
 * verify-help.mjs — التحقّق الحيّ لـ P-M9 «مركز المساعدة وحالة الخدمة»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس الوعد الذي بُني عليه الجزء: **مركز مساعدةٍ يُجيب قبل أن يُفتح تذكرة** — فئاتٌ من نظام
 * المحتوى، ومقالٌ يُقرأ ويُصوَّت عليه، وسجلُّ تغييراتٍ حقيقي، وصفحةُ حالةٍ تقرأ مجسّات المنصّة
 * نفسها بلا أن تُسرّب تفصيلاً داخلياً. وسبعة أقسام:
 *
 *   1. 🚪 الباب — `GET /public/help` يعمل بلا توكن، ومدخلُ صوتٍ لا يصلح يُردّ 400 لا 500،
 *      ومقالٌ غير موجود 404 — والرسالة نفسها للمسوّدة وللغائب (لا أداةَ استكشاف).
 *   2. 📚 المنشور وحده يظهر — مقالاتٌ تُزرع في CMS: ثلاثة منشورة وواحدة مسوّدة وواحدة من نوع
 *      `post`؛ والقائمة تُصفّي، وعدّادات الفئات من المنشور وحده، والبحث والترشيح يعملان.
 *   3. 🧭 الأنواع محكومة — `/public/help/:slug` لا يخدم `post` ولا مسوّدةً ولا مدخل تغييرات،
 *      والمقال يعود بكتله وفئته ومقالاته المجاورة.
 *   4. 🗳️ التصويت — صوتٌ واحد لكل متصفّح: الأول `recorded:true` والمكرّر `recorded:false`
 *      والعدّاد لا يتحرّك، **وصفّر صفوف تدقيق** (لا يُحفظ عنوان الزائر مع صوتٍ مجهول).
 *   5. 🌡️ حالة الخدمة — المكوّنات الخمسة كاملة، والجواب لا يحمل اسماً داخلياً ولا رسالة خطأ،
 *      وحادثٌ لا يُعلَن ثم يُعلَن من الإعدادات ثم يُرفع — مع قياس ذاكرة العشر ثوانٍ.
 *   6. 🗺️ الموقع — `/help` و`/help/<slug>` و`/changelog` و`/changelog/<slug>` و`/status`،
 *      وزرّا التصويت في الصفحة، وخريطة الموقع تحمل الصفحات الثلاث.
 *   7. 🧊 دلوُ المعدّل — سقفٌ مستقلّ عن الاستمارات (`public-help-feedback`)، **يُقاس آخراً
 *      لأنه يستهلك الدلو**؛ فينتظر السكربت في أوّله امتلاءه إن كان شبه فارغٍ من تشغيلٍ سابق.
 *
 * **وما يُقرأ من القاعدة؟** صفحاتُ CMS المزروعة وأصواتُها وعددُ صفوف التدقيق — كتابةً ثم
 * قراءةً ثم تنظيفاً. وكل صفحة تُزرع بـslugٍ يحمل طابع الوقت وتُحذف في النهاية، فلا يُلوَّث
 * بذرُ العرض (`demo`) ولا يبقى مقالٌ دخيل في الموقع.
 *
 * Usage: node scripts/verify-help.mjs
 */
import { createRequire } from 'node:module';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const siteBase = (
  process.env.MARKETING_BASE ?? `http://127.0.0.1:${process.env.MARKETING_PORT ?? 3002}`
).replace(/\/+$/, '');

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

/** العقد نفسه — يُقرأ من بنائه (`dist`) فلا تُكتب مفردات الحالة يدوياً في سكربت. */
const contracts = await import(new URL('../packages/contracts/dist/platform/status.js', import.meta.url).href);
const { publicComponentKeys, PUBLIC_STATUS_NOTE_AR } = contracts;

const stamp = Date.now().toString(36);
const HELP = '/public/help';
const STATUS = '/public/status';
const CATEGORY_MAIN = `فئة-${stamp}`;
const CATEGORY_OTHER = `أخرى-${stamp}`;
const slugs = {
  invoice: `hs-invoice-${stamp}`,
  reports: `hs-reports-${stamp}`,
  reports2: `hs-reports-2-${stamp}`,
  draft: `hs-draft-${stamp}`,
  blog: `hs-blog-${stamp}`,
  changelog: `chg-${stamp}`,
};
const visitorA = '7c9f1a2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c';
const visitorB = 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

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

async function query(text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: response.status, data: parsed.data, raw: parsed, headers: response.headers };
}

async function post(path, body) {
  return api(path, { method: 'POST', body });
}

/**
 * الدلو **دلوُ رموزٍ لا نافذة**: `limit/windowMs` رمزاً في الثانية (١٠ في الدقيقة ⇒ رمزٌ كل ٦ث)،
 * فمن شغّل السكربت قبل قليل ورث دلوًا شبه فارغ — وتسقط أصوات القسم الأول والرابع بلا عطلٍ حقيقي
 * (وهو ما وقع فعلاً حين شُغِّل مرّتين متعاقبتين). فالسكربت ينتظر قبل أن يقيس: نداءُ فحصٍ واحد
 * يقرأ `X-RateLimit-Remaining`، فإن كان الدلو شبه فارغٍ نام بقدر ما يلزم لامتلائه ثم أعاد الفحص.
 */
async function waitForBucket(minTokens = 8) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const probe = await post(`${HELP}/${slugs.invoice}/feedback`, { helpful: true, visitor: visitorB });
    if (probe.status === 429) {
      const retryAfter = Number(probe.headers.get('retry-after'));
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 6) * 1000 + 500;
      console.log(`  … الدلو مُستنفَد من تشغيلٍ سابق — انتظار ${Math.ceil(waitMs / 1000)}ث`);
      await sleep(waitMs);
      continue;
    }
    const remaining = Number(probe.headers.get('x-ratelimit-remaining'));
    if (!Number.isFinite(remaining) || remaining >= minTokens) return;
    const limit = Number(probe.headers.get('x-ratelimit-limit'));
    // معدّل الامتلاء من الترويسة نفسها (١٠ في الدقيقة ⇒ رمزٌ كل ٦ث) — لا رقمٌ مكتوب هنا.
    const refillMs = Number.isFinite(limit) && limit > 0 ? Math.ceil(60_000 / limit) : 6_000;
    // +١ لأن نداء الفحص نفسه يستهلك رمزاً؛ بغيرها يستقرّ الدلو عند حدّ الانتظار فلا يبلغه أبداً.
    const waitMs = (minTokens - remaining + 1) * refillMs + 500;
    console.log(`  … الدلو متبقّيه ${remaining} رمزاً — انتظار ${Math.ceil(waitMs / 1000)}ث لامتلائه`);
    await sleep(waitMs);
  }
}

async function page(path) {
  const response = await fetch(`${siteBase}${path}`);
  return { status: response.status, html: await response.text() };
}

const createdPages = [];

async function seedPage({ slug, kind, title, category = null, status = 'published' }) {
  const rows = await query(
    `INSERT INTO content_pages (id, slug, kind, title_ar, summary_ar, status, publish_at, published_at, category)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
             CASE WHEN $5 = 'scheduled' THEN now() + interval '1 day' ELSE NULL END,
             CASE WHEN $5 = 'published' THEN now() ELSE NULL END, $6)
     RETURNING id`,
    [slug, kind, title, `ملخّص ${title}`, status, category],
  );
  const pageId = rows[0].id;
  await query(
    `INSERT INTO content_blocks (id, page_id, position, kind, content)
     VALUES (gen_random_uuid(), $1, 0, 'text', $2::jsonb)`,
    [pageId, JSON.stringify({ ar: { text: `متن ${title}` }, en: null })],
  );
  createdPages.push(pageId);
  return pageId;
}

async function auditRows() {
  const rows = await query('SELECT count(*)::int AS total FROM audit_log');
  return rows[0].total;
}

/** الحادث مصدره الإعدادات (`platform.maintenance*`) كما في P-C9 — لا نصٌّ في الشاشة. */
async function setIncident(active, message = null) {
  await query(
    `INSERT INTO platform_settings (id, tenant_id, key, value)
     VALUES (gen_random_uuid(), NULL, 'platform.maintenance', $1::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(active)],
  );
  await query(
    `INSERT INTO platform_settings (id, tenant_id, key, value)
     VALUES (gen_random_uuid(), NULL, 'platform.maintenance_message', $1::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(message)],
  );
}

async function clearIncident() {
  await query(`DELETE FROM platform_settings WHERE tenant_id IS NULL AND key IN ('platform.maintenance', 'platform.maintenance_message')`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await client.connect();

  // ═══════════════════════════════════════════════ 1. الباب
  console.log(`\n■ 1. 🚪 الباب العامّ — ${apiBase}${HELP}`);
  await waitForBucket();
  const anonymous = await api(HELP);
  check('القائمة تعمل بلا توكن إطلاقاً', anonymous.status === 200, `status=${anonymous.status}`);
  check('والغلاف يحمل فئاتٍ صريحةً (لا undefined)', Array.isArray(anonymous.raw.meta?.categories));
  check('وبلا جلسةٍ ولا كوكي مطلوب', (anonymous.headers.get('content-type') ?? '').includes('application/json'));

  const badVisitor = await post(`${HELP}/${slugs.invoice}/feedback`, { helpful: true, visitor: 'ليس-معرّفاً' });
  check('صوتٌ بمعرّفٍ غير صالح ⇒ 400', badVisitor.status === 400, `status=${badVisitor.status}`);
  check('ورمز الخطأ من السجلّ الموحَّد', badVisitor.raw.code === 'VALIDATION_FAILED', String(badVisitor.raw.code));

  const extraKey = await post(`${HELP}/${slugs.invoice}/feedback`, { helpful: true, visitor: visitorA, ip: '10.0.0.1' });
  check('ومفتاحٌ خارج العقد ⇒ 400 (لا يُقبل عنوان الزائر في الجسم)', extraKey.status === 400, `status=${extraKey.status}`);

  const unknown = await api(`${HELP}/no-such-article-${stamp}`);
  check('مقالٌ غير موجود ⇒ 404', unknown.status === 404, `status=${unknown.status}`);
  const unknownVote = await post(`${HELP}/no-such-article-${stamp}/feedback`, { helpful: true, visitor: visitorA });
  check('والصوت على مقالٍ غير موجود ⇒ 404', unknownVote.status === 404, `status=${unknownVote.status}`);

  // ═══════════════════════════════════════════════ 2. المنشور وحده يظهر
  console.log('\n■ 2. 📚 المنشور وحده يظهر — ثلاث مقالات وفئة');
  await seedPage({ slug: slugs.invoice, kind: 'help', title: `كيف أُصدر فاتورة ${stamp}`, category: CATEGORY_MAIN });
  await seedPage({ slug: slugs.reports, kind: 'help', title: `تقرير المبيعات ${stamp}`, category: CATEGORY_OTHER });
  await seedPage({ slug: slugs.reports2, kind: 'help', title: `تقرير المصروفات ${stamp}`, category: CATEGORY_OTHER });
  await seedPage({ slug: slugs.draft, kind: 'help', title: `مسوّدة لا تُنشر ${stamp}`, category: CATEGORY_MAIN, status: 'draft' });
  await seedPage({ slug: slugs.blog, kind: 'post', title: `مقال مدوّنة ${stamp}`, category: CATEGORY_MAIN });

  const list = await api(`${HELP}?limit=50`);
  const listSlugs = (list.data ?? []).map((item) => item.slug);
  check('المقالات المنشورة تظهر', [slugs.invoice, slugs.reports, slugs.reports2].every((slug) => listSlugs.includes(slug)));
  check('والمسوّدة لا تظهر', listSlugs.includes(slugs.draft) === false);
  check('ومقال المدوّنة ليس من مركز المساعدة', listSlugs.includes(slugs.blog) === false);
  check('ونصّ المسوّدة لا يتسرّب في الجسم', JSON.stringify(list.raw).includes(`مسوّدة لا تُنشر ${stamp}`) === false);

  const categories = new Map((list.raw.meta?.categories ?? []).map((item) => [item.name, item.count]));
  check('وفئة المقال تُعدّ بمقالها', categories.get(CATEGORY_MAIN) === 1, String(categories.get(CATEGORY_MAIN)));
  check('والفئة التي فيها مقالان تُعدّ اثنين', categories.get(CATEGORY_OTHER) === 2, String(categories.get(CATEGORY_OTHER)));

  const searched = await api(`${HELP}?q=${encodeURIComponent('المصروفات')}`);
  check(
    'والبحث يرشّح على العنوان',
    (searched.data ?? []).some((item) => item.slug === slugs.reports2) && (searched.data ?? []).length === 1,
    (searched.data ?? []).map((item) => item.slug).join(' '),
  );
  const filtered = await api(`${HELP}?category=${encodeURIComponent(CATEGORY_OTHER)}`);
  check(
    'وترشيح الفئة يعمل',
    (filtered.data ?? []).map((item) => item.slug).sort().join(',') === [slugs.reports, slugs.reports2].sort().join(','),
    (filtered.data ?? []).map((item) => item.slug).join(' '),
  );
  check(
    'والفئات لا تُسقط بالترشيح (من دخل على فئةٍ يرى غيرها ليخرج منها)',
    (filtered.raw.meta?.categories ?? []).some((item) => item.name === CATEGORY_MAIN),
  );

  // ═══════════════════════════════════════════════ 3. الأنواع محكومة
  console.log('\n■ 3. 🧭 الأنواع محكومة — النوع والمنشور يُحكمان في الخدمة');
  const article = await api(`${HELP}/${slugs.reports}`);
  check('المقال المنشور يُقرأ', article.status === 200, `status=${article.status}`);
  const firstBlock = JSON.stringify(article.data?.page?.blocks?.[0]?.content?.ar ?? {});
  check('بكتله (المتن لا العنوان)', (article.data?.page?.blocks ?? []).length >= 1 && firstBlock.includes('متن'), firstBlock.slice(0, 60));
  check('وفئته معه', article.data?.category === CATEGORY_OTHER, String(article.data?.category));
  check(
    'والمجاورة من الفئة نفسها لا من عموم المقالات',
    (article.data?.related ?? []).length === 1 && article.data?.related?.[0]?.slug === slugs.reports2,
    (article.data?.related ?? []).map((item) => item.slug).join(' '),
  );
  check('وعدّادا الصوت يبدآن من صفر', article.data?.helpful?.yes === 0 && article.data?.helpful?.no === 0);

  const viaHelpBlog = await api(`${HELP}/${slugs.blog}`);
  check('مقال المدوّنة لا يُخدم من مسار المساعدة (404)', viaHelpBlog.status === 404, `status=${viaHelpBlog.status}`);
  const viaHelpDraft = await api(`${HELP}/${slugs.draft}`);
  check('والمسوّدة لا تُخدم', viaHelpDraft.status === 404, `status=${viaHelpDraft.status}`);
  check('ونصّها لا يظهر في ردّ الخطأ', JSON.stringify(viaHelpDraft.raw).includes(`مسوّدة لا تُنشر ${stamp}`) === false);

  await seedPage({ slug: slugs.changelog, kind: 'changelog', title: `v1.9 تحديثات ${stamp}` });
  const viaHelpChangelog = await api(`${HELP}/${slugs.changelog}`);
  check('ومدخل سجلّ التغييرات لا يُخدم من مسار المساعدة', viaHelpChangelog.status === 404, `status=${viaHelpChangelog.status}`);
  const changelogList = await api('/public/posts?kind=changelog&limit=50');
  const changelogEntry = (changelogList.data ?? []).find((item) => item.slug === slugs.changelog);
  check('ويُقرأ من مسار المقالات بنوعه', Boolean(changelogEntry));
  check('ومساره `/changelog/<slug>`', changelogEntry?.path === `/changelog/${slugs.changelog}`, String(changelogEntry?.path));

  // ═══════════════════════════════════════════════ 4. التصويت
  console.log('\n■ 4. 🗳️ التصويت — صوتٌ واحد لكل متصفّح، وبلا تدقيق');
  const auditBefore = await auditRows();
  const firstVote = await post(`${HELP}/${slugs.reports}/feedback`, { helpful: true, visitor: visitorA });
  check('الصوت الأول يُسجَّل', firstVote.status === 200 && firstVote.data?.recorded === true, `status=${firstVote.status}`);
  check('والعدّاد يتحرّك مرّة', firstVote.data?.yes === 1 && firstVote.data?.no === 0);

  const repeatVote = await post(`${HELP}/${slugs.reports}/feedback`, { helpful: false, visitor: visitorA });
  check('والإعادة من المتصفّح نفسه لا تُحسب (recorded:false)', repeatVote.data?.recorded === false);
  check('والعدّاد لا يتحرّك — ولا يُقلب الصوت', repeatVote.data?.yes === 1 && repeatVote.data?.no === 0);

  const otherVote = await post(`${HELP}/${slugs.reports}/feedback`, { helpful: false, visitor: visitorB });
  check('ومتصفّحٌ آخر يُحسب صوته', otherVote.data?.recorded === true && otherVote.data?.no === 1);

  const afterVote = await api(`${HELP}/${slugs.reports}`);
  check('والمقال يعرض العدّادين مجموعاً لا صفوفاً', afterVote.data?.helpful?.yes === 1 && afterVote.data?.helpful?.no === 1);
  const voteRows = await query('SELECT count(*)::int AS total FROM content_feedback WHERE page_id IN (SELECT id FROM content_pages WHERE slug = $1)', [slugs.reports]);
  check('والصفوف المكتوبة صوتان لا ثلاثة', voteRows[0].total === 2, String(voteRows[0].total));
  const auditAfter = await auditRows();
  check('وصفر صفوف تدقيق: صوتُ زائرٍ مجهول لا يُحفظ مع عنوانه', auditAfter === auditBefore, `${auditBefore}→${auditAfter}`);

  // ═══════════════════════════════════════════════ 5. حالة الخدمة
  console.log(`\n■ 5. 🌡️ حالة الخدمة — ${apiBase}${STATUS}`);
  await clearIncident();
  await sleep(10_500); // ذاكرة اللقطة ١٠ث: ننتظرها حتى تُقاس الحالة المعلَنة لا المخزَّنة
  const calm = await api(STATUS);
  check('الصفحة تُقرأ بلا توكن', calm.status === 200, `status=${calm.status}`);
  check(
    'والمكوّنات الخمسة كلها حاضرة',
    JSON.stringify((calm.data?.components ?? []).map((component) => component.key)) === JSON.stringify([...publicComponentKeys]),
    (calm.data?.components ?? []).map((component) => component.key).join(' '),
  );
  check(
    'ولكل مكوّنٍ تسميةٌ وشرحٌ وحالة',
    (calm.data?.components ?? []).every((component) => component.labelAr && component.whatAr && component.noteAr && component.status),
  );
  check('والحكم الإجمالي واحدٌ من مفردات العقد الأربع', ['up', 'degraded', 'down', 'not_configured'].includes(calm.data?.status));
  check('والمدّة والتوقيت مقيسان', typeof calm.data?.uptimeSeconds === 'number' && typeof calm.data?.checkedAt === 'string');
  check('والوعد المطبوع هو نصّ العقد', calm.data?.noteAr === PUBLIC_STATUS_NOTE_AR);
  check('ولا حادث معلَناً قبل أن يُعلَن', calm.data?.incident === null);
  const statusBody = JSON.stringify(calm.raw);
  check(
    'ولا تفصيل داخليّ في الجسم (لا سائق ولا دلو ولا رسالة خطأ)',
    ['REDIS_URL', 'JOBS_ENABLED', 'driver', 'bucket', 'SELECT 1', 'at Object.', 'MAIL_TRANSPORT'].every(
      (needle) => statusBody.includes(needle) === false,
    ),
  );

  await setIncident(true, `عطلٌ مخطط للاختبار ${stamp}`);
  const cached = await api(STATUS);
  check('اللقطة المخزَّنة تُخدم خلال عشر ثوانٍ (لا استنزاف للمجسّات)', cached.data?.incident === null);
  await sleep(10_500);
  const open = await api(STATUS);
  check('وبعد الذاكرة يظهر الحادث المعلَن', open.data?.incident?.message === `عطلٌ مخطط للاختبار ${stamp}`, String(open.data?.incident?.message));

  await clearIncident();
  await sleep(10_500);
  const recovered = await api(STATUS);
  check('ورفع الحادث يُعلَن بدوره', recovered.data?.incident === null);

  // ═══════════════════════════════════════════════ 6. الموقع
  console.log(`\n■ 6. 🗺️ الموقع — ${siteBase}`);
  const helpPage = await page('/help');
  check('`/help` تُخدَم', helpPage.status === 200, `status=${helpPage.status}`);
  check('وفيها فئاتٌ من نظام المحتوى', helpPage.html.includes(CATEGORY_MAIN) && helpPage.html.includes(CATEGORY_OTHER));
  check('وفيها المقال المنشور', helpPage.html.includes(`تقرير المبيعات ${stamp}`));
  check('والمسوّدة ليست فيها', helpPage.html.includes(`مسوّدة لا تُنشر ${stamp}`) === false);
  check('وفيها صندوق بحث', helpPage.html.includes('name="q"'));

  const filteredPage = await page(`/help?category=${encodeURIComponent(CATEGORY_OTHER)}`);
  check('والصفحة تحترم ترشيح الفئة', filteredPage.status === 200 && filteredPage.html.includes(`تقرير المصروفات ${stamp}`));

  const articlePage = await page(`/help/${slugs.reports}`);
  check('وصفحة المقال تُخدَم', articlePage.status === 200, `status=${articlePage.status}`);
  check('وفيها زرّا «هل أفادك هذا؟»', articlePage.html.includes('هل أفادك هذا؟') && articlePage.html.includes('أفادني') && articlePage.html.includes('لم يفدني'));
  check('وفيها مقال الفئة نفسه', articlePage.html.includes(`تقرير المصروفات ${stamp}`));

  const changelogPage = await page('/changelog');
  check('`/changelog` تُخدَم', changelogPage.status === 200, `status=${changelogPage.status}`);
  check('وفيها المدخل المنشور', changelogPage.html.includes(`v1.9 تحديثات ${stamp}`));
  const changelogEntryPage = await page(`/changelog/${slugs.changelog}`);
  check('وصفحة المدخل تُخدَم', changelogEntryPage.status === 200, `status=${changelogEntryPage.status}`);
  const blogViaChangelog = await page(`/changelog/${slugs.blog}`);
  check('ومقال المدوّنة لا يُخدَم من مسار السجلّ (404)', blogViaChangelog.status === 404, `status=${blogViaChangelog.status}`);

  const statusPage = await page('/status');
  check('`/status` تُخدَم', statusPage.status === 200, `status=${statusPage.status}`);
  check(
    'وفيها المكوّنات الخمسة بتسمياتها',
    ['المنصّة والواجهات', 'قاعدة البيانات', 'المهام الخلفية', 'البريد والتذكيرات', 'الملفات والمرفقات'].every(
      (label) => statusPage.html.includes(label),
    ),
  );
  check('وفيها الوعد المطبوع', statusPage.html.includes('الحالة لا التفاصيل'));

  const sitemap = await page('/sitemap.xml');
  check(
    'وخريطة الموقع تحمل الصفحات الثلاث الجديدة',
    sitemap.html.includes('/changelog') && sitemap.html.includes('/status') && sitemap.html.includes('/help'),
  );
  check('وتحمل المقال المنشور', sitemap.html.includes(`/help/${slugs.reports}`));

  // ═══════════════════════════════════════════════ 7. دلو المعدّل (آخراً: يستهلك الدلو)
  console.log('\n■ 7. 🧊 دلوُ المعدّل — سقفٌ مستقلّ يُقاس آخراً');
  let limited = null;
  for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
    const response = await post(`${HELP}/${slugs.invoice}/feedback`, { helpful: true, visitor: `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}` });
    if (response.status === 429) limited = response;
  }
  check('الطلبات تُقطع بـ429 بعد حدّ الدلو', limited?.status === 429, `status=${limited?.status ?? 'لم يُحدّ'}`);
  check('ورمز الخطأ يقول السبب', limited?.raw.code === 'RATE_LIMITED', String(limited?.raw.code));
  check('وترويسة `Retry-After` تُخبر متى يعود', Boolean(limited?.headers.get('retry-after')), String(limited?.headers.get('retry-after')));
} catch (error) {
  failures += 1;
  console.log(`\n✗ توقّف السكربت: ${error.message}`);
} finally {
  try {
    await clearIncident();
    if (createdPages.length > 0) {
      // الأصوات تسقط مع الصفحات (‏`ON DELETE CASCADE`) — فلا يبقى أثرُ فحصٍ في بذر العرض.
      await query('DELETE FROM content_pages WHERE id = ANY($1::uuid[])', [createdPages]);
    }
  } catch {
    // التنظيف تحسينٌ لا شرط: لو فشل لا يُسقط نتيجة التحقّق.
  }
  await client.end().catch(() => {});
}

console.log(`\n${failures === 0 ? '✔' : '✗'} verify-help: ${checks - failures}/${checks} نقطة ناجحة في 7 أقسام`);
process.exit(failures === 0 ? 0 : 1);
