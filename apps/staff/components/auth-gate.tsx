'use client';

import { Suspense } from 'react';
import { usePathname } from 'next/navigation';

import { useSession } from '../lib/session';
import { isEmployeeSurface, isPublicSurface } from '../lib/surface-routing';

import { AppShell } from './app-shell';
import { EmployeeShell } from './employee-shell';
import { LoginScreen } from './login-screen';

/**
 * Everything behind this component requires a session. The admin panel used to be fully
 * public — anybody who could reach port 3001 saw the whole back office.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, error } = useSession();
  const pathname = usePathname() ?? '';
  // AUD-13 — حدّ مقطعٍ كامل (`/esign` وحدها، وليس `/esign-evil`)، والبوابة كذلك.
  if (isPublicSurface(pathname)) return children;

  if (status === 'loading') {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="logo">ERP</span>
          <p>جارٍ التحقق من الجلسة…</p>
        </div>
      </div>
    );
  }

  if (status === 'anonymous')
    return (
      <Suspense>
        <LoginScreen initialError={error} />
      </Suspense>
    );

  // AUD-13 — `/m` و`/m/…` فقط: `/marina` و`/migration` ليستا تطبيق الموظف.
  if (isEmployeeSurface(pathname)) return <EmployeeShell>{children}</EmployeeShell>;
  return <AppShell>{children}</AppShell>;
}
