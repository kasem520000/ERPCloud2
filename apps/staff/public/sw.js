const CACHE_NAME = 'erpcloud-staff-shell-v2';
const APP_SHELL = ['/pos/offline', '/pos/offline-queue', '/m', '/m/attendance', '/m/requests/new', '/m/approvals', '/m/profile', '/manifest.webmanifest'];

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

self.addEventListener('push', (event) => {
  let payload = { title: 'تنبيه', body: '' };
  try {
    payload = event.data ? event.data.json() : payload;
  } catch {
    payload = { title: 'تنبيه', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(payload.title || 'تنبيه', { body: payload.body || '', dir: 'rtl', lang: 'ar' }));
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
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/pos/offline'))),
    );
    return;
  }

  if (request.method === 'GET' && (url.pathname.startsWith('/_next/') || url.pathname === '/manifest.webmanifest')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        });
        return cached || network;
      }),
    );
  }
});
