'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  BookOpen,
  CalendarRange,
  Coins,
  FileText,
  Home,
  Landmark,
  LogOut,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { ThemeToggle } from '@erp/ui/theme';
import { useSession } from '@erp/web-core/session';

import { useLang } from '../lib/i18n';
import { visibleScreens, type NavScreen } from '../lib/navigation';

const ICONS: Record<NavScreen['icon'], React.ComponentType<{ size?: number }>> = {
  home: Home,
  accounts: Landmark,
  journals: BookOpen,
  periods: CalendarRange,
  trial: Scale,
  income: Coins,
  cost: ShieldCheck,
  zatca: FileText,
};

/**
 * M3 — the accounting app shell: one focused sidebar (the accountant's surfaces only,
 * each hidden unless the session can view it), a topbar with the tenant + user, and the
 * read-only badge that states this milestone's contract plainly.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const { lang, setLang, t } = useLang();
  const { me, can, signOut } = useSession();
  const [navQuery, setNavQuery] = useState('');

  const screens = visibleScreens(can);
  const query = navQuery.trim();
  const filtered = query
    ? screens.filter((screen) =>
        (lang === 'ar' ? screen.labelAr : screen.labelEn).toLowerCase().includes(query.toLowerCase()),
      )
    : screens;

  return (
    <div className="shell">
      <aside className="side">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <span className="logo">ERP</span>
          <span>
            {t('app.name')}
            <small>{me?.membership.tenantName ?? me?.membership.tenantCode ?? ''}</small>
          </span>
        </Link>

        <input
          className="nav-search"
          type="search"
          placeholder={lang === 'ar' ? 'ابحث في الشاشات…' : 'Search screens…'}
          value={navQuery}
          onChange={(event) => setNavQuery(event.target.value)}
          aria-label={lang === 'ar' ? 'ابحث في الشاشات' : 'Search screens'}
        />

        <nav className="nav" aria-label={lang === 'ar' ? 'الشاشات' : 'Screens'}>
          {filtered.map((screen) => {
            const Icon = ICONS[screen.icon];
            const active = pathname === screen.href || (screen.href !== '/' && pathname.startsWith(`${screen.href}/`));
            return (
              <Link
                key={screen.href}
                href={screen.href}
                className={`nav-link${screen.href === '/' ? ' home' : ''}${active ? ' active' : ''}`}
              >
                <Icon size={16} />
                <span>{lang === 'ar' ? screen.labelAr : screen.labelEn}</span>
              </Link>
            );
          })}
          {filtered.length === 0 ? <span className="muted small">{lang === 'ar' ? 'لا نتائج.' : 'No results.'}</span> : null}
        </nav>

        <div className="side-foot">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span>
              {me?.user.fullName ?? me?.user.email ?? ''} · {me?.membership.displayName ?? ''}
            </span>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
              title={t('nav.lang')}
            >
              {lang === 'ar' ? 'English' : 'العربية'}
            </button>
            <ThemeToggle />
            <button type="button" className="btn ghost sm" onClick={() => void signOut()} title={t('nav.logout')}>
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <span className="badge">{t('common.readonly')}</span>
            <span className="muted small">
              {lang === 'ar'
                ? 'مرحلة الهيكل: الشاشات تقرأ بيانات المنشأة الحقيقية عبر نقاط النهاية القائمة'
                : 'Scaffold milestone: screens read real tenant data through existing endpoints'}
            </span>
          </div>
          <span className="muted small">{me?.membership.tenantName ?? ''}</span>
        </div>
        {children}
      </main>
    </div>
  );
}
