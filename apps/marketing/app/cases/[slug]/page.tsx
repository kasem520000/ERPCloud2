import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '../../../components/site/views';
import { fetchPage } from '../../../lib/content';
import { contentMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'case_study') {
    return { title: 'غير موجود', description: 'دراسة الحالة غير موجودة', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'ar',
    page,
    path: `/cases/${slug}`,
    fallbackTitle: 'دراسات حالة',
    fallbackDescription: 'دراسة حالة من عملاء المنصّة',
  });
}

export default async function CasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'case_study') notFound();
  return <ArticleView locale="ar" page={page} basePath="/cases" baseLabel="دراسات حالة" />;
}
