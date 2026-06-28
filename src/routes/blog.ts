import { Hono } from 'hono';
import type { Env } from '../types';
import { fetchBlogSources } from '../ingest/blog-sources';
import { ingestBlog, writeArticle, deriveHeadline } from '../ingest/blog-cron';
import { sanitizeHtml, isSafePublicUrl } from '../lib/sanitize';
import { cspNonce } from '../lib/security';

// Dynamic /blog ("Noticias") — a magazine of AI-written field reports, each
// derived from a REAL scraped citizen post about the 24-J terremoto. Rendered
// live from the `blog_posts` D1 table so the every-3h cron
// (scripts/cron-blog.mjs) can publish a new story by POSTing to
// /api/admin/blog/ingest — no redeploy needed. Mirrors the design system and
// HTML conventions of routes/desaparecidos.ts (app.css + app-shell.js).
export const blog = new Hono<{ Bindings: Env }>();

const PAGE = 24;
const BASE = 'https://sismo911.com';
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Slugs owned by routes/desaparecidos.ts + the rss route registered above —
// never let /blog/:slug shadow them.
const RESERVED = new Set(['desaparecidos', 'rss.xml']);

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
<link rel="alternate" type="application/rss+xml" title="SISMO911 · Noticias" href="${BASE}/blog/rss.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css" />
<script src="/app-shell.js" defer></script>
<style>body{background:#f9f9fc}.font-display{font-family:'Public Sans',sans-serif}.prose-ve p{margin:.85rem 0;line-height:1.75}.prose-ve b{color:#00173a}</style>
${extra}</head>`;

// Branded SVG cover (base64 data-URI) used as the card/hero background so an
// expired social-CDN photo never leaves a blank navy block (see skill playbook).
function coverDataUri(place: string, platform: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00173a"/><stop offset="1" stop-color="#0a2a5e"/></linearGradient></defs><rect width="1200" height="675" fill="url(#g)"/><g fill="#ffffff" opacity="0.9"><text x="60" y="120" font-family="Public Sans,Arial" font-size="34" font-weight="800" letter-spacing="2">SISMO911</text><text x="60" y="360" font-family="Public Sans,Arial" font-size="64" font-weight="800">${esc(place).slice(0, 22)}</text><text x="60" y="430" font-family="Inter,Arial" font-size="30" opacity="0.75">Reporte ciudadano · ${esc(platform || 'redes')}</text></g><rect x="0" y="655" width="1200" height="20" fill="#bb0027"/></svg>`;
  // base64 (NOT ;utf8,+encodeURIComponent — that renders blank in Chrome).
  // UTF-8-safe btoa (place names carry accents); the SVG is small.
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:image/svg+xml;base64,' + btoa(bin);
}

