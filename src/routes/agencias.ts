import { Hono } from 'hono';
import type { Env } from '../types';
import { AGENCIAS, ESF, type Agencia } from '../data/agencias';

// FEMA-VE: mapa + directorio de agencias de emergencia de Venezuela, mapeadas a
// las 15 Funciones de Soporte de Emergencia (ESF) de FEMA. Cada agencia está
// representada por un agente IA con avatar. Server-rendered: /agencias (mapa +
// overlay ESF + directorio) y /agencias/:slug (ficha por agente).
export const agencias = new Hono<{ Bindings: Env }>();

const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const initials = (n: string) => n.replace(/^(Cnel\.|Cmdte\.|Cap\.|Gral\.|Dr\.|Dra\.|Ing\.|Lic\.|Abg\.|MV\.|Econ\.|Emb\.|Det\.|Sra\.|Coord\.|Viceministra)\s*/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

const CATCOLOR: Record<string, string> = {
  monitoreo: '#0369a1', rescate: '#c8102e', bomberos: '#e57200', planificacion: '#00173a',
  seguridad: '#1f2937', salud: '#16a34a', infraestructura: '#7a94ca', logistica: '#0b2b5b',
  comunicaciones: '#9333ea', energia: '#d97706', agua: '#0891b2', alimentos: '#65a30d',
  agricultura: '#4d7c0f', ambiente: '#15803d', economia: '#44474f', albergues: '#db2777', relaciones: '#0e7490',
};
const color = (c: string) => CATCOLOR[c] || '#00173a';

function avatar(a: Agencia, size: number): string {
  const col = color(a.category);
  return `<span class="ag-av" style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;background:${col};color:#fff;font-family:'Public Sans',sans-serif;font-weight:800;font-size:${Math.round(size * 0.36)}px;flex:0 0 auto;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.25)">
    <img src="${e(a.avatar)}" alt="${e(a.agent_name)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.parentNode.dataset.fb='1'">${e(initials(a.agent_name))}</span>`;
}

function head(title: string, desc: string, canonical: string, leaflet = false): string {
  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(title)}</title><meta name="description" content="${e(desc)}">
<link rel="canonical" href="https://sismo911.com${e(canonical)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="SISMO911"><meta property="og:locale" content="es_VE">
<meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(desc)}"><meta property="og:url" content="https://sismo911.com${e(canonical)}"><meta property="og:image" content="https://sismo911.com/og/og-default.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><meta name="theme-color" content="#00173a">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css" />
${leaflet ? '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" /><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>' : ''}
<style>body{background:#f9f9fc}.font-display{font-family:'Public Sans',sans-serif}
.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:.85rem}
.chip{display:inline-block;padding:.1rem .55rem;border-radius:99px;font-size:11px;font-weight:600}
.ag-av[data-fb="1"] img{display:none}
#map{width:100%;height:420px;border-radius:.7rem;background:#0b2b5b}
@media print{body>header,#s911-shell,#s911-topbar,.noprint{display:none!important}body{padding:0!important}}
</style>
<script src="/app-shell.js" defer></script></head>
<body class="font-sans text-on-surface">
<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/operaciones" class="hover:text-white/70">Operaciones</a><a href="/agencias" class="text-white font-bold">Agencias</a><a href="/red-ayuda" class="hover:text-white/70">Red de Ayuda</a><a href="/sos" class="text-secondary-fixed font-bold">SOS</a></nav></div></header>`;
}
const FOOT = `</body></html>`;
const NOTE = 'Marco de respuesta tipo FEMA adaptado a Venezuela. Las agencias son reales; los "agentes" y sus fotos son personas IA de la capa de coordinación del sistema (no funcionarios reales). Datos de referencia, no oficiales.';

// GET /api/agencias — JSON
agencias.get('/api/agencias', (c) =>
  c.json({ count: AGENCIAS.length, esf: ESF, agencias: AGENCIAS }, 200, { 'Cache-Control': 'public, max-age=3600' }));

