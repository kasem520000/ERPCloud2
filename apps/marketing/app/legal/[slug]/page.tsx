import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LegalView } from '../../../components/site/views';
import { fetchPage } from '../../../lib/content';
import { contentMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'legal') {
    return { title: 'غير موجود', description: 'المستند غير موجود', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'ar',
    page,
    path: `/legal/${slug}`,
    fallbackTitle: 'مستندات قانونية',
    fallbackDescription: 'مستندٌ قانوني من المنصّة',
  });
}

export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'legal') notFound();
  return <LegalView locale="ar" page={page} />;
}
