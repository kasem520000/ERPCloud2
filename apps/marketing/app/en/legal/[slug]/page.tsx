import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LegalView } from '../../../../components/site/views';
import { fetchPage } from '../../../../lib/content';
import { contentMetadata } from '../../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'legal') {
    return { title: 'Not found', description: 'Document not found', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'en',
    page,
    path: `/en/legal/${slug}`,
    fallbackTitle: 'Legal',
    fallbackDescription: 'A legal document',
  });
}

export default async function LegalPageEn({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'legal') notFound();
  return <LegalView locale="en" page={page} />;
}
