/*
 * ERPCloud rep app — service worker (M5, D-006: PWA first).
 *
 * Same contract as the staff panel's worker (`apps/staff/public/sw.js`), trimmed to the
 * rep app's shell:
 *   • the app shell (every top-level screen) is precached on install, so the rep can
 *     open the app with no connectivity at all;
 *   • navigations try the network first and fall back to the cached shell (the data is
 *     in IndexedDB, not in this cache);
 *   • `/api/*` is NEVER cached or intercepted — the offline queue in IndexedDB is the
 *     honest offline story for writes, and stale reads are the server's delta to serve;
 *   • no push/notification handling: the rep app has no push channel (yet).
 */
const CACHE_NAME = 'erpcloud-rep-shell-v1';
const APP_SHELL = [
  '/',
  '/customers',
  '/stock',
  '/invoice',
  '/receipt',
  '/return',
  '/closing',
  '/sync',
  '/queue',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map((path) => fetch(path).then((response) => {
        if (response.ok) return cache.put(path, response);
        return undefined;
      }).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/'))),
    );
    return;
  }

  if (request.method === 'GET') {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok && url.pathname.startsWith('/_next/static/')) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
  }
});
