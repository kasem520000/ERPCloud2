import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { RouteNotFound } from '../components/site/views';
import { localeFromPath, isLocale, type Locale } from '../lib/i18n';

/**
 * صفحة 404 — تُرسم بلغة المسار الذي رفضه الوسيط.
 *
 * واللغة تُقرأ من ترويسة `x-pathname` التي يضعها `middleware.ts` (وهي التي يضبط بها التخطيط
 * `lang`/`dir` كذلك). ومع ذلك تبقى بوابة الحالة الحقيقية في الوسيط: هو من يعيد **404** بدل
 * 200 لصفحةٍ غير منشورة (السبب مشروح في `app/not-found-view/[locale]/page.tsx`).
 */
export const metadata: Metadata = {
  // عنوانٌ بلغتين عمداً: حدود `not-found` في Next قد تُحسب ميتاداتاها بمسارٍ لا يمرّ
  // بالترويسة، فلا ندّعي لغةً واحدة على صفحةٍ قد تُخدَم لأيٍّ منهما.
  title: '404 — الصفحة غير موجودة / Page not found',
  robots: { index: false, follow: false },
};

export default async function NotFound() {
  const pathname = (await headers()).get('x-pathname') ?? '/';
  const candidate = localeFromPath(pathname);
  return <RouteNotFound locale={(isLocale(candidate) ? candidate : 'ar') as Locale} />;
}
