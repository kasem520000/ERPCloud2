import type { Metadata } from 'next';

import { CasesIndexView } from '../../components/site/views';
import { fetchPosts } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/cases', titleKey: 'cases.title' });
}

export default async function CasesPage() {
  const { items } = await fetchPosts({ kind: 'case_study', limit: 24 });
  return <CasesIndexView locale="ar" cases={items} />;
}
