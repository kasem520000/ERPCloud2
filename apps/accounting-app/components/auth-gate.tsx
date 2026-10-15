'use client';

import { useSession } from '@erp/web-core/session';

import { useQuery } from '../lib/use-query';
import { fetchAccountingEntitlement } from '../lib/accounting';

import { AppShell } from './app-shell';
import { LoginScreen } from './login-screen';

/**
 * M3 — everything behind this component requires a session AND an entitlement:
 *
 *   1. session (same model as the staff panel — the anonymous visitor sees the login
 *      screen, never the back office);
 *   2. the `accounting` marketplace app must be entitled for the tenant (D-002:
 *      entitlement control via `tenant_apps`, never new tenancy). The check runs once
 *      per session against `GET /marketplace/apps`; an operator's explicit disable
 *      (`tenant_apps.is_enabled = false`) locks the tenant out.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, error } = useSession();
  const entitlement = useQuery(fetchAccountingEntitlement, [status]);

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

  if (entitlement.status === 'loading') {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="logo big">ERP</span>
          <p>جارٍ التحقق من اشتراك التطبيق…</p>
        </div>
      </div>
    );
  }

  if (entitlement.status !== 'success' || !entitlement.data) {
    return (
      <div className="boot">
        <div className="boot-card" style={{ maxWidth: '560px', padding: '24px', textAlign: 'center' }}>
          <span className="logo big">ERP</span>
          <h1 style={{ fontSize: '20px', margin: 0 }}>التطبيق غير مفعّل لهذه المنشأة</h1>
          <p className="muted small">
            تطبيق المحاسبة مشحون مع النظام لكن يمكن لمشغّل المنصة تعطيله لمنشأتك. تواصل مع إدارة
            المنصة أو فعّله من لوحة التحكم (السوق ← الإضافات).
          </p>
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