// Build an iframe-only video embed from platform + url. Iframe-only keeps the
// CSP tight: only `frame-src` needs the host, no third-party `script-src`.
function videoEmbed(platform: string, videoUrl: string): string {
  const u = videoUrl || '';
  try {
    if (platform === 'youtube' || /youtu\.?be/.test(u)) {
      const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
      if (m) return iframe(`https://www.youtube-nocookie.com/embed/${m[1]}`, 'YouTube');
    }
    if (platform === 'tiktok' || /tiktok\.com/.test(u)) {
      const m = u.match(/video\/(\d+)/);
      if (m) return iframe(`https://www.tiktok.com/embed/v2/${m[1]}`, 'TikTok', 'aspect-[9/16] max-w-[340px] mx-auto');
    }
    if (platform === 'instagram' || /instagram\.com/.test(u)) {
      const m = u.match(/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/);
      if (m) return iframe(`https://www.instagram.com/p/${m[1]}/embed`, 'Instagram', 'aspect-[4/5] max-w-[420px] mx-auto');
    }
  } catch { /* fall through to no embed */ }
  return '';
}
function iframe(src: string, label: string, cls = 'aspect-video') {
  return `<div class="${cls} my-5 rounded-lg overflow-hidden border border-outline-variant/60 bg-black"><iframe src="${esc(src)}" title="Video de ${esc(label)}" class="w-full h-full" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
}

function shareBar(title: string, url: string) {
  const u = encodeURIComponent(url), t = encodeURIComponent(title), tu = `${t}%20${u}`;
  const btn = (label: string, href: string, bg: string) =>
    `<a class="inline-flex items-center gap-1 text-sm font-semibold text-white rounded-lg px-3 py-2 hover:opacity-90 no-underline" style="background:${bg}" target="_blank" rel="noopener" href="${href}" aria-label="Compartir en ${label}">${label}</a>`;
  return `<div class="mt-6 flex flex-wrap items-center gap-2" aria-label="Compartir esta noticia">
    <span class="text-xs font-bold text-on-surface-variant uppercase tracking-wide mr-1">Difundir</span>
    <button data-act="__share" class="inline-flex items-center gap-1 text-sm font-semibold border border-outline-variant rounded-lg px-3 py-2 hover:bg-surface-container" aria-label="Compartir o copiar el enlace">🔗 Compartir</button>
    ${btn('WhatsApp', `https://wa.me/?text=${tu}`, '#25D366')}
    ${btn('Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`, '#1877F2')}
    ${btn('X', `https://twitter.com/intent/tweet?text=${t}&url=${u}`, '#111827')}
    ${btn('Telegram', `https://t.me/share/url?url=${u}&text=${t}`, '#229ED9')}
  </div>`;
}

const caseLink = (place: string, ref: string) =>
  `/familia?reportar=1&lugar=${encodeURIComponent(place || 'Venezuela')}&ref=${encodeURIComponent(ref)}`;

const platIcon = (p: string) =>
  ({ tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', x: 'X' } as Record<string, string>)[p] || 'Redes';

// ---------------- index (magazine) ----------------
blog.get('/blog', async (c) => {
  const nonce = cspNonce(c);
  const page = Math.max(1, Number(c.req.query('page') || '1') || 1);
  const offset = (page - 1) * PAGE;
  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM blog_posts WHERE status='published'`).first<any>())?.n) ?? 0;
  const { results: rows } = await c.env.DB.prepare(
    `SELECT slug, headline, meta_desc, place, platform, author, image_url, video_url, featured, published_at
       FROM blog_posts WHERE status='published'
       ORDER BY featured DESC, published_at DESC LIMIT ? OFFSET ?`,
  ).bind(PAGE, offset).all<any>();
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const hero = page === 1 ? rows[0] : null;
  const grid = page === 1 ? rows.slice(1) : rows;

  const cover = (p: any) => `'${coverDataUri(p.place, p.platform)}'`;
  const heroCard = (p: any) => `<a href="/blog/${esc(p.slug)}" class="group block rounded-2xl overflow-hidden border border-outline-variant/60 bg-white hover:shadow-xl transition-shadow no-underline mb-8">
    <div class="aspect-[16/9] bg-cover bg-center relative" style="background-image:url(${cover(p)})">
      <img src="${esc(p.image_url || '')}" alt="" loading="eager" fetchpriority="high" class="w-full h-full object-cover" data-hide-on-err>
      <span class="absolute top-3 left-3 bg-secondary text-white text-[11px] font-bold px-2 py-1 rounded">DESTACADA${p.video_url ? ' · 🎬 VIDEO' : ''}</span>
    </div>
    <div class="p-5 sm:p-7">
      <div class="label-caps text-secondary text-[11px] mb-2">📍 ${esc(p.place)} · ${esc(platIcon(p.platform))}</div>
      <h2 class="font-display font-extrabold text-2xl sm:text-3xl leading-tight text-on-surface group-hover:text-primary">${esc(p.headline)}</h2>
      <p class="text-sm text-on-surface-variant mt-3 max-w-2xl">${esc(p.meta_desc)}</p>
    </div></a>`;

  const card = (p: any) => `<article class="group bg-white border border-outline-variant/60 rounded-xl overflow-hidden flex flex-col hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
    <a href="/blog/${esc(p.slug)}" class="block aspect-[16/9] bg-cover bg-center relative" style="background-image:url(${cover(p)})">
      <img src="${esc(p.image_url || '')}" alt="" loading="lazy" class="w-full h-full object-cover" data-hide-on-err>
      ${p.video_url ? `<span class="absolute top-2 right-2 bg-black/70 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">🎬 VIDEO</span>` : ''}
    </a>
    <div class="p-4 flex flex-col flex-1">
      <div class="label-caps text-secondary text-[10px] mb-1">📍 ${esc(p.place)} · ${esc(platIcon(p.platform))}</div>
      <a href="/blog/${esc(p.slug)}"><h3 class="font-display font-bold text-[15px] leading-snug text-on-surface mb-1 line-clamp-3 group-hover:text-primary">${esc(p.headline)}</h3></a>
      <p class="text-xs text-on-surface-variant line-clamp-2 mb-3">${esc(p.meta_desc)}</p>
      <div class="mt-auto flex items-center justify-between text-[11px]">
        <a href="/blog/${esc(p.slug)}" class="text-primary font-semibold hover:underline">Leer →</a>
        <a href="${esc(caseLink(p.place, `${BASE}/blog/${p.slug}`))}" class="text-secondary font-semibold hover:underline">🔎 Vincular a caso</a>
      </div>
    </div></article>`;

  const pageLink = (n: number, label: string, disabled: boolean) =>
    disabled ? `<span class="px-3 py-2 text-sm text-on-surface-variant/50">${label}</span>`
      : `<a href="/blog?page=${n}" class="px-3 py-2 text-sm font-semibold border border-outline-variant rounded-lg hover:bg-surface-container">${label}</a>`;

  const empty = total === 0 ? `<div class="bg-white border border-outline-variant/60 rounded-xl p-10 text-center text-on-surface-variant">Aún no hay reportes publicados. El monitor de redes publica nuevas noticias del terremoto cada pocas horas.</div>` : '';
  const canon = `${BASE}/blog${page > 1 ? `?page=${page}` : ''}`;
  const html = `${HEAD(
    `Noticias del terremoto de Venezuela — SISMO911${page > 1 ? ` (página ${page})` : ''}`,
    `Cobertura en vivo del terremoto M7.5 del 24-J: ${total.toLocaleString('es')} reportes ciudadanos verificados desde TikTok, Instagram, YouTube y más, geolocalizados y narrados.`,
    canon, hero?.image_url || `${BASE}/og/og-default.png`,
    `${page > 1 ? `<link rel="prev" href="/blog?page=${page - 1}">` : ''}${page < pages ? `<link rel="next" href="/blog?page=${page + 1}">` : ''}`,
  )}
<body class="font-sans text-on-surface">
${HEADER}
<main class="px-4 sm:px-6 lg:px-8 py-8"><div class="mx-auto max-w-6xl">
  <div class="border-b border-outline-variant/60 pb-5 mb-7">
    <div class="label-caps text-secondary text-[11px] mb-1">SISMO911 · Cobertura en vivo</div>
    <h1 class="font-display font-extrabold text-3xl sm:text-4xl tracking-tight">Noticias del terremoto</h1>
    <p class="text-sm text-on-surface-variant max-w-2xl mt-2">Reportes ciudadanos del terremoto del <b>24-J</b> recogidos de redes sociales, geolocalizados y narrados. Cada noticia enlaza a su fuente y al sistema de <b>personas desaparecidas</b>.</p>
  </div>
  ${empty}
  ${hero ? heroCard(hero) : ''}
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
    ${grid.map(card).join('\n')}
  </div>
  <nav class="mt-9 flex items-center justify-center gap-2" aria-label="Paginación">
    ${pageLink(page - 1, '← Anterior', page <= 1)}
    <span class="px-3 py-2 text-sm text-on-surface-variant">Página ${page} de ${pages}</span>
    ${pageLink(page + 1, 'Siguiente →', page >= pages)}
  </nav>
  <p class="mt-6 text-center"><a href="/blog/desaparecidos" class="text-primary font-semibold text-sm">Ver personas desaparecidas →</a></p>
</div></main>
<script nonce="${nonce}">if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
addEventListener("error",function(e){var t=e.target;if(!t||t.tagName!=="IMG")return;
  if(t.hasAttribute("data-hide-on-err")){t.style.display="none";return}
  if(t.hasAttribute("data-fb-remove")){t.remove();return}
  if(t.hasAttribute("data-fb-html")){t.outerHTML=t.getAttribute("data-fb-html")}},true);</script>
</body></html>`;
  return c.html(html);
});

