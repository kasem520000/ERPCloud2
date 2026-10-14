'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ThemeToggle } from '@erp/ui/theme';
import type { SupportTicket } from '@erp/contracts';

import { apiData } from '../lib/api';
import { groupForPath, visibleConsoleGroups, type ConsoleItem } from '../lib/navigation';
import { useSession } from '../lib/session';
import { useQuery } from '../lib/use-query';

import { Forbidden } from './screen';

type AddonPendingRequest = {
  id: string;
  tenantName: string;
  tenantCode: string;
  appNameAr: string;
  createdAt: string;
};

const PRIORITY_AR: Record<string, string> = {
  urgent: 'عاجلة',
  high: 'عالية',
  normal: 'عادية',
  low: 'منخفضة',
};

export function PlatformGuard({ children }: { children: React.ReactNode }) {
  const { isPlatformAdmin, me, signOut } = useSession();
  const pathname = usePathname() ?? '';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const settings = useQuery<{ environment: { name: string; labelAr: string } }>(
    () => apiData('/platform/settings'),
    [],
  );
  const overview = useQuery<{
    tenants: { suspended: number };
    subscriptions: { past_due: number };
    pendingActivations: number;
  }>(() => apiData('/platform/overview'), [pathname]);

  const groups = useMemo(
    () => visibleConsoleGroups(me?.platformPermissions ?? []),
    [me?.platformPermissions],
  );
  const activeGroup = groupForPath(pathname);

  useEffect(() => {
    setDrawerOpen(false);
    setPaletteOpen(false);
  }, [pathname]);

  // Ctrl+K opens the palette anywhere in the console; Escape closes both overlays.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setDrawerOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!isPlatformAdmin) return <Forbidden />;

  const environment = settings.data?.environment;

  return (
    <div className="shell">
      {drawerOpen && (
        <div
          className="no-print"
          onClick={() => setDrawerOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            zIndex: 40,
          }}
        />
      )}
      <aside className={`side no-print ${drawerOpen ? 'open' : ''}`}>
        <div className="brand" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="logo">ERP</span>
            <span>
              لوحة تحكم المنصة
              <small>{environment ? `بيئة ${environment.labelAr}` : 'بيئة السحابة'}</small>
            </span>
          </div>
          {drawerOpen && (
            <button
              type="button"
              className="btn sm only-mobile"
              onClick={() => setDrawerOpen(false)}
              aria-label="إغلاق القائمة"
            >
              ✕
            </button>
          )}
        </div>

        <nav className="nav" aria-label="أقسام لوحة المنصة">
          {groups.map((group) => (
            <div className="nav-group" key={group.key}>
              <p className="nav-group-title">
                {group.icon} {group.labelAr}
              </p>
              {group.items.map((entry) => {
                const active = pathname === entry.href || (entry.href !== '/' && pathname.startsWith(entry.href));
                return (
                  <Link
                    key={entry.key}
                    href={entry.href}
                    className={`nav-link ${active ? 'active' : ''}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <span className={`dot ${entry.status}`} aria-hidden="true" />
                    {entry.labelAr}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="nav-legend">
          <span>
            <span className="dot ready" /> جاهز
          </span>
          <span>
            <span className="dot planned" /> مخطَّط
          </span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <div className="row" style={{ alignItems: 'center' }}>
            <button
              className="btn sm only-mobile"
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-label="إظهار القائمة"
            >
              ☰
            </button>
            <nav className="crumbs" aria-label="موقعك في اللوحة">
              <Link href="/">المنصة</Link>
              {activeGroup ? ` ← ${activeGroup.labelAr}` : ''}
            </nav>
          </div>

          <div className="row" style={{ alignItems: 'center' }}>
            <ThemeToggle compact />
            <button className="btn sm" type="button" onClick={() => setPaletteOpen(true)}>
              🔍 بحث شامل <span className="muted small">Ctrl+K</span>
            </button>
            <Bell
              pendingActivations={overview.data?.pendingActivations ?? 0}
              pastDue={overview.data?.subscriptions.past_due ?? 0}
              suspendedTenants={overview.data?.tenants.suspended ?? 0}
              pathname={pathname}
            />
            {environment && (
              <span className={`badge ${environment.name === 'production' ? 'failed' : 'pending'}`}>
                {environment.labelAr}
              </span>
            )}
            <span className="muted small">
              {me?.user.fullName} · {me?.user.email}
            </span>
            <button className="btn sm" type="button" onClick={() => void signOut()}>
              تسجيل الخروج
            </button>
          </div>
        </header>

        {paletteOpen && <Omnibox onClose={() => setPaletteOpen(false)} />}

        {children}
      </div>
    </div>
  );
}

/**
 * مركز إشعارات المنصة الحي (`Bell`) — يستطلع:
 * 1) تذاكر المساعدة والدعم المفتوحة من العملاء (`GET /platform/tickets?filter[status]=open`)
 * 2) طلبات تفعيل الباقات والإضافات المعلقة (`GET /marketplace/platform/requests?status=pending`)
 * 3) طلبات تفعيل المنشآت والتراخيص المتأخرة والعملاء الموقوفين
 */
function Bell({
  pendingActivations,
  pastDue,
  suspendedTenants,
  pathname,
}: {
  pendingActivations: number;
  pastDue: number;
  suspendedTenants: number;
  pathname: string;
}) {
  const [open, setOpen] = useState(false);
  const [openTickets, setOpenTickets] = useState<SupportTicket[]>([]);
  const [addonRequests, setAddonRequests] = useState<AddonPendingRequest[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadNotifications = useCallback(async () => {
    const [ticketsRes, addonsRes] = await Promise.all([
      apiData<SupportTicket[]>('/platform/tickets?filter[status]=open&limit=10').catch(() => [] as SupportTicket[]),
      apiData<AddonPendingRequest[]>('/marketplace/platform/requests?status=pending').catch(
        () => [] as AddonPendingRequest[],
      ),
    ]);
    setOpenTickets(Array.isArray(ticketsRes) ? ticketsRes : []);
    setAddonRequests(Array.isArray(addonsRes) ? addonsRes : []);
  }, []);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications, pathname]);

  useEffect(() => {
    const timer = setInterval(() => void loadNotifications(), 15_000);
    const onFocus = () => void loadNotifications();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadNotifications]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', handleOutside);
      document.addEventListener('keydown', handleKey);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const totalCount =
    openTickets.length + addonRequests.length + pendingActivations + pastDue + suspendedTenants;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        className={`btn sm ${totalCount > 0 ? 'primary' : ''}`}
        type="button"
        aria-label={`التنبيهات (${totalCount})`}
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void loadNotifications();
        }}
      >
        🔔 الإشعارات {totalCount > 0 ? `(${totalCount})` : '(0)'}
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: 'absolute',
            insetInlineEnd: 0,
            top: 38,
            zIndex: 60,
            minWidth: 360,
            maxWidth: 420,
            maxHeight: '75vh',
            overflowY: 'auto',
            display: 'grid',
            gap: 10,
            boxShadow: 'var(--shadow-4)',
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>🔔 مركز إشعارات وطلبات المنصة ({totalCount})</strong>
            <button type="button" className="btn sm" onClick={() => void loadNotifications()}>
              تحديث
            </button>
          </div>

          {/* 1. Open Support Tickets from Customers */}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>🛟 طلبات المساعدة والدعم الفني ({openTickets.length})</strong>
              <Link href="/tickets" className="small" onClick={() => setOpen(false)}>
                فتح الصندوق ←
              </Link>
            </div>
            {openTickets.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                لا توجد تذاكر مساعدة مفتوحة حالياً.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {openTickets.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tickets/${t.id}`}
                    onClick={() => setOpen(false)}
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      background: 'var(--surface-2)',
                      textDecoration: 'none',
                      color: 'inherit',
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong style={{ fontSize: 13 }}>{t.subject}</strong>
                      <span className="badge pending" style={{ fontSize: 11 }}>
                        {PRIORITY_AR[t.priority] ?? t.priority}
                      </span>
                    </div>
                    <div className="muted small" style={{ marginTop: 2 }}>
                      المنشأة: {t.tenantName ?? t.tenantCode ?? 'عميل'} ·{' '}
                      {new Date(t.createdAt).toLocaleString('ar-SA')}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 2. Pending Marketplace Add-on Requests */}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>🛒 طلبات تفعيل الباقات القطاعية ({addonRequests.length})</strong>
              <Link href="/marketplace" className="small" onClick={() => setOpen(false)}>
                إدارة الباقات ←
              </Link>
            </div>
            {addonRequests.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                لا توجد طلبات باقات معلقة.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {addonRequests.map((req) => (
                  <Link
                    key={req.id}
                    href="/marketplace"
                    onClick={() => setOpen(false)}
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      background: 'var(--surface-2)',
                      textDecoration: 'none',
                      color: 'inherit',
                    }}
                  >
                    <strong style={{ fontSize: 13 }}>طلب تفعيل: {req.appNameAr}</strong>
                    <div className="muted small">
                      العميل: {req.tenantName} ({req.tenantCode})
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 3. System / Subscription Counters */}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>⚙️ تنبيهات التشغيل والتراخيص</strong>
            <ul style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 4, fontSize: 13 }}>
              <li>
                <Link href="/activation-requests" onClick={() => setOpen(false)}>
                  طلبات تفعيل منشآت جديدة ({pendingActivations})
                </Link>
              </li>
              <li>
                <Link href="/subscriptions" onClick={() => setOpen(false)}>
                  تراخيص متأخرة السداد ({pastDue})
                </Link>
              </li>
              <li>
                <Link href="/tenants?status=suspended" onClick={() => setOpen(false)}>
                  عملاء موقوفون ({suspendedTenants})
                </Link>
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

type TenantHit = { id: string; code: string; name: string; status: string };
type UserHit = { id: string; email: string; full_name?: string; fullName?: string };

function Omnibox({ onClose }: { onClose: () => void }) {
  const { canConsole } = useSession();
  const [term, setTerm] = useState('');
  const [tenants, setTenants] = useState<TenantHit[]>([]);
  const [users, setUsers] = useState<UserHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const canSeeUsers = canConsole('console.users.view');

  const search = useCallback(
    async (value: string) => {
      if (value.trim().length === 0) {
        setTenants([]);
        setUsers([]);
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const [tenantHits, userHits] = await Promise.all([
          apiData<TenantHit[]>(`/platform/tenants/search?q=${encodeURIComponent(value)}`),
          canSeeUsers
            ? apiData<UserHit[]>(`/platform/users?search=${encodeURIComponent(value)}`)
            : Promise.resolve([] as UserHit[]),
        ]);
        setTenants(
          (Array.isArray(tenantHits) ? tenantHits : []).filter(
            (t) => !['platform', 'platform-ops'].includes(t.code.toLowerCase()),
          ),
        );
        setUsers((Array.isArray(userHits) ? userHits : []).slice(0, 5));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [canSeeUsers],
  );

  useEffect(() => {
    const handle = setTimeout(() => void search(term), 200);
    return () => clearTimeout(handle);
  }, [term, search]);

  return (
    <div className="card" role="dialog" aria-label="البحث الشامل" style={{ marginBottom: 16 }}>
      <div className="row">
        <input
          className="input"
          style={{ flex: 1 }}
          autoFocus
          placeholder="ابحث عن عميل (رمز أو اسم) أو مستخدم…"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
        <button className="btn" type="button" onClick={onClose}>
          إغلاق
        </button>
      </div>

      {busy && <p className="muted small">جارٍ البحث…</p>}
      {error && <p className="alert danger">{error}</p>}

      {!busy && term.trim().length > 0 && tenants.length === 0 && users.length === 0 && !error && (
        <p className="muted small">لا نتائج.</p>
      )}

      {tenants.length > 0 && (
        <>
          <h3>العملاء</h3>
          <div className="chips">
            {tenants.map((hit) => (
              <Link
                key={hit.id}
                className="chip"
                href={`/tenants/${hit.id}`}
                onClick={onClose}
              >
                {hit.name} <span className="muted">({hit.code})</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {users.length > 0 && (
        <>
          <h3>المستخدمون</h3>
          <div className="chips">
            {users.map((hit) => (
              <Link key={hit.id} className="chip" href={`/users/${hit.id}`} onClick={onClose}>
                {hit.fullName ?? hit.full_name ?? hit.email}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export type { ConsoleItem };
