'use client';

import { useSession } from '../lib/session';

import { LoginScreen } from './login-screen';
import { PlatformGuard } from './platform-guard';

/**
 * Everything behind this component requires a platform session. There is no
 * self-service signup on the console: platform operators are created by hand and
 * granted roles from `/roles`.
 *
 * P-C1 moved the page chrome (sidebar, top bar, breadcrumb) into `PlatformGuard`, so this
 * gate is now only the session boundary: loading, sign-in, or the console itself.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, error } = useSession();

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

  if (status === 'anonymous') return <LoginScreen initialError={error} />;

  return <PlatformGuard>{children}</PlatformGuard>;
}
