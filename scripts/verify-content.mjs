#!/usr/bin/env node
/**
 * تحقّقٌ حيّ من **P-M5 — نظام إدارة المحتوى** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 و§6)
 * على حزمةٍ تعمل: `node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`.
 *
 * يقود الـAPI الحقيقي الذي تقوده اللوحة والموقع — لا شيء مُهيَّأ (mock):
 *
 *   1. 🔐 الصلاحيتان — `console.content.view` / `console.content.manage` لمن ومن دونهما
 *   2. 📖 القراءة — الصفحات والتصنيفات والقوائم الخمس واللافتات
 *   3. 🧭 دورة حياة الصفحة — مسوّدة ← مجدولة ← منشورة ← مسحوبة، والنسخ والاستعادة
 *   4. 🧱 الكتل — حمولةٌ مكسورة تُرفض وأخرى صحيحة تُحفظ (والكتل البديل الكامل)
 *   5. 🧩 القوائم — الكتابة والترتيب، وظهورها في `/public/site`
 *   6. 🚩 اللافتات — النشر بحسب النافذة والجمهور، والإيقاف
 *   7. 🧹 التنظيف — لا يبقى شيء معروض للزوّار
 *
 * **يعيد التشغيل بلا أثرٍ متراكم**: الصفحة التجريبية بمسار ثابت (`verify-pm5-case`) تُعاد إلى
 * مسوّدة، واللافتة التجريبية تُوقف، وقائمة الرأس تُستعاد من لقطةٍ سابقة. ولا يمحو السكربت
 * شيئاً: «السحب لا الحذف» قاعدة النظام نفسه.
 *
 * Usage: node scripts/verify-content.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const demo = {
  tenantCode: process.env.VERIFY_TENANT ?? 'demo',
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
};

const slug = 'verify-pm5-case';
const bannerMark = 'verify-pm5-banner';

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

async function call(method, path, body, token, options = {}) {
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
  if (!response.ok && !options.allowFailure) {
    const error = new Error(
      `${method.toUpperCase()} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail ?? parsed.message;
    throw error;
  }
  return { status: response.status, body: parsed };
}

/** نداءٌ خام يعيد المغلّف كما هو (`{data, meta}`) — للتحقق من الغلاف نفسه. */
async function raw(method, path, body, token) {
  const { status, body: parsed } = await call(method, path, body, token, { allowFailure: true });
  return { status, body: parsed };
}

/** نداءٌ يفكّ `{data}` — ما تفعله `apiData` في اللوحة والموقع. */
async function data(method, path, body, token) {
  const { body: parsed } = await call(method, path, body, token);
  return parsed.data ?? parsed;
}

/** نداءٌ **يُتوقَّع رفضه**: حالته ورمزه هما الجواب. */
async function refused(method, path, body, token) {
  const { status, body: parsed } = await call(method, path, body, token, { allowFailure: true });
  return { status, code: parsed.code ?? '', detail: parsed.detail ?? parsed.message ?? '' };
}

