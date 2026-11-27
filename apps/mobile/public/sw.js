/*
 * HAVEN service worker: the app shell only (DEC-026 Phase 1, installable web app).
 *
 * - Never touches the API (/v1/...): no personal data is ever cached or served offline.
 * - Navigations: network first; the last good page shell is kept so a brief drop in
 *   signal still opens the app (it then shows its own "offline" banner).
 * - /_expo/static/ files have content hashes in their names, so they are cached as is.
 * - Bump VERSION to drop every old cache on the next visit.
 */
const VERSION = 'haven-shell-v1';
const SHELL_KEY = '/__shell';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/__')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(SHELL_KEY, copy));
          }
          return response;
        })
        .catch(() => caches.match(SHELL_KEY).then((cached) => cached || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/_expo/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
