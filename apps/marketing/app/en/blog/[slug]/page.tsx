import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { JsonLd } from '../../../../components/site/pieces';
import { ArticleView } from '../../../../components/site/views';
import { fetchPage } from '../../../../lib/content';
import { contentMetadata, siteInfo } from '../../../../lib/meta';
import { articleJsonLd } from '../../../../lib/site';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page) {
    return { title: 'Not found', description: 'Article not found', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'en',
    page,
    path: `/en/blog/${slug}`,
    fallbackTitle: 'Blog',
    fallbackDescription: 'An article from the product blog',
    type: 'article',
  });
}

export default async function BlogPostPageEn({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'post') notFound();
  const site = await siteInfo();
  return (
    <>
      <JsonLd
        data={articleJsonLd({
          site,
          title: page.titleEn ?? page.titleAr,
          description: page.seo.descriptionEn ?? page.summaryEn ?? page.summaryAr ?? '',
          path: `/blog/${slug}`,
          publishedAt: page.publishedAt,
          authorName: page.authorName,
        })}
      />
      <ArticleView
        locale="en"
        page={page}
        basePath="/en/blog"
        baseLabel="Blog"
        trail={[
          { href: '/en', label: 'Home' },
          { href: '/en/blog', label: 'Blog' },
        ]}
      />
    </>
  );
}
