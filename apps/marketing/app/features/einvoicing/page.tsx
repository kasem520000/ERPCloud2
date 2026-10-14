import type { Metadata } from 'next';

import { EinvoicingView } from '../../../components/site/views';
import { fetchPage } from '../../../lib/content';
import { staticMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/features/einvoicing', titleKey: 'einvoicing.title' });
}

/**
 * صفحة القسم — والمحتوى من نظام إدارة المحتوى بـslug `features-einvoicing`.
 * الربط بين المسار المرئي (`/features/einvoicing`) والـslug (`features-einvoicing`) مقصود:
 * الـslug في نظام المحتوى بلا شرطةٍ مائلة (قاعدة `contentSlugSchema`)، والرابط مقروء.
 */
export default async function EinvoicingPage() {
  const page = await fetchPage('features-einvoicing');
  return <EinvoicingView locale="ar" page={page} />;
}
