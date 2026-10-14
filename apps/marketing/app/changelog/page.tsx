import type { Metadata } from 'next';

import { ChangelogView } from '../../components/site/views';
import { fetchChangelog } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

/**
 * P-M9 — `/changelog`: ما تغيّر فعلاً.
 *
 * والمصدر **نظام المحتوى** لا `docs/change-log`: الموقع يقرأ من القاعدة في كل صفحةٍ أخرى،
 * وسجلُّ التغييرات رسالةٌ إلى العملاء يكتبها فريق التسويق — فمكانها حيث يكتبون، وتُنشر بلا
 * نشرة، وتُترجم كغيرها حين تُترجم (P-M10). (القرار مُبرَّر في تقرير الجزء §«ما اخترعناه».)
 */
export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({
    locale: 'ar',
    path: '/changelog',
    titleKey: 'changelog.title',
    descriptionKey: 'changelog.subtitle',
    type: 'website',
  });
}

export default async function ChangelogPage() {
  const entries = await fetchChangelog(24);
  return <ChangelogView locale="ar" entries={entries} />;
}