// GET /agencias — mapa + overlay ESF-15 + directorio
agencias.get('/agencias', (c) => {
  const esfNums = Object.keys(ESF).map(Number).sort((a, b) => a - b);
  const byEsf: Record<number, Agencia[]> = {};
  for (const a of AGENCIAS) (byEsf[a.esf] ||= []).push(a);

  const esfSections = esfNums.map((n) => `
    <section class="mb-6" data-esf="${n}">
      <h3 class="font-display font-bold text-[15px] mb-2"><span class="chip" style="background:#00173a;color:#fff">ESF-${n}</span> ${e(ESF[n])} <span class="text-xs font-normal text-on-surface-variant">(${byEsf[n].length})</span></h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        ${byEsf[n].map((a) => `<a href="/agencias/${e(a.slug)}" class="ag-card card p-3 flex items-center gap-3 hover:shadow-md transition" data-s="${e((a.agency + ' ' + a.acronym + ' ' + a.agent_name + ' ' + a.category).toLowerCase())}">
          ${avatar(a, 44)}
          <span class="min-w-0">
            <span class="block font-semibold text-[13.5px] leading-tight truncate">${e(a.acronym)}</span>
            <span class="block text-xs text-on-surface-variant truncate">${e(a.agent_name)}</span>
            <span class="block text-[11px] text-on-surface-variant truncate">${e(a.agency)}</span>
          </span></a>`).join('')}
      </div>
    </section>`).join('');

  const markers = JSON.stringify(AGENCIAS.map((a) => ({ s: a.slug, n: a.agent_name, ag: a.acronym, t: a.agency, e: a.esf, c: color(a.category), lat: a.lat, lng: a.lng })));
  const body = `<main class="mx-auto max-w-6xl px-4 py-8">
    <span class="chip bg-secondary text-white">FEMA-VE</span>
    <h1 class="font-display font-extrabold text-3xl mt-2 mb-1">Mapa de Agencias de Emergencia</h1>
    <p class="text-on-surface-variant mb-4 max-w-3xl">Las agencias del Estado venezolano organizadas como un marco de respuesta tipo <b>FEMA</b>: ${AGENCIAS.length} agencias mapeadas a las <b>15 Funciones de Soporte de Emergencia (ESF)</b>, cada una con un agente de coordinación.</p>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">${AGENCIAS.length}</div><div class="text-xs text-on-surface-variant">Agencias / agentes</div></div>
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">15</div><div class="text-xs text-on-surface-variant">Funciones ESF</div></div>
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">${new Set(AGENCIAS.map((a) => a.category)).size}</div><div class="text-xs text-on-surface-variant">Categorías</div></div>
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">24/7</div><div class="text-xs text-on-surface-variant">Línea 171</div></div>
    </div>
    <div id="map" class="mb-6"></div>
    <div class="flex flex-wrap gap-3 items-center mb-4">
      <h2 class="font-display font-bold text-xl mr-auto">Directorio por función (ESF)</h2>
      <input id="q" placeholder="Buscar agencia, agente, sigla…" class="border border-outline-variant/60 rounded-lg px-3 py-2 text-sm w-72 max-w-full">
    </div>
    <div id="dir">${esfSections}</div>
    <p class="text-xs text-on-surface-variant mt-8">${e(NOTE)}</p>
  </main>
  <script>
  const q=document.getElementById('q');
  q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
    document.querySelectorAll('section[data-esf]').forEach(sec=>{let any=false;
      sec.querySelectorAll('.ag-card').forEach(a=>{const m=!v||a.dataset.s.includes(v);a.style.display=m?'':'none';if(m)any=true;});
      sec.style.display=any?'':'none';});});
  const MK=${markers};
  if(typeof L!=='undefined'){
    const map=L.map('map',{scrollWheelZoom:false}).setView([8.6,-66.5],6);
    L.tileLayer('/api/sat/google/{z}/{x}/{y}',{minZoom:3,maxZoom:18,attribution:'Imágenes © Google'}).addTo(map);
    MK.forEach(m=>{const html='<div style="background:'+m.c+';color:#fff;width:24px;height:24px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">'+m.e+'</div>';
      L.marker([m.lat,m.lng],{icon:L.divIcon({html,className:'',iconSize:[24,24],iconAnchor:[12,12]}),title:m.ag})
        .addTo(map).bindPopup('<div style="font-family:Inter;font-size:12.5px"><b>'+m.ag+'</b> · ESF-'+m.e+'<br>'+m.t+'<br><a href="/agencias/'+m.s+'">Ver agente →</a></div>');});
    setTimeout(()=>map.invalidateSize(),200);
  }
  </script>`;
  return c.html(head('Mapa de Agencias de Emergencia (FEMA-VE) | SISMO911',
    `${AGENCIAS.length} agencias del Estado venezolano mapeadas a las 15 funciones de emergencia (ESF) de FEMA: monitoreo, rescate, salud, seguridad, energía, logística y más.`,
    '/agencias', true) + body + FOOT, 200, { 'Cache-Control': 'public, max-age=600' });
});

