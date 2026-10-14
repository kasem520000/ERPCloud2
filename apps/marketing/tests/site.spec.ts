import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dir, localeFromPath, localePath, LOCALES } from '../lib/i18n';
import { siteFooterLinks, siteNavLinks, siteRoutes } from '../lib/navigation';
import {
  articleJsonLd,
  breadcrumbJsonLd,
  buildMetadata,
  faqJsonLd,
  fallbackSite,
  hasEnglishTwin,
  organizationJsonLd,
  robotsRules,
  sitemapEntries,
  softwareJsonLd,
} from '../lib/site';

/**
 * P-M1 — «الأساس والتصميم وSEO» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * الاختبار مقسومٌ قسمين عن قصد:
 *
 *   * **بنية**: كل مسارٍ مُعلَن له ملفُّ صفحةٍ حقيقي بلغتيه (رابطٌ بلا صفحة أسوأ من لا رابط).
 *   * **SEO**: عنوانٌ ووصفٌ و`canonical` و`hreflang` لكل صفحة، وبياناتٌ منظَّمة تُبنى من
 *     محتوى حقيقي — ولا `aggregateRating` ولا رقم مخترَع.
 *
 * وما لا يُقاس هنا (الحالة الحقيقية 200، والترويسات، والـHTML الناتج) يُقاس في
 * `scripts/verify-marketing-site.mjs` على خادمٍ يعمل — وهذا الفرق بين سبيك الوحدة وسكربت
 * التحقّق الحيّ (بوابة القبول §11: اختبار + سكربت يُعيد الحالة).
 */

const appDir = fileURLToPath(new URL('../app', import.meta.url));

const pageFileFor = (href: string, locale: 'ar' | 'en'): string => {
  const base = locale === 'en' ? href.replace(/^\/en/, '') || '/' : href;
  const relative = base === '/' ? 'page.tsx' : `${base.replace(/^\//, '')}/page.tsx`;
  return locale === 'en' ? join(appDir, 'en', relative) : join(appDir, relative);
};

describe('marketing site structure (P-M1)', () => {
  it('كل مسار مُعلَن له ملفّ صفحة — بالعربية والإنجليزية حين يُعلن أنه ثنائي اللغة', () => {
    for (const route of siteRoutes) {
      expect(existsSync(pageFileFor(route.href, 'ar')), `ar: ${route.href}`).toBe(true);
      if (route.bilingual) {
        expect(existsSync(pageFileFor(route.href, 'en')), `en: ${route.href}`).toBe(true);
      }
    }
  });

  it('المسارات الديناميكية الثلاثة لها صفحاتٌ في اللغتين', () => {
    for (const relative of ['blog/[slug]/page.tsx', 'help/[slug]/page.tsx', 'cases/[slug]/page.tsx', 'legal/[slug]/page.tsx']) {
      expect(existsSync(join(appDir, relative)), relative).toBe(true);
      expect(existsSync(join(appDir, 'en', relative)), `en/${relative}`).toBe(true);
    }
  });

  it('للموقع صفحة 404 وخريطة موقع وrobots', () => {
    for (const relative of ['not-found.tsx', 'sitemap.ts', 'robots.ts']) {
      expect(existsSync(join(appDir, relative)), relative).toBe(true);
    }
    expect(existsSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)))).toBe(true);
  });

  it('القشرة تعرض التنقّل والتذييل في اللغتين بلا رابط فارغ', () => {
    for (const locale of LOCALES) {
      const nav = siteNavLinks(locale);
      expect(nav.length).toBeGreaterThanOrEqual(5);
      expect(nav.every((link) => link.href.startsWith('/') && link.label.length > 0)).toBe(true);

      const footer = siteFooterLinks(locale);
      expect(footer.map((group) => group.key)).toContain('product');
      expect(footer.flatMap((group) => group.links).every((link) => link.href.startsWith('/'))).toBe(true);
    }
    // الإنجليزية تحت `/en` والعربية على الجذر — وهذا ما يجعل `hreflang` ممكناً.
    expect(siteNavLinks('ar').every((link) => !link.href.startsWith('/en'))).toBe(true);
    expect(siteNavLinks('en').every((link) => link.href === '/en' || link.href.startsWith('/en/'))).toBe(true);
  });
});