// ---------------- RSS (must register before /blog/:slug so it isn't shadowed) ----------------
blog.get('/blog/rss.xml', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT slug, headline, meta_desc, published_at FROM blog_posts WHERE status='published'
       ORDER BY published_at DESC LIMIT 50`,
  ).all<any>();
  const items = results.map((r) => `  <item><title>${esc(r.headline)}</title><link>${BASE}/blog/${esc(r.slug)}</link><guid>${BASE}/blog/${esc(r.slug)}</guid><description>${esc(r.meta_desc)}</description><pubDate>${new Date(r.published_at).toUTCString()}</pubDate></item>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>SISMO911 · Noticias del terremoto</title><link>${BASE}/blog</link><description>Cobertura ciudadana del terremoto M7.5 del 24-J en Venezuela.</description><language>es-VE</language>\n${items}\n</channel></rss>\n`;
  return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' });
});

// ---------------- single article ----------------
blog.get('/blog/:slug', async (c) => {
  const nonce = cspNonce(c);
  const slug = c.req.param('slug');
  if (RESERVED.has(slug)) return c.notFound(); // owned by desaparecidos.ts / rss
  const p = await c.env.DB.prepare(
    `SELECT slug, headline, meta_desc, body_html, place, platform, author, source_url,
            image_url, video_url, views, likes, comments, published_at
       FROM blog_posts WHERE slug = ? AND status='published'`,
  ).bind(slug).first<any>().catch(() => null);
  if (!p) return c.text('Noticia no encontrada', 404);

  const canon = `${BASE}/blog/${p.slug}`;
  const img = p.image_url || `${BASE}/og/og-default.png`;
  const embed = videoEmbed(p.platform, p.video_url);
  const cl = caseLink(p.place, canon);
  // M2: esc() entity-encodes but does NOT strip dangerous schemes, so a stored
  // javascript:-scheme source_url would be a clickable XSS. Only link when http(s).
  const safeSourceUrl = isSafePublicUrl(p.source_url) ? p.source_url : '';
  const eng = [p.views && `${Number(p.views).toLocaleString('es')} vistas`, p.likes && `${Number(p.likes).toLocaleString('es')} me gusta`].filter(Boolean).join(' · ');

  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: p.headline, description: p.meta_desc, inLanguage: 'es', image: [img],
    mainEntityOfPage: canon, datePublished: p.published_at,
    publisher: { '@type': 'Organization', name: 'SISMO911', logo: { '@type': 'ImageObject', url: `${BASE}/logo.svg` } },
    about: [{ '@type': 'Event', name: 'Terremoto de Venezuela del 24 de junio de 2026' }],
  };
  const crumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: BASE },
      { '@type': 'ListItem', position: 2, name: 'Noticias', item: `${BASE}/blog` },
      { '@type': 'ListItem', position: 3, name: p.place, item: canon },
    ],
  };

  const heroBlock = embed || `<figure class="mb-5"><div class="w-full rounded-lg border border-outline-variant/60 overflow-hidden bg-cover bg-center" style="aspect-ratio:16/9;background-image:url('${coverDataUri(p.place, p.platform)}')"><img src="${esc(img)}" alt="${esc(p.headline)}" class="w-full h-full object-cover" loading="eager" decoding="async" data-hide-on-err></div><figcaption class="mt-2 text-xs text-on-surface-variant">Reporte ciudadano desde ${esc(p.place)}${p.author ? ` · @${esc(p.author)}` : ''} en ${esc(platIcon(p.platform))}. ${eng ? `(${esc(eng)})` : ''}</figcaption></figure>`;

  const html = `${HEAD(`${p.headline} — SISMO911`, p.meta_desc, canon, img,
    `<script type="application/ld+json">${JSON.stringify(ld)}</script><script type="application/ld+json">${JSON.stringify(crumb)}</script>`)}
<body class="font-sans text-on-surface">
${HEADER}
<main class="px-4 sm:px-6 lg:px-8 py-8"><div class="mx-auto max-w-3xl">
  <nav class="text-xs text-on-surface-variant mb-3" aria-label="Ruta"><a href="/" class="hover:underline">Inicio</a> › <a href="/blog" class="hover:underline">Noticias</a> › <span>${esc(p.place)}</span></nav>
  <article class="prose-ve">
    <div class="flex flex-wrap items-center gap-2 text-xs font-semibold mb-3">
      <span class="inline-flex items-center gap-1 text-white px-2 py-0.5 rounded bg-secondary">📍 ${esc(p.place)}</span>
      <span class="bg-surface-container text-on-surface-variant px-2 py-0.5 rounded">Terremoto 24-J · ${esc(platIcon(p.platform))}</span>
    </div>
    <h1 class="font-display font-extrabold text-2xl sm:text-3xl leading-tight mb-4">${esc(p.headline)}</h1>
    ${heroBlock}
    <a href="${esc(cl)}" class="flex items-center gap-3 bg-secondary/10 border border-secondary/30 rounded-lg p-3 mb-6 hover:bg-secondary/15 no-underline"><span class="text-xl shrink-0">🔎</span><span class="text-sm text-on-surface"><b class="text-secondary">¿Reconoces a alguien o el lugar?</b> Abre un <b>caso de búsqueda</b> en Familia con esta ubicación →</span></a>
    ${sanitizeHtml(p.body_html)}
    ${safeSourceUrl ? `<p class="mt-5 text-sm"><a href="${esc(safeSourceUrl)}" target="_blank" rel="noopener nofollow" class="text-primary font-semibold hover:underline">↗ Ver publicación original en ${esc(platIcon(p.platform))}</a></p>` : ''}
    ${shareBar(p.headline, canon)}
    <div class="mt-8 bg-primary/5 border border-primary/20 rounded-lg p-4 text-xs text-on-surface-variant">
      <b>Aviso:</b> noticia generada a partir de una <b>publicación ciudadana en redes sociales</b> sobre el terremoto del 24-J. Es un <b>testimonio sin verificación independiente</b>; los detalles pueden cambiar. Para información oficial siga a Protección Civil, FUNVISIS y a las autoridades.
    </div>
    <p class="mt-6"><a href="/blog" class="text-primary font-semibold text-sm">← Volver a Noticias</a></p>
  </article>
</div></main>
<script nonce="${nonce}">if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
function __share(){navigator.share?navigator.share({title:document.title,url:location.href}):navigator.clipboard.writeText(location.href).then(function(){alert('Enlace copiado')});}
var ACTIONS={__share:__share,__rmClosest:function(sel,el){var n=el&&el.closest(sel);if(n)n.remove();}};
function __resolveArgs(el){var a=[],i=1,v;while((v=el.getAttribute("data-a"+i))!==null){a.push(v==="@value"?el.value:(v==="@checked"?el.checked:v));i++;}a.push(el);return a;}
["click","change","input"].forEach(function(ev){document.addEventListener(ev,function(e){
  var el=e.target.closest("[data-act]");if(!el)return;var want=el.getAttribute("data-ev")||"click";if(want!==ev)return;
  var f=ACTIONS[el.getAttribute("data-act")];if(f)f.apply(el,__resolveArgs(el));},false);});
addEventListener("error",function(e){var t=e.target;if(!t||t.tagName!=="IMG")return;
  if(t.hasAttribute("data-hide-on-err")){t.style.display="none";return}
  if(t.hasAttribute("data-fb-remove")){t.remove();return}
  if(t.hasAttribute("data-fb-html")){t.outerHTML=t.getAttribute("data-fb-html")}},true);</script>
</body></html>`;
  return c.html(html);
});

// ---------------- blog sitemap ----------------
blog.get('/sitemap-blog.xml', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT slug, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 5000`,
  ).all<any>();
  const urls = [`  <url><loc>${BASE}/blog</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`]
    .concat(results.map((r) => `  <url><loc>${BASE}/blog/${esc(r.slug)}</loc><lastmod>${esc(String(r.published_at).slice(0, 10))}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8' });
});

// ---------------- JSON list (cron dedupe reads source_post_id set) ----------------
blog.get('/api/blog', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT slug, source_post_id, headline, place, platform, published_at
       FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 1000`,
  ).all<any>();
  return c.json({ total: results.length, items: results });
});

