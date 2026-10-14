import type { Metadata } from 'next';

import { FeaturesView } from '../../../components/site/views';
import { fetchPage } from '../../../lib/content';
import { staticMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'en', path: '/en/features', titleKey: 'features.title', descriptionKey: 'features.subtitle' });
}

export default async function FeaturesPageEn() {
  const page = await fetchPage('features');
  return <FeaturesView locale="en" page={page} />;
}
