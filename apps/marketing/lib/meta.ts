/**
 * P-M1 — ربطٌ صغير بين المحتوى و`lib/site.ts`: يجلب هوية الموقع ثم يبني `Metadata`.
 *
 * وظيفته منع التكرار في أربعة عشر ملفّ مسار: كلٌّ منها يسمّي مفتاحه ونصّه الاحتياطي،
 * والبناء واحد. وهي **خالصة الحكم**: لا تُقرّر نصّاً، بل تُمرّره.
 */

import type { Metadata } from 'next';

import { fetchShell, summaryFor, titleFor, type ContentPageDetail } from './content';
import { t, type Locale } from './i18n';
import { buildMetadata, clampDescription, fallbackSite, type SiteInfo } from './site';

export async function siteInfo(): Promise<SiteInfo> {
  const shell = await fetchShell();
  return {
    ...fallbackSite,
    ...shell,
    locales: shell.locales.length > 0 ? shell.locales : fallbackSite.locales,
  };
}

/** ميتاداتا صفحةٍ ثابتة: عنوانها ووصفها من قاموس اللغة. */
export async function staticMetadata(input: {
  locale: Locale;
  path: string;
  titleKey?: string;
  title?: string;
  descriptionKey?: string;
  description?: string;
  image?: string | null;
  type?: 'website' | 'article';
}): Promise<Metadata> {
  const site = await siteInfo();
  const rawTitle = input.title ?? t(input.locale, input.titleKey ?? '');
  const description = clampDescription(
    input.description ??
      (input.descriptionKey ? t(input.locale, input.descriptionKey) : '') ??
      (input.locale === 'ar' ? site.taglineAr : site.taglineEn),
  );
  return buildMetadata({
    locale: input.locale,
    path: input.path,
    title: rawTitle || site.brandName,
    description: description || (input.locale === 'ar' ? site.taglineAr : site.taglineEn),
    site,
    image: input.image ?? null,
    type: input.type,
  });
}

/**
 * ميتاداتا صفحةٍ من نظام المحتوى: العنوان والوصف من الصفحة نفسها (مع سقوطٍ احتياطيّ)،
 * و`canonical` من نوعها ومسارها — فلا تختلف حقيقتان عن صفحةٍ واحدة.
 */
export async function contentMetadata(input: {
  locale: Locale;
  page: ContentPageDetail;
  path: string;
  fallbackTitle: string;
  fallbackDescription: string;
  type?: 'website' | 'article';
}): Promise<Metadata> {
  const site = await siteInfo();
  const { locale, page } = input;
  const seoTitle = locale === 'en' ? page.seo.titleEn : page.seo.titleAr;
  const seoDescription = locale === 'en' ? page.seo.descriptionEn : page.seo.descriptionAr;
  const title = seoTitle ?? titleFor(page, locale);
  const description = clampDescription(seoDescription ?? summaryFor(page, locale) ?? input.fallbackDescription);
  return buildMetadata({
    locale,
    path: input.path,
    title,
    description,
    site,
    image: page.ogImageUrl ?? null,
    type: input.type ?? 'website',
    publishedTime: page.publishedAt,
  });
}

/**
 * P-M8 — ميتاداتا صفحة قطاع: العنوان والوصف من `lib/industries.ts` لا من قاعدة البيانات،
 * فالصفحةُ ومحتواها من مصدرٍ واحد. و`canonical` هو مسارها نفسه (`/industries/<slug>`) —
 * وليس لها نظيرٌ إنجليزي بعد، فلا يُعلَن `hreflang` لها (`hasEnglishTwin` تعرف ذلك).
 */
export async function industryMetadata(input: {
  slug: string;
  label: string;
  summary: string;
}): Promise<Metadata> {
  const site = await siteInfo();
  return buildMetadata({
    locale: 'ar',
    path: `/industries/${input.slug}`,
    title: `${input.label} — وحدةٌ قائمة في النظام`,
    description: clampDescription(input.summary),
    site,
  });
}
