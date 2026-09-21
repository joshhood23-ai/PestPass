// PestPass service worker — must be served as its own file, same directory as index.html.
// (Service worker registration cannot use a blob: URL — that's disallowed by spec in
// every browser, not just Safari, so this needs to be a real, network-fetchable file.)
const CACHE = 'ga-pest-v95';
const ASSETS = ['./', './index.html', './privacy-policy.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  // Without this, a newly installed SW sits "waiting" until every open tab
  // is fully closed (not just refreshed) before it takes over — meaning an
  // update never reaches the user until they quit and relaunch the app.
  // For a single-file PWA under active iteration, that delay is a real
  // problem, so the new worker activates as soon as it's installed instead.
  self.skipWaiting();
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