// ---------------- admin: remove posts by slug (bearer-gated) ----------------
blog.post('/api/blog/delete', async (c) => {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!c.env.BLOG_INGEST_TOKEN || tok !== c.env.BLOG_INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const slugs: string[] = Array.isArray(body?.slugs) ? body.slugs.filter((s: any) => typeof s === 'string').slice(0, 50) : [];
  if (!slugs.length) return c.json({ error: 'no_slugs' }, 400);
  const ph = slugs.map(() => '?').join(',');
  const res = await c.env.DB.prepare(`DELETE FROM blog_posts WHERE slug IN (${ph})`).bind(...slugs).run();
  await c.env.CACHE.delete('sitemap:blog').catch(() => {});
  return c.json({ ok: true, deleted: res.meta?.changes ?? 0 });
});

// ---------------- run the always-on cron now (bearer-gated manual trigger) ----------------
blog.post('/api/blog/run', async (c) => {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!c.env.BLOG_INGEST_TOKEN || tok !== c.env.BLOG_INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  // ?probe=1 → isolate the Workers AI writer on a synthetic post (no sources/dedup).
  if (c.req.query('probe')) {
    const rec: any = {
      platform: 'youtube', id: 'probe', author: 'Canal de Prueba', caption: 'Vecinos de Chacao en Caracas evacuan un edificio tras el fuerte sismo y muestran grietas en las paredes.',
      url: '', image: '', video: '', ts: Date.now(), views: 0, likes: 0, comments: 0, place: 'Chacao',
    };
    const headline = deriveHeadline(rec);
    const art = await writeArticle(c.env, rec, headline);
    return c.json({ ok: true, probe: true, headline, article: art });
  }
  const summary = await ingestBlog(c.env, { force: true });
  return c.json({ ok: true, ...summary });
});