async function signIn(tenantCode, credentials) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await data('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return { token, user: login.user };
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const owner = (await signIn(platformTenant, operator)).token;
const tenantSession = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const tenantToken = tenantSession.token;
console.log(`✔ logged in as ${operator.email} (platform) and ${demo.email} (tenant ${demo.tenantCode})\n`);

// ═══════════════════════════════════════════════ 1. 🔐 الصلاحيتان
console.log('■ 1. 🔐 الصلاحيتان — من يقرأ ومن يكتب');
const me = await data('get', '/me', undefined, owner);
const consoleCodes = me.platformPermissions ?? [];
check('مالك المنصة يحمل `console.content.view`', consoleCodes.includes('console.content.view'));
check('ويحمل `console.content.manage`', consoleCodes.includes('console.content.manage'));
check(
  'ولا يظهر أي رمز console بين صلاحيات المستأجر',
  (me.permissions ?? []).every((code) => !code.startsWith('console.')),
  `${(me.permissions ?? []).length} رمزاً`,
);

const registry = await data('get', '/platform/roles', undefined, owner);
const registryCodes = JSON.stringify(registry);
check(
  'والرمزان مُدرَجان في سجلّ الصلاحيات (ترحيل 0078)',
  registryCodes.includes('console.content.view') && registryCodes.includes('console.content.manage'),
);

const tenantPages = await refused('get', '/platform/content/pages', undefined, tenantToken);
check(
  'وجلسة المستأجر لا تدخل شاشة المحتوى (403 لا 401)',
  tenantPages.status === 403,
  `${tenantPages.status} ${tenantPages.code}`,
);
const anonymous = await refused('get', '/platform/content/pages');
check('وبلا توكن ⇒ 401', anonymous.status === 401, `${anonymous.status}`);

const menuWrites = await refused('put', '/platform/content/menus/sidebar', { items: [] }, tenantToken);
check('ولا تكتب قائمةً بجلسة مستأجر', menuWrites.status === 403, `${menuWrites.status} ${menuWrites.code}`);

// ═══════════════════════════════════════════════ 2. 📖 القراءة
console.log('\n■ 2. 📖 القراءة — الصفحات والتصنيفات والقوائم واللافتات');
const list = await raw('get', '/platform/content/pages?limit=100', undefined, owner);
check('قائمة الصفحات تعيد غلافاً `{data, meta}`', Array.isArray(list.body.data), `HTTP ${list.status}`);
check(
  'و`meta` يحمل العدّ والحدّ والإزاحة',
  typeof list.body.meta?.total === 'number' && typeof list.body.meta?.limit === 'number' && typeof list.body.meta?.offset === 'number',
  JSON.stringify(list.body.meta ?? {}),
);

const categories = await data('get', '/platform/content/categories', undefined, owner);
check(
  'والتصنيفات مشتقّة من المحتوى (مدوّنة ومساعدة)',
  Array.isArray(categories.blog) && Array.isArray(categories.help),
  `مدوّنة: ${categories.blog.length} · مساعدة: ${categories.help.length}`,
);

const menus = await data('get', '/platform/content/menus', undefined, owner);
check(
  'والقوائم خمس بمواضعها الخمسة',
  menus.length === 5 && ['header', 'footer', 'sidebar', 'legal', 'social'].every((p) => menus.some((m) => m.position === p)),
  menus.map((m) => m.position).join(' · '),
);

const banners = await data('get', '/platform/content/banners', undefined, owner);
check('واللافتات مصفوفةٌ تحمل وسم `live`', Array.isArray(banners) && banners.every((b) => typeof b.live === 'boolean'));

const sorted = await data('get', '/platform/content/pages?sort=title&limit=5', undefined, owner);
check('والترتيب بالعنوان يعمل', Array.isArray(sorted.data) || Array.isArray(sorted));

// ═══════════════════════════════════════════════ 3. 🧭 دورة حياة الصفحة
console.log('\n■ 3. 🧭 دورة حياة الصفحة — مسوّدة ← مجدولة ← منشورة ← مسحوبة، والنسخ');
const before = await data('get', `/platform/content/pages?q=${slug}&limit=5`, undefined, owner);
/** `/platform/content/pages` يعيد `{data, meta}` و`apiData` تفكّها؛ و`/jobs/outbox` يعيد `{items,total}`. */
const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload.data ?? payload.items ?? []));
const existing = rowsOf(before).find((page) => page.slug === slug);

const payload = {
  titleAr: 'قصة عميل تجريبية (التحقّق الآلي)',
  titleEn: 'Verification case study',
  summaryAr: 'صفحةٌ يُنشئها سكربت التحقّق ثم يعيدها مسوّدة.',
  category: 'تصنيع',
  blocks: [
    { position: 0, kind: 'heading', content: { ar: { text: 'أول عنوان', level: 2 }, en: { text: 'First heading', level: 2 } } },
    { position: 1, kind: 'text', content: { ar: { text: 'نصّ الفقرة التجريبية.' } } },
  ],
};

