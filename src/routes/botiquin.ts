import { Hono } from 'hono';
import type { Env } from '../types';
import { BOTIQUIN, type MedItem } from '../data/botiquin';
import { cspNonce } from '../lib/security';

// Individual page per medical item (142) + an index, server-rendered so each
// item has its own shareable, SEO-friendly URL: /botiquin/<slug>.
export const botiquin = new Hono<{ Bindings: Env }>();

const SHEET = 'https://docs.google.com/spreadsheets/d/1kf_XzHfb5toxMa07snbN8JvoaNhdggc1Za3O-IBolcU/edit';
const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => (Number(n) || 0).toLocaleString('es-VE');

function layout(title: string, desc: string, body: string, canonical: string): string {
  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="https://sismo911.com${e(canonical)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="SISMO911"><meta property="og:locale" content="es_VE">
<meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(desc)}">
<meta property="og:url" content="https://sismo911.com${e(canonical)}"><meta property="og:image" content="https://sismo911.com/og/og-default.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><meta name="theme-color" content="#00173a">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css" />
<style>body{background:#f9f9fc}.font-display{font-family:'Public Sans',sans-serif}
.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:.85rem}
.chip{display:inline-block;padding:.1rem .55rem;border-radius:99px;font-size:11px;font-weight:600}
@media print{body>header,#s911-shell,#s911-topbar,.noprint{display:none!important}body{padding:0!important}}
</style>
<script src="/app-shell.js" defer></script>
</head>
<body class="font-sans text-on-surface">
<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/suministros-medicos" class="hover:text-white/70">Suministros</a><a href="/botiquin" class="text-white font-bold">Botiquín</a><a href="/donar" class="hover:text-white/70">Donar</a></nav></div></header>
${body}
</body></html>`;
}

function catDot(cat: string): string {
  // stable-ish color per category from the dashboard palette
  const map: Record<string, string> = {
    'Sueros / Fluidos IV': '#0b2b5b', 'Antibióticos': '#bb0027', 'Analgésicos / Anestesia': '#e57200',
    'Trauma / Hemorragia': '#c8102e', 'Cardiovascular': '#7a94ca', 'Respiratorio': '#2e7d32',
    'Gastrointestinal': '#00173a', 'Antiparasitarios / Micóticos': '#9333ea', 'Salud Mental / Neuro': '#0369a1',
    'Obstétrico': '#db2777', 'Crónicos': '#44474f', 'Vacunas': '#16a34a', 'Antídotos': '#d97706',
    'Insumos / Descartables': '#747780',
  };
  return map[cat] || '#00173a';
}

const DISCLAIMER = 'Datos de referencia para planificación y adquisición humanitaria, dimensionados para 100.000 damnificados / 90 días. NO es consejo médico individual. Verifique dosis, contraindicaciones y registro sanitario (FDA / INHRR) antes de uso o importación.';

// GET /api/botiquin — JSON list (slug + names) for reuse.
botiquin.get('/api/botiquin', (c) =>
  c.json({ count: BOTIQUIN.length, items: BOTIQUIN }, 200, { 'Cache-Control': 'public, max-age=3600' }));

// GET /botiquin — index, grouped by category, each item links to its page.
botiquin.get('/botiquin', (c) => {
  const cats: string[] = [];
  const byCat: Record<string, MedItem[]> = {};
  for (const it of BOTIQUIN) { if (!byCat[it.cat]) { byCat[it.cat] = []; cats.push(it.cat); } byCat[it.cat].push(it); }
  const sections = cats.map((cat) => `
    <section class="mb-7" data-cat="${e(cat)}">
      <h2 class="font-display font-bold text-lg mb-2 flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full" style="background:${catDot(cat)}"></span>${e(cat)} <span class="text-xs font-normal text-on-surface-variant">(${byCat[cat].length})</span></h2>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        ${byCat[cat].map((it) => `<a href="/botiquin/${e(it.slug)}" class="med-item card px-3 py-2 hover:shadow-md transition block" data-s="${e((it.dci + ' ' + it.marca + ' ' + it.us).toLowerCase())}">
          <div class="font-semibold text-[14px] leading-tight">${e(it.dci)} ${it.cold ? '<span title="Cadena de frío">❄︎</span>' : ''}${it.ctrl ? '<span title="Controlado">🔒</span>' : ''}</div>
          <div class="text-xs text-on-surface-variant">VE: ${e(it.marca)} · EE.UU.: ${e(it.us.split('(')[0].trim() || it.us)}</div>
          <div class="text-xs text-on-surface-variant mt-0.5">${fmt(it.qty)} ${e(it.unit)}</div>
        </a>`).join('')}
      </div>
    </section>`).join('');
  const nonce = cspNonce(c);
  const body = `<main class="mx-auto max-w-6xl px-4 py-8">
    <h1 class="font-display font-extrabold text-3xl mb-1">Botiquín de Emergencia — Catálogo</h1>
    <p class="text-on-surface-variant mb-1">${BOTIQUIN.length} insumos y medicamentos, dimensionados para <b>100.000 damnificados / 90 días</b>. Cada ítem tiene su ficha: nombre genérico (DCI), nombre en Venezuela, nombre en EE.UU. (importación), uso y dosis.</p>
    <div class="flex flex-wrap gap-3 items-center mb-5 text-sm">
      <input id="q" placeholder="Buscar medicamento, marca, nombre EE.UU.…" class="border border-outline-variant/60 rounded-lg px-3 py-2 w-72 max-w-full">
      <a href="/suministros-medicos" class="text-primary hover:underline">📊 Tablero + gráficas</a>
      <a href="${SHEET}" target="_blank" rel="noopener" class="text-primary hover:underline">🧾 Hoja de cálculo</a>
    </div>
    <div id="list">${sections}</div>
    <p class="text-xs text-on-surface-variant mt-8">${e(DISCLAIMER)}</p>
  </main>
  <script nonce="${nonce}">
  const q=document.getElementById('q');
  q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
    document.querySelectorAll('section[data-cat]').forEach(sec=>{let any=false;
      sec.querySelectorAll('.med-item').forEach(a=>{const m=!v||a.dataset.s.includes(v);a.style.display=m?'':'none';if(m)any=true;});
      sec.style.display=any?'':'none';});});
  </script>`;
  return c.html(layout('Botiquín de Emergencia — Catálogo | SISMO911',
    `Catálogo de ${BOTIQUIN.length} medicamentos e insumos para respuesta sísmica (100.000 damnificados): genérico, nombre Venezuela, nombre EE.UU., uso y dosis.`,
    body, '/botiquin'), 200, { 'Cache-Control': 'public, max-age=600' });
});

// GET /botiquin/:slug — individual item page.
botiquin.get('/botiquin/:slug', (c) => {
  const slug = c.req.param('slug');
  const it = BOTIQUIN.find((x) => x.slug === slug);
  if (!it) {
    return c.html(layout('Ítem no encontrado — Botiquín SISMO911', 'Ítem no encontrado.',
      `<main class="mx-auto max-w-3xl px-4 py-16 text-center"><h1 class="font-display font-extrabold text-2xl mb-2">Ítem no encontrado</h1><p class="text-on-surface-variant mb-4">No existe una ficha con ese identificador.</p><a href="/botiquin" class="text-primary underline">← Volver al catálogo</a></main>`,
      '/botiquin/' + slug), 404);
  }
  const flags = [
    it.cold ? '<span class="chip" style="background:#e0f2fe;color:#0369a1">❄︎ Cadena de frío</span>' : '',
    it.ctrl ? '<span class="chip" style="background:#fee2e2;color:#dc2626">🔒 Controlado</span>' : '',
  ].filter(Boolean).join(' ');
  const field = (label: string, val: string) => `<div class="card p-4"><dt class="text-xs uppercase tracking-wide text-on-surface-variant font-display font-bold mb-1">${label}</dt><dd class="text-[15px] font-medium">${e(val) || '—'}</dd></div>`;
  const nonce = cspNonce(c);
  const body = `<main class="mx-auto max-w-3xl px-4 py-8">
    <nav class="text-sm text-on-surface-variant mb-3"><a href="/botiquin" class="text-primary hover:underline">Botiquín</a> · <span>${e(it.cat)}</span></nav>
    <div class="flex items-start gap-3 flex-wrap mb-1">
      <span class="chip" style="background:${catDot(it.cat)};color:#fff">${e(it.cat)}</span>${flags}
    </div>
    <h1 class="font-display font-extrabold text-3xl mb-4">${e(it.dci)}</h1>

    <div class="grid sm:grid-cols-2 gap-3 mb-4">
      ${field('Nombre genérico (DCI)', it.dci)}
      ${field('Nombre en Venezuela', it.marca)}
      ${field('Nombre en EE.UU. (importación)', it.us)}
      ${field('Presentación', it.pres)}
      ${field('Cantidad (100.000 / 90 días)', fmt(it.qty) + ' ' + it.unit)}
      ${field('Categoría', it.cat)}
    </div>

    <div class="card p-5 mb-3"><h2 class="font-display font-bold text-lg mb-1">¿Para qué se usa?</h2><p class="leading-relaxed">${e(it.uso) || '—'}</p></div>
    <div class="card p-5 mb-4"><h2 class="font-display font-bold text-lg mb-1">Dosis (adulto, referencia)</h2><p class="leading-relaxed">${e(it.dosis) || '—'}</p></div>

    <div class="flex flex-wrap gap-3 text-sm noprint mb-6">
      <a href="/botiquin" class="text-primary hover:underline">← Catálogo</a>
      <a href="/suministros-medicos" class="text-primary hover:underline">📊 Tablero</a>
      <a href="${SHEET}" target="_blank" rel="noopener" class="text-primary hover:underline">🧾 Hoja de cálculo</a>
      <button data-act="__print" class="text-primary hover:underline">🖨️ Imprimir ficha</button>
    </div>
    <p class="text-xs text-on-surface-variant border-t border-outline-variant/50 pt-3">${e(DISCLAIMER)}</p>
  </main>
  <script nonce="${nonce}">
  var ACTIONS={__print:function(){window.print();}};
  function __resolveArgs(el){var a=[],i=1,v;while((v=el.getAttribute("data-a"+i))!==null){a.push(v==="@value"?el.value:(v==="@checked"?el.checked:v));i++;}a.push(el);return a;}
  ["click","change","input"].forEach(function(ev){document.addEventListener(ev,function(e){
    var el=e.target.closest("[data-act]");if(!el)return;var want=el.getAttribute("data-ev")||"click";if(want!==ev)return;
    var f=ACTIONS[el.getAttribute("data-act")];if(f)f.apply(el,__resolveArgs(el));},false);});
  </script>`;
  const desc = `${it.dci} (Venezuela: ${it.marca}; EE.UU.: ${it.us}). ${it.uso}`.slice(0, 180);
  return c.html(layout(`${it.dci} — Botiquín SISMO911`, desc, body, '/botiquin/' + it.slug),
    200, { 'Cache-Control': 'public, max-age=3600' });
});
