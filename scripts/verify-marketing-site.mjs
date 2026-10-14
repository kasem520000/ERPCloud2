/**
 * verify-marketing-site.mjs — التحقّق الحيّ للموقع التسويقي (P-M1 · P-M2 · P-M5 من ناحية الموقع).
 *
 * يقيس **HTML المعروض** لا كود المصدر: أن يعمل الموقع للزائر، وأن يُقرأ لمحرّك البحث، وأن
 * يظهر فيه ما يُكتب في نظام إدارة المحتوى — **الآن** (زمن إعادة التحقّق صفر في التطوير).
 *
 * أربعة أقسام (≈ 24 نقطة):
 *
 *   1. القشرة واللغتان: `lang` و`dir` لكل لغة، والقائمة والتذييل، واللافتة من الإعدادات.
 *   2. SEO: عنوانٌ ووصفٌ و`canonical` و`hreflang` على كل صفحة، وبيانات منظَّمة.
 *   3. خريطة الموقع وrobots: XML صحيح، وروابط مطلقة، ومنع الـAPI.
 *   4. **من اللوحة إلى الموقع**: يُكتب مقالٌ في نظام المحتوى (بالأدوات الحقيقية: `POST
 *      /platform/content/pages` ثم النشر) ويُتحقّق أنه ظهر في `/blog` وفي صفحته وفي
 *      `/en/blog` وفي `sitemap.xml` — ثم يُسحب فيختفي. وهذه هي بوابة القبول §11: نقطة
 *      نهاية حقيقية لكل شاشة، لا نصّ ثابت.
 *
 * Usage: node scripts/verify-marketing-site.mjs
 */
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

const stamp = Date.now().toString(36);

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

