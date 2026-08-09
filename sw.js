// Bump CACHE_VERSION any time you change index.html or the other app-shell
// files — that's what triggers clients to fetch the new version instead of
// serving stale cache. This does NOT affect already-cached content like
// reeving diagrams (see CONTENT_CACHE below) — those persist across updates
// so a crew doesn't lose offline access to plans they've already viewed just
// because an app update shipped.
const CACHE_VERSION = 'myslewer-v4';
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;

// Fetched-on-demand content (reeving diagrams, etc). Fixed name, never
// versioned, never cleared automatically — only ever grows. If this ever
// needs a manual reset, change this constant's name once.
const CONTENT_CACHE = 'app-content-v1';

// Paths are relative to this file's location (repo root on GitHub Pages).
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // Only clean up old APP-SHELL versions. CONTENT_CACHE is never in
          // this deletion list regardless of its name, so previously-viewed
          // reeving diagrams survive every future app update.
          .filter((key) => key.startsWith('app-shell-') && key !== APP_SHELL_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Cache-first for everything, falling back to network. App-shell files are
// precached above; anything else (reeving diagrams, etc.) gets cached into
// the persistent CONTENT_CACHE the first time it's successfully fetched.
// Falls back to the cached index.html for any navigation request that fails
// offline, so deep links / reloads still open the app instead of a browser
// error page.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const responseClone = response.clone();
            caches.open(CONTENT_CACHE).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        });
    })
  );
});