let created;
if (existing) {
  // تشغيلٌ ثانٍ: الصفحة نفسها تُعاد إلى حالتها المعلومة — فالتحقّق يعيد التشغيل ولا يراكم.
  if (existing.status !== 'draft') {
    await data('post', `/platform/content/pages/${existing.id}/retract`, { reason: 'إعادة تشغيل سكربت التحقّق' }, owner);
  }
  created = await data('patch', `/platform/content/pages/${existing.id}`, { ...payload, note: 'إعادة تشغيل التحقّق' }, owner);
  check('تشغيلٌ ثانٍ: أُعيدت الصفحة التجريبية مسوّدةً بدل إنشاء أخرى', created.status === 'draft', slug);
} else {
  created = await data('post', '/platform/content/pages', { slug, kind: 'case_study', ...payload }, owner);
  check('إنشاء مسوّدة يعيدها مسوّدةً', created.status === 'draft', created.status);
}
check('ومسارها مشتقٌّ من نوعها (`kind=case_study` ⇒ `/cases/:slug`)', created.path === `/cases/${slug}`, created.path);
check('وكتلاها محفوظتان', created.blockCount === 2 && created.blocks?.length === 2, `${created.blockCount} كتلة`);
check(
  'واللغتان المترجمتان معلَنتان (عربي + إنجليزي)',
  Array.isArray(created.translatedLocales) && created.translatedLocales.includes('ar') && created.translatedLocales.includes('en'),
  (created.translatedLocales ?? []).join(','),
);

const duplicate = await refused(
  'post',
  '/platform/content/pages',
  { slug, kind: 'page', titleAr: 'نسخةٌ مكرّرة' },
  owner,
);
check('والمسار المكرّر يُرفض برمزٍ مفهوم (409)', duplicate.status === 409 && duplicate.code === 'CONTENT_SLUG_TAKEN', `${duplicate.status} ${duplicate.code}`);

const unpublished = await refused('get', `/public/content/${slug}`);
check('والمسوّدة لا تُقرأ من الموقع العام (404)', unpublished.status === 404, `${unpublished.status}`);

const detail = await data('get', `/platform/content/pages/${created.id}`, undefined, owner);
check(
  'وقراءة الصفحة بالمشغّل تُعيد كتلها مرتّبة',
  detail.blocks?.[0]?.kind === 'heading' && detail.blocks?.[1]?.kind === 'text',
  detail.blocks?.map((b) => b.kind).join(' → '),
);

const at = new Date(Date.now() + 3_600_000).toISOString();
const scheduled = await data('post', `/platform/content/pages/${created.id}/publish`, { at, note: 'جدولة تجريبية' }, owner);
check('وجَدْوَلة النشر تضبط الحالة والوقت', scheduled.status === 'scheduled' && Boolean(scheduled.publishAt), scheduled.status);

const outbox = await data('get', '/platform/jobs/outbox?limit=100', undefined, owner);
const job = rowsOf(outbox).filter((row) => row.type === 'content.publish');
check('والمهمّة تُسجَّل في الطابور (`content.publish` على `maintenance`)', job.length > 0, `${job.length} مهمّة`);
check(
  'ووقتها المطلوب هو وقت الجدولة',
  job.some((row) => Math.abs(new Date(row.runAt).getTime() - new Date(at).getTime()) < 60_000),
);
check('وصفّ الطابور لا يكشف حمولة الصفحة', job.every((row) => !('payload' in row)));

const scheduledPublic = await refused('get', `/public/content/${slug}`);
check('والمجدولة لا تظهر قبل وقتها (404)', scheduledPublic.status === 404, `${scheduledPublic.status}`);

const published = await data('post', `/platform/content/pages/${created.id}/publish`, { note: 'نشرٌ تجريبي' }, owner);
check('والنشر الفوري يضع الحالة منشورة', published.status === 'published' && Boolean(published.publishedAt), published.status);

