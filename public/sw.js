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

// ---- FLOTA Background Sync ----
// Flush buffered GPS even when the phone PWA is closed. The 'flota-gps' IndexedDB
// (written by /flota/track) holds the queued fixes + the unit token; we upload to
// /flota/track/backfill in batches and remove on success. A failed upload throws so
// the browser retries the sync later. Token never leaves the device except as the
// Bearer auth to its own backfill endpoint.
const FLOTA_DB = 'flota-gps', FLOTA_QUEUE = 'queue', FLOTA_META = 'meta', FLOTA_BATCH = 200;
function flotaIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(FLOTA_DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(FLOTA_QUEUE)) db.createObjectStore(FLOTA_QUEUE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(FLOTA_META)) db.createObjectStore(FLOTA_META, { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function flotaMeta(db, k) {
  return new Promise((res) => {
    const rq = db.transaction(FLOTA_META, 'readonly').objectStore(FLOTA_META).get(k);
    rq.onsuccess = () => res(rq.result ? rq.result.v : null);
    rq.onerror = () => res(null);
  });
}
function flotaTake(db, limit) {
  return new Promise((res) => {
    const items = []; const tx = db.transaction(FLOTA_QUEUE, 'readonly');
    tx.objectStore(FLOTA_QUEUE).openCursor().onsuccess = (e) => {
      const c = e.target.result; if (c && items.length < limit) { items.push({ id: c.key, fix: c.value.fix }); c.continue(); }
    };
    tx.oncomplete = () => res(items);
  });
}
function flotaDel(db, ids) {
  return new Promise((res) => {
    const tx = db.transaction(FLOTA_QUEUE, 'readwrite'); const s = tx.objectStore(FLOTA_QUEUE);
    ids.forEach((id) => s.delete(id));
    tx.oncomplete = () => res();
  });
}
async function flotaFlush() {
  const db = await flotaIdb();
  const token = await flotaMeta(db, 'token');
  if (!token) return;
  for (let pass = 0; pass < 50; pass++) {
    const items = await flotaTake(db, FLOTA_BATCH);
    if (!items.length) return;
    const r = await fetch('/flota/track/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ fixes: items.map((it) => it.fix) }),
    });
    if (!r.ok) throw new Error('backfill ' + r.status); // throw → the browser retries the sync later
    await flotaDel(db, items.map((it) => it.id));
  }
}
self.addEventListener('sync', (e) => {
  if (e.tag === 'flota-flush') e.waitUntil(flotaFlush());
});
