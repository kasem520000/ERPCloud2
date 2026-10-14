'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { canonicalizePermissionCode } from '@erp/contracts';

import { ApiError, fetchMe, login as apiLogin, logout as apiLogout, readSession, writeSession, type MePayload } from './api';

export type SessionState = {
  status: 'loading' | 'anonymous' | 'authenticated';
  me?: MePayload;
  error?: string;
};

type SessionContextValue = SessionState & {
  can: (permission?: string) => boolean;
  /**
   * P-C1 — the console permission check. Separate from `can()` on purpose: the tenant
   * aliases above must never be consulted for a `console.*` code (the planes are disjoint
   * in `@erp/contracts`), and `*` — which a tenant owner holds — grants nothing here.
   */
  canConsole: (permission?: string) => boolean;
  isPlatformAdmin: boolean;
  signIn: (email: string, password: string, tenantCode: string, mfaCode?: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const load = useCallback(async () => {
    if (!readSession()) {
      setState({ status: 'anonymous' });
      return;
    }
    try {
      const me = await fetchMe();
      setState({ status: 'authenticated', me });
    } catch (error) {
      if (error instanceof ApiError && error.isAuthError) {
        writeSession(undefined);
        setState({ status: 'anonymous' });
        return;
      }
      // The API is unreachable or misconfigured — say so rather than bouncing the user
      // back to a login form that will also fail.
      setState({
        status: 'anonymous',
        error: error instanceof Error ? error.message : 'تعذر الاتصال بالخادم',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string, tenantCode: string, mfaCode?: string) => {
      await apiLogin(email, password, tenantCode, mfaCode);
      const me = await fetchMe();
      setState({ status: 'authenticated', me });
    },
    [],
  );

  const signOut = useCallback(async () => {
    await apiLogout();
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<SessionContextValue>(() => {
    const permissions = state.me?.permissions ?? [];
    const consolePermissions = state.me?.platformPermissions ?? [];
    return {
      ...state,
      isPlatformAdmin: state.me?.user.isPlatformAdmin === true,
      /**
       * AUD-12 — التحقق يمرّ بمُحلّل العقود `canonicalizePermissionCode` وحده:
       * خرائطٌ محلية كانت تُدخل أسماءً لا وجود لها في سجلّ الصلاحيات
       * (`tenant.profile.view`، `tenant.users.view`…)، فيبدو العنصر مخفياً دائماً.
       * الآن الرمزان — الممنوح والمطلوب — يُطبَّعان قبل المقارنة، فالكنسي والقديم
       * يحلّان إلى الشيء نفسه، والمصدر واحد.
       */
      can: (permission?: string) => {
        if (!permission) return true;
        if (permissions.includes('*')) return true;
        const wanted = canonicalizePermissionCode(permission);
        return permissions.some((granted) => canonicalizePermissionCode(granted) === wanted);
      },
      canConsole: (permission?: string) => {
        if (!permission) return true;
        return consolePermissions.includes(permission);
      },
      signIn,
      signOut,
      reload: load,
    };
  }, [state, signIn, signOut, load]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
