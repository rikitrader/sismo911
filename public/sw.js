// SISMO911 service worker — offline shell + cached emergency guide.
const CACHE = 'sismo911-v10';
const PRECACHE = [
  '/',
  '/app',
  '/flota/track',
  '/archivo',
  '/acopio',
  '/acopio.html',
  '/alertas',
  '/blog',
  '/canal',
  '/casos',
  '/comms',
  '/contacto',
  '/cuenta',
  '/dashboard',
  '/donar',
  '/danos',
  '/danos-estructurales',
  '/developers',
  '/estados',
  '/estoy-a-salvo',
  '/familia',
  '/gracias',
  '/geosismico',
  '/geosismico.html',
  '/guia',
  '/guia.html',
  '/hospitales',
  '/humanitario',
  '/humanitario.html',
  '/informacion-verificada',
  '/layers',
  '/layers.html',
  '/login',
  '/logistica',
  '/mapa',
  '/mapa.html',
  '/mascota',
  '/mascotas',
  '/movimiento',
  '/operaciones',
  '/operaciones.html',
  '/pager',
  '/personas',
  '/privacidad',
  '/reporte',
  '/recaudar',
  '/recursos',
  '/red-ayuda',
  '/reportar',
  '/restablecer',
  '/roadmap',
  '/satellite',
  '/satellite.html',
  '/sos',
  '/sos.html',
  '/suministros-dashboard',
  '/suministros-medicos',
  '/voluntario',
  '/voluntarios',
  '/logo.svg',
  '/acopio-data.json',
  // Emergency guide images — cached so the guía works fully offline.
  '/guia/00-banner.webp', '/guia/01-refuerce-casa.webp', '/guia/02-plan-familiar.webp', '/guia/03-mochila-suministros.webp',
  '/guia/04-documentos-finanzas.webp', '/guia/05-agachese-cubrase.webp', '/guia/06-seguridad-despues.webp', '/guia/07-restablezca-radio.webp',
  // Telemedicina installable-app shell — so the dedicated PWA opens offline.
  '/telemedicina', '/telemedicina-panel', '/app.css', '/app-shell.js', '/telemedicina-pwa.js',
  '/telemedicina.webmanifest', '/telemedicina-icon.svg', '/icons/telemedicina-192.png', '/icons/telemedicina-512.png',
];

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
