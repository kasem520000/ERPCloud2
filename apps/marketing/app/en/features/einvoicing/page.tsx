import type { Metadata } from 'next';

import { EinvoicingView } from '../../../../components/site/views';
import { fetchPage } from '../../../../lib/content';
import { staticMetadata } from '../../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'en', path: '/en/features/einvoicing', titleKey: 'einvoicing.title' });
}

export default async function EinvoicingPageEn() {
  const page = await fetchPage('features-einvoicing');
  return <EinvoicingView locale="en" page={page} />;
}