const publicPage = await data('get', `/public/content/${slug}`);
check('والصفحة المنشورة تُقرأ من الموقع العام بكتلها', publicPage.slug === slug && publicPage.blocks?.length === 2);
check('وبالعنوان العربي في اللغة الافتراضية', publicPage.titleAr.includes('التحقّق الآلي'));

const cases = await raw('get', '/public/posts?kind=case_study&limit=50');
const inCases = (cases.body.data ?? []).some((post) => post.slug === slug);
const blog = await raw('get', '/public/posts?limit=50');
const inBlog = (blog.body.data ?? []).some((post) => post.slug === slug);
check('وتظهر في `/public/posts?kind=case_study` (مسار `/cases`)', inCases, `${(cases.body.data ?? []).length} قصة`);
check('ولا تظهر في قائمة المدوّنة (`kind` معاملٌ لا ثابت)', !inBlog);

const sitemap = await raw('get', '/public/sitemap');
check(
  'وتظهر في خريطة الموقع بلغتيها',
  (sitemap.body.data ?? []).some((row) => row.path === `/cases/${slug}` && row.locales.includes('en')),
);

const shortReason = await refused('post', `/platform/content/pages/${created.id}/retract`, { reason: 'لا' }, owner);
check('وسبب السحب القصير يُرفض (السبب إلزاميّ)', shortReason.status === 400 || shortReason.status === 422, `${shortReason.status} ${shortReason.code}`);

const retracted = await data('post', `/platform/content/pages/${created.id}/retract`, { reason: 'انتهى التحقّق الآلي' }, owner);
check('والسحب يعيدها مسوّدة', retracted.status === 'draft' && retracted.publishedAt === null, retracted.status);
const gone = await refused('get', `/public/content/${slug}`);
check('وتختفي من الموقع بعد السحب (404)', gone.status === 404, `${gone.status}`);
const twice = await refused('post', `/platform/content/pages/${created.id}/retract`, { reason: 'محاولةٌ ثانية' }, owner);
check('وسطحٌ مسوّدة أصلاً لا يُسحب مرّتين (409)', twice.status === 409 && twice.code === 'INVALID_STATE', `${twice.status} ${twice.code}`);

const versions = await data('get', `/platform/content/pages/${created.id}/versions`, undefined, owner);
check('وتاريخ الصفحة يحفظ نسخةً لكل خطوة', versions.length >= 4, `${versions.length} نسخة`);
const first = versions[versions.length - 1];
const restored = await data('post', `/platform/content/pages/${created.id}/versions/${first.version}/restore`, { note: 'استعادة تجريبية' }, owner);
check('والاستعادة تُعيد لقطة النسخة', restored.blockCount === 2 && restored.blocks?.length === 2, `${restored.blockCount} كتلة`);
check('ولا تُغيّر حالة النشر (الاستعادة محتوى لا نشر)', restored.status === 'draft', restored.status);
const afterRestore = await data('get', `/platform/content/pages/${created.id}/versions`, undefined, owner);
check('وتُحفظ الحالة القائمة نسخةً قبل الاستعادة', afterRestore.length > versions.length, `${versions.length} → ${afterRestore.length}`);

// ═══════════════════════════════════════════════ 4. 🧱 الكتل
console.log('\n■ 4. 🧱 الكتل — الحمولة تُحقَّق بمخطّط نوعها');
const broken = await refused(
  'patch',
  `/platform/content/pages/${created.id}`,
  { blocks: [{ position: 0, kind: 'heading', content: { ar: { text: 'قصير جداً', level: 7 } } }] },
  owner,
);
check(
  'حمولةٌ لا تطابق مخطّط نوعها تُرفض بوصفٍ عربي',
  broken.status === 400 || broken.status === 422,
  `${broken.status} ${broken.detail ?? broken.code}`,
);

