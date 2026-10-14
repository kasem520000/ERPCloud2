/**
 * P-M2 · P-M5 — قراءة المحتوى من الخادم لا من الكود (الخطّة §3.2).
 *
 * **على الخادم لا في المتصفح**: الصفحات مكوّناتٌ خادمية (`server components`) تقرأ من
 * `/public/*` وقت الطلب، فيصل HTML كاملٌ فيه العنوان والوصف والبيانات المنظَّمة — وهذا شرط
 * كل ما في `lib/site.ts`. لو قُرئ المحتوى في المتصفح لَما رأى محرّك البحث شيئاً.
 *
 * **وإلى أين يتّصل؟** إلى الـAPI الداخلي (`API_PROXY_TARGET` أو `127.0.0.1:3000`) — الخادم
 * يخاطب الخادم. والمتصفح لا يعرف هذا العنوان أبداً؛ ما يخصّه مكتوب في `lib/api.ts` كمساراتٍ
 * نسبية يمرّرها `next.config.mjs` إلى نفس الـAPI.
 *
 * **وبلا محتوى لا تسقط الصفحة**: كل دالة هنا تُعيد قيمةً احتياطية عند الفشل (شبكة، أو
 * خادمٌ لم يقم بعد)، لأن موقعاً يعرض «500» لأن الـAPI تعطّل أسوأ من موقعٍ يعرض قسمه
 * الثابت. و`tests/site.spec.ts` يقيس هذا السلوك.
 */

import type { Locale } from './i18n';

const apiBase = (
  process.env.API_INTERNAL_BASE ??
  process.env.API_PROXY_TARGET ??
  `http://127.0.0.1:${process.env.PORT ?? 3000}`
).replace(/\/+$/, '');

export type ContentBlock = {
  id: string;
  position: number;
  kind: string;
  content: { ar: unknown; en: unknown | null };
};

export type ContentPageSummary = {
  slug: string;
  kind: string;
  titleAr: string;
  titleEn: string | null;
  summaryAr: string | null;
  summaryEn: string | null;
  path: string;
  category: string | null;
  authorName: string | null;
  publishedAt: string;
  ogImageUrl?: string | null;
};

export type ContentPageDetail = ContentPageSummary & {
  status: string;
  defaultLocale: Locale;
  translatedLocales: Locale[];
  seo: { titleAr: string | null; titleEn: string | null; descriptionAr: string | null; descriptionEn: string | null };
  blocks: ContentBlock[];
};

export type MenuItem = { key: string; href: string; labelAr: string; labelEn?: string | null; badgeAr?: string | null };
export type ContentBanner = {
  id: string;
  textAr: string;
  textEn: string | null;
  href: string | null;
  linkLabelAr: string | null;
  linkLabelEn: string | null;
  tone: string;
  live: boolean;
};

