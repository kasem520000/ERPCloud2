import type { Metadata } from 'next';

import { HomeView } from '../../components/site/views';
import { fetchFaq, fetchPosts, fetchShell } from '../../lib/content';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'en', path: '/en', titleKey: 'home.top' });
}

/**
 * P-M1 — الصفحة الرئيسية بالإنجليزية على `/en`.
 *
 * نفس المكوّن ونفس نقاط النهاية؛ ما يتغيّر لغةُ الطلب فقط. وهذا هو معنى «لغتان حقيقيتان»:
 * النصّ من نظام المحتوى بحقله الإنجليزي، والسقوط إلى العربية حين لا ترجمة (بلا فراغ).
 */
export default async function HomePageEn() {
  const [shell, faq, cases] = await Promise.all([
    fetchShell(),
    fetchFaq(6),
    fetchPosts({ kind: 'case_study', limit: 3 }),
  ]);
  return <HomeView locale="en" shell={shell} faq={faq} cases={cases.items} />;
}
