import { Hono } from 'hono';
import type { Env } from '../types';

// Public, shareable "Se busca" articles — one per missing-person case in the
// `personas` registry. Rendered dynamically from D1 so it scales to the full
// registry (tens of thousands of cases) with zero static files. Each page has
// the person's photo, last-known location, a short report, a link to their
// search case in /familia, and full social-share buttons → built to go viral
// and help reunite families after the 24-J terremoto.
export const desaparecidos = new Hono<{ Bindings: Env }>();

const PAGE = 48; // cards per index page
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const BASE = 'https://sismo911.com';

const HEADER = `<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/mapa" class="hover:text-white/70">Mapa</a><a href="/sos" class="text-secondary-fixed font-bold">SOS</a><a href="/personas" class="hover:text-white/70">Personas</a><a href="/familia" class="hover:text-white/70">Familia</a><a href="/acopio" class="hover:text-white/70">Acopio</a><a href="/recursos" class="hover:text-white/70">Recursos</a><a href="/guia" class="hover:text-white/70">Guía</a><a href="/contacto" class="hover:text-white/70">Contacto</a><a href="/blog" class="text-white">Noticias</a></nav></div></header>`;

const HEAD = (title: string, desc: string, canon: string, img: string, extra = '') => `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${esc(canon)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="SISMO911"><meta property="og:locale" content="es_VE">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canon)}"><meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><meta name="theme-color" content="#13284f">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css" />
<script src="/app-shell.js" defer></script>
<style>body{background:#f9f9fc}.font-display{font-family:'Public Sans',sans-serif}.prose-ve p{margin:.85rem 0;line-height:1.75}</style>
${extra}</head>`;

