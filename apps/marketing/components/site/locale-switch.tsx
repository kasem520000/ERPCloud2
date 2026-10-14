'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { dir, localePath, t, type Locale } from '../../lib/i18n';

/**
 * P-M1 — مبدّل اللغة: **مسارٌ لا كوكي**.
 *
 * الزائر في `/blog/x` يرى زرّاً ينقله إلى `/en/blog/x` (والعكس)، والمقصد يُبنى بـ`localePath`
 * نفسها التي تبني `hreflang` — فما يراه الزائر هو ما يُعلنه الموقع لمحرّك البحث.
 */
export function LocaleSwitch({ locale }: { locale: Locale }) {
  const pathname = usePathname() || '/';
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  return (
    <Link className="lang-switch" href={localePath(pathname, other)} hrefLang={other} dir={dir(other)}>
      {t(locale, 'lang.switch')}
    </Link>
  );
}