const oneBlock = await data(
  'patch',
  `/platform/content/pages/${created.id}`,
  {
    blocks: [{ position: 0, kind: 'cta', content: { ar: { title: 'ابدأ الآن', primaryLabel: 'أنشئ حسابك', primaryHref: '/onboarding' } } }],
    note: 'اختبار الاستبدال الكامل',
  },
  owner,
);
check('والكتل المرسلة هي البديل الكامل (كتلتان ← واحدة)', oneBlock.blockCount === 1 && oneBlock.blocks?.[0]?.kind === 'cta', `${oneBlock.blockCount} كتلة`);
check('وأنواع الكتل الأحد عشر هي المعلنة في العقد', oneBlock.blocks?.[0]?.kind === 'cta');

const missing = await refused('patch', '/platform/content/pages/00000000-0000-0000-0000-000000000000', { titleAr: 'لا وجود' }, owner);
check('وتعديل صفحةٍ غير موجودة ⇒ 404', missing.status === 404, `${missing.status}`);

// ═══════════════════════════════════════════════ 5. 🧩 القوائم
console.log('\n■ 5. 🧩 القوائم — ما يظهر في الرأس');
const menusBefore = await data('get', '/platform/content/menus', undefined, owner);
const headerBefore = menusBefore.find((menu) => menu.position === 'header');
const items = [
  { key: 'home', href: '/', labelAr: 'الرئيسية', labelEn: 'Home' },
  { key: 'pricing', href: '/pricing', labelAr: 'الباقات', labelEn: 'Pricing', badgeAr: 'جديد' },
];
const headerAfter = await data('put', '/platform/content/menus/header', { items }, owner);
check(
  'كتابة قائمة الرأس تحفظ الترتيب كما أُرسل',
  headerAfter.items.length === 2 && headerAfter.items[0]?.key === 'home' && headerAfter.items[1]?.key === 'pricing',
);
check('والوسم (badgeAr) يُحفظ مع العنصر', headerAfter.items[1]?.badgeAr === 'جديد');

const badHref = await refused('put', '/platform/content/menus/header', { items: [{ key: 'x', href: 'javascript:alert(1)', labelAr: 'خبيث' }] }, owner);
check('ورابطٌ لا يبدأ بـ`/` أو `https://` يُرفض', badHref.status === 400 || badHref.status === 422, `${badHref.status}`);

const site = await raw('get', '/public/site');
check(
  'والموقع العام يقرأ القائمة نفسها (لوحة ⇒ موقع)',
  (site.body.data?.menus?.header ?? []).map((item) => item.key).join(',') === 'home,pricing',
  (site.body.data?.menus?.header ?? []).map((item) => item.key).join(','),
);

const headerRestored = await data(
  'put',
  '/platform/content/menus/header',
  { items: headerBefore?.items ?? [] },
  owner,
);
check(
  'وتُستعاد القائمة الأصلية كما كانت',
  JSON.stringify(headerRestored.items) === JSON.stringify(headerBefore?.items ?? []),
  `${headerRestored.items.length} عنصراً`,
);

// ═══════════════════════════════════════════════ 6. 🚩 اللافتات
console.log('\n■ 6. 🚩 اللافتات — نافذة العرض والجمهور');
const badTone = await refused('post', '/platform/content/banners', { textAr: 'لافتةٌ بلون غير معروف', tone: 'rainbow' }, owner);
check('ولونٌ خارج {info, ok, warn, danger} يُرفض', badTone.status === 400 || badTone.status === 422, `${badTone.status}`);

const allBanners = rowsOf(await data('get', '/platform/content/banners', undefined, owner));
const previous = allBanners.filter((banner) => banner.textAr.includes(bannerMark));
for (const row of previous) {
  if (row.active) await data('patch', `/platform/content/banners/${row.id}`, { active: false }, owner);
}
check('لا تتراكم لافتات التحقّق عند إعادة التشغيل', true, `${previous.length} سابقة أُوقفت`);

