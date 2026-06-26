import { Hono } from 'hono';
import type { Env } from '../types';
import { AGENCIAS, ESF, type Agencia } from '../data/agencias';
import { AICORP, FLUJO } from '../data/ai_corp';

// Gobierno IA de Venezuela — un gobierno autónomo operado por agentes de IA,
// coordinado por "AI Corp Federal", TOTALMENTE detached del gobierno real de
// Venezuela. Federal + 24 estados + ciudades capitales. Server-rendered:
// /agencias (portal: AI Corp Federal + mapa + filtros + directorio),
// /agencias/:slug (ficha del agente IA), /api/agencias (JSON).
export const agencias = new Hono<{ Bindings: Env }>();

const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const initials = (n: string) => n.replace(/^(ARQ-1|Cnel\.|Cmdte\.|Cap\.|Gral\.|Dr\.|Dra\.|Ing\.|Lic\.|Abg\.|MV\.|Econ\.|Emb\.|Det\.|Sra\.|Coord\.|Viceministra)\s*/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'IA';

const CATCOLOR: Record<string, string> = {
  central: '#7c3aed', monitoreo: '#0369a1', rescate: '#c8102e', bomberos: '#e57200', planificacion: '#00173a',
  seguridad: '#1f2937', salud: '#16a34a', infraestructura: '#7a94ca', logistica: '#0b2b5b',
  comunicaciones: '#9333ea', energia: '#d97706', agua: '#0891b2', alimentos: '#65a30d',
  agricultura: '#4d7c0f', ambiente: '#15803d', economia: '#44474f', albergues: '#db2777', relaciones: '#0e7490',
};
const color = (c: string) => CATCOLOR[c] || '#00173a';

function avatar(a: Agencia, size: number): string {
  const col = color(a.category);
  // every agent has a generated photo at /agentes/<slug>.webp; missing → initials
  // initials sit behind; the photo overlays absolutely and covers them when it
  // loads (onerror removes it → initials show). Absolute overlay avoids the
  // flexbox-shrink bug that hid the photo behind the initials.
  return `<span class="ag-av" style="position:relative;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;background:${col};color:#fff;font-family:'Public Sans',sans-serif;font-weight:800;font-size:${Math.round(size * 0.34)}px;flex:0 0 auto;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.25)"><span>${e(initials(a.agent_name))}</span><img src="/agentes/${e(a.slug)}.webp" alt="${e(a.agent_name)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.remove()"></span>`;
}

function head(title: string, desc: string, canonical: string, leaflet = false): string {
  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(title)}</title><meta name="description" content="${e(desc)}"><meta name="robots" content="index,follow">
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
.nivchip{cursor:pointer;border:1px solid #c4c6d0;background:#fff;border-radius:99px;padding:.25rem .7rem;font-size:12.5px;font-weight:600}
.nivchip.on{background:#00173a;color:#fff;border-color:#00173a}
#map{width:100%;height:420px;border-radius:.7rem;background:#0b2b5b}
@media print{body>header,#s911-shell,#s911-topbar,.noprint{display:none!important}body{padding:0!important}}
</style>
<script src="/app-shell.js" defer></script></head>
<body class="font-sans text-on-surface">
<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/operaciones" class="hover:text-white/70">Operaciones</a><a href="/agencias" class="text-white font-bold">Gobierno IA</a><a href="/sos" class="text-secondary-fixed font-bold">SOS</a></nav></div></header>`;
}
const FOOT = `</body></html>`;
const NOTE = 'GOBIERNO DE IA AUTÓNOMO Y SIMULADO, totalmente independiente y NO afiliado al gobierno real de Venezuela. Los agentes, nombres, correos y fotos son entidades de IA — no son funcionarios, organismos ni correos oficiales del Estado venezolano.';
const apex = () => AGENCIAS.find((a) => a.nivel === 'Central IA')!;

// GET /ai-corp — el AI Corp Federal: orquestador + departamentos + flujo + proyectos
agencias.get('/ai-corp', (c) => {
  const STEPCOL: Record<string, string> = { 'Detección': '#0369a1', 'Activación': '#e57200', 'Aprobación': '#16a34a', 'Financiamiento': '#d97706', 'Entrega': '#0891b2', 'Asistencia': '#db2777', 'Orquestación': '#7c3aed' };
  const orch = AICORP[0];
  const depts = AICORP.slice(1);
  const pipeline = FLUJO.map((s, i) => `<div style="flex:1;min-width:120px" class="text-center">
      <div class="mx-auto mb-1" style="width:34px;height:34px;border-radius:50%;background:${STEPCOL[s]};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-family:'Public Sans'">${i + 1}</div>
      <div class="text-[12.5px] font-semibold">${e(s)}</div>
    </div>`).join('<div class="self-start mt-3 text-on-surface-variant">→</div>');
  const card = (d: typeof AICORP[number]) => `<div class="card p-4 flex items-start gap-3">
      <span style="width:52px;height:52px;border-radius:14px;overflow:hidden;flex:0 0 auto;background:${STEPCOL[d.step] || '#7c3aed'};display:inline-block"><img src="/agentes/${e(d.slug)}.webp" alt="${e(d.name)}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.display='none'"></span>
      <div class="min-w-0">
        <div class="chip" style="background:${STEPCOL[d.step] || '#7c3aed'};color:#fff">${e(d.step)}</div>
        <div class="font-display font-bold text-[15px] mt-1 leading-tight">${e(d.name)}</div>
        <div class="text-xs text-on-surface-variant mb-1">${e(d.role)}</div>
        <div class="text-[12.5px] text-on-surface-variant">${e(d.skills)}</div>
      </div></div>`;
  const body = `<main class="mx-auto max-w-6xl px-4 py-8">
    <nav class="text-sm text-on-surface-variant mb-3"><a href="/agencias" class="text-primary hover:underline">Gobierno IA</a> · <span>AI Corp Federal</span></nav>
    <span class="chip" style="background:#7c3aed;color:#fff">AI Corp Federal · orquestación</span>
    <h1 class="font-display font-extrabold text-3xl mt-2 mb-1">AI Corp Federal</h1>
    <p class="text-on-surface-variant mb-5 max-w-3xl">La corporación de IA que <b>gobierna la emergencia</b>: un <b>orquestador central</b> y sus departamentos detectan, activan, <b>aprueban proyectos</b> y coordinan la <b>entrega y asistencia</b>, en un ciclo continuo sobre las 139 agencias.</p>

    <div class="card p-5 mb-6 flex items-center gap-4" style="border:1.5px solid #7c3aed;background:linear-gradient(90deg,#faf5ff,#fff)">
      <span style="width:84px;height:84px;border-radius:50%;overflow:hidden;flex:0 0 auto;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.25)"><img src="/agentes/${e(orch.slug)}.webp" alt="${e(orch.name)}" style="width:100%;height:100%;object-fit:cover"></span>
      <div><div class="chip" style="background:#7c3aed;color:#fff">ORQUESTADOR</div>
        <div class="font-display font-extrabold text-xl mt-1">${e(orch.name)}</div>
        <div class="text-on-surface-variant text-sm">${e(orch.skills)}</div></div>
    </div>

    <h2 class="font-display font-bold text-xl mb-2">Flujo operativo</h2>
    <div class="card p-4 mb-6"><div class="flex flex-wrap items-start gap-2 justify-between">${pipeline}</div></div>

    <h2 class="font-display font-bold text-xl mb-3">Departamentos del AI Corp</h2>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">${depts.map(card).join('')}</div>

    <h2 class="font-display font-bold text-xl mb-1">Proyectos en el flujo de aprobación</h2>
    <p class="text-on-surface-variant text-sm mb-3">El <b>Dpto. de Aprobación de Proyectos</b> evalúa las campañas de ayuda para entrega y asistencia. <span id="projsum"></span></p>
    <div id="projs" class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3"><p class="text-on-surface-variant text-sm col-span-full">Cargando proyectos…</p></div>
    <p class="text-xs text-on-surface-variant mt-8 border-t border-outline-variant/50 pt-3">${e(NOTE)}</p>
  </main>
  <script>
  const fmt=n=>'$'+Math.round(Number(n)||0).toLocaleString('en-US');
  const esc=s=>(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  fetch('/api/campaigns').then(r=>r.json()).then(d=>{
    const cs=d.campaigns||[];
    document.getElementById('projsum').textContent=cs.length+' proyectos aprobados y en ejecución.';
    document.getElementById('projs').innerHTML=cs.length?cs.map(c=>{
      const goal=+c.goal_usd||0,raised=+c.raised_usd||0,pct=goal>0?Math.min(100,Math.round(raised/goal*100)):0;
      return '<a href="/campana?c='+encodeURIComponent(c.slug)+'" class="card p-4 block hover:shadow-md transition">'
        +'<div class="flex items-center gap-2 mb-1"><span class="chip" style="background:#16a34a;color:#fff">APROBADO</span><span class="chip" style="background:#0891b2;color:#fff">EN ENTREGA</span></div>'
        +'<div class="font-display font-bold text-[15px] leading-tight">'+esc(c.title)+'</div>'
        +'<div class="text-xs text-on-surface-variant mb-2">'+esc(c.category||'')+(c.location?' · '+esc(c.location):'')+'</div>'
        +'<div style="height:.5rem;border-radius:99px;background:#e2e2e5;overflow:hidden"><span style="display:block;height:100%;width:'+pct+'%;background:#16a34a"></span></div>'
        +'<div class="text-xs mt-1"><b>'+fmt(raised)+'</b> '+(goal>0?'de '+fmt(goal):'')+' · '+(c.donors_count||0)+' donantes</div></a>';
    }).join(''):'<p class="text-on-surface-variant text-sm col-span-full">No hay proyectos activos. <a href="/recaudar" class="text-primary underline">Crear uno</a>.</p>';
  }).catch(()=>{document.getElementById('projs').innerHTML='<p class="text-secondary text-sm col-span-full">No se pudieron cargar los proyectos.</p>';});
  </script>`;
  return c.html(head('AI Corp Federal — orquestador, departamentos y flujo | SISMO911',
    'AI Corp Federal: el orquestador y los departamentos del Gobierno IA de Venezuela que activan el flujo, aprueban proyectos y coordinan entrega y asistencia.',
    '/ai-corp') + body + FOOT, 200, { 'Cache-Control': 'public, max-age=600' });
});

// GET /api/agencias — JSON
agencias.get('/api/agencias', (c) =>
  c.json({ count: AGENCIAS.length, esf: ESF, agencias: AGENCIAS }, 200, { 'Cache-Control': 'public, max-age=3600' }));

// GET /agencias — portal del Gobierno IA
agencias.get('/agencias', (c) => {
  const ax = apex();
  const others = AGENCIAS.filter((a) => a.nivel !== 'Central IA');
  const estados = ['Nacional', ...Array.from(new Set(others.filter((a) => a.estado !== 'Nacional').map((a) => a.estado))).sort()];
  const byEstado: Record<string, Agencia[]> = {};
  for (const a of others) (byEstado[a.estado] ||= []).push(a);

  const cardOf = (a: Agencia) => `<a href="/agencias/${e(a.slug)}" class="ag-card card p-3 flex items-start gap-3 hover:shadow-md transition" data-niv="${e(a.nivel)}" data-s="${e((a.agency + ' ' + a.acronym + ' ' + a.agent_name + ' ' + a.category + ' ' + a.estado + ' ' + a.ciudad + ' ' + a.esf_name + ' ' + a.ics + ' ' + a.skills).toLowerCase())}">
      ${avatar(a, 46)}
      <span class="min-w-0 flex-1">
        <span class="block font-semibold text-[13.5px] leading-snug">${e(a.acronym)} <span class="chip" style="background:${color(a.category)};color:#fff;font-size:9px;padding:.02rem .3rem">${e(a.nivel)}</span> ${a.esf ? `<span class="chip" style="background:#eef1f7;color:#00173a;font-size:9px;padding:.02rem .3rem">ESF-${a.esf}</span>` : ''}</span>
        <span class="block text-xs text-on-surface mt-0.5">${e(a.agent_name)} <span class="text-on-surface-variant">· ${e(a.agent_title)}</span></span>
        <span class="block text-[11.5px] text-on-surface-variant leading-snug">${e(a.agency)}</span>
        <span class="block text-[11px] text-on-surface-variant mt-0.5">📍 ${e(a.ciudad)} · 🛡️ ${e(a.ics)} · ⏱️ ${e(a.activacion)}</span>
      </span></a>`;

  const sections = estados.map((est) => `
    <section class="mb-6 est-sec" data-est="${e(est)}">
      <h3 class="font-display font-bold text-[15px] mb-2">${est === 'Nacional' ? '🏛️ Gobierno Federal IA' : '📍 ' + e(est)} <span class="text-xs font-normal text-on-surface-variant">(${byEstado[est].length})</span></h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">${byEstado[est].map(cardOf).join('')}</div>
    </section>`).join('');

  const markers = JSON.stringify(others.map((a) => ({ s: a.slug, n: a.agent_name, ag: a.acronym, t: a.agency, e: a.esf, c: color(a.category), lat: a.lat, lng: a.lng, niv: a.nivel })));
  const estOpts = estados.map((s) => `<option value="${e(s)}">${s === 'Nacional' ? 'Federal (Nacional)' : e(s)}</option>`).join('');

  const body = `<main class="mx-auto max-w-6xl px-4 py-8">
    <span class="chip bg-secondary text-white">Gobierno IA · autónomo</span>
    <h1 class="font-display font-extrabold text-3xl mt-2 mb-1">Gobierno IA de Venezuela</h1>
    <p class="text-on-surface-variant mb-5 max-w-3xl">Un gobierno de emergencias <b>operado por agentes de inteligencia artificial</b>. <b>AI Corp Federal</b> ingiere y coordina los datos de las ${AGENCIAS.length - 1} agencias IA — federales, de los 24 estados y de las ciudades capitales — en un único comando nacional. Cada agente opera bajo el <b>Sistema de Comando de Incidentes (SCI)</b> con competencias de gestión de emergencias y nivel de activación, para <b>tomar el control del desastre ASAP</b>.</p>

    <a href="/ai-corp" class="card p-5 mb-6 flex items-center gap-4 hover:shadow-lg transition" style="border:1.5px solid #7c3aed;background:linear-gradient(90deg,#faf5ff,#fff)">
      ${avatar(ax, 76)}
      <div class="min-w-0">
        <div class="chip" style="background:#7c3aed;color:#fff">CENTRO DE MANDO · AI CORP FEDERAL</div>
        <div class="font-display font-extrabold text-xl mt-1 leading-tight">${e(ax.agency)}</div>
        <div class="text-on-surface-variant text-sm">Orquestador central + 6 departamentos: detecta, activa el flujo de respuesta, aprueba proyectos y coordina la entrega y la asistencia sobre las 139 agencias IA.</div>
      </div>
      <span class="ml-auto text-primary font-bold shrink-0 hidden sm:block">Ver AI Corp →</span>
    </a>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">${AGENCIAS.length}</div><div class="text-xs text-on-surface-variant">Agentes IA</div></div>
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">24</div><div class="text-xs text-on-surface-variant">Estados</div></div>
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">15</div><div class="text-xs text-on-surface-variant">Funciones ESF</div></div>
      <div class="card p-3"><div class="font-display font-extrabold text-2xl">1</div><div class="text-xs text-on-surface-variant">AI Corp Federal</div></div>
    </div>

    <div id="map" class="mb-6"></div>

    <div class="flex flex-wrap gap-2 items-center mb-4">
      <div class="flex gap-1.5 flex-wrap mr-auto">
        <button class="nivchip on" data-niv="">Todos</button>
        <button class="nivchip" data-niv="Federal">Federal</button>
        <button class="nivchip" data-niv="Estadal">Estadal</button>
        <button class="nivchip" data-niv="Municipal">Municipal</button>
      </div>
      <select id="estSel" class="border border-outline-variant/60 rounded-lg px-2 py-2 text-sm"><option value="">Todos los estados</option>${estOpts}</select>
      <input id="q" placeholder="Buscar agente, agencia, estado…" class="border border-outline-variant/60 rounded-lg px-3 py-2 text-sm w-64 max-w-full">
    </div>
    <div id="dir">${sections}</div>
    <p class="text-xs text-on-surface-variant mt-8 border-t border-outline-variant/50 pt-3">${e(NOTE)}</p>
  </main>
  <script>
  const q=document.getElementById('q'),estSel=document.getElementById('estSel');let niv='';
  function apply(){const v=q.value.trim().toLowerCase(),es=estSel.value;
    document.querySelectorAll('.est-sec').forEach(sec=>{let any=false;
      if(es&&sec.dataset.est!==es){sec.style.display='none';return;}
      sec.querySelectorAll('.ag-card').forEach(a=>{const m=(!niv||a.dataset.niv===niv)&&(!v||a.dataset.s.includes(v));a.style.display=m?'':'none';if(m)any=true;});
      sec.style.display=any?'':'none';});}
  q.addEventListener('input',apply);estSel.addEventListener('change',apply);
  document.querySelectorAll('.nivchip').forEach(b=>b.addEventListener('click',()=>{niv=b.dataset.niv;document.querySelectorAll('.nivchip').forEach(x=>x.classList.toggle('on',x===b));apply();}));
  const MK=${markers};
  if(typeof L!=='undefined'){const map=L.map('map',{scrollWheelZoom:false}).setView([8.4,-66.3],6);
    L.tileLayer('/api/sat/google/{z}/{x}/{y}',{minZoom:3,maxZoom:18,attribution:'Imágenes © Google'}).addTo(map);
    MK.forEach(m=>{const html='<div style="background:'+m.c+';color:#fff;width:22px;height:22px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">'+(m.e||'C')+'</div>';
      L.marker([m.lat,m.lng],{icon:L.divIcon({html,className:'',iconSize:[22,22],iconAnchor:[11,11]}),title:m.ag}).addTo(map)
        .bindPopup('<div style="font-family:Inter;font-size:12.5px"><b>'+m.ag+'</b> · '+m.niv+'<br>'+m.t+'<br><a href="/agencias/'+m.s+'">Ver agente →</a></div>');});
    setTimeout(()=>map.invalidateSize(),200);}
  </script>`;
  return c.html(head('Gobierno IA de Venezuela — AI Corp Federal | SISMO911',
    `Gobierno de emergencias autónomo operado por IA: ${AGENCIAS.length} agentes (federal + 24 estados + ciudades) coordinados por AI Corp Federal. No afiliado al gobierno real.`,
    '/agencias', true) + body + FOOT, 200, { 'Cache-Control': 'public, max-age=600' });
});

// GET /agencias/:slug — ficha del agente IA
agencias.get('/agencias/:slug', (c) => {
  const a = AGENCIAS.find((x) => x.slug === c.req.param('slug'));
  if (!a) return c.html(head('Agente no encontrado | SISMO911', 'No encontrado', '/agencias') +
    `<main class="mx-auto max-w-3xl px-4 py-16 text-center"><h1 class="font-display font-extrabold text-2xl mb-2">Agente no encontrado</h1><a href="/agencias" class="text-primary underline">← Volver al Gobierno IA</a></main>` + FOOT, 404);
  const skills = a.skills.split(',').map((s) => s.trim()).filter(Boolean);
  const parent = AGENCIAS.find((x) => x.agency === a.reports_to || x.acronym === a.reports_to);
  const children = AGENCIAS.filter((x) => x.reports_to === a.agency);
  const isApex = a.nivel === 'Central IA';
  const field = (l: string, v: string) => v ? `<div class="card p-4"><dt class="text-xs uppercase tracking-wide text-on-surface-variant font-display font-bold mb-1">${l}</dt><dd class="text-[15px] font-medium break-words">${v}</dd></div>` : '';
  const body = `<main class="mx-auto max-w-3xl px-4 py-8">
    <nav class="text-sm text-on-surface-variant mb-3"><a href="/agencias" class="text-primary hover:underline">Gobierno IA</a> · <span>${e(a.nivel)}${a.estado !== 'Nacional' ? ' · ' + e(a.estado) : ''}</span></nav>
    <div class="card p-6 flex items-center gap-4 mb-4" ${isApex ? 'style="border:1.5px solid #7c3aed;background:linear-gradient(90deg,#faf5ff,#fff)"' : ''}>
      ${avatar(a, 88)}
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-1"><span class="chip" style="background:${color(a.category)};color:#fff">${e(a.category)}</span><span class="chip" style="background:#00173a;color:#fff">${isApex ? 'AI Corp Federal' : 'ESF-' + a.esf}</span><span class="chip bg-surface-container">${e(a.nivel)}</span></div>
        <h1 class="font-display font-extrabold text-2xl leading-tight">${e(a.agent_name)}</h1>
        <div class="text-on-surface-variant">${e(a.agent_title)}</div>
      </div>
    </div>

    <div class="card p-5 mb-3"><h2 class="font-display font-bold text-lg mb-1">${e(a.agency)} <span class="text-on-surface-variant font-normal text-sm">(${e(a.acronym)})</span></h2>
      <p class="text-on-surface-variant text-sm">${isApex ? 'Centro de mando del Gobierno IA: ingiere y coordina los datos de todas las agencias en un comando nacional.' : `Agente IA de ${e(a.estado === 'Nacional' ? 'nivel federal' : a.estado)} — función ${e(a.esf_name)}.`}</p></div>

    <div class="grid sm:grid-cols-2 gap-3 mb-3">
      <div class="card p-4"><dt class="text-xs uppercase tracking-wide text-on-surface-variant font-display font-bold mb-1">Correo del agente</dt><dd class="text-[15px] font-medium break-words"><a href="mailto:${e(a.email)}" class="text-primary hover:underline">${e(a.email)}</a></dd></div>
      ${field(isApex ? 'Rol' : 'Función (FEMA ESF)', isApex ? 'Coordinación Central' : `ESF-${a.esf} · ${e(a.esf_name)}`)}
      ${field('Nivel', e(a.nivel))}
      ${field('Función SCI / ICS', e(a.ics))}
      ${field('Fase de emergencia', e(a.phase))}
      ${field('Nivel de activación', e(a.activacion))}
      ${a.estado !== 'Nacional' ? field('Estado', e(a.estado)) : ''}
      ${a.ciudad ? field('Ciudad / Sede', e(a.ciudad)) : ''}
    </div>

    <div class="card p-5 mb-4"><h3 class="font-display font-bold mb-2">Competencias / skills (gestión de emergencias)</h3>
      <ul class="list-disc pl-5 space-y-1 text-[15px]">${skills.map((r) => `<li>${e(r)}</li>`).join('')}</ul></div>
    ${isApex ? `<div class="card p-5 mb-4" style="border:1.5px solid #7c3aed"><h3 class="font-display font-bold mb-2">Protocolo «tomar el control ASAP»</h3>
      <ol class="list-decimal pl-5 space-y-1 text-[15px]">
        <li>Detección del evento (FUNVISIS / INAMEH / USGS) → AI Corp Federal activa el COE Nacional.</li>
        <li>Asignación automática de roles SCI a los 139 agentes según su ESF y nivel de activación.</li>
        <li>Despliegue inmediato (0–6 h): rescate, salud, seguridad y albergues en los estados afectados.</li>
        <li>Soporte (0–24 h): logística, transporte, comunicaciones, energía y agua.</li>
        <li>Síntesis situacional continua → decisiones y reasignación de recursos en tiempo real.</li>
      </ol></div>` : ''}

    ${children.length ? `<div class="mb-4"><h3 class="font-display font-bold mb-2 text-sm uppercase tracking-wide text-on-surface-variant">Coordina (${children.length})</h3>
      <div class="flex flex-wrap gap-2">${children.slice(0, 60).map((p) => `<a href="/agencias/${e(p.slug)}" class="chip bg-surface-container hover:bg-surface-container-high">${e(p.acronym)}</a>`).join('')}</div></div>` : ''}
    ${parent ? `<div class="mb-4 text-sm"><span class="text-on-surface-variant">Reporta a:</span> <a href="/agencias/${e(parent.slug)}" class="text-primary hover:underline font-semibold">${e(parent.agency)}</a></div>` : ''}

    <div class="flex flex-wrap gap-3 text-sm noprint mb-6"><a href="/agencias" class="text-primary hover:underline">← Gobierno IA</a><button onclick="window.print()" class="text-primary hover:underline">🖨️ Imprimir ficha</button></div>
    <p class="text-xs text-on-surface-variant border-t border-outline-variant/50 pt-3">${e(NOTE)}</p>
  </main>`;
  return c.html(head(`${a.agent_name} — ${a.acronym} | Gobierno IA de Venezuela`,
    `${a.agency} (${a.acronym}) · agente IA ${a.nivel}. ${a.skills}`.slice(0, 180), '/agencias/' + a.slug) + body + FOOT,
    200, { 'Cache-Control': 'public, max-age=3600' });
});
