import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '../../../components/site/views';
import { fetchPage } from '../../../lib/content';
import { contentMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

/**
 * P-M9 — مدخل سجلّ التغييرات.
 *
 * والصفحة تُبنى من `fetchPage` مع **شرط النوع** `changelog` في الصفحة نفسها: النوع هنا وسمُ
 * عرضٍ لا سياقُ وصول (المدخل صفحةٌ من المحتوى كغيرها)، والشرط يمنع أن يفتح `/changelog/<slug>`
 * مقالَ مدوّنة — وإلّا صار لكل مقالٍ رابطٌ ثانٍ ينافس رابطه الأصلي في نتائج البحث.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'changelog') {
    return { title: 'غير موجود', description: 'المدخل غير موجود', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'ar',
    page,
    path: `/changelog/${slug}`,
    fallbackTitle: 'سجلّ التغييرات',
    fallbackDescription: 'تحديثٌ منشور في سجلّ التغييرات',
  });
}

export default async function ChangelogEntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'changelog') notFound();
  return (
    <ArticleView
      locale="ar"
      page={page}
      basePath="/changelog"
      baseLabel="سجلّ التغييرات"
      trail={[
        { href: '/', label: 'الرئيسية' },
        { href: '/changelog', label: 'سجلّ التغييرات' },
      ]}
    />
  );
}
