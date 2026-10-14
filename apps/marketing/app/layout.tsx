import './globals.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { ThemeProvider, ThemeScript } from '@erp/ui/theme';

import { ConsentBanner } from '../components/site/consent-banner';
import { SiteEvents } from '../components/site/site-events';
import { SiteShellLayout } from '../components/site/shell';
import { JsonLd } from '../components/site/pieces';
import { fetchShell } from '../lib/content';
import { dir, localeFromPath, t, DEFAULT_LOCALE } from '../lib/i18n';
import { absoluteUrl, fallbackSite, organizationJsonLd, softwareJsonLd } from '../lib/site';

/**
 * P-M1 — تخطيط الموقع: هويّة `<html>` + القشرة + البيانات المنظَّمة.
 *
 * **كيف تُعرف اللغة؟** من **المسار** لا من كوكي: `middleware.ts` يضع `x-pathname` على
 * الطلب، وهذا التخطيط يقرؤه ويشتقّ اللغة بـ`localeFromPath` — وهي الدالّة نفسها التي تبني
 * `hreflang` ومبدّل اللغة. البديل كان مجموعتين من المسارات لكل لغة (نقل كل ملفٍّ إلى
 * `(ar)/` و`(en)/`)، وهو تكرارُ بنيةٍ لا تكرارُ ترجمة — والمكسب صفر.
 *
 * ولأن هذا التخطيط يقرأ ترويسةً، فكل صفحات الموقع ديناميكية (تُرسم عند الطلب) — وهو
 * الصواب هنا: المحتوى يُدار من اللوحة، وصفحةٌ تُخبأ ساعةً لا تُظهر مقالاً نُشر الآن.
 */

export async function generateMetadata(): Promise<Metadata> {
  const pathname = (await headers()).get('x-pathname') ?? '/';
  const locale = localeFromPath(pathname);
  const shell = await fetchShell();
  const description = locale === 'ar' ? shell.taglineAr : shell.taglineEn;
  return {
    title: { default: shell.brandName, template: `%s · ${shell.brandName}` },
    description,
    applicationName: shell.brandName,
    metadataBase: shell.siteUrl ? new URL(shell.siteUrl) : undefined,
    openGraph: {
      title: shell.brandName,
      description,
      url: absoluteUrl(pathname, shell.siteUrl),
      siteName: shell.brandName,
      locale: locale === 'ar' ? 'ar_SA' : 'en_US',
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title: shell.brandName, description },
    icons: { icon: '/favicon.ico' },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const pathname = (await headers()).get('x-pathname') ?? '/';
  const locale = localeFromPath(pathname);
  const shell = await fetchShell();

  const site = {
    ...fallbackSite,
    ...shell,
    locales: shell.locales.length > 0 ? shell.locales : fallbackSite.locales,
    defaultLocale: shell.defaultLocale ?? DEFAULT_LOCALE,
  };

  return (
    <html lang={locale} dir={dir(locale)} suppressHydrationWarning>
      <head>
        {/* Design v3 §2.1 — the site follows the OS by default and offers the
            switch in the navbar. One script, one `erp.theme` key. */}
        <ThemeScript defaultChoice="system" />
      </head>
      <body>
        <ThemeProvider defaultChoice="system">
        <a className="skip-link" href="#main">
          {locale === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content'}
        </a>
        <JsonLd data={organizationJsonLd(site)} />
        <JsonLd data={softwareJsonLd(site, locale, locale === 'ar' ? site.taglineAr : site.taglineEn)} />
        <Suspense fallback={null}>
          <SiteShellLayout shell={shell} locale={locale}>
            {children}
          </SiteShellLayout>
        </Suspense>
        {/* P-M10 — القياس: مُلتقِطٌ صامت (يعود `null`) ولافتةُ موافقةٍ لا تحجب شيئاً.
            الاثنان بعد القشرة فلا يزاحمان الرسم الأول، ولا يعملان قبل موافقة الزائر. */}
        <SiteEvents />
        <ConsentBanner locale={locale} />
        <p className="sr-only">{t(locale, 'meta.localeName')}</p>
        </ThemeProvider>
      </body>
    </html>
  );
}
