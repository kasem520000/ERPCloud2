import type { Metadata } from 'next';

import { BlogIndexView } from '../../../components/site/views';
import { fetchPosts } from '../../../lib/content';
import { staticMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'en', path: '/en/blog', titleKey: 'blog.title', descriptionKey: 'blog.subtitle' });
}

export default async function BlogPageEn({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const [page, all] = await Promise.all([fetchPosts({ category, limit: 24 }), fetchPosts({ limit: 50 })]);
  const categories = [
    ...new Set(all.items.map((item) => item.category).filter((value): value is string => Boolean(value))),
  ];
  return <BlogIndexView locale="en" posts={page.items} categories={categories} activeCategory={category} />;
}