/** قشرة الموقع: الهوية والقوائم واللافتة — من `GET /public/site`. */
export type ShellData = {
  site: {
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
  menus: Record<string, MenuItem[]>;
  banner: ContentBanner | null;
};

/**
 * زمن إعادة التحقّق: **صفر في التطوير، ٣٠ ثانية في الإنتاج**.
 *
 * في التطوير يقيس `scripts/verify-marketing-site.mjs` ما كُتب في نظام المحتوى **الآن** —
 * فكاشٌ نصف دقيقةٍ يجعل التحقّق الحيّ يقول «لم تظهر» وهو مخطئ. وفي الإنتاج لا يجوز أن يدفع
 * كل زائر ثمن قراءة الخادم، فالثلاثون ثانية حدٌّ معقول بين «نُشر» و«ظهر».
 */
/**
 * مدّة صلاحية ذاكرة البيانات (ثوانٍ) — **قابلةٌ للضبط** بـ`MARKETING_REVALIDATE_SECONDS`:
 * الافتراضي 30 ثانية في الإنتاج و0 في التطوير (بلا تخزين)، ونشرٌ محليٌّ للعرض يضبطها 0
 * فيظهر تعديل المشغّل في الصفحة فوراً (وهو الوعد المُقاس في `verify-*.mjs`).
 */
export const REVALIDATE_SECONDS = Number(
  process.env.MARKETING_REVALIDATE_SECONDS ?? (process.env.NODE_ENV === 'production' ? 30 : 0),
);

async function getJson<T>(path: string, fallback: T, revalidate = REVALIDATE_SECONDS): Promise<T> {
  try {
    const response = await fetch(`${apiBase}/api/v1${path}`, {
      next: { revalidate },
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as { data?: T };
    return (payload.data ?? payload) as T;
  } catch {
    return fallback;
  }
}

export type SiteShell = {
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
  menus: Record<string, MenuItem[]>;
  banner: ContentBanner | null;
};

const emptyShell: SiteShell = {
  brandName: 'Cloud SaaS ERP',
  brandInitials: 'ERP',
  taglineAr: 'نظام تخطيط موارد المؤسسات السحابي',
  taglineEn: 'Cloud ERP for growing businesses',
  supportEmail: '',
  supportPhone: '',
  defaultLocale: 'ar',
  locales: ['ar', 'en'],
  siteUrl: '',
  companyLegalName: '',
  maintenance: false,
  menus: { header: [], footer: [], legal: [], social: [], sidebar: [] },
  banner: null,
};

/** قشرة الموقع كاملة — تُقرأ مرّةً في التخطيط وتُمرَّر لكل صفحة. */
export async function fetchShell(): Promise<SiteShell> {
  const data = await getJson<Partial<SiteShell>>('/public/site', {});
  return {
    ...emptyShell,
    ...data,
    menus: { ...emptyShell.menus, ...(data.menus ?? {}) },
    banner: data.banner ?? null,
  };
}

/** صفحةٌ منشورة بالـslug — `null` تعني «لا تُعرض» (مسوّدة أو غير موجودة، بلا تفريق). */
export async function fetchPage(slug: string): Promise<ContentPageDetail | null> {
  const page = await getJson<ContentPageDetail | null>(`/public/content/${encodeURIComponent(slug)}`, null);
  return page && page.status === 'published' ? page : null;
}

export type ListMeta = { total: number; limit: number; offset: number };

export async function fetchPosts(
  options: { kind?: string; category?: string; limit?: number; offset?: number } = {},
): Promise<{ items: ContentPageSummary[]; meta: ListMeta }> {
  const query = new URLSearchParams();
  if (options.kind) query.set('kind', options.kind);
  if (options.category) query.set('category', options.category);
  query.set('limit', String(options.limit ?? 12));
  query.set('offset', String(options.offset ?? 0));
  const payload = await getJson<{ data?: ContentPageSummary[]; meta?: ListMeta } | ContentPageSummary[]>(
    `/public/posts?${query.toString()}`,
    [],
  );
  if (Array.isArray(payload)) {
    return { items: payload, meta: { total: payload.length, limit: options.limit ?? 12, offset: 0 } };
  }
  const items = payload.data ?? [];
  return { items, meta: payload.meta ?? { total: items.length, limit: options.limit ?? 12, offset: 0 } };
}

export type HelpMeta = ListMeta & { categories: Array<{ name: string; count: number }> };

/**
 * `GET /public/help` — القائمة **والفئات معها** (P-M9).
 *
 * والاحتياط عند الفشل فارغٌ لا مخترع: صفحةُ مساعدةٍ تعرض فئاتٍ من العدم أسوأ من صفحةٍ تقول
 * «لا مقالات»، لأن الفئة الكاذبة تقود الزائر إلى نتيجةٍ لا توجد.
 */
export async function fetchHelp(
  options: { q?: string; category?: string; limit?: number } = {},
): Promise<{ items: ContentPageSummary[]; meta: HelpMeta }> {
  const query = new URLSearchParams();
  if (options.q) query.set('q', options.q);
  if (options.category) query.set('category', options.category);
  query.set('limit', String(options.limit ?? 20));
  const payload = await getJson<{ data?: ContentPageSummary[]; meta?: HelpMeta } | ContentPageSummary[]>(
    `/public/help?${query.toString()}`,
    [],
  );
  const fallback: HelpMeta = { total: 0, limit: 20, offset: 0, categories: [] };
  if (Array.isArray(payload)) return { items: payload, meta: { ...fallback, total: payload.length } };
  const items = payload.data ?? [];
  return { items, meta: payload.meta ?? { ...fallback, total: items.length } };
}

/** مقالُ مساعدةٍ كامل كما يردّه `GET /public/help/:slug` (P-M9). */
export type HelpArticle = {
  page: ContentPageDetail;
  category: string | null;
  related: ContentPageSummary[];
  helpful: { yes: number; no: number };
};

export async function fetchHelpArticle(slug: string): Promise<HelpArticle | null> {
  const payload = await getJson<HelpArticle | null>(`/public/help/${encodeURIComponent(slug)}`, null);
  return payload && payload.page.status === 'published' ? payload : null;
}

/** حالة الخدمة كما يردّها `GET /public/status` (P-M9) — و`null` تعني «تعذّر القياس». */
export type SiteStatus = {
  status: 'up' | 'degraded' | 'down' | 'not_configured';
  statusLabelAr: string;
  statusLabelEn: string;
  statusTone: 'ready' | 'pending' | 'failed' | 'muted';
  checkedAt: string;
  uptimeSeconds: number;
  incident: { message: string | null; since: string | null } | null;
  components: Array<{
    key: string;
    labelAr: string;
    labelEn: string;
    whatAr: string;
    whatEn: string;
    status: 'up' | 'degraded' | 'down' | 'not_configured';
    noteAr: string;
    noteEn: string;
    latencyMs: number | null;
  }>;
  noteAr: string;
  noteEn: string;
};

export async function fetchStatus(): Promise<SiteStatus | null> {
  return getJson<SiteStatus | null>('/public/status', null, 0);
}

/** مدخلات سجلّ التغييرات — `kind=changelog` على مسار المقالات نفسه (P-M9). */
export async function fetchChangelog(limit = 24): Promise<ContentPageSummary[]> {
  const payload = await getJson<{ data?: ContentPageSummary[] } | ContentPageSummary[]>(
    `/public/posts?kind=changelog&limit=${limit}`,
    [],
  );
  return Array.isArray(payload) ? payload : (payload.data ?? []);
}

export type FaqItem = { slug: string; question: string; answer: string };

export async function fetchFaq(limit = 8): Promise<FaqItem[]> {
  return getJson<FaqItem[]>(`/public/faq?limit=${limit}`, []);
}

export type SitemapRow = { path: string; kind: string; lastModified: string; locales: Locale[] };

export async function fetchSitemap(): Promise<SitemapRow[]> {
  return getJson<SitemapRow[]>('/public/sitemap', []);
}

/** نصّ الكتلة بلغتها — وإن غابت الترجمة يُعرض الأصل العربي (لا فراغٌ صامت). */
export function blockFor(block: ContentBlock, locale: Locale): unknown {
  if (locale === 'en') return block.content.en ?? block.content.ar;
  return block.content.ar ?? block.content.en;
}

/** عنوان الصفحة بلغتها مع السقوط إلى العربية. */
export function titleFor(page: Pick<ContentPageSummary, 'titleAr' | 'titleEn'>, locale: Locale): string {
  return (locale === 'en' ? page.titleEn : page.titleAr) ?? page.titleAr;
}

export function summaryFor(page: Pick<ContentPageSummary, 'summaryAr' | 'summaryEn'>, locale: Locale): string {
  return (locale === 'en' ? page.summaryEn : page.summaryAr) ?? page.summaryAr ?? '';
}

/** تاريخٌ مقروء بالعربية أو الإنجليزية — بلا مكتبة تواريخ ثقيلة. */
export function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** لغات المحتوى المتاحة للعرض (تُقاس من الترجمة لا من الكوكي). */
export function isTranslated(page: Pick<ContentPageDetail, 'translatedLocales'>, locale: Locale): boolean {
  return page.translatedLocales.includes(locale);
}
