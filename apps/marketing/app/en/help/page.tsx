import type { Metadata } from 'next';

import { HelpIndexView } from '../../../components/site/views';
import { fetchHelp } from '../../../lib/content';
import { staticMetadata } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'en', path: '/en/help', titleKey: 'help.title', descriptionKey: 'help.subtitle' });
}

export default async function HelpPageEn({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q, category } = await searchParams;
  // P-M9: الفئات تُمرَّر كما تمرّ في `/help` — القائمة واحدة والمكوّن واحد، واللغة تُبدّل النصّ.
  const { items, meta } = await fetchHelp({ q, category, limit: 50 });
  return <HelpIndexView locale="en" items={items} meta={meta} selected={category} query={q} />;
}
