// ── Origin migration handover (added 2026-11-20) ─────────────────────
// This file is served from two origins during the hosting move. On the
// retired origin (pest-pass.vercel.app) it is a one-way handover: an
// installed copy there never sees the domain redirect — its update check
// follows the redirect off-origin and fails, and the old worker keeps
// serving its stored copy without touching the network. So on that
// origin this worker activates immediately, wipes the stored copy, and
// forwards every page load to the new home. On pestpass.app none of
// this runs and the worker behaves exactly as before.
const MIGRATING = self.location.hostname === 'pest-pass.vercel.app';
if (MIGRATING) {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', e => {
    e.waitUntil(
      caches.keys()
        .then(ks => Promise.all(ks.map(k => caches.delete(k))))
        .then(() => self.clients.claim())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then(cs => Promise.all(cs.map(c => {
          try { return c.navigate('https://pestpass.app/').catch(() => {}); } catch (err) { return null; }
        })))
        .catch(() => {})
    );
  });
  self.addEventListener('fetch', e => {
    if (e.request.mode === 'navigate') {
      const u = new URL(e.request.url);
      e.respondWith(Response.redirect('https://pestpass.app' + u.pathname + u.search, 302));
    }
  });
}

// PestPass service worker — ONLINE-ONLY build (Josh's decision, 2026-11-25).
// The app stays installable to the home screen (this worker + the manifest
// satisfy the install criteria), but the app itself is never cached: every
// page load goes to the network, so PestPass only works with an internet
// connection. The ONLY file this worker caches is a tiny "connection
// required" page, shown when a navigation fails because the device is
// offline. On activation it deletes every cache left by the old
// offline-first worker (the app shell and the ~19 MB of photo packs), so
// installed copies stop working offline as soon as they take this update.
const CACHE='ga-pest-52f1135f39';          // rewritten by stamp-version.js on every build; holds ONLY offline.html
const OFFLINE_URL = './offline.html';

self.addEventListener('install', e => {
  // Cache the offline notice individually — if it is somehow missing, the
  // install must still succeed (the browser's own offline error is the
  // fallback). NOTE: no unconditional skipWaiting() here, same as before:
  // the new worker parks in "waiting" so the page can show its one-tap
  // Refresh toast, and activates when the user taps it (SKIP_WAITING below).
  e.waitUntil(
    caches.open(CACHE).then(c => c.add(OFFLINE_URL).catch(() => {}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Delete EVERY cache except this build's tiny offline-notice cache —
    // including the old app-shell and image caches — then empty the notice
    // cache of anything that is not the notice page itself (an earlier
    // worker may have used the same cache name for the app shell), and
    // take control of open tabs so the purge applies on the same reload
    // that updates.
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => caches.open(CACHE))
      .then(c => c.keys().then(ks => Promise.all(ks.filter(r => !r.url.endsWith('/offline.html')).map(r => c.delete(r)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  // Activates a waiting worker immediately when the user taps "Refresh" in
  // the in-app update toast.
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Cross-origin requests are never intercepted — they go straight to the
  // network. (This also keeps future ad requests untouched: ads are always
  // fetched live and never served from any cache.)
  if (url.origin !== self.location.origin) return;
  // API endpoints are always live data: never intercept, never cache.
  if (url.pathname.startsWith('/api/')) return;
  // Page loads: network only. If the network is unreachable, show the
  // cached connection-required page instead of the browser's error.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() =>
        caches.open(CACHE).then(c => c.match(OFFLINE_URL)).then(hit =>
          hit || new Response('PestPass needs an internet connection.', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        )
      )
    );
    return;
  }
  // Everything else (photo packs, styles, pages): straight to the network,
  // not intercepted and never stored by this worker.
});
