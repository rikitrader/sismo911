// Build a real, magazine-style blog for SISMO911 from the (real) terremoto coverage.
// Outputs: public/blog.html (index) + public/blog/<slug>.html (one per article).
// Uses the app design system (app.css + app-shell.js) so everything is styled + works.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
const TN = '/Users/ricardoprieto/projects/terremoto-news/data'
const OUT = '/Users/ricardoprieto/projects/sismo911/public'
mkdirSync(OUT + '/blog', { recursive: true })

const posts = JSON.parse(readFileSync(TN + '/results.json', 'utf8'))
const OV = {}
for (const f of readdirSync(TN).filter(n => /^ai_out_\d+\.json$/.test(n)))
  for (const o of JSON.parse(readFileSync(TN + '/' + f, 'utf8'))) if (o && o.idx != null && o.body_html) OV[o.idx] = o

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const stripAcc = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const slugify = (s, i) => (stripAcc(String(s || '').toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'reporte') + '-' + i
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const fmtNum = n => { n = num(n); if (!n) return ''; if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K'; return '' + n }
const fmtDate = iso => { const t = Date.parse(iso); if (Number.isNaN(t)) return '24 jun 2026'; return new Date(t).toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Caracas' }) }
const PLAT = { 'TikTok': '#111827', 'Instagram': '#C13584', 'YouTube': '#FF0000', 'Facebook': '#1877F2', 'X/Twitter': '#111827' }
const platLabel = p => ({ 'X/Twitter': 'X' }[p] || p)
const titleCase = s => s.toLowerCase().replace(/\b[\wáéíóúñ]/g, c => c.toUpperCase())
const place = p => {
  const l = (p.lugar || '').trim()
  // reject junk: empty, generic, anything with digits or codes, overly long, non-place chars
  if (!l || /general|desconocida/i.test(l) || /\d/.test(l) || l.length > 30 || !/^[A-Za-zÁÉÍÓÚÑáéíóúñ .'-]+$/.test(l)) return 'Venezuela'
  return titleCase(l)
}

// premium branded SVG cover (data-uri, always works) — used as fallback + card art
function cover(p) {
  const c = PLAT[p.plataforma] || '#00173a'
  const loc = esc(place(p).slice(0, 32))
  const pl = esc(platLabel(p.plataforma))
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='675' viewBox='0 0 1200 675'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${c}'/><stop offset='.65' stop-color='#00112e'/><stop offset='1' stop-color='#000814'/></linearGradient></defs><rect width='1200' height='675' fill='url(#g)'/><path d='M0 470 L120 470 160 380 200 540 250 300 300 470 1200 470' fill='none' stroke='#bb0027' stroke-width='3' opacity='.55'/><text x='64' y='96' fill='#ffffff' opacity='.7' font-family='Arial,Helvetica,sans-serif' font-size='26' font-weight='700' letter-spacing='3'>SISMO911 · COBERTURA</text><text x='64' y='350' fill='#ffffff' font-family='Arial,Helvetica,sans-serif' font-size='92' font-weight='800'>${loc}</text><text x='64' y='420' fill='#ffd166' font-family='Arial,Helvetica,sans-serif' font-size='34' font-weight='700'>Reporte ciudadano · ${pl}</text><text x='64' y='610' fill='#ffffff' opacity='.6' font-family='Arial,Helvetica,sans-serif' font-size='26'>Terremoto M7.5 · 24 junio 2026 · Venezuela</text></svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}
// every report photo links to a search case in /familia, prefilled with location + source
const caseLink = (p, slug) => `/familia?reportar=1&lugar=${encodeURIComponent(place(p))}&ref=${encodeURIComponent('https://sismo911.com/blog/' + slug)}`
const headline = (p, ov) => (ov && ov.headline) || (p.texto && p.texto.length > 22 && p.texto.length < 110 ? p.texto.replace(/\s+/g, ' ') : `Reporte del terremoto en ${place(p)} (${platLabel(p.plataforma)})`)
const dek = (p, ov) => (ov && ov.metaDesc) || `Reporte ciudadano del terremoto M7.5 del 24 de junio de 2026 desde ${place(p)}.`

// ---- shared chrome ----
const HEADER = `<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/mapa" class="hover:text-white/70">Mapa</a><a href="/alertas" class="hover:text-white/70">Alertas</a><a href="/sos" class="text-secondary-fixed font-bold">SOS</a><a href="/personas" class="hover:text-white/70">Personas</a><a href="/familia" class="hover:text-white/70">Familia</a><a href="/acopio" class="hover:text-white/70">Acopio</a><a href="/recursos" class="hover:text-white/70">Recursos</a><a href="/comms" class="hover:text-white/70">Radio</a><a href="/guia" class="hover:text-white/70">Guía</a><a href="/reportar" class="hover:text-white/70">Reportar</a><a href="/contacto" class="hover:text-white/70">Contacto</a><a href="/blog" class="text-white">Blog</a></nav></div></header>`
const HEAD = (title, desc, canon, img) => `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${canon}">
<meta property="og:type" content="article"><meta property="og:site_name" content="SISMO911"><meta property="og:locale" content="es_VE">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${img}">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><meta name="theme-color" content="#13284f">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css" />
<script src="/app-shell.js" defer></script>
<style>body{background:#f9f9fc}.font-display{font-family:'Public Sans',sans-serif}.prose-ve p{margin:.85rem 0;line-height:1.75}.prose-ve h2{font-family:'Public Sans',sans-serif;font-weight:700;font-size:1.25rem;color:#00173a;margin:1.6rem 0 .4rem;scroll-margin-top:5rem}</style>`

// ---- article page ----
function renderArticle(p, ov, slug) {
  const title = headline(p, ov), desc = dek(p, ov), canon = `https://sismo911.com/blog/${slug}`, cv = cover(p)
  const cl = caseLink(p, slug)
  const heroImg = `<a href="${cl}" class="block relative group" title="¿Reconoces a alguien? Vincula esta imagen a un caso de búsqueda en Familia">
    <div class="w-full rounded-lg border border-outline-variant/60 overflow-hidden bg-cover bg-center" style="aspect-ratio:16/9;background-image:url('${cv}')"><img src="${esc(p.imagen || cv)}" alt="${esc(title)}" class="w-full h-full object-cover" loading="eager" decoding="async" onerror="this.style.display='none'"></div>
    <span class="absolute top-3 left-3 bg-primary/85 text-white text-[11px] font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">🔎 Vincular a un caso</span>
  </a>`
  const dateISO = Date.parse(p.fechaISO) ? new Date(p.fechaISO).toISOString() : '2026-06-24T21:04:00Z'
  const stats = [fmtNum(p.vistas) && `${fmtNum(p.vistas)} reproducciones`, fmtNum(p.likes) && `${fmtNum(p.likes)} me gusta`].filter(Boolean).join(' · ')
  const ld = { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: title, description: desc, datePublished: dateISO, dateModified: dateISO, inLanguage: 'es', image: [cv], mainEntityOfPage: canon, author: { '@type': 'Person', name: p.autor || 'Reporte ciudadano' }, publisher: { '@type': 'Organization', name: 'SISMO911', logo: { '@type': 'ImageObject', url: 'https://sismo911.com/logo.svg' } }, about: { '@type': 'Event', name: 'Terremoto de Venezuela del 24 de junio de 2026' } }
  return `${HEAD(title + ' — SISMO911', desc, canon, cv)}
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body class="font-sans text-on-surface">
${HEADER}
<main class="px-4 sm:px-6 lg:px-8 py-8">
  <div class="mx-auto max-w-3xl">
    <nav class="text-xs text-on-surface-variant mb-3" aria-label="Ruta"><a href="/" class="hover:underline">Inicio</a> › <a href="/blog" class="hover:underline">Blog</a> › <span>${esc(place(p))}</span></nav>
    <article class="prose-ve">
      <div class="flex flex-wrap items-center gap-2 text-xs font-semibold mb-3">
        <span class="inline-flex items-center gap-1 text-white px-2 py-0.5 rounded" style="background:${PLAT[p.plataforma] || '#00173a'}">${esc(platLabel(p.plataforma))}</span>
        <span class="bg-surface-container text-on-surface-variant px-2 py-0.5 rounded">Reporte ciudadano</span>
        <time datetime="${dateISO.slice(0, 10)}" class="text-on-surface-variant">${fmtDate(p.fechaISO)}</time>
        ${p.autor ? `<span class="text-on-surface-variant">· ${esc(p.autor)}</span>` : ''}
      </div>
      <h1 class="font-display font-extrabold text-3xl sm:text-4xl leading-tight mb-4">${esc(title)}</h1>
      <figure class="mb-3">${heroImg}${stats ? `<figcaption class="mt-2 text-xs text-on-surface-variant">${esc(stats)} · al momento del registro</figcaption>` : ''}</figure>
      <a href="${cl}" class="flex items-center gap-3 bg-secondary/10 border border-secondary/30 rounded-lg p-3 mb-6 hover:bg-secondary/15 transition-colors no-underline"><span class="text-xl shrink-0">🔎</span><span class="text-sm text-on-surface"><b class="text-secondary">¿Reconoces a alguien en esta imagen?</b> Vincúlala a un <b>caso de búsqueda de personas</b> en Familia →</span></a>
      ${ov && ov.body_html ? ov.body_html : `<p>${esc(p.texto || '')}</p>`}
      ${p.enlace ? `<p class="mt-6"><a href="${esc(p.enlace)}" target="_blank" rel="noopener nofollow" class="inline-flex items-center gap-2 bg-primary text-white font-semibold text-sm px-4 py-2.5 rounded-lg hover:bg-primary-container transition">▶ Ver la publicación original en ${esc(platLabel(p.plataforma))}</a></p>` : ''}
      <div class="mt-6 flex flex-wrap gap-2" aria-label="Compartir">
        <button onclick="navigator.share?navigator.share({title:document.title,url:location.href}):navigator.clipboard.writeText(location.href)" class="text-sm font-semibold border border-outline-variant rounded-lg px-3 py-2 hover:bg-surface-container">🔗 Compartir</button>
        <a class="text-sm font-semibold border border-outline-variant rounded-lg px-3 py-2 hover:bg-surface-container" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(title)}%20https://sismo911.com/blog/${slug}">WhatsApp</a>
        <a class="text-sm font-semibold border border-outline-variant rounded-lg px-3 py-2 hover:bg-surface-container" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=https://sismo911.com/blog/${slug}">X</a>
      </div>
      <div class="mt-8 bg-primary/5 border border-primary/20 rounded-lg p-4 text-xs text-on-surface-variant">
        <b>Aviso:</b> material recopilado del monitoreo social de SISMO911 a partir de una publicación pública en ${esc(platLabel(p.plataforma))}. Es un <b>testimonio ciudadano sin verificación independiente</b>; los derechos pertenecen a su autor. Para información oficial siga a FUNVISIS, Protección Civil y NOAA/PTWC.
      </div>
      <p class="mt-6"><a href="/blog" class="text-primary font-semibold text-sm">← Volver al Blog</a></p>
    </article>
  </div>
</main>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>
</body></html>`
}

// ---- curate: top N by engagement with a usable caption ----
const ranked = posts.map((p, idx) => ({ p, idx, ov: OV[idx], score: num(p.vistas) + 10 * num(p.likes) }))
  .filter(x => (x.p.texto || '').trim().length >= 40)
  .sort((a, b) => b.score - a.score)
const N = 48
const picked = ranked.slice(0, N).map(x => ({ ...x, slug: slugify(headline(x.p, x.ov), x.idx) }))

for (const x of picked) writeFileSync(`${OUT}/blog/${x.slug}.html`, renderArticle(x.p, x.ov, x.slug))

// ---- index (magazine) ----
const FEATURED = { slug: 'terremoto-magnitud-7-5-yumare-venezuela-24-junio-2026', img: '/og/og-terremoto-yumare.png', tag: '🔴 INFORME · EVENTO MAYOR', date: '24 jun 2026', title: 'Terremoto M7.5 frente a Yumare: el doblete sísmico que sacudió a Venezuela', dek: 'Dos terremotos mayores (M7.2 y M7.5) con 39 segundos de diferencia frente a Yaracuy. Epicentro, daños en Caracas, alerta de tsunami, réplicas y qué puede pasar ahora — análisis con fuentes oficiales (USGS, EMSC, PTWC).' }

const card = x => {
  const p = x.p, t = headline(p, x.ov), a = `/blog/${x.slug}`, cl = caseLink(p, x.slug)
  return `<div class="group bg-white border border-outline-variant/60 rounded-xl overflow-hidden flex flex-col hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
    <a href="${a}" class="block relative aspect-[16/9] overflow-hidden bg-cover bg-center" style="background-image:url('${cover(p)}')"><img src="${esc(p.imagen || cover(p))}" alt="${esc(t)}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" onerror="this.style.display='none'"><span class="absolute top-2 left-2 bg-primary/85 text-white text-[10px] font-bold px-2 py-0.5 rounded-full backdrop-blur-sm">🔎 Caso</span></a>
    <div class="p-4 flex flex-col flex-1">
      <div class="flex items-center gap-2 text-[11px] font-bold mb-2"><span class="text-white px-2 py-0.5 rounded" style="background:${PLAT[p.plataforma] || '#00173a'}">${esc(platLabel(p.plataforma))}</span><span class="text-on-surface-variant uppercase tracking-wide">${esc(place(p))}</span></div>
      <a href="${a}"><h3 class="font-display font-bold text-[15px] leading-snug text-on-surface mb-1 line-clamp-3 group-hover:text-primary">${esc(t)}</h3></a>
      <p class="text-xs text-on-surface-variant line-clamp-2 mb-3">${esc(dek(p, x.ov))}</p>
      <div class="mt-auto flex items-center justify-between text-[11px]"><a href="${cl}" class="text-secondary font-semibold hover:underline">🔎 Vincular a caso</a><a href="${a}" class="text-primary font-semibold hover:underline">Leer →</a></div>
    </div>
  </div>`
}

const indexHtml = `${HEAD('Blog Sísmico — Cobertura del terremoto de Venezuela | SISMO911', 'Cobertura del terremoto M7.5 que sacudió Venezuela el 24 de junio de 2026: informe oficial con fuentes verificadas (USGS, EMSC, PTWC) y ' + picked.length + ' reportes ciudadanos en terreno geolocalizados.', 'https://sismo911.com/blog', 'https://sismo911.com/og/og-terremoto-yumare.png')}
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Blog","name":"Blog Sísmico SISMO911","url":"https://sismo911.com/blog","inLanguage":"es","publisher":{"@type":"Organization","name":"SISMO911","logo":{"@type":"ImageObject","url":"https://sismo911.com/logo.svg"}}}</script>
</head>
<body class="font-sans text-on-surface">
${HEADER}
<main class="px-4 sm:px-6 lg:px-8 py-8">
  <!-- Masthead -->
  <div class="border-b border-outline-variant/60 pb-5 mb-7">
    <div class="flex items-end justify-between flex-wrap gap-3">
      <div>
        <div class="label-caps text-secondary text-[11px] mb-1">SISMO911 · Periodismo sísmico</div>
        <h1 class="font-display font-extrabold text-4xl tracking-tight">Blog Sísmico</h1>
      </div>
      <p class="text-sm text-on-surface-variant max-w-md">Informe oficial con fuentes verificadas (USGS · EMSC · PTWC · FUNVISIS) y la cobertura ciudadana del terremoto del 24-J — sin predicciones, solo ciencia y testimonios.</p>
    </div>
  </div>

  <!-- Featured -->
  <a href="/blog/${FEATURED.slug}" class="group block bg-white border border-outline-variant/60 rounded-2xl overflow-hidden mb-10 hover:shadow-xl transition-shadow">
    <div class="grid md:grid-cols-2">
      <div class="aspect-[16/10] md:aspect-auto overflow-hidden bg-primary flex items-center justify-center"><img src="${FEATURED.img}" alt="${esc(FEATURED.title)}" class="w-full h-full object-contain md:object-cover md:object-left" width="1200" height="630"></div>
      <div class="p-6 sm:p-8 flex flex-col justify-center">
        <div class="flex items-center gap-2 text-xs font-bold mb-3"><span class="bg-secondary text-white px-2.5 py-1 rounded-full">${FEATURED.tag}</span><span class="text-on-surface-variant">${FEATURED.date}</span></div>
        <h2 class="font-display font-extrabold text-2xl sm:text-3xl leading-tight text-on-surface mb-3 group-hover:text-primary">${esc(FEATURED.title)}</h2>
        <p class="text-on-surface-variant mb-5">${esc(FEATURED.dek)}</p>
        <span class="inline-flex items-center gap-2 text-primary font-bold">Leer el informe completo →</span>
      </div>
    </div>
  </a>

  <!-- Section header -->
  <div class="flex items-center justify-between mb-4">
    <h2 class="font-display font-bold text-xl">Cobertura en terreno · reportes ciudadanos</h2>
    <span class="text-xs text-on-surface-variant">${picked.length} reportes geolocalizados</span>
  </div>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
    ${picked.map(card).join('\n')}
  </div>
</main>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>
</body></html>`

writeFileSync(`${OUT}/blog.html`, indexHtml)
console.log(`generated blog index + ${picked.length} article pages`)
