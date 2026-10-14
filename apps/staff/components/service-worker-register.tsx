'use client';

import { useEffect } from 'react';

/** Registers the same-origin PWA worker without making offline mode a hard dependency. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
