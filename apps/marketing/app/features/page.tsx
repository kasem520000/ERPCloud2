import type { Metadata } from 'next';

import { FeaturesView } from '../../components/site/views';
import { fetchPage } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/features', titleKey: 'features.title', descriptionKey: 'features.subtitle' });
}

export default async function FeaturesPage() {
  const page = await fetchPage('features');
  return <FeaturesView locale="ar" page={page} />;
}
