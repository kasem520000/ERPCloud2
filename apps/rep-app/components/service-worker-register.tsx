'use client';

import { useEffect } from 'react';

/**
 * M5 — registers `/sw.js` (D-006: installable PWA with an app-shell cache). Same
 * contract as the staff panel's registrar: swallow every error (the app must work even
 * where service workers are blocked), unregister nothing, log nothing in production.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    };
    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
    return undefined;
  }, []);

  return null;
}
