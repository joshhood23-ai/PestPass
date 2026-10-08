// PestPass service worker — must be served as its own file, same directory as index.html.
// (Service worker registration cannot use a blob: URL — that's disallowed by spec in
// every browser, not just Safari, so this needs to be a real, network-fetchable file.)
const CACHE='ga-pest-551eca634c';          // rewritten by tools/build.js on every build
const IMG_CACHE='ga-pest-img';             // the photo + boss-art files; their names are content-hashed, so entries never go stale
const ASSETS = ['./', './index.html', './privacy-policy.html'];
const PACKS = /*@@PACKS@@*/["photos-e138ab4101-p1.js","photos-e138ab4101-p2.js","photos-e138ab4101-p3.js","photos-e138ab4101-p4.js","photos-e138ab4101-p5.js","photos-e138ab4101-p6.js","photos-e138ab4101-p7.js","photos-e138ab4101-p8.js","photos-e138ab4101-p9.js","photos-e138ab4101-p10.js","photos-e138ab4101-p11.js","photos-e138ab4101-p12.js","photos-e138ab4101-p13.js","photos-e138ab4101-p14.js","photos-e138ab4101-p15.js","photos-e138ab4101-p16.js","photos-e138ab4101-p17.js","photos-e138ab4101-p18.js","boss-187592eb8d.js"];             // rewritten by tools/build.js — the photos-*.js and boss-*.js files

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
  // The photo files are deliberately NOT fetched here: they'd delay the update toast.
  // The page asks for them after startup (PREFETCH_IMAGES below).
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
      // Take control of any already-open tabs immediately, rather than only
      // controlling tabs opened after this activation — pairs with
      // skipWaiting() above so an update applies on next reload, not next launch.
      .then(() => self.clients.claim())
  );
});

const imgKey = url => new URL(url, self.registration.scope).href;

// Download the photo / boss-art files if we don't have them yet, and drop old versions.
async function prefetchImages() {
  const cache = await caches.open(IMG_CACHE);
  const wanted = new Set(PACKS.map(imgKey));
  const have = new Set((await cache.keys()).map(r => r.url));
  await Promise.all([...have].filter(u => !wanted.has(u)).map(u => cache.delete(u)));
  for (const u of [...wanted].filter(u => !have.has(u))) {
    try { const res = await fetch(u); if (res && res.ok) await cache.put(u, res); } catch (e) {}
  }
}

self.addEventListener('message', e => {
  // Activates a waiting worker immediately when the user taps "Refresh" in
  // the in-app update toast. This is the primary activation path: the
  // install handler deliberately does NOT call skipWaiting(), so the update
  // toast reliably appears instead of the worker activating silently.
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // Sent by the page a few seconds after startup: cache every photo for offline use.
  if(e.data && e.data.type === 'PREFETCH_IMAGES') e.waitUntil(prefetchImages().catch(() => {}));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Photo / boss-art files: cache-first from the image cache, fall back to network and remember it.
  if (url.origin === self.location.origin && /\/(photos|boss)-[0-9a-f]+\.js$/.test(url.pathname)) {
    e.respondWith(
      caches.open(IMG_CACHE).then(c =>
        c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
          if (res && res.ok) c.put(e.request, res.clone());
          return res;
        }))
      ).catch(() => new Response('', { status: 504, statusText: 'Offline' }))
    );
    return;
  }
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
