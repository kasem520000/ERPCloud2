'use client';

import Link from 'next/link';
import { BookOpen, CalendarRange, Coins, Landmark, Scale, ShieldCheck } from 'lucide-react';
import { useSession } from '@erp/web-core/session';

import { useLang } from '../lib/i18n';
import { visibleScreens } from '../lib/navigation';

/**
 * M3 — the accounting app home: the accountant's own map. Every tile is a screen the
 * session may actually open (permission-filtered), so the home page never advertises a
 * surface the gate would then refuse.
 */
export default function HomePage() {
  const { lang, t } = useLang();
  const { me, can } = useSession();
  const screens = visibleScreens(can).filter((screen) => screen.href !== '/');

  const tiles: Record<string, React.ComponentType<{ size?: number }>> = {
    accounts: Landmark,
    journals: BookOpen,
    periods: CalendarRange,
    trial: Scale,
    income: Coins,
    cost: ShieldCheck,
    zatca: BookOpen,
  };

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '22px' }}>
              {lang === 'ar' ? 'أهلاً' : 'Welcome'}، {me?.user.fullName ?? me?.user.email ?? ''}
            </h1>
            <p className="muted small" style={{ margin: 0 }}>
              {me?.membership.tenantName ?? ''} · {me?.membership.displayName ?? ''}
            </p>
          </div>
          <span className="badge">{t('common.readonly')}</span>
        </div>
      </section>

      <div className="grid cols">
        {screens.map((screen) => {
          const Icon = tiles[screen.icon] ?? Landmark;
          return (
            <Link
              key={screen.href}
              href={screen.href}
              className="card lift"
              style={{ textDecoration: 'none', display: 'grid', gap: '8px' }}
            >
              <Icon size={22} />
              <strong>{lang === 'ar' ? screen.labelAr : screen.labelEn}</strong>
              <span className="muted small">{screen.permission}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
