import type { Metadata } from 'next';

import { BlogIndexView } from '../../components/site/views';
import { fetchPosts } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/blog', titleKey: 'blog.title', descriptionKey: 'blog.subtitle' });
}

export default async function BlogPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const [page, all] = await Promise.all([fetchPosts({ category, limit: 24 }), fetchPosts({ limit: 50 })]);
  // التصنيفات من المقالات نفسها: لا قائمةٌ مكتوبة في الكود تنسى تصنيفاً جديداً.
  const categories = [
    ...new Set(all.items.map((item) => item.category).filter((value): value is string => Boolean(value))),
  ];
  return <BlogIndexView locale="ar" posts={page.items} categories={categories} activeCategory={category} />;
}