// full social-share bar — every major network + native share/copy
function shareBar(title: string, url: string) {
  const u = encodeURIComponent(url), t = encodeURIComponent(title), tu = `${t}%20${u}`;
  const btn = (label: string, href: string, bg: string) =>
    `<a class="inline-flex items-center gap-1 text-sm font-semibold text-white rounded-lg px-3 py-2 hover:opacity-90 transition-opacity no-underline" style="background:${bg}" target="_blank" rel="noopener" aria-label="Compartir en ${label}">${label}</a>`;
  return `<div class="mt-6 flex flex-wrap items-center gap-2" aria-label="Compartir este caso">
    <span class="text-xs font-bold text-on-surface-variant uppercase tracking-wide mr-1">Difundir</span>
    <button onclick="navigator.share?navigator.share({title:document.title,url:location.href}):navigator.clipboard.writeText(location.href).then(()=>alert('Enlace copiado'))" class="inline-flex items-center gap-1 text-sm font-semibold border border-outline-variant rounded-lg px-3 py-2 hover:bg-surface-container" aria-label="Compartir o copiar el enlace">🔗 Compartir</button>
    ${btn('WhatsApp', `https://wa.me/?text=${tu}`, '#25D366')}
    ${btn('Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`, '#1877F2')}
    ${btn('X', `https://twitter.com/intent/tweet?text=${t}&url=${u}`, '#111827')}
    ${btn('Telegram', `https://t.me/share/url?url=${u}&text=${t}`, '#229ED9')}
    ${btn('LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`, '#0A66C2')}
    ${btn('Email', `mailto:?subject=${t}&body=${tu}`, '#6B7280')}
  </div>`;
}

const statusLabel = (e: string) =>
  e === 'localizado' ? { txt: '✅ Localizado con vida', bg: '#16a34a' }
    : e === 'fallecido' ? { txt: 'Localizado sin vida', bg: '#6b7280' }
      : { txt: '🔴 Reportado como desaparecido', bg: '#bb0027' };

const caseLink = (p: any) =>
  `/familia?reportar=1&nombre=${encodeURIComponent(p.nombre || '')}&lugar=${encodeURIComponent(p.ubicacion || '')}&ref=${encodeURIComponent(`${BASE}/blog/desaparecido/${p.id}`)}`;

// ---------- single case article ----------
desaparecidos.get('/blog/desaparecido/:id', async (c) => {
  const id = c.req.param('id');
  const p = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, descripcion, estado, foto, foto_r2, updated_at
     FROM personas WHERE id = ? AND moderation = 'approved'`,
  ).bind(id).first<any>().catch(() => null);
  if (!p) return c.text('Caso no encontrado', 404);

  const canon = `${BASE}/blog/desaparecido/${p.id}`;
  const img = (p.foto_r2 || p.foto) ? `${BASE}/api/familia/photo/${p.id}` : `${BASE}/og/og-default.png`;
  const age = p.edad ? `, ${p.edad} años` : '';
  const lugar = p.ubicacion || 'Venezuela';
  const title = `🔴 Se busca a ${p.nombre}${age} — visto por última vez en ${lugar}`;
  const desc = `${p.nombre}${age} figura entre las personas reportadas como desaparecidas tras el terremoto M7.5 del 24-J en Venezuela. Última ubicación conocida: ${lugar}. Comparte para ayudar a su familia.`;
  const st = statusLabel(p.estado);
  const cl = caseLink(p);
  const body = `<p>${esc(p.nombre)}${age ? ` (${esc(p.edad)} años)` : ''} figura entre las personas que sus familiares reportaron como <b>desaparecidas</b> tras el terremoto de magnitud 7.5 del <b>24 de junio de 2026</b> en Venezuela. La última ubicación conocida es <b>${esc(lugar)}</b>.</p>
    ${p.descripcion ? `<p>${esc(p.descripcion)}</p>` : ''}
    <p>Si has visto a esta persona o tienes cualquier información sobre su paradero, <b>repórtalo en el caso de búsqueda</b> de SISMO911. Cada vez que compartes este aviso aumentan las probabilidades de reunir a esta familia.</p>`;

  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: title, description: desc, inLanguage: 'es', image: [img],
    mainEntityOfPage: canon, datePublished: '2026-06-24T21:04:00Z',
    publisher: { '@type': 'Organization', name: 'SISMO911', logo: { '@type': 'ImageObject', url: `${BASE}/logo.svg` } },
    about: [{ '@type': 'Person', name: p.nombre }, { '@type': 'Event', name: 'Terremoto de Venezuela del 24 de junio de 2026' }],
  };

  const html = `${HEAD(`${title} — SISMO911`, desc, canon, img, `<script type="application/ld+json">${JSON.stringify(ld)}</script>`)}
<body class="font-sans text-on-surface">
${HEADER}
<main class="px-4 sm:px-6 lg:px-8 py-8"><div class="mx-auto max-w-3xl">
  <nav class="text-xs text-on-surface-variant mb-3" aria-label="Ruta"><a href="/" class="hover:underline">Inicio</a> › <a href="/blog" class="hover:underline">Noticias</a> › <a href="/blog/desaparecidos" class="hover:underline">Desaparecidos</a> › <span>${esc(p.nombre)}</span></nav>
  <article class="prose-ve">
    <div class="flex flex-wrap items-center gap-2 text-xs font-semibold mb-3">
      <span class="inline-flex items-center gap-1 text-white px-2 py-0.5 rounded" style="background:${st.bg}">${st.txt}</span>
      <span class="bg-surface-container text-on-surface-variant px-2 py-0.5 rounded">Terremoto 24-J · Venezuela</span>
    </div>
    <h1 class="font-display font-extrabold text-2xl sm:text-3xl leading-tight mb-4">Se busca a ${esc(p.nombre)}${esc(age)}</h1>
    <figure class="mb-4">
      <div class="w-full rounded-lg border border-outline-variant/60 overflow-hidden bg-surface-container" style="aspect-ratio:4/3"><img src="${esc(img)}" alt="${esc(p.nombre)}" class="w-full h-full object-cover" loading="eager" decoding="async"></div>
      <figcaption class="mt-2 text-xs text-on-surface-variant">Última ubicación conocida: ${esc(lugar)}</figcaption>
    </figure>
    <a href="${esc(cl)}" class="flex items-center gap-3 bg-secondary/10 border border-secondary/30 rounded-lg p-3 mb-6 hover:bg-secondary/15 transition-colors no-underline"><span class="text-xl shrink-0">🔎</span><span class="text-sm text-on-surface"><b class="text-secondary">¿Tienes información?</b> Abre el <b>caso de búsqueda</b> en Familia y reporta un avistamiento →</span></a>
    ${body}
    ${shareBar(title, canon)}
    <div class="mt-8 bg-primary/5 border border-primary/20 rounded-lg p-4 text-xs text-on-surface-variant">
      <b>Aviso:</b> dato del registro ciudadano de personas desaparecidas de SISMO911. Es un <b>reporte sin verificación independiente</b>; si los datos son incorrectos o la persona ya fue localizada, repórtalo en el caso para actualizarlo. Para información oficial siga a Protección Civil y a las autoridades.
    </div>
    <p class="mt-6"><a href="/blog/desaparecidos" class="text-primary font-semibold text-sm">← Ver más personas desaparecidas</a></p>
  </article>
</div></main>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>
</body></html>`;
  return c.html(html);
});

// ---------- paginated index of all cases ----------
desaparecidos.get('/blog/desaparecidos', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || '1') || 1);
  const offset = (page - 1) * PAGE;
  const where = `foto_r2 IS NOT NULL AND moderation = 'approved'`;
  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${where}`).first<any>())?.n) ?? 0;
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, estado FROM personas WHERE ${where}
     ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).bind(PAGE, offset).all<any>();
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const card = (p: any) => {
    const a = `/blog/desaparecido/${p.id}`;
    const st = statusLabel(p.estado);
    return `<div class="group bg-white border border-outline-variant/60 rounded-xl overflow-hidden flex flex-col hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
      <a href="${a}" class="block relative aspect-[4/3] overflow-hidden bg-surface-container"><img src="/api/familia/photo/${esc(p.id)}" alt="${esc(p.nombre)}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"><span class="absolute top-2 left-2 text-white text-[10px] font-bold px-2 py-0.5 rounded-full backdrop-blur-sm" style="background:${st.bg}cc">${st.txt}</span></a>
      <div class="p-3 flex flex-col flex-1">
        <a href="${a}"><h3 class="font-display font-bold text-[14px] leading-snug text-on-surface mb-0.5 line-clamp-2 group-hover:text-primary">${esc(p.nombre)}${p.edad ? `, ${esc(p.edad)}` : ''}</h3></a>
        <p class="text-xs text-on-surface-variant line-clamp-1 mb-2">📍 ${esc(p.ubicacion || 'Venezuela')}</p>
        <div class="mt-auto flex items-center justify-between text-[11px]"><a href="${a}" class="text-primary font-semibold hover:underline">Ver y difundir →</a><a target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Se busca a ${p.nombre}. ${BASE}/blog/desaparecido/${p.id}`)}" class="text-[#25D366] font-semibold hover:underline">WhatsApp</a></div>
      </div>
    </div>`;
  };

  const pageLink = (n: number, label: string, disabled: boolean) =>
    disabled ? `<span class="px-3 py-2 text-sm text-on-surface-variant/50">${label}</span>`
      : `<a href="/blog/desaparecidos?page=${n}" class="px-3 py-2 text-sm font-semibold border border-outline-variant rounded-lg hover:bg-surface-container">${label}</a>`;

  const canon = `${BASE}/blog/desaparecidos${page > 1 ? `?page=${page}` : ''}`;
  const html = `${HEAD(
    `Personas desaparecidas tras el terremoto de Venezuela — SISMO911${page > 1 ? ` (página ${page})` : ''}`,
    `Registro ciudadano de ${total.toLocaleString('es')} personas reportadas como desaparecidas tras el terremoto M7.5 del 24-J en Venezuela. Comparte cada caso para ayudar a reunir a las familias.`,
    canon, `${BASE}/og/og-default.png`,
    `${page > 1 ? `<link rel="prev" href="/blog/desaparecidos?page=${page - 1}">` : ''}${page < pages ? `<link rel="next" href="/blog/desaparecidos?page=${page + 1}">` : ''}`,
  )}
<body class="font-sans text-on-surface">
${HEADER}
<main class="px-4 sm:px-6 lg:px-8 py-8"><div class="mx-auto max-w-6xl">
  <div class="border-b border-outline-variant/60 pb-5 mb-7">
    <div class="label-caps text-secondary text-[11px] mb-1">SISMO911 · Familia · Difunde y reúne</div>
    <h1 class="font-display font-extrabold text-3xl sm:text-4xl tracking-tight">Personas desaparecidas</h1>
    <p class="text-sm text-on-surface-variant max-w-2xl mt-2">${total.toLocaleString('es')} reportes ciudadanos del terremoto del 24-J. Cada persona tiene su propia página para <b>compartir en redes</b>. Si reconoces a alguien, abre su caso y reporta un avistamiento.</p>
  </div>
  <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
    ${rows.map(card).join('\n')}
  </div>
  <nav class="mt-8 flex items-center justify-center gap-2" aria-label="Paginación">
    ${pageLink(page - 1, '← Anterior', page <= 1)}
    <span class="px-3 py-2 text-sm text-on-surface-variant">Página ${page} de ${pages}</span>
    ${pageLink(page + 1, 'Siguiente →', page >= pages)}
  </nav>
</div></main>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>
</body></html>`;
  return c.html(html);
});

// ---------- sitemap of every case (KV-cached 6h) ----------
desaparecidos.get('/sitemap-desaparecidos.xml', async (c) => {
  const KEY = 'sitemap:desaparecidos';
  const cached = await c.env.CACHE.get(KEY).catch(() => null);
  if (cached) return c.body(cached, 200, { 'content-type': 'application/xml; charset=utf-8' });
  const { results } = await c.env.DB.prepare(
    `SELECT id FROM personas WHERE foto_r2 IS NOT NULL AND moderation = 'approved'
     ORDER BY updated_at DESC LIMIT 45000`,
  ).all<any>();
  const urls = [`  <url><loc>${BASE}/blog/desaparecidos</loc><changefreq>hourly</changefreq><priority>0.7</priority></url>`]
    .concat(results.map((r) => `  <url><loc>${BASE}/blog/desaparecido/${esc(r.id)}</loc><lastmod>2026-06-25</lastmod><changefreq>daily</changefreq><priority>0.5</priority></url>`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  await c.env.CACHE.put(KEY, xml, { expirationTtl: 21600 }).catch(() => {});
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8' });
});
