import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '../../../../components/site/views';
import { fetchPage } from '../../../../lib/content';
import { contentMetadata } from '../../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'case_study') {
    return { title: 'Not found', description: 'Case study not found', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'en',
    page,
    path: `/en/cases/${slug}`,
    fallbackTitle: 'Case studies',
    fallbackDescription: 'A customer case study',
  });
}

export default async function CasePageEn({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'case_study') notFound();
  return (
    <ArticleView
      locale="en"
      page={page}
      basePath="/en/cases"
      baseLabel="Case studies"
      trail={[
        { href: '/en', label: 'Home' },
        { href: '/en/cases', label: 'Case studies' },
      ]}
    />
  );
}
