'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@erp/web-core/api';
import { useSession } from '@erp/web-core/session';

import { fetchServerQueue, startRepAutoSync } from '../lib/offline/rep-sync';
import { clearRepData } from '../lib/offline/rep-db';
import { useLang } from '../lib/i18n';

import { AppShell } from './app-shell';
import { LoginScreen } from './login-screen';

/**
 * M5 — everything behind this component requires a session AND a rep card:
 *
 *   1. session (same model as every surface — the anonymous visitor sees the login
 *      screen, never the route data);
 *   2. the caller must resolve as a REP through the M4 guard (membership → salesman
 *      card → van warehouse scope, D-004). The probe is `GET /field-sync/queue`: the
 *      cheapest guard-gated route.
 *
 * The probe FAILS OPEN on network errors: a rep opening the app offline must reach his
 * cached data — only a definitive 403 from the guard blocks the shell.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, error, signOut } = useSession();
  const { t } = useLang();
  const [repProbe, setRepProbe] = useState<'checking' | 'ok' | 'not-a-rep'>('checking');

  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    fetchServerQueue()
      .then(() => {
        if (!cancelled) setRepProbe('ok');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 403) setRepProbe('not-a-rep');
        else setRepProbe('ok'); // offline / server hiccup → fail open, the data is local
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  // Auto-sync starts once a real rep is inside (mount) and stops on sign-out — with a
  // data wipe, so the next rep on a shared phone never sees the previous one's prices.
  useEffect(() => {
    if (status !== 'authenticated' || repProbe === 'not-a-rep') return;
    const stop = startRepAutoSync();
    return () => stop();
  }, [status, repProbe]);

  async function signOutRep(): Promise<void> {
    try {
      await clearRepData();
    } catch {
      // A wipe failure must never block the sign-out itself.
    }
    await signOut();
  }

  if (status === 'loading') {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="logo big">ERP</span>
          <p>جارٍ التحقق من الجلسة…</p>
        </div>
      </div>
    );
  }

  if (status === 'anonymous') return <LoginScreen initialError={error} />;

  if (repProbe === 'checking') {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="logo big">ERP</span>
          <p>جارٍ التحقق من بطاقة المندوب…</p>
        </div>
      </div>
    );
  }

  if (repProbe === 'not-a-rep') {
    return (
      <div className="boot">
        <div className="boot-card" style={{ maxWidth: '560px', padding: '24px', textAlign: 'center' }}>
          <span className="logo big">ERP</span>
          <h1 style={{ fontSize: '20px', margin: 0 }}>هذا الحساب ليس حساب مندوب</h1>
          <p className="muted small">
            {t('app.name')} يخدم مندوبي التوزيع فقط: الحساب يحتاج بطاقة مندوب مرتبطة بمستودع فان
            (حرس المزامنة — D-004). إن كنت مندوبًا فتواصل مع الإدارة لربط بطاقتك.
          </p>
          <button type="button" className="btn" onClick={() => void signOutRep()}>
            خروج
          </button>
        </div>
      </div>
    );
  }

  return <AppShell onSignOut={signOutRep}>{children}</AppShell>;
}