// ---------------- free source feed (cron reads this; bearer-token gated) ----------------
// Fetches GDELT + YouTube + Bluesky from Cloudflare's clean network (the host
// Mac has poisoned DNS for these hosts) and returns normalized candidates. The
// local cron then geolocates, writes with `claude -p`, and POSTs to ingest.
blog.get('/api/blog/sources', async (c) => {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!c.env.BLOG_INGEST_TOKEN || tok !== c.env.BLOG_INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  const since = Number(c.req.query('since')) || (Date.now() - 6 * 3600_000);
  const { candidates, counts } = await fetchBlogSources(c.env, since);
  return c.json({ since, counts, total: candidates.length, candidates });
});

// ---------------- ingest (cron POSTs new posts here; bearer-token gated) ----------------
// NOTE: path is /api/blog/ingest, NOT /api/admin/* — the global guard in
// index.ts force-401s every write under /api/admin before it reaches a route.
blog.post('/api/blog/ingest', async (c) => {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = c.env.BLOG_INGEST_TOKEN;
  if (!expected || tok !== expected) return c.json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const posts: any[] = Array.isArray(body) ? body : Array.isArray(body?.posts) ? body.posts : [];
  if (!posts.length) return c.json({ error: 'no_posts' }, 400);

  let inserted = 0, updated = 0;
  const errors: string[] = [];
  for (const raw of posts.slice(0, 60)) {
    const src = String(raw.source_post_id || '').trim();
    const headline = String(raw.headline || '').trim();
    if (!src || !headline) { errors.push(`skip: missing source_post_id/headline`); continue; }
    const slug = String(raw.slug || '').trim() || slugify(headline);
    const now = new Date().toISOString();
    try {
      const res = await c.env.DB.prepare(
        `INSERT INTO blog_posts
           (slug, source_post_id, headline, meta_desc, body_html, place, lat, lon,
            platform, author, source_url, image_url, video_url, video_embed_html,
            views, likes, comments, featured, status, published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_post_id) DO UPDATE SET
           headline=excluded.headline, meta_desc=excluded.meta_desc, body_html=excluded.body_html,
           place=excluded.place, lat=excluded.lat, lon=excluded.lon, platform=excluded.platform,
           author=excluded.author, source_url=excluded.source_url, image_url=excluded.image_url,
           video_url=excluded.video_url, views=excluded.views, likes=excluded.likes,
           comments=excluded.comments`,
      ).bind(
        slug, src, headline, String(raw.meta_desc || ''), sanitizeHtml(String(raw.body_html || '')),
        String(raw.place || 'Venezuela'), raw.lat ?? null, raw.lon ?? null,
        String(raw.platform || ''), String(raw.author || ''), String(raw.source_url || ''),
        String(raw.image_url || ''), String(raw.video_url || ''), String(raw.video_embed_html || ''),
        Number(raw.views || 0), Number(raw.likes || 0), Number(raw.comments || 0),
        raw.featured ? 1 : 0, 'published', String(raw.published_at || now),
      ).run();
      if (res.meta?.changes) (res.meta.last_row_id ? inserted++ : updated++); else updated++;
    } catch (e: any) {
      // slug collision on a different source → suffix and retry once
      if (String(e?.message || '').includes('UNIQUE') && String(e.message).includes('slug')) {
        try {
          await c.env.DB.prepare(`INSERT OR IGNORE INTO blog_posts (slug, source_post_id, headline, meta_desc, body_html, place, lat, lon, platform, author, source_url, image_url, video_url, video_embed_html, views, likes, comments, featured, status, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(`${slug}-${src.replace(/\W+/g, '').slice(-6)}`, src, headline, String(raw.meta_desc || ''), sanitizeHtml(String(raw.body_html || '')), String(raw.place || 'Venezuela'), raw.lat ?? null, raw.lon ?? null, String(raw.platform || ''), String(raw.author || ''), String(raw.source_url || ''), String(raw.image_url || ''), String(raw.video_url || ''), String(raw.video_embed_html || ''), Number(raw.views || 0), Number(raw.likes || 0), Number(raw.comments || 0), raw.featured ? 1 : 0, 'published', String(raw.published_at || now)).run();
          inserted++;
        } catch (e2: any) { errors.push(`${src}: ${e2?.message || e2}`); }
      } else { errors.push(`${src}: ${e?.message || e}`); }
    }
  }
  // Invalidate the blog sitemap cache if present.
  await c.env.CACHE.delete('sitemap:blog').catch(() => {});
  return c.json({ ok: true, inserted, updated, errors });
});

function slugify(s: string) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'noticia';
}
