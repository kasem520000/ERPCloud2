'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { fetchProfile, logout, readToken, type PortalProfile } from '../lib/api';
import { moneyText } from '../lib/format';
import { portalRoutes } from '../lib/navigation';

type ShellState = { profile: PortalProfile | null; error: string };

const ProfileContext = createContext<ShellState>({ profile: null, error: '' });

/** Lets a page reuse the profile the shell already loaded instead of asking again. */
export const usePortalProfile = () => useContext(ProfileContext);

export function PortalShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<ShellState>({ profile: null, error: '' });
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!readToken()) {
      globalThis.location.assign('/auth/login');
      return;
    }
    fetchProfile()
      .then((profile) => setState({ profile, error: '' }))
      .catch((error: Error) => setState({ profile: null, error: error.message }))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <div className="card">جارٍ فتح البوابة…</div>;

  // An account that exists but is not linked to a customer gets a plain explanation instead of
  // a shell full of endpoints that will all fail the same way.
  if (!state.profile) {
    return (
      <section className="card">
        <h1>لا يمكن فتح البوابة</h1>
        <p className="muted">{state.error || 'تعذّر تحميل بيانات الحساب.'}</p>
        <button className="btn" type="button" onClick={logout}>
          تسجيل الخروج
        </button>
      </section>
    );
  }

  const { party, company } = state.profile;
  const dueBalance = state.profile.balance;

  return (
    <ProfileContext.Provider value={state}>
      <div className="portal">
        <aside className="card side">
          <strong>{party?.name ?? 'بوابة العملاء'}</strong>
          <p className="muted" style={{ margin: '4px 0 12px' }}>
            <small>{company.nameAr || 'المورد'}</small>
          </p>
          {portalRoutes.map((route) => (
            <Link href={route.href} key={route.key} style={pathname === route.href ? { background: '#eff6ff', color: 'var(--brand)' } : undefined}>
              {route.labelAr}
              <br />
              <small>{route.labelEn}</small>
            </Link>
          ))}
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '12px 0' }} />
          <p className="muted">
            <small>الرصيد المستحق</small>
          </p>
          <div className="kpi" style={{ fontSize: 20 }}>
            {moneyText(dueBalance)}
          </div>
          <button className="btn" type="button" onClick={logout} style={{ marginTop: 12, width: '100%' }}>
            تسجيل الخروج
          </button>
        </aside>
        <section className="grid">{children}</section>
      </div>
    </ProfileContext.Provider>
  );
}
