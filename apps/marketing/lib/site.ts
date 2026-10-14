/**
 * P-M1 — SEO بنيوي: كل ما يُبنى مرّةً ويُستعمل في كل صفحة.
 *
 * الدوال هنا **خالصة** (بلا `fetch` وبلا JSX) لسببٍ عمليّ: تُقاس في
 * `tests/site.spec.ts` بلا خادم. فما يُقاس هو القرار — هل للصفحة عنوانٌ ووصفٌ و`canonical`
 * و`hreflang`؟ — لا شكل الصفحة.
 *
 * وقاعدتان من الخطّة §3 محفوظتان هنا:
 *
 *   1. **لا أرقام ولا شهادات مخترعة**: لا تُبنى بياناتٌ منظَّمة (`JSON-LD`) إلا من محتوى
 *      حقيقي وصل من الخادم. فدالّة الأسئلة الشائعة تُعيد `null` حين لا أسئلة.
 *   2. **الرابط المطلق من إعدادات الموقع** (`site.url` في نظام المحتوى) لا من `localhost`
 *      مكتوبٍ في الكود — فخريطة الموقع تشير إلى النطاق الصحيح في كل بيئة.
 */

import type { Metadata } from 'next';

import { industrySlugs } from './industries';
import { DEFAULT_LOCALE, LOCALES, localePath, type Locale } from './i18n';

/** هوية الموقع كما يعيدها `GET /public/site` (نطاقٌ مقصود: ما تحتاجه القشرة وSEO). */
export type SiteInfo = {
  brandName: string;
  brandInitials: string;
  taglineAr: string;
  taglineEn: string;
  supportEmail: string;
  supportPhone: string;
  defaultLocale: Locale;
  locales: Locale[];
  siteUrl: string;
  companyLegalName: string;
  maintenance: boolean;
};

/** احتياطيٌ يعمل بلا خادم: القشرة لا تسقط لأن الـAPI لم يُجِب. */
export const fallbackSite: SiteInfo = {
  brandName: 'Cloud SaaS ERP',
  brandInitials: 'ERP',
  taglineAr: 'نظام تخطيط موارد المؤسسات السحابي',
  taglineEn: 'Cloud ERP for growing businesses',
  supportEmail: '',
  supportPhone: '',
  defaultLocale: DEFAULT_LOCALE,
  locales: [...LOCALES],
  siteUrl: '',
  companyLegalName: '',
  maintenance: false,
};

export const SITE_PATHS = {
  home: '/',
  features: '/features',
  einvoicing: '/features/einvoicing',
  blog: '/blog',
  cases: '/cases',
  help: '/help',
  pricing: '/pricing',
  contact: '/contact',
  // P-M6: طلب العرض مسارٌ حقيقي بمصدره الخاص (`demo`) — ومسارٌ حقيقي لا يُستثنى من الخريطة.
  demo: '/demo',
  onboarding: '/onboarding',
  login: '/login',
  verify: '/verify',
  // P-M7: صفحة الخروج من القائمة — مسارٌ حقيقي يُفتح من كل رسالة حملة. **وخارج خريطة
  // الموقع عن قصد**: صفحةُ إجراءٍ لا صفحةُ محتوى، وتُعلَن `noindex` في `metadata`.
  unsubscribe: '/unsubscribe',
  // P-M8: القطاعات وصفحة الثقة — عربيّان وحدهما اليوم (`bilingual: false` في `navigation.ts`)،
  // فالترجمة لا تُعلَن قبل أن توجد.
  industries: '/industries',
  trust: '/trust',
  // P-M9: سجلّ التغييرات وحالة الخدمة — عربيّان وحدهما اليوم، وصفوفُهما في خريطة الموقع.
  // و`/status` يُفهرَس عن قصد: صفحةُ حالةٍ لا يجدها محرّك البحث تُقرأ كأنها غير موجودة.
  changelog: '/changelog',
  status: '/status',
  maintenance: '/maintenance',
} as const;

/**
 * المسارات التي لها نظيرٌ في اللغتين. `hreflang` **لا يُعلَن إلا لنظيرٍ موجود**: إعلان
 * `/en/verify` وهو غير موجود خطأٌ يُعاقبه محرّك البحث أكثر من غياب الوسم.
 */
export const BILINGUAL_PATHS: readonly string[] = [
  SITE_PATHS.home,
  SITE_PATHS.features,
  SITE_PATHS.einvoicing,
  SITE_PATHS.blog,
  SITE_PATHS.cases,
  SITE_PATHS.help,
  '/blog/[slug]',
  '/help/[slug]',
  '/cases/[slug]',
  '/legal/[slug]',
];

