import type { Metadata } from 'next';

import { StatusView } from '../../components/site/views';
import { fetchStatus } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

/**
 * P-M9 — `/status`: حالة الخدمة كما يراها العميل.
 *
 * **وبلا ذاكرة في الطبقة الأولى**: `fetchStatus` ينادي بـ`revalidate: 0`، لأن صفحةَ حالةٍ
 * تُخبر عن لحظةٍ مضت أسوأ من صفحةٍ تُخبر أنها لم تستطع القياس. والذاكرة الوحيدة هي عشر ثوانٍ
 * في خدمة الـAPI — حدٌّ يمنع الاستنزاف ولا يُخفي تغيّراً حقيقياً.
 */
export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({
    locale: 'ar',
    path: '/status',
    titleKey: 'status.title',
    descriptionKey: 'status.subtitle',
    type: 'website',
  });
}

export default async function StatusPage() {
  const status = await fetchStatus();
  return <StatusView locale="ar" status={status} />;
}
