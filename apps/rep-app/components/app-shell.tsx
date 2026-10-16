'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ClipboardList, Home, Package, ShoppingCart, Truck, Users } from 'lucide-react';
import { ThemeToggle } from '@erp/ui/theme';
import { useSession } from '@erp/web-core/session';

import { useLang } from '../lib/i18n';
import { primaryScreens, type NavScreen } from '../lib/navigation';
import { readQueueBoard } from '../lib/offline/rep-sync';

const ICONS: Record<NavScreen['icon'], React.ComponentType<{ size?: number }>> = {
  home: Home,
  customers: Users,
  stock: Package,
  invoice: ShoppingCart,
  queue: ClipboardList,
  receipt: Truck,
  return: Truck,
  closing: Truck,
  sync: Truck,
};

/**
 * M5 — the rep app shell, phone-first (D-006: this app is installed on the rep's
 * phone): a compact topbar (tenant, language, theme, online state, pending count) and a
 * five-tab bottom bar filtered by the session's permissions — same hiding rule as the
 * staff/accounting sidebars.
 */
export function AppShell({ children, onSignOut }: { children: React.ReactNode; onSignOut: () => void | Promise<void> }) {
  const pathname = usePathname() ?? '';
  const { lang, setLang, t } = useLang();
  const { me, can } = useSession();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      readQueueBoard()
        .then((board) => {
          if (!cancelled) setPending(board.pending + board.conflict);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const tabs = primaryScreens(can);

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <span className="logo">ERP</span>
          <span>
            {t('app.name')}
            <small>{me?.membership.tenantName ?? me?.membership.tenantCode ?? ''}</small>
          </span>
        </Link>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className={`badge ${online ? 'approved' : 'failed'}`} title={online ? t('common.online') : t('common.offline')}>
            {online ? t('common.online') : t('common.offline')}
          </span>
          {pending > 0 ? (
            <Link href="/queue" className="badge pending" style={{ textDecoration: 'none' }}>
              {pending}
            </Link>
          ) : null}
          <ThemeToggle />
          <button type="button" className="btn sm ghost" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
            {lang === 'ar' ? 'EN' : 'ع'}
          </button>
          <button type="button" className="btn sm ghost" onClick={() => void onSignOut()} aria-label="خروج">
            ⎋
          </button>
        </div>
      </header>

      <main className="main">{children}</main>

      <nav className="tabbar" aria-label={lang === 'ar' ? 'الشاشات' : 'Screens'}>
        {tabs.map((screen) => {
          const Icon = ICONS[screen.icon];
          const active = pathname === screen.href;
          return (
            <Link
              key={screen.href}
              href={screen.href}
              className={`tab${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{lang === 'ar' ? screen.labelAr : screen.labelEn}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