export function hasEnglishTwin(path: string): boolean {
  if (BILINGUAL_PATHS.includes(path)) return true;
  return BILINGUAL_PATHS.some((known) => known.includes('[slug]') && path.startsWith(known.replace('[slug]', '')));
}

/** رابطٌ مطلق بالدالة الواحدة — ولا يُلحق شرطةً مزدوجة أبداً. */
export function absoluteUrl(path: string, siteUrl = ''): string {
  const base = siteUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${suffix}` : suffix;
}

/** عنوان الصفحة الكامل: «العنوان · اسم العلامة» — لا تكرار إن كانا واحداً. */
export function pageTitle(title: string, site: Pick<SiteInfo, 'brandName'>): string {
  return title.includes(site.brandName) ? title : `${title} · ${site.brandName}`;
}

/** وصفٌ من محتوى حقيقي: يُقتطع عند حدّ محرّكات البحث (١٦٠ حرفاً تقريباً). */
export function clampDescription(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

export type PageMetaInput = {
  locale: Locale;
  /** المسار في هذه اللغة (`/en/blog` مثلاً). */
  path: string;
  title: string;
  description: string;
  site: SiteInfo;
  image?: string | null;
  type?: 'website' | 'article';
  publishedTime?: string | null;
};

/**
 * `generateMetadata` من مكانٍ واحد: عنوانٌ ووصفٌ و`canonical` و`hreflang` وOpen Graph
 * وبطاقة تويتر. و`alternates.languages` تُبنى من `localePath` — أي من الدالّة نفسها التي
 * يستعملها مبدّل اللغة في القشرة، فلا يختلف الرابط المُعلَن عن الرابط المعروض.
 */
export function buildMetadata(input: PageMetaInput): Metadata {
  const { locale, path, title, description, site } = input;
  // العنوان يمرّ **مجرداً**: قالب التخطيط (`%s · brand`) هو من يُلحقه بالعلامة، فلو ألحقناه
  // هنا لظهر مرّتين (`المدوّنة · Cloud SaaS ERP · Cloud SaaS ERP`).
  const fullTitle = pageTitle(title, site);
  const url = absoluteUrl(path, site.siteUrl);
  const purePath = localePath(path, 'ar');
  const arabicUrl = absoluteUrl(purePath, site.siteUrl);
  const englishUrl = absoluteUrl(localePath(purePath, 'en'), site.siteUrl);
  const twin = hasEnglishTwin(purePath);
  const image = input.image ?? undefined;

  return {
    title,
    description,
    metadataBase: site.siteUrl ? new URL(site.siteUrl) : undefined,
    alternates: {
      canonical: url,
      ...(twin ? { languages: { ar: arabicUrl, en: englishUrl, 'x-default': arabicUrl } } : {}),
    },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: site.brandName,
      locale: locale === 'ar' ? 'ar_SA' : 'en_US',
      alternateLocale: locale === 'ar' ? ['en_US'] : ['ar_SA'],
      type: input.type ?? 'website',
      ...(image ? { images: [{ url: image }] } : {}),
      ...(input.publishedTime ? { publishedTime: input.publishedTime } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      ...(image ? { images: [image] } : {}),
    },
    robots: { index: true, follow: true },
  };
}

// ─────────────────────────────────────────────────────────────── البيانات المنظَّمة

/** كائنٌ عام للربط: `Organization` — يُطبع في القشرة مرّةً واحدة. */
export function organizationJsonLd(site: SiteInfo): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: site.brandName,
    ...(site.companyLegalName ? { legalName: site.companyLegalName } : {}),
    url: absoluteUrl('/', site.siteUrl),
    ...(site.supportEmail ? { email: site.supportEmail } : {}),
    ...(site.supportPhone ? { telephone: site.supportPhone } : {}),
  };
}

/** `SoftwareApplication` — المنتج نفسه، بلغته وبدون تقييماتٍ مخترعة. */
export function softwareJsonLd(site: SiteInfo, locale: Locale, description: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: site.brandName,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description,
    url: absoluteUrl(locale === 'ar' ? '/' : '/en', site.siteUrl),
    inLanguage: locale,
    // لا `aggregateRating`: نظامٌ لا يجمع تقييماتٍ بعد لا يُعلن رقماً.
  };
}

export function faqJsonLd(items: Array<{ question: string; answer: string }>): Record<string, unknown> | null {
  if (items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

export function articleJsonLd(input: {
  site: SiteInfo;
  title: string;
  description: string;
  path: string;
  publishedAt: string | null;
  authorName: string | null;
}): Record<string, unknown> {
  const url = absoluteUrl(input.path, input.site.siteUrl);
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: input.title,
    description: input.description,
    mainEntityOfPage: url,
    ...(input.publishedAt ? { datePublished: input.publishedAt } : {}),
    ...(input.authorName ? { author: { '@type': 'Organization', name: input.authorName } } : {}),
    publisher: { '@type': 'Organization', name: input.site.brandName },
  };
}

export function breadcrumbJsonLd(site: SiteInfo, trail: Array<{ name: string; path: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path, site.siteUrl),
    })),
  };
}

// ─────────────────────────────────────────────────────────────── خريطة الموقع

export type SitemapRow = { path: string; lastModified?: string; locales?: Locale[] };

/**
 * صفوف `sitemap.xml` من مسارات الموقع + مسارات المحتوى القادمة من `/public/sitemap`.
 * واللغتان تصيران صفّين لمسارٍ واحد مع `alternates` — وهذا ما تفهمه محرّكات البحث.
 */
export function sitemapEntries(
  site: SiteInfo,
  contentRows: SitemapRow[],
  options: { now?: string } = {},
): Array<{
  url: string;
  lastModified: string;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
  priority: number;
  alternates?: { languages: Record<string, string> };
}> {
  const fallbackDate = options.now ?? new Date().toISOString();
  const staticPaths: SitemapRow[] = [
    { path: SITE_PATHS.home, locales: ['ar', 'en'] },
    { path: SITE_PATHS.features, locales: ['ar', 'en'] },
    { path: SITE_PATHS.einvoicing, locales: ['ar', 'en'] },
    { path: SITE_PATHS.blog, locales: ['ar', 'en'] },
    { path: SITE_PATHS.cases, locales: ['ar', 'en'] },
    { path: SITE_PATHS.help, locales: ['ar', 'en'] },
    // الصفحات أحادية اللغة: عربيةٌ وحدها، فلا تُعلَن نظائرُ لها.
    { path: SITE_PATHS.pricing, locales: ['ar'] },
    { path: SITE_PATHS.contact, locales: ['ar'] },
    // P-M6: مساران كانا خارج الخريطة (`/demo` وُلد في P-M6، و`/onboarding` وُلد في P-M4
    // ولم يُدرَج) — ومسارُ تحويلٍ حقيقيّ لا يُخفى عن محرّكات البحث.
    { path: SITE_PATHS.demo, locales: ['ar'] },
    { path: SITE_PATHS.onboarding, locales: ['ar'] },
    { path: SITE_PATHS.verify, locales: ['ar'] },
    // P-M8: `/trust` و`/industries` مساراتُ محتوى تُفهرَس، وصفحاتُ القطاعات الخمس تُضاف لكلٍّ
    // بحسب قطاعه (لا نظير لها بالإنجليزية بعد).
    { path: SITE_PATHS.trust, locales: ['ar'] },
    { path: SITE_PATHS.industries, locales: ['ar'] },
    { path: SITE_PATHS.changelog, locales: ['ar'] },
    { path: SITE_PATHS.status, locales: ['ar'] },
    ...industrySlugs.map((slug: string): SitemapRow => ({ path: `${SITE_PATHS.industries}/${slug}`, locales: ['ar'] })),
  ];

  const rows = [...staticPaths, ...contentRows];
  const seen = new Set<string>();
  const entries: ReturnType<typeof sitemapEntries> = [];

  for (const row of rows) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    const locales = row.locales && row.locales.length > 0 ? row.locales : [DEFAULT_LOCALE];
    const both = locales.includes('ar') && locales.includes('en');
    entries.push({
      url: absoluteUrl(row.path, site.siteUrl),
      lastModified: row.lastModified ?? fallbackDate,
      changeFrequency: row.path === SITE_PATHS.home ? 'daily' : 'weekly',
      priority: row.path === SITE_PATHS.home ? 1 : 0.7,
      ...(both
        ? {
            alternates: {
              languages: {
                ar: absoluteUrl(row.path, site.siteUrl),
                en: absoluteUrl(localePath(row.path, 'en'), site.siteUrl),
              },
            },
          }
        : {}),
    });
  }
  return entries;
}

/** `robots.txt` — يمنع فهرسة الـAPI ويفتح كل ما هو محتوى. */
export function robotsRules(site: SiteInfo): { rules: { userAgent: string; allow?: string[]; disallow: string[] }[]; sitemap: string } {
  return {
    // `/not-found-view` مسارٌ داخليّ للوسيط (يُخدَم بحالة 404): لا يُفهرَس ولا يُتتبَّع.
    rules: [{ userAgent: '*', allow: ['/'], disallow: ['/api/', '/login', '/not-found-view/'] }],
    sitemap: absoluteUrl('/sitemap.xml', site.siteUrl),
  };
}

/** المسار المطلق لصفحةٍ بحسب لغتها — يُستعمل في الروابط الداخلية. */
export function hrefFor(path: string, locale: Locale): string {
  return localePath(path, locale);
}
