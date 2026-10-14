import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { IndustryView } from '../../../components/site/views';
import { industryBySlug, industrySlugs } from '../../../lib/industries';
import { industryMetadata } from '../../../lib/meta';

/**
 * P-M8 — صفحة قطاع (`/industries/tailoring` وأخواتها، `docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **القطاعات مصدرها الكود لا قاعدة البيانات**: هي مطابقةٌ للوحدات الرأسية القائمة في
 * `apps/staff`، فلو جاءت من جدولٍ في اللوحة لأمكن أن تُضاف قطاعاتٌ لا شاشة لها — وهي بالضبط
 * العلّة التي بُنيت هذه الصفحة لتفاديها. ولذلك `generateStaticParams` من المصدر نفسه، والـslug
 * غير المعروف يعطي 404 صريحةً لا صفحةً فارغة.
 *
 * `dynamic = 'force-dynamic'` تبقى للاتّساق مع بقية الأسطح: القشرة (قائمةُ الرأس والتذييل)
 * تُقرأ من `/public/site` في كل طلب، فلا تُخزَّن صفحةٌ بقائمةٍ قديمة.
 */
export const dynamic = 'force-dynamic';

export function generateStaticParams(): Array<{ slug: string }> {
  return industrySlugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const industry = industryBySlug(slug);
  if (!industry) {
    return { title: 'قطاعٌ غير معروف', description: 'لا قطاع بهذا المسار', robots: { index: false, follow: false } };
  }
  return industryMetadata({ slug, label: industry.labelAr, summary: industry.summaryAr });
}

export default async function IndustryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const industry = industryBySlug(slug);
  if (!industry) notFound();
  return <IndustryView locale="ar" industry={industry} />;
}