// GET /agencias/:slug — ficha del agente/agencia
agencias.get('/agencias/:slug', (c) => {
  const a = AGENCIAS.find((x) => x.slug === c.req.param('slug'));
  if (!a) return c.html(head('Agente no encontrado | SISMO911', 'No encontrado', '/agencias') +
    `<main class="mx-auto max-w-3xl px-4 py-16 text-center"><h1 class="font-display font-extrabold text-2xl mb-2">Agente no encontrado</h1><a href="/agencias" class="text-primary underline">← Volver al mapa</a></main>` + FOOT, 404);
  const resp = a.responsibilities.split(',').map((s) => s.trim()).filter(Boolean);
  const peers = AGENCIAS.filter((x) => x.esf === a.esf && x.slug !== a.slug);
  const field = (l: string, v: string, link = false) => v ? `<div class="card p-4"><dt class="text-xs uppercase tracking-wide text-on-surface-variant font-display font-bold mb-1">${l}</dt><dd class="text-[15px] font-medium break-words">${link ? `<a href="${e(v)}" target="_blank" rel="noopener" class="text-primary hover:underline">${e(v.replace(/^https?:\/\//, ''))}</a>` : e(v)}</dd></div>` : '';
  const body = `<main class="mx-auto max-w-3xl px-4 py-8">
    <nav class="text-sm text-on-surface-variant mb-3"><a href="/agencias" class="text-primary hover:underline">Agencias</a> · <span>ESF-${a.esf} ${e(a.esf_name)}</span></nav>
    <div class="card p-6 flex items-center gap-4 mb-4">
      ${avatar(a, 84)}
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-1"><span class="chip" style="background:${color(a.category)};color:#fff">${e(a.category)}</span><span class="chip" style="background:#00173a;color:#fff">ESF-${a.esf}</span></div>
        <h1 class="font-display font-extrabold text-2xl leading-tight">${e(a.agent_name)}</h1>
        <div class="text-on-surface-variant">${e(a.agent_title)}</div>
      </div>
    </div>

    <div class="card p-5 mb-3"><h2 class="font-display font-bold text-lg mb-1">${e(a.agency)} <span class="text-on-surface-variant font-normal text-sm">(${e(a.acronym)})</span></h2>
      <p class="leading-relaxed">${e(a.mission)}</p></div>

    <div class="grid sm:grid-cols-2 gap-3 mb-3">
      ${field('Función de emergencia (FEMA ESF)', `ESF-${a.esf} · ${a.esf_name}`)}
      ${field('Jurisdicción', a.jurisdiction)}
      ${field('Sede', a.hq_city)}
      ${field('Teléfono', a.phone)}
      ${field('Sitio web', a.web, true)}
      ${field('Categoría', a.category)}
    </div>

    <div class="card p-5 mb-4"><h3 class="font-display font-bold mb-2">Responsabilidades en emergencia</h3>
      <ul class="list-disc pl-5 space-y-1 text-[15px]">${resp.map((r) => `<li>${e(r)}</li>`).join('')}</ul></div>

    ${peers.length ? `<div class="mb-4"><h3 class="font-display font-bold mb-2 text-sm uppercase tracking-wide text-on-surface-variant">Otras agencias en ESF-${a.esf}</h3>
      <div class="flex flex-wrap gap-2">${peers.map((p) => `<a href="/agencias/${e(p.slug)}" class="chip bg-surface-container hover:bg-surface-container-high">${e(p.acronym)}</a>`).join('')}</div></div>` : ''}

    <div class="flex flex-wrap gap-3 text-sm noprint mb-6"><a href="/agencias" class="text-primary hover:underline">← Mapa de agencias</a><button onclick="window.print()" class="text-primary hover:underline">🖨️ Imprimir ficha</button></div>
    <p class="text-xs text-on-surface-variant border-t border-outline-variant/50 pt-3">${e(NOTE)}</p>
  </main>`;
  return c.html(head(`${a.agent_name} — ${a.acronym} (ESF-${a.esf}) | SISMO911`,
    `${a.agency} (${a.acronym}). ${a.mission}`.slice(0, 180), '/agencias/' + a.slug) + body + FOOT,
    200, { 'Cache-Control': 'public, max-age=3600' });
});
