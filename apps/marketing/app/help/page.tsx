import type { Metadata } from 'next';

import { HelpIndexView } from '../../components/site/views';
import { fetchHelp } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/help', titleKey: 'help.title', descriptionKey: 'help.subtitle' });
}

/**
 * P-M9 — `/help`: الفئات من نظام المحتوى، والبحث المرشَّح بالفئة.
 *
 * والقراءة **خادمية** (`fetchHelp` → `/public/help`) فيصل HTML كاملاً بالمقالات والفئات،
 * ويبقى `q` و`category` في الرابط فتُشارَك نتيجةُ بحثٍ كما هي (`/help?category=…&q=…`).
 */
export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q, category } = await searchParams;
  const { items, meta } = await fetchHelp({ q, category, limit: 50 });
  return <HelpIndexView locale="ar" items={items} meta={meta} selected={category} query={q} />;
}