describe('marketing i18n (P-M1)', () => {
  it('اللغة من المسار لا من كوكي، و`dir` منها', () => {
    expect(localeFromPath('/')).toBe('ar');
    expect(localeFromPath('/blog/x')).toBe('ar');
    expect(localeFromPath('/en')).toBe('en');
    expect(localeFromPath('/en/blog/x')).toBe('en');
    // كلمةٌ تبدأ بـ`en` ليست لغةً إنجليزية: `/energy` عربية.
    expect(localeFromPath('/energy')).toBe('ar');

    expect(dir('ar')).toBe('rtl');
    expect(dir('en')).toBe('ltr');
  });

  it('localePath ذهاباً وإياباً بلا فقدان مسار', () => {
    const pairs: Array<[string, string]> = [
      ['/', '/en'],
      ['/blog', '/en/blog'],
      ['/blog/kayfa-tabdaa', '/en/blog/kayfa-tabdaa'],
      ['/legal/terms', '/en/legal/terms'],
    ];
    for (const [arabic, english] of pairs) {
      expect(localePath(arabic, 'en')).toBe(english);
      expect(localePath(english, 'ar')).toBe(arabic);
      // ثنائيّة السفر: العودة إلى اللغة نفسها لا تُزيح المسار.
      expect(localePath(arabic, 'ar')).toBe(arabic);
      expect(localePath(english, 'en')).toBe(english);
    }
  });
});

