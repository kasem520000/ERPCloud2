import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '../../../components/site/views';
import { fetchPage } from '../../../lib/content';
import { contentMetadata } from '../../../lib/meta';
import { buildMetadata, articleJsonLd } from '../../../lib/site';
import { JsonLd } from '../../../components/site/pieces';
import { siteInfo } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page) {
    // صفحةٌ غير منشورة لا تُفهرَس ولا تُوصَف: 404 حقيقي من `notFound()`.
    return buildMetadata({
      locale: 'ar',
      path: `/blog/${slug}`,
      title: 'غير موجود',
      description: 'المقال غير موجود',
      site: await siteInfo(),
    });
  }
  return contentMetadata({
    locale: 'ar',
    page,
    path: `/blog/${slug}`,
    fallbackTitle: 'المدوّنة',
    fallbackDescription: 'مقالٌ من مدوّنة المنصّة',
    type: 'article',
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page || page.kind !== 'post') notFound();
  const site = await siteInfo();
  return (
    <>
      <JsonLd
        data={articleJsonLd({
          site,
          title: page.titleAr,
          description: page.seo.descriptionAr ?? page.summaryAr ?? '',
          path: `/blog/${slug}`,
          publishedAt: page.publishedAt,
          authorName: page.authorName,
        })}
      />
      <ArticleView locale="ar" page={page} basePath="/blog" baseLabel="المدوّنة" />
    </>
  );
}
