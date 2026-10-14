import type { Metadata } from 'next';

import { IndustriesView } from '../../components/site/views';
import { fetchPage } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

/**
 * P-M8 — `/industries`: فهرس القطاعات (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * الصفحة تعرض القطاعات الخمسة من `lib/industries.ts` — ومصدرُ كل سطرٍ فيها شاشةٌ في تطبيق
 * العمل بملفها وسطرها. ولها — مثل `/trust` — إمكان صفحةٍ تحريرية من نظام المحتوى بالـslug
 * نفسه تُعرض كمقدّمة.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({
    locale: 'ar',
    path: '/industries',
    titleKey: 'industries.title',
    descriptionKey: 'industries.subtitle',
  });
}

export default async function IndustriesPage() {
  const page = await fetchPage('industries');
  return <IndustriesView locale="ar" page={page} />;
}
