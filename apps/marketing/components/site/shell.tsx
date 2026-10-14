/**
 * P-M1 — قشرة الموقع: رأسٌ وتذييلٌ ولافتة، كلها من **محتوى الخادم** (`/public/site`).
 *
 * القائمة تُقرأ من `content_menus` (تُحرَّر من اللوحة)، وإن كانت فارغة تُستعمل مسارات
 * `lib/navigation.ts` الثابتة — فموقعٌ جديد بلا محتوى لا يظهر بلا تنقّل.
 */

import Link from 'next/link';
import { ThemeToggle } from '@erp/ui/theme';
import type { ReactNode } from 'react';

import type { MenuItem, SiteShell } from '../../lib/content';
import { dir, t, type Locale } from '../../lib/i18n';
import { siteFooterLinks, siteNavLinks } from '../../lib/navigation';
import { NewsletterForm } from '../newsletter-form';

import { ConsentStatusLine } from './consent-banner';
import { HeaderScroll } from './header-scroll';
import { LocaleSwitch } from './locale-switch';

function menuItems(items: MenuItem[], locale: Locale) {
  return items.map((item) => (
    <Link key={item.key} href={item.href}>
      {locale === 'en' ? (item.labelEn ?? item.labelAr) : item.labelAr}
      {item.badgeAr ? <span className="pill">{item.badgeAr}</span> : null}
    </Link>
  ));
}

export function SiteHeader({ shell, locale }: { shell: SiteShell; locale: Locale }) {
  const cmsMenu = shell.menus.header ?? [];
  // قائمة الرأس من نظام المحتوى إن وُجدت؛ وإلا فالافتراضية من `lib/navigation.ts`.
  const nav =
    cmsMenu.length > 0
      ? menuItems(cmsMenu, locale)
      : siteNavLinks(locale).map((link) => (
          <Link key={link.key} href={link.href}>
            {link.label}
          </Link>
        ));

  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <Link className="brand" href={locale === 'ar' ? '/' : '/en'}>
          <span className="logo" aria-hidden="true">
            {shell.brandInitials}
          </span>
          <span className="brand-name">{shell.brandName}</span>
        </Link>
        <nav className="site-nav" aria-label={locale === 'ar' ? 'التنقّل الرئيسي' : 'Main navigation'}>
          {nav}
        </nav>
        <div className="header-actions">
          {/* Design v3 §2.1 — the site follows the OS by default and offers the
              switch here. Same component, same `erp.theme` key as the two
              back-office surfaces. */}
          <ThemeToggle variant="icon" lang={locale === 'en' ? 'en' : 'ar'} />
          <LocaleSwitch locale={locale} />
          <Link className="btn ghost" href="/login">
            {t(locale, 'cta.login')}
          </Link>
          <Link className="btn primary" href="/onboarding">
            {t(locale, 'cta.start')}
          </Link>
        </div>
      </div>
    </header>
  );
}

export function SiteBanner({ shell, locale }: { shell: SiteShell; locale: Locale }) {
  const banner = shell.banner;
  if (!banner) return null;
  const text = (locale === 'en' ? banner.textEn : banner.textAr) ?? banner.textAr;
  const label = (locale === 'en' ? banner.linkLabelEn : banner.linkLabelAr) ?? null;
  return (
    <div className={`site-banner tone-${banner.tone}`} role="status">
      <div className="wrap banner-inner">
        <span>{text}</span>
        {banner.href ? (
          <Link className="banner-link" href={banner.href}>
            {label ?? t(locale, 'cta.readMore')}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function MaintenanceNotice({ locale }: { locale: Locale }) {
  return (
    <div className="site-banner tone-warn" role="status">
      <div className="wrap banner-inner">
        <span>{t(locale, 'maintenance.title')}</span>
        <Link className="banner-link" href={locale === 'ar' ? '/maintenance' : '/maintenance'}>
          {t(locale, 'maintenance.body')}
        </Link>
      </div>
    </div>
  );
}

export function SiteFooter({ shell, locale }: { shell: SiteShell; locale: Locale }) {
  const year = new Date().getFullYear();
  const legalItems = shell.menus.legal ?? [];
  const socialItems = shell.menus.social ?? [];
  const groups = siteFooterLinks(locale);

  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <div className="footer-brand">
          <span className="logo" aria-hidden="true">
            {shell.brandInitials}
          </span>
          <p className="footer-tagline">{locale === 'en' ? shell.taglineEn : shell.taglineAr}</p>
          {shell.supportEmail ? (
            <a className="footer-contact" href={`mailto:${shell.supportEmail}`} dir="ltr">
              {shell.supportEmail}
            </a>
          ) : null}
          {shell.supportPhone ? (
            <a className="footer-contact" href={`tel:${shell.supportPhone}`} dir="ltr">
              {shell.supportPhone}
            </a>
          ) : null}
          {socialItems.length > 0 ? <nav className="footer-social">{menuItems(socialItems, locale)}</nav> : null}
        </div>

        {groups.map((group) => (
          <nav className="footer-group" key={group.key} aria-label={group.label}>
            <h2>{group.label}</h2>
            {group.links.map((link) => (
              <Link key={link.href} href={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>
        ))}

        {/* P-M6 — النشرة في التذييل: مكانها المعتاد، وبلا مسارٍ جديد يضيع من خريطة الموقع. */}
        <NewsletterForm locale={locale} compact />

        {legalItems.length > 0 ? (
          <nav className="footer-group" aria-label={t(locale, 'footer.legal')}>
            <h2>{t(locale, 'footer.legal')}</h2>
            {menuItems(legalItems, locale)}
          </nav>
        ) : (
          <nav className="footer-group" aria-label={t(locale, 'footer.legal')}>
            <h2>{t(locale, 'footer.legal')}</h2>
            <Link href={locale === 'ar' ? '/legal/terms' : '/en/legal/terms'}>
              {locale === 'ar' ? 'شروط الاستخدام' : 'Terms of use'}
            </Link>
            <Link href={locale === 'ar' ? '/legal/privacy' : '/en/legal/privacy'}>
              {locale === 'ar' ? 'سياسة الخصوصية' : 'Privacy policy'}
            </Link>
            <Link href={locale === 'ar' ? '/legal/cookies' : '/en/legal/cookies'}>
              {locale === 'ar' ? 'ملفات الارتباط' : 'Cookies'}
            </Link>
          </nav>
        )}
      </div>
      <div className="wrap footer-legal">
        <span dir={dir(locale)}>
          © {year} {shell.companyLegalName || shell.brandName} — {t(locale, 'footer.rights')}
        </span>
        {/* P-M10 — حالة القياس وزرّ تغييرها: قرارٌ يمكن التراجع عنه، ونصُّه من `consentCopy`. */}
        <ConsentStatusLine locale={locale} />
      </div>
    </footer>
  );
}

export function SiteShellLayout({
  shell,
  locale,
  children,
}: {
  shell: SiteShell;
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <>
      <HeaderScroll>
        <SiteHeader shell={shell} locale={locale} />
      </HeaderScroll>
      {shell.maintenance ? <MaintenanceNotice locale={locale} /> : <SiteBanner shell={shell} locale={locale} />}
      <main id="main" className="wrap site-main">
        {children}
      </main>
      <SiteFooter shell={shell} locale={locale} />
    </>
  );
}
