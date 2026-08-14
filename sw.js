// Bump CACHE_VERSION any time you change index.html or the other app-shell
// files — that's what triggers clients to fetch the new version instead of
// serving stale cache. This does NOT affect already-cached content like
// reeving diagrams (see CONTENT_CACHE below) — those persist across updates
// so a crew doesn't lose offline access to plans they've already viewed just
// because an app update shipped.
const CACHE_VERSION = 'myslewer-v84';
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;

// Fetched-on-demand content (reeving diagrams, etc). Fixed name, never
// versioned, never cleared automatically — only ever grows. If this ever
// needs a manual reset, change this constant's name once.
const CONTENT_CACHE = 'app-content-v1';

// Paths are relative to this file's location (repo root on GitHub Pages).
// Counterweight diagrams are precached here (versioned, refreshed on every
// CACHE_VERSION bump) rather than left to fall into CONTENT_CACHE like
// reeving diagrams - these get actively edited as part of ongoing app
// development (unlike reeving diagrams, which don't change once shipped),
// so they need the same "update replaces the old one" guarantee as
// index.html itself. Getting this wrong is exactly how a person can keep
// seeing a diagram fixed weeks ago after every possible cache-version bump -
// the fix landed in CONTENT_CACHE the first time, which nothing here ever
// clears. See methodology.txt 10.28.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './counterweight/img/ltm1250-cwt-exploded-v2.png',
  './counterweight/img/ltm1110-cwt-exploded-v2.png',
  './counterweight/img/ltm1130-cwt-exploded-v2.png',
  './counterweight/img/ltm1160-cwt-newangle.jpg',
  './counterweight/img/ltm1650-cwt-exploded.jpg',
  './counterweight/img/ltm1300-cwt-exploded.png',
  './counterweight/img/ltr1220-cwt-exploded.png'
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
    (async () => {
      const keys = await caches.keys();
      // Only clean up old APP-SHELL versions. CONTENT_CACHE is never in
      // this deletion list regardless of its name, so previously-viewed
      // reeving diagrams survive every future app update.
      await Promise.all(
        keys
          .filter((key) => key.startsWith('app-shell-') && key !== APP_SHELL_CACHE)
          .map((key) => caches.delete(key))
      );
      // Purge any stale duplicate of a now-APP_SHELL url that was
      // previously cached into CONTENT_CACHE before it was added here
      // (this is exactly how the LTM 1650/1160/1300 diagram fixes stayed
      // invisible through several CACHE_VERSION bumps - the old copy
      // landed in CONTENT_CACHE on first view and nothing ever cleared
      // it). Without this, a stale CONTENT_CACHE entry can still win a
      // caches.match() lookup depending on cache iteration order, even
      // though a fresh copy now sits in APP_SHELL_CACHE too.
      const contentCache = await caches.open(CONTENT_CACHE);
      await Promise.all(APP_SHELL.map((url) => contentCache.delete(url)));
      await self.clients.claim();
    })()
  );
});

// App-shell files (precached above) are matched from APP_SHELL_CACHE
// explicitly first and always win, even if a stale copy of the same URL
// still exists in CONTENT_CACHE - this is what actually GUARANTEES an
// updated diagram replaces the old one on the next activate, rather than
// just hoping cache iteration order favours the fresh copy. Everything
// else falls back to cache-first/network, caching into the persistent
// CONTENT_CACHE the first time it's successfully fetched. Falls back to
// the cached index.html for any navigation request that fails offline, so
// deep links / reloads still open the app instead of a browser error page.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.open(APP_SHELL_CACHE).then((shellCache) => shellCache.match(event.request)).then((shellHit) => {
      if (shellHit) return shellHit;

      return caches.match(event.request).then((cached) => {
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
      });
    })
  );
});

// Manual update check, triggered by the header refresh button. Re-fetches
// every app-shell file fresh from the network (cache: 'reload' bypasses the
// HTTP cache too, not just this SW's own cache), overwrites the existing
// entries in the current APP_SHELL_CACHE in place, and reports back whether
// index.html actually changed so the page knows whether to reload. This
// works regardless of whether CACHE_VERSION was bumped on deploy — it
// doesn't rely on the browser's own (throttled) SW-script update check.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHECK_FOR_UPDATE') return;

  event.waitUntil((async () => {
    try {
      const cache = await caches.open(APP_SHELL_CACHE);

      const oldIndexRes = await cache.match('./index.html');
      const oldIndexText = oldIndexRes ? await oldIndexRes.text() : '';

      await Promise.all(APP_SHELL.map(async (url) => {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
      }));

      const newIndexRes = await cache.match('./index.html');
      const newIndexText = newIndexRes ? await newIndexRes.text() : '';

      event.source.postMessage({
        type: 'UPDATE_CHECK_RESULT',
        changed: oldIndexText !== newIndexText
      });
    } catch (e) {
      event.source.postMessage({ type: 'UPDATE_CHECK_RESULT', error: true });
    }
  })());
});
