// SISMO911 service worker — offline shell + cached emergency guide.
const CACHE = 'sismo911-v4';
const PRECACHE = ['/', '/guia.html', '/logo.svg', '/mapa.html', '/sos.html', '/acopio.html', '/acopio-data.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for SAME-ORIGIN GETs only. Cross-origin requests (fonts, unpkg,
// CDNs, analytics) are left untouched so the browser loads them natively — the
// SW must never fetch() them itself (that's subject to connect-src CSP and would
// fail, then serve an HTML fallback that breaks CSS/JS).
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== location.origin) return; // skip cross-origin
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('/guia.html') : undefined)))
  );
});
