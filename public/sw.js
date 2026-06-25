// SISMO911 service worker — offline shell + cached emergency guide.
const CACHE = 'sismo911-v6';
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

// Incoming push → show a notification.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'SISMO911 — Alerta sísmica';
  const opts = {
    body: d.body || 'Nuevo evento sísmico detectado en Venezuela.',
    icon: '/logo.svg', badge: '/logo.svg', vibrate: [120, 60, 120],
    tag: d.tag || 'sismo', renotify: true,
    data: { url: d.url || '/mapa' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Tap a notification → focus/open the relevant page.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if (w.url.includes(url) && 'focus' in w) return w.focus(); }
      return clients.openWindow(url);
    })
  );
});