async function page(path) {
  const response = await fetch(`${siteBase}${path}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  const html = await response.text();
  return { status: response.status, html };
}

const tag = (html, pattern) => (html.match(pattern) ?? [])[1] ?? '';
const all = (html, pattern) => {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...html.matchAll(global)].map((match) => match[1] ?? '');
};

/** `hrefLang` تُصدَّر من React بصيغة الحرف الكبير — والوسم في HTML لا يفرّق الحالة، والقياس يطابق الاثنين. */
const hreflangs = (html) => all(html, /rel="alternate"\s+hrefLang="([^"]*)"/gi);

async function apiCall(method, path, body, token) {
  const response = await fetch(`${apiBase}${path}`, {
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
    error.detail = parsed.detail ?? parsed.message;
    throw error;
  }
  return parsed.data ?? parsed;
}

async function signIn() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await apiCall('post', '/auth/login', { tenantCode: platformTenant, ...operator });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error('login failed');
      return token;
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const slug = `site-verify-${stamp}`;
let createdId = null;

try {
  // ═══════════════════════════════════════════════ 1. القشرة واللغتان
  console.log(`■ 1. 🧭 القشرة واللغتان — ${siteBase}`);
  const home = await page('/');
  check('الصفحة الرئيسية تُخدَم في التطوير', home.status === 200);
  check('والعربية معلنة عنصراً واتجاهاً', tag(home.html, /<html[^>]*lang="(ar)"/) === 'ar' && /dir="rtl"/.test(home.html));
  check('والقائمة مرسومة', home.html.includes('site-nav'), `${all(home.html, /class="site-nav"[\s\S]{0,400}?<\/nav>/).length} قائمة`);
  check('والتذييل مرسوم', home.html.includes('site-footer'));
  check('والوحدات الثمانية معروضة', all(home.html, /class="card-icon"/g).length >= 8);

  const english = await page('/en');
  check('والصفحة الإنجليزية تعمل', english.status === 200);
  check('وتعلن `lang="en"` و`dir="ltr"`', /lang="en"/.test(english.html) && /dir="ltr"/.test(english.html));

  const routes = ['/features', '/features/einvoicing', '/blog', '/help', '/cases', '/maintenance', '/pricing', '/contact', '/verify', '/onboarding', '/login'];
  const routeResults = [];
  for (const path of routes) {
    const { status } = await page(path);
    routeResults.push(`${path}:${status}`);
  }
  check('كل مسارٍ معلن يعمل', routeResults.every((entry) => entry.endsWith(':200')), routeResults.join(' '));

  const englishRoutes = ['/en/features', '/en/features/einvoicing', '/en/blog', '/en/help', '/en/cases'];
  const englishResults = [];
  for (const path of englishRoutes) {
    const { status } = await page(path);
    englishResults.push(`${path}:${status}`);
  }
  check('ولكل مسارٍ نظيرٌ إنجليزي يعمل', englishResults.every((entry) => entry.endsWith(':200')), englishResults.join(' '));

  const missing = await page('/safha-la-tujad');
  check('وصفحة 404 حقيقية لا صفحة بيضاء', missing.status === 404 && missing.html.includes('404'));

  // ═══════════════════════════════════════════════ 2. SEO
  console.log('\n■ 2. 🔎 SEO — ما يقرؤه محرّك البحث');
  const homeTitle = tag(home.html, /<title>([^<]*)<\/title>/);
  const homeDescription = tag(home.html, /<meta name="description" content="([^"]*)"/);
  check('عنوانٌ للصفحة الرئيسية', homeTitle.length > 5, homeTitle);
  check('ووصفٌ لها', homeDescription.length > 10, homeDescription.slice(0, 60));
  const homeCanonical = all(home.html, /rel="canonical" href="([^"]*)"/)[0] ?? '';
  check(
    'وcanonical للصفحة الرئيسية يشير إلى أصل الموقع',
    homeCanonical === siteBase || homeCanonical === `${siteBase}/`,
    homeCanonical,
  );
  const homeLanguages = hreflangs(home.html);
  check(
    'وhreflang يعلن العربية والإنجليزية',
    homeLanguages.includes('ar') && homeLanguages.includes('en'),
    homeLanguages.join(', '),
  );

  const blog = await page('/blog');
  const blogLanguages = hreflangs(blog.html);
  const blogCanonical = all(blog.html, /rel="canonical" href="([^"]*)"/)[0] ?? '';
  check('وصفحة المدوّنة تُعلن نظيرها الإنجليزي', blogLanguages.includes('en'));
  check('وcanonical يشير إلى `/blog`', blogCanonical.endsWith('/blog'), blogCanonical);

  const enBlog = await page('/en/blog');
  const enBlogCanonical = all(enBlog.html, /rel="canonical" href="([^"]*)"/)[0] ?? '';
  check('ونظيرها الإنجليزي يشير إلى `/en/blog`', enBlogCanonical.endsWith('/en/blog'), enBlogCanonical);

  const jsonLd = [...home.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  });
  const types = jsonLd.filter(Boolean).map((entry) => entry['@type']);
  check('وبيانات منظَّمة Organization', types.includes('Organization'));
  check('وبيانات SoftwareApplication', types.includes('SoftwareApplication'));

  // ═══════════════════════════════════════════════ 3. خريطة الموقع وrobots
  console.log('\n■ 3. 🗺️ خريطة الموقع وrobots');
  const sitemapResponse = await fetch(`${siteBase}/sitemap.xml`);
  const sitemap = await sitemapResponse.text();
  check('sitemap.xml يُخدَم', sitemapResponse.status === 200);
  check('وهو XML صحيح بخريطة عناوين', sitemap.includes('<urlset') && sitemap.includes('sitemaps.org'));
  check('وفيه بديل اللغتين', sitemap.includes('hreflang="en"') && sitemap.includes('hreflang="ar"'));
  check('وروابطه مطلقة', /<loc>https?:\/\//.test(sitemap));
  const robotsResponse = await fetch(`${siteBase}/robots.txt`);
  const robots = await robotsResponse.text();
  check('robots.txt يُخدَم', robotsResponse.status === 200);
  check('ويشير إلى الخريطة', /Sitemap:\s*https?:\/\//.test(robots));
  check('ويمنع فهرسة الـAPI', robots.includes('Disallow: /api/'));

  // ═══════════════════════════════════════════════ 4. من اللوحة إلى الموقع
  console.log('\n■ 4. ✍️ من اللوحة إلى الموقع — كتابةٌ تظهر بلا نشرة');
  const token = await signIn();
  const created = await apiCall('post', '/platform/content/pages', {
    slug,
    kind: 'post',
    titleAr: `مقال تحقّق ${stamp}`,
    titleEn: `Verification post ${stamp}`,
    summaryAr: 'ملخّصٌ كتبه سكربت التحقّق.',
    summaryEn: 'A summary written by the verification script.',
    category: 'تحقّق',
    authorName: 'سكربت التحقّق',
    seoTitleAr: 'عنوان SEO للتحقّق',
    seoDescAr: 'وصفُ SEO كتبه سكربت التحقّق.',
    blocks: [{ position: 0, kind: 'text', content: { ar: { text: 'نصُّ المقال الذي يجب أن يظهر في الصفحة.' } } }],
  }, token);
  createdId = created.id;
  check('كُتب مقاله في نظام المحتوى', created.status === 'draft');

  const postPage = await page(`/blog/${slug}`);
  check('والمسوّدة لا تُعرض على الموقع', postPage.status === 404);

  await apiCall('post', `/platform/content/pages/${createdId}/publish`, {}, token);
  const blogAfter = await page('/blog');
  check('وبعد النشر يظهر في قائمة المدوّنة', blogAfter.html.includes(slug));

  const articlePage = await page(`/blog/${slug}`);
  check('وله صفحةٌ خاصة تعمل', articlePage.status === 200);
  check('وقدمت عنوانه', articlePage.html.includes(`مقال تحقّق ${stamp}`));
  check('وقدمة SEO من الحقل المخصّص', articlePage.html.includes('عنوان SEO للتحقّق'));
  const articleLanguages = hreflangs(articlePage.html);
  check('وتُعلن لغتها ونظيرها', articleLanguages.includes('ar') && articleLanguages.includes('en'));
  const articleTypes = [...articlePage.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => {
      try {
        return JSON.parse(match[1])['@type'];
      } catch {
        return '';
      }
    });
  check('وبيانات Article', articleTypes.includes('Article'));

  const englishArticle = await page(`/en/blog/${slug}`);
  check('ونظيرها الإنجليزي يعرض العنوان الإنجليزي', englishArticle.status === 200 && englishArticle.html.includes(stamp));

  const sitemapAfter = await (await fetch(`${siteBase}/sitemap.xml`)).text();
  check('وظهر في خريطة الموقع', sitemapAfter.includes(`/blog/${slug}`));

  await apiCall('post', `/platform/content/pages/${createdId}/retract`, { reason: 'تنظيف التحقّق' }, token);
  const blogFinal = await page('/blog');
  const articleFinal = await page(`/blog/${slug}`);
  check('وبعد السحب يختفي من الموقع', !blogFinal.html.includes(slug) && articleFinal.status === 404);
} catch (error) {
  failures += 1;
  console.error(`\n✗ توقّف التحقّق: ${error.message}`);
} finally {
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} نقطة تحقّق ناجحة`);
  process.exit(failures === 0 ? 0 : 1);
}