describe('marketing SEO (P-M1)', () => {
  const site = { ...fallbackSite, siteUrl: 'https://erp.example.sa', supportEmail: 'sales@erp.example.sa' };

  it('كل صفحة تُنتج عنواناً ووصفاً وcanonical وhreflang', () => {
    const metadata = buildMetadata({
      locale: 'ar',
      path: '/blog',
      title: 'المدوّنة · Cloud SaaS ERP',
      description: 'ما نكتبه عن المحاسبة والتشغيل.',
      site,
    });
    expect(metadata.title).toBe('المدوّنة · Cloud SaaS ERP');
    expect(metadata.description).toBeTruthy();
    expect(metadata.alternates?.canonical).toBe('https://erp.example.sa/blog');
    expect(metadata.alternates?.languages).toEqual({
      ar: 'https://erp.example.sa/blog',
      en: 'https://erp.example.sa/en/blog',
      'x-default': 'https://erp.example.sa/blog',
    });
    expect(metadata.openGraph?.locale).toBe('ar_SA');
  });

  it('الصفحة الإنجليزية تُعلن نظيرها العربي، والصفحة أحادية اللغة لا تُعلن شيئاً', () => {
    const english = buildMetadata({
      locale: 'en',
      path: '/en/help',
      title: 'Help center · Cloud SaaS ERP',
      description: 'Short articles.',
      site,
    });
    expect(english.alternates?.canonical).toBe('https://erp.example.sa/en/help');
    expect(english.alternates?.languages).toMatchObject({ ar: 'https://erp.example.sa/help' });

    // `/pricing` عربيةٌ وحدها: `alternates.languages` غائبة لا كاذبة.
    expect(hasEnglishTwin('/pricing')).toBe(false);
    const pricing = buildMetadata({
      locale: 'ar',
      path: '/pricing',
      title: 'الباقات',
      description: 'أسعار المنصّة',
      site,
    });
    expect(pricing.alternates?.languages).toBeUndefined();
    expect(pricing.alternates?.canonical).toBe('https://erp.example.sa/pricing');
  });

  it('البيانات المنظَّمة تُبنى من محتوى حقيقي — وبلا تقييماتٍ مخترعة', () => {
    const organization = organizationJsonLd(site);
    expect(organization['@type']).toBe('Organization');
    expect(organization.url).toBe('https://erp.example.sa/');
    expect(organization).not.toHaveProperty('aggregateRating');

    const software = softwareJsonLd(site, 'ar', 'نظام تخطيط موارد المؤسسات السحابي');
    expect(software['@type']).toBe('SoftwareApplication');
    expect(software.inLanguage).toBe('ar');

    const faq = faqJsonLd([{ question: 'كم تستغرق البداية؟', answer: 'أقل من ساعة.' }]);
    expect(faq?.['@type']).toBe('FAQPage');
    expect((faq?.mainEntity as unknown[]).length).toBe(1);
    // بلا أسئلة لا يُعلن FAQPage فارغ.
    expect(faqJsonLd([])).toBeNull();

    const article = articleJsonLd({
      site,
      title: 'كيف تبدأ؟',
      description: 'خطواتٌ أولى',
      path: '/blog/kayfa-tabdaa',
      publishedAt: '2026-09-01T00:00:00.000Z',
      authorName: 'فريق المنصّة',
    });
    expect(article['@type']).toBe('Article');
    expect(article.mainEntityOfPage).toBe('https://erp.example.sa/blog/kayfa-tabdaa');
    expect(article).not.toHaveProperty('aggregateRating');

    const breadcrumbs = breadcrumbJsonLd(site, [
      { name: 'الرئيسية', path: '/' },
      { name: 'المدوّنة', path: '/blog' },
    ]);
    expect((breadcrumbs.itemListElement as unknown[]).length).toBe(2);
  });

  it('خريطة الموقع تجمع الصفحات الثابتة والمحتوى، وتمنع التكرار', () => {
    const entries = sitemapEntries(
      site,
      [
        { path: '/blog/kayfa-tabdaa', lastModified: '2026-09-10T00:00:00.000Z', locales: ['ar', 'en'] },
        { path: '/help/rabat-alfatoura', lastModified: '2026-09-11T00:00:00.000Z', locales: ['ar'] },
        // صفٌّ مكرّر: يُسقَط لأن خريطة الموقع بمفتاح `path`.
        { path: '/blog/kayfa-tabdaa', lastModified: '2026-09-12T00:00:00.000Z', locales: ['ar'] },
      ],
      { now: '2026-09-17T00:00:00.000Z' },
    );

    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain('https://erp.example.sa/');
    // P-M6: مسارا التحويل (`/demo` و`/onboarding`) في الخريطة — صدرٌ يُبحث عنه، وشاشةٌ
    // لا تُعلن في الخريطة شاشةٌ لا يجدها من يبحث عنها.
    expect(urls).toContain('https://erp.example.sa/demo');
    expect(urls).toContain('https://erp.example.sa/onboarding');
    expect(urls).toContain('https://erp.example.sa/blog/kayfa-tabdaa');
    // النظير الإنجليزي **لا يُكرَّر صفّاً**: يُعلَن بديلاً بالـ`hreflang` داخل الصفّ نفسه
    // (`alternates.languages`) — وهذا ما يقرؤه محرّك البحث كصفحتين لمعنًى واحد.
    expect(urls.filter((url) => url === 'https://erp.example.sa/en').length).toBe(0);
    expect(urls.filter((url) => url.endsWith('/blog/kayfa-tabdaa')).length).toBe(1);

    const bilingual = entries.find((entry) => entry.url.endsWith('/blog/kayfa-tabdaa'));
    expect(bilingual?.alternates?.languages).toEqual({
      ar: 'https://erp.example.sa/blog/kayfa-tabdaa',
      en: 'https://erp.example.sa/en/blog/kayfa-tabdaa',
    });
    // مقالٌ عربيٌّ وحده لا يُعلَن له نظير إنجليزي غير موجود.
    const arabicOnly = entries.find((entry) => entry.url.endsWith('/help/rabat-alfatoura'));
    expect(arabicOnly?.alternates).toBeUndefined();
    expect(arabicOnly?.lastModified).toBe('2026-09-11T00:00:00.000Z');
  });

  it('robots يمنع الـAPI ويفتح المحتوى ويشير إلى خريطة الموقع', () => {
    const rules = robotsRules(site);
    expect(rules.rules[0]?.disallow).toContain('/api/');
    expect(rules.rules[0]?.allow).toContain('/');
    expect(rules.sitemap).toBe('https://erp.example.sa/sitemap.xml');
  });

  it('لا يحتوي الموقع رقماً تسويقياً مزخرفاً ولا شهادةً مكتوبة في الكود', () => {
    // حماية مبدأ §3.1: الأرقام والشهادات تأتي من نظام المحتوى. الملفات الثابتة هنا لا
    // يجوز أن تحمل أرقاماً تسويقية («+500 عميل»، «%99»).
    const files = ['../components/site/views.tsx', '../components/site/pieces.tsx', '../lib/modules.ts'];
    for (const relative of files) {
      const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      expect(text).not.toMatch(/[+٪%]\s?\d{2,}\s*(عميل|منشأة|مستخدم|دقة|رضا)/u);
      expect(text).not.toMatch(/\b\d{2,}\s*(customers|users|uptime)\b/i);
    }
  });
});