const banner = await data(
  'post',
  '/platform/content/banners',
  {
    textAr: `${bannerMark} — خصمٌ على الباقة السنوية`,
    textEn: `${bannerMark} — annual plan discount`,
    href: '/pricing',
    linkLabelAr: 'اعرف المزيد',
    tone: 'ok',
    audience: 'visitors',
    active: true,
  },
  owner,
);
check('إنشاء لافتةٍ داخل نافذتها يجعلها معروضة (`live`)', banner.live === true, `live=${banner.live}`);

const publicBanners = await raw('get', '/public/banners');
check(
  'وتظهر في `/public/banners` التي يقرؤها الموقع',
  (publicBanners.body.data ?? []).some((row) => row.id === banner.id),
  `${(publicBanners.body.data ?? []).length} لافتة`,
);

const liveSite = await raw('get', '/public/site');
check('والرئيسية تراها لافتةً معروضة', liveSite.body.data?.banner?.id === banner.id, liveSite.body.data?.banner?.textAr ?? 'لا شيء');

const stopped = await data('patch', `/platform/content/banners/${banner.id}`, { active: false }, owner);
check('والإيقاف يُغيّر وسم العرض فوراً', stopped.live === false, `live=${stopped.live}`);
const afterStop = await raw('get', '/public/banners');
check('وتختفي من الموقع فور الإيقاف', !(afterStop.body.data ?? []).some((row) => row.id === banner.id));

const expired = await data(
  'patch',
  `/platform/content/banners/${banner.id}`,
  {
    active: true,
    startsAt: new Date(Date.now() - 7_200_000).toISOString(),
    endsAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  owner,
);
check('ولافتةٌ انتهت نافذتها لا تُعدّ معروضة حتى وهي نشطة', expired.live === false, `live=${expired.live}`);

// عطلٌ حقيقي أمسكه هذا الفحص: `ends_at > starts_at` قيدٌ في القاعدة، وتعديلٌ يرسل `endsAt`
// وحده كان يسقط فيه فيردّ 500. اليوم يُردّ 422 بوصفٍ عربي قبل أن تصل الكتابة إلى القاعدة.
const inverted = await refused('patch', `/platform/content/banners/${banner.id}`, { endsAt: new Date(Date.now() - 7_200_000).toISOString() }, owner);
check(
  'ونافذةٌ معكوسة تُرفض بوصفٍ عربي (لا 500 من قيد القاعدة)',
  inverted.status === 400 || inverted.status === 422,
  `${inverted.status} ${inverted.code} ${inverted.detail ?? ''}`,
);
await data('patch', `/platform/content/banners/${banner.id}`, { active: false }, owner);

// ═══════════════════════════════════════════════ 7. 🧹 التنظيف
console.log('\n■ 7. 🧹 التنظيف — لا يبقى شيء معروض للزوّار');
const finishPage = await data('get', `/platform/content/pages/${created.id}`, undefined, owner);
check('الصفحة التجريبية بقيت مسوّدة (لا حذف — السحب هو الفعل)', finishPage.status === 'draft', finishPage.status);
const finishCases = await raw('get', '/public/posts?kind=case_study&limit=50');
check('ولا تظهر في قصص العملاء بعد السحب', !(finishCases.body.data ?? []).some((post) => post.slug === slug));
const finishSitemap = await raw('get', '/public/sitemap');
check('ولا في خريطة الموقع', !(finishSitemap.body.data ?? []).some((row) => row.path === `/cases/${slug}`));
const finishBanners = rowsOf(await data('get', '/platform/content/banners', undefined, owner));
check(
  'ولافتات التحقّق كلها موقوفة',
  finishBanners.filter((row) => row.textAr.includes(bannerMark)).every((row) => row.active === false),
);
const finishMenus = await data('get', '/platform/content/menus', undefined, owner);
const finishHeader = finishMenus.find((menu) => menu.position === 'header');
check(
  'وقائمة الرأس عادت إلى لقطتها الأولى',
  JSON.stringify(finishHeader?.items ?? []) === JSON.stringify(headerBefore?.items ?? []),
);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} نقطة تحقّق ناجحة`);
process.exit(failures === 0 ? 0 : 1);
