'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { apiData } from '../lib/api';
import { useLang } from '../lib/i18n';
import { useSession } from '../lib/session';

import { ImpersonationBanner } from './impersonation-banner';

type Notice = { id: string; title: string; body: string };

const NAV_ITEMS = [
  { href: '/m', label: '🏠 الرئيسية' },
  { href: '/m/attendance', label: '⏱️ الحضور والانصراف' },
  { href: '/m/requests/new', label: '📝 طلب جديد' },
  { href: '/m/approvals', label: '✅ موافقات الفريق' },
  { href: '/m/profile', label: '👤 راتبي وإجازاتي' },
];

export function EmployeeShell({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice>();
  // AUD-13 — لافتة الدخول المؤقّت تظهر في **كل** قشرة، لا في لوحة الإدارة وحدها:
  // الموظف المستعار لا يجوز أن يعمل بلا أن يرى أن الشاشة ليست شاشته.
  const { me } = useSession();
  const { lang } = useLang();
  const pathname = usePathname() ?? '/m';

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const rows = await apiData<Notice[]>('/employee/notices');
        const next = Array.isArray(rows) ? rows[0] : undefined;
        if (!stop && next) {
          setNotice(next);
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(next.title, { body: next.body, dir: 'rtl', lang: 'ar' });
          }
        }
      } catch {
        // A missing employee link should not block the shell.
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 30000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="employee-app">
      <header className="employee-bar">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <strong style={{ fontSize: 18 }}>📱 تطبيق الموظف الذاتي</strong>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
              {me?.membership.tenantName ?? 'المنشأة'} · {me?.user.fullName || me?.user.email || ''}
            </p>
          </div>
          <Link className="btn sm" href="/">
            ↩ العودة للنظام الرئيسي
          </Link>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? 'btn primary sm' : 'btn sm'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <ImpersonationBanner impersonation={me?.impersonation} lang={lang} />
      {notice ? <p className="alert warn">{notice.title}: {notice.body}</p> : null}
      <main style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}>{children}</main>
    </div>
  );
}
