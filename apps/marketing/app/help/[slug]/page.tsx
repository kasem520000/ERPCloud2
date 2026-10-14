import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HelpArticleView } from '../../../components/site/views';
import { fetchHelpArticle } from '../../../lib/content';
import { contentMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

/**
 * P-M9 — `/help/[slug]`: المقال من **مسار المساعدة المخصّص** (`/public/help/:slug`) لا من
 * `/public/content/:slug`. والفرق ليس تجميلياً: المسار المخصّص يحكم النوع في الخدمة، فمقالٌ
 * من نوعٍ آخر أو مسوّدة **لا يصل** إلى هذه الصفحة أصلاً — فلا تتحوّل إلى بابٍ خلفي للمدوّنة.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = await fetchHelpArticle(slug);
  if (!article) {
    return { title: 'غير موجود', description: 'المقال غير موجود', robots: { index: false, follow: false } };
  }
  return contentMetadata({
    locale: 'ar',
    page: article.page,
    path: `/help/${slug}`,
    fallbackTitle: 'مركز المساعدة',
    fallbackDescription: 'مقالٌ من مركز المساعدة',
  });
}

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await fetchHelpArticle(slug);
  if (!article) notFound();
  return <HelpArticleView locale="ar" article={article} />;
}
