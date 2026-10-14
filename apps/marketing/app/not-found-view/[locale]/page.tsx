import type { Metadata } from 'next';

import { RouteNotFound } from '../../../components/site/views';
import { isLocale, type Locale } from '../../../lib/i18n';

/**
 * صفحة 404 بلغة صاحبها — واللغة **في المسار** (`/not-found-view/en`).
 *
 * لماذا مسارٌ خاص؟ لأن حالة الردّ يجب أن تكون 404 لا 200: في Next تُرسَل الحالة مع أول بايت
 * من التصيير، وهذا التخطيط ديناميكيّ (يقرأ ترويسة المسار ليضبط `lang`/`dir`)، فـ`notFound()`
 * من صفحةٍ ديناميكية ينتهي بـ200 — أي «خطأٌ ناعم» (soft 404) يدفع ثمنه فهرسة الموقع.
 * فالوسيط يسأل الـAPI عن الـslug، وما لم يُنشر يُعيد كتابة الطلب إلى هنا **بحالة 404**.
 *
 * واللغة تُمرَّر قطعةً في المسار لا ترويسة: الترويسة تُقرأ في التصيير (فتعمل)، أما ميتاداتا
 * الصفحة فتُحسب في مسارٍ آخر لا يراها فيه — وقطعة المسار يعرفها الاثنان.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: locale === 'en' ? 'Page not found' : 'الصفحة غير موجودة',
    robots: { index: false, follow: false },
  };
}

export default async function NotFoundView({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <RouteNotFound locale={(isLocale(locale) ? locale : 'ar') as Locale} />;
}
