import type { Metadata } from 'next';

import { HomeView } from '../components/site/views';
import { fetchFaq, fetchPosts, fetchShell } from '../lib/content';
import { staticMetadata } from '../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/', titleKey: 'home.top' });
}

/**
 * P-M2 — الصفحة الرئيسية.
 *
 * البطل من **إعدادات الموقع** (`/public/site`)، وشبكة الوحدات من شجرة `apps/staff`،
 * والآراء والأسئلة الشائعة من **نظام المحتوى** (وتُخفى أقسامها حين لا محتوى — لا شهادة
 * مخترعة ولا رقم مفترض).
 */
export default async function HomePage() {
  const [shell, faq, cases] = await Promise.all([
    fetchShell(),
    fetchFaq(6),
    fetchPosts({ kind: 'case_study', limit: 3 }),
  ]);
  return <HomeView locale="ar" shell={shell} faq={faq} cases={cases.items} />;
}
