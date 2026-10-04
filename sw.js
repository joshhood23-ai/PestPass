// PestPass service worker — must be served as its own file, same directory as index.html.
// (Service worker registration cannot use a blob: URL — that's disallowed by spec in
// every browser, not just Safari, so this needs to be a real, network-fetchable file.)
const CACHE='ga-pest-8d4243e347';
const ASSETS = ['./', './index.html', './privacy-policy.html'];

self.addEventListener('install', e => {
  // Cache each asset individually: addAll() rejects the ENTIRE install if a
  // single asset 404s (e.g. an optional page like privacy-policy.html that
  // wasn't deployed), which would silently leave the app with no offline
  // support at all. Caching individually means a missing optional file is
  // skipped instead of killing the service worker.
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(url => c.add(url).catch(() => {})))
    )
  );
  // NOTE: no unconditional skipWaiting() here. A worker that activates
  // silently gives the open page no reliable update signal — the
  // 'installed' statechange can fire before the page's updatefound listener
  // attaches, so the "New version available" toast never appears and users
  // stay on the old copy without knowing. Instead the new worker parks in
  // "waiting", the page reliably shows the one-tap Refresh toast, and
  // tapping it sends SKIP_WAITING (handled below) to activate immediately.
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      // Take control of any already-open tabs immediately, rather than only
      // controlling tabs opened after this activation — pairs with
      // skipWaiting() above so an update applies on next reload, not next launch.
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  // Activates a waiting worker immediately when the user taps "Refresh" in
  // the in-app update toast. This is the primary activation path: the
  // install handler deliberately does NOT call skipWaiting(), so the update
  // toast reliably appears instead of the worker activating silently.
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
