import type { Metadata } from 'next';

import { TrustView } from '../../components/site/views';
import { fetchPage } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

/**
 * P-M8 — `/trust` (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * الصفحة **خادمية** لا عميلية: محتواها ثابتٌ (ملفٌّ في `lib/trust.ts`) ومعه — إن وُجدت — صفحةٌ
 * تحريرية من نظام إدارة المحتوى بالـslug نفسه (`trust`)، فتُعرض فوق الأقسام الثابتة لا بدلاً
 * منها. فيصل النصّ في HTML الأول (يقرؤه محرّك البحث)، وتُحرَّر مقدّمته من اللوحة بلا نشر كود.
 *
 * `dynamic = 'force-dynamic'` لأن الصفحة تقرأ المحتوى من الـAPI في كل طلب، كما تفعل
 * `/features` و`/help` — فلا تُخزَّن نسخةٌ تسبق تعديلاً في اللوحة.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({
    locale: 'ar',
    path: '/trust',
    titleKey: 'trust.title',
    descriptionKey: 'trust.subtitle',
  });
}

export default async function TrustPage() {
  const page = await fetchPage('trust');
  return <TrustView locale="ar" page={page} />;
}
