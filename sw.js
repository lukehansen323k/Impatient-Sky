// Impatient Sky service worker: instant start and offline use.
// App files: served from cache, refreshed in the background.
// Data: network first (it changes every 2 hours), cache as the fallback.
const VERSION = 'isky-__BUILD__';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/worker.js', 'js/passes.js', 'js/astro.js', 'js/ar.js', 'js/sky-objects.js',
  'js/vendor/satellite.min.mjs', 'js/vendor/geomag.min.mjs', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) {
    // strip the cache-busting query so the offline copy can always be found
    const key = new Request(url.origin + url.pathname);
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key)));
    return;
  }
  const key = new Request(url.origin + url.pathname);
  e.respondWith(caches.match(key).then((hit) => {
    const net = fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
      return r;
    });
    return hit || net;
  }));
});
