import { Hono } from 'hono';
import type { Env } from '../types';
import { ESTADOS, type Estado } from '../data/estados';

// Mapa sísmico por estado. Plantilla única parametrizada por :slug que reúne,
// para cualquiera de los 25 estados de Venezuela: la cartografía GIS del estado
// (límite, municipios, vialidad, poblados — OpenStreetMap/ODbL), el feed de
// sismos USGS en vivo de SISMO911, y los daños estructurales reportados
// (sosvenezuela2026.com), con tablas de municipios + edificios colapsados/
// dañados debajo del mapa. /estados (índice nacional) y /estado/:slug.
// La Guaira suma capas propias: parroquias, viaducto, puerto/aeropuerto y la
// referencia histórica del deslave de 1999.
export const estados = new Hono<{ Bindings: Env }>();

const e = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const byName = (a: Estado, b: Estado) => a.name.localeCompare(b.name, 'es');

function head(title: string, desc: string, canonical: string): string {
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
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" /><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>body{background:#f9f9fc}.font-display{font-family:'Public Sans',sans-serif}
.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:.85rem}
#map{width:100%;height:70vh;min-height:460px;border-radius:.7rem;background:#0b2b5b;z-index:0}
.lyr{display:flex;align-items:center;gap:.5rem;font-size:13px;padding:.16rem 0;cursor:pointer}
.lyr input{accent-color:#00173a}
.sw{width:15px;height:4px;border-radius:2px;display:inline-block;flex:0 0 auto}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block;flex:0 0 auto;border:1px solid rgba(0,0,0,.3)}
table.dt{width:100%;border-collapse:collapse;font-size:13px}
table.dt th{text-align:left;font-weight:700;color:#00173a;border-bottom:2px solid #e6e8ef;padding:.4rem .5rem;position:sticky;top:0;background:#fff}
table.dt td{padding:.35rem .5rem;border-bottom:1px solid #f0f1f6}
table.dt tr:hover td{background:#f7f8fc}
.sev{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.3rem}
.scroll{max-height:360px;overflow:auto}
.estcard{display:block;padding:.7rem .8rem;border:1px solid rgba(0,0,0,.08);border-radius:.7rem;background:#fff;transition:.12s}
.estcard:hover{border-color:#00173a;box-shadow:0 2px 10px rgba(0,23,58,.08)}
.qk{font-variant-numeric:tabular-nums}
.leaflet-popup-content{font:13px/1.4 Inter,sans-serif}.leaflet-popup-content b{color:#00173a}
.pulse{animation:pl 1.8s ease-out infinite}@keyframes pl{0%{stroke-opacity:.9;stroke-width:2}70%{stroke-opacity:0;stroke-width:18}100%{stroke-opacity:0}}
</style>
<script src="/app-shell.js" defer></script></head>
<body class="font-sans text-on-surface">
<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/estados" class="text-white font-bold">Estados</a><a href="/operaciones" class="hover:text-white/70">Operaciones</a><a href="/agencias" class="hover:text-white/70">Gobierno IA</a><a href="/sos" class="text-secondary-fixed font-bold">SOS</a></nav></div></header>`;
}
const FOOT = `</body></html>`;

// ---------- /estados : índice nacional ----------
estados.get('/estados', (c) => {
  const list = [...ESTADOS].sort(byName);
  const cards = list.map((s) => `<a href="/estado/${e(s.slug)}" class="estcard">
    <div class="font-display font-bold text-primary">${e(s.name)}</div>
    <div class="text-[12px] text-on-surface-variant mt-.5">${s.municipios} municipios · ${s.places} poblados</div></a>`).join('');
  const html = `${head('Mapa sísmico por estado — SISMO911', 'Mapas sísmicos de los 25 estados de Venezuela: límite, municipios, vialidad, poblados, sismos USGS en vivo y daños estructurales reportados.', '/estados')}
<main class="mx-auto max-w-6xl px-4 py-6">
  <h1 class="font-display text-2xl sm:text-3xl font-extrabold text-primary">Mapa sísmico por estado</h1>
  <p class="text-sm text-on-surface-variant mt-1 mb-4">Cartografía GIS + sismos en vivo + daños estructurales reportados, para los 25 estados del país.</p>
  <div id="map" class="card mb-5"></div>
  <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">${cards}</div>
</main>
<script>
const EST=${JSON.stringify(list.map((s) => ({ slug: s.slug, name: s.name, c: s.center })))};
const map=L.map('map').setView([7.5,-66],6);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'&copy; OpenStreetMap &copy; CARTO',subdomains:'abcd',maxZoom:19}).addTo(map);
EST.forEach(s=>{L.marker(s.c).addTo(map).bindPopup('<b>'+s.name+'</b><br><a href="/estado/'+s.slug+'">Ver mapa sísmico →</a>');});
fetch('/api/events?limit=300').then(r=>r.json()).then(d=>{(d.events||[]).forEach(q=>{if(q.lat==null)return;
  L.circleMarker([q.lat,q.lon],{radius:Math.max(3,Math.min(16,(q.mag||1)*2.5)),color:'#fff',weight:1,
  fillColor:(q.mag>=4.5?'#c8102e':q.mag>=2.5?'#d97706':'#16a34a'),fillOpacity:.7})
  .addTo(map).bindPopup('<b>M '+(q.mag||0).toFixed(1)+'</b> · '+(q.place_es||q.place||''));});}).catch(()=>{});
</script>${FOOT}`;
  return c.html(html);
});

// ---------- /sitemap-estados.xml : all state GIS pages ----------
estados.get('/sitemap-estados.xml', (c) => {
  const urls = [...ESTADOS].sort(byName).map((st) => `  <url><loc>https://sismo911.com/estado/${e(st.slug)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return c.body(xml, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

// ---------- /estado/:slug : plantilla por estado ----------
estados.get('/estado/:slug', (c) => {
  const slug = c.req.param('slug');
  const st = ESTADOS.find((s) => s.slug === slug);
  if (!st) return c.notFound();
  const isLG = slug === 'la-guaira';
  const bb = st.bbox; // [minlon,minlat,maxlon,maxlat]

  const html = `${head(
    `Mapa sísmico de ${e(st.name)} — SISMO911`,
    `Mapa GIS de ${e(st.name)}: límite, municipios, vialidad y poblados sobre el feed de sismos USGS en vivo y los daños estructurales reportados.`,
    `/estado/${e(slug)}`,
  )}
<main class="mx-auto max-w-6xl px-4 py-6">
  <div class="flex flex-wrap items-end justify-between gap-3 mb-4">
    <div>
      <nav class="text-[12px] text-on-surface-variant mb-1"><a href="/estados" class="hover:underline">Estados</a> › <span>${e(st.name)}</span></nav>
      <h1 class="font-display text-2xl sm:text-3xl font-extrabold text-primary leading-tight">${e(st.name)} — Mapa sísmico</h1>
      <p class="text-sm text-on-surface-variant mt-1">Cartografía GIS + sismos USGS en vivo + daños estructurales reportados.</p>
    </div>
    <div id="quakeStat" class="text-right text-[13px] text-on-surface-variant qk">Cargando…</div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
    <div id="map" class="card"></div>
    <aside class="space-y-4">
      <div class="card p-4">
        <h2 class="font-display font-bold text-primary text-sm mb-2">Mapa base</h2>
        <label class="lyr"><input type="radio" name="base" value="calle" checked><span class="sw" style="background:#cdd3dc"></span> Calle</label>
        <label class="lyr"><input type="radio" name="base" value="aereo"><span class="sw" style="background:#3f6212"></span> Aéreo (satélite)</label>
        <label class="lyr" id="baseGoogleRow" style="display:none"><input type="radio" name="base" value="google"><span class="sw" style="background:#1f6f3f"></span> Aéreo (Google)</label>
        <h2 class="font-display font-bold text-primary text-sm mt-3 mb-2">Capas</h2>
        <label class="lyr"><input type="checkbox" id="l_bound" checked><span class="sw" style="height:3px;background:#00173a;border:1px dashed #00173a"></span> Límite estatal</label>
        <label class="lyr"><input type="checkbox" id="l_muni" checked><span class="sw" style="background:#7a94ca"></span> Municipios</label>
        ${isLG ? `<label class="lyr"><input type="checkbox" id="l_parr"><span class="sw" style="background:#0891b2"></span> Parroquias (11)</label>` : ''}
        <label class="lyr"><input type="checkbox" id="l_roads" checked><span class="sw" style="background:#9aa3b2"></span> Vialidad principal</label>
        <label class="lyr"><input type="checkbox" id="l_places" checked><span class="dot" style="background:#0369a1"></span> Poblados</label>
        <label class="lyr"><input type="checkbox" id="l_quakes" checked><span class="dot" style="background:#c8102e"></span> Sismos (USGS)</label>
        <label class="lyr"><input type="checkbox" id="l_damage" checked><span class="dot" style="background:#7c1d1d"></span> Daños / colapsos</label>
        ${isLG ? `<div class="mt-2 pt-2 border-t border-black/10 text-[11px] font-bold text-primary">Capas La Guaira</div>
        <label class="lyr"><input type="checkbox" id="l_viad"><span class="sw" style="background:#e57200"></span> Autopista + viaductos</label>
        <label class="lyr"><input type="checkbox" id="l_fac"><span class="dot" style="background:#00173a"></span> Puerto / aeropuerto</label>
        <label class="lyr"><input type="checkbox" id="l_quebr"><span class="sw" style="background:#0891b2"></span> Quebradas (deslave)</label>
        <label class="lyr"><input type="checkbox" id="l_des"><span class="dot" style="background:#9333ea"></span> Deslave 1999 (ref.)</label>` : ''}
      </div>
      <div class="card p-4">
        <h2 class="font-display font-bold text-primary text-sm mb-2">Magnitud</h2>
        <div class="space-y-1.5 text-[12.5px] text-on-surface-variant">
          <div class="flex items-center gap-2"><span class="dot" style="width:8px;height:8px;background:#16a34a"></span> M &lt; 2.5</div>
          <div class="flex items-center gap-2"><span class="dot" style="width:12px;height:12px;background:#d97706"></span> M 2.5–4.5</div>
          <div class="flex items-center gap-2"><span class="dot" style="width:17px;height:17px;background:#c8102e"></span> M 4.5+</div>
        </div>
        <h2 class="font-display font-bold text-primary text-sm mt-3 mb-2">Daños</h2>
        <div class="space-y-1.5 text-[12.5px] text-on-surface-variant">
          <div class="flex items-center gap-2"><span class="sev" style="background:#c8102e"></span> Colapsado</div>
          <div class="flex items-center gap-2"><span class="sev" style="background:#d97706"></span> Dañado</div>
        </div>
      </div>
    </aside>
  </div>

  <!-- Datos bajo el mapa -->
  <div id="stats" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5 mt-5"></div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
    <section class="card p-4">
      <h2 class="font-display font-bold text-primary mb-2">${isLG ? 'Parroquias y municipio' : 'Municipios'} <span id="muniN" class="text-on-surface-variant font-normal text-[13px]"></span></h2>
      <div class="scroll"><table class="dt"><thead><tr><th>Nombre</th><th>Población</th></tr></thead><tbody id="muniBody"><tr><td colspan="2" class="text-on-surface-variant">Cargando…</td></tr></tbody></table></div>
    </section>
    <section class="card p-4">
      <h2 class="font-display font-bold text-primary mb-2">Edificios colapsados <span id="colN" class="text-on-surface-variant font-normal text-[13px]"></span></h2>
      <div class="scroll"><table class="dt"><thead><tr><th>Edificio</th><th>Municipio</th><th>Parroquia</th><th>Atrap.</th></tr></thead><tbody id="colBody"><tr><td colspan="4" class="text-on-surface-variant">Cargando…</td></tr></tbody></table></div>
      <p class="text-[11px] text-on-surface-variant mt-2">Fuente: sosvenezuela2026.com (reportes ciudadanos verificados/ por verificar).</p>
    </section>
    <section class="card p-4">
      <h2 class="font-display font-bold text-primary mb-2">Edificios dañados <span id="damN" class="text-on-surface-variant font-normal text-[13px]"></span></h2>
      <div class="scroll"><table class="dt"><thead><tr><th>Edificio</th><th>Municipio</th><th>Parroquia</th><th>Sev.</th></tr></thead><tbody id="damBody"><tr><td colspan="4" class="text-on-surface-variant">Cargando…</td></tr></tbody></table></div>
    </section>
    <section class="card p-4">
      <h2 class="font-display font-bold text-primary mb-2">Poblados con población <span id="popN" class="text-on-surface-variant font-normal text-[13px]"></span></h2>
      <div class="scroll"><table class="dt"><thead><tr><th>Poblado</th><th>Tipo</th><th>Población</th></tr></thead><tbody id="popBody"><tr><td colspan="3" class="text-on-surface-variant">Cargando…</td></tr></tbody></table></div>
    </section>
  </div>

  <!-- Fotos de edificios (de los reportes con imagen) -->
  <section class="card p-4 mt-4">
    <div class="flex items-baseline justify-between flex-wrap gap-2 mb-2">
      <h2 class="font-display font-bold text-primary">Fotos de edificios <span id="fotoN" class="text-on-surface-variant font-normal text-[13px]"></span></h2>
      <span class="text-[11px] text-on-surface-variant">Imágenes adjuntas a los reportes (sosvenezuela2026.com + prensa).</span>
    </div>
    <div id="fotoGrid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
      <div class="text-[13px] text-on-surface-variant col-span-full">Cargando…</div>
    </div>
  </section>
  ${isLG ? `<p class="text-[11px] text-on-surface-variant mt-3">La capa “Deslave 1999 (ref.)” marca localidades documentadas como las más afectadas por la Tragedia de Vargas (dic. 1999); son referencias históricas de comunidad, no extensiones de flujo topografiadas.</p>` : ''}
  <p class="text-[11px] text-on-surface-variant mt-2">GIS: OpenStreetMap (ODbL). Sismos: USGS (dominio público) vía SISMO911. Daños: sosvenezuela2026.com.</p>
</main>
<script>
const SLUG=${JSON.stringify(slug)}, BB=${JSON.stringify(bb)}, CEN=${JSON.stringify(st.center)}, ISLG=${isLG};
// Point-in-polygon (ray casting, even-odd handles holes) against the real state
// boundary — avoids the bbox over-count where adjacent states (Caracas cluster)
// would otherwise claim each other's reports.
let BG=null, bgResolve; const bgReady=new Promise(r=>{bgResolve=r;});
function pip(lon,lat,rings){let inside=false;for(const ring of rings){for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];if(((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/(yj-yi)+xi))inside=!inside;}}return inside;}
function inState(lon,lat){if(lon==null||lat==null)return false;if(!BG)return lon>=BB[0]&&lon<=BB[2]&&lat>=BB[1]&&lat<=BB[3];for(const poly of BG)if(pip(lon,lat,poly))return true;return false;}
const ge=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>{const v=parseInt(String(n).replace(/\\D/g,''));return isFinite(v)&&v>0?v.toLocaleString('es-VE'):'—';};
const map=L.map('map',{preferCanvas:true}).setView(CEN,9);
// Base layers: calle (CARTO) + aéreo (Esri World Imagery, free) + aéreo Google
// (vía proxy /api/sat/google, sólo si hay clave). Etiquetas Esri sobre el aéreo.
const baseCalle=L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'&copy; OpenStreetMap &copy; CARTO',subdomains:'abcd',maxZoom:19});
const baseAereo=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics',maxZoom:19});
const aereoLabels=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,opacity:.9});
let baseGoogle=null; // set if /api/sat/config reports google:true
const BASES={calle:baseCalle,aereo:baseAereo};
let curBase=baseCalle.addTo(map);
function setBase(key){
  const nb=BASES[key]||baseCalle;
  if(nb!==curBase){map.removeLayer(curBase);nb.addTo(map);curBase=nb;curBase.bringToBack();}
  if(key==='calle')map.removeLayer(aereoLabels); else aereoLabels.addTo(map);
}
fetch('/api/sat/config').then(r=>r.json()).then(cfg=>{ if(cfg&&cfg.google){
  baseGoogle=L.tileLayer('/api/sat/google/{z}/{x}/{y}',{attribution:'Imagery &copy; Google',maxZoom:21});
  BASES.google=baseGoogle;
  const row=document.getElementById('baseGoogleRow'); if(row)row.style.display='';
}}).catch(()=>{});
const LY={};
const base='/data/estados/'+SLUG+'/';
const roadStyle=h=>({motorway:{color:'#c8102e',weight:3},trunk:{color:'#e57200',weight:2.4},primary:{color:'#d97706',weight:2},secondary:{color:'#5b6b82',weight:1.5},tertiary:{color:'#8a96a8',weight:1.1}}[h]||{color:'#b6bdc8',weight:.8});
function geo(url,key,opts){return fetch(url).then(r=>r.json()).then(g=>{LY[key]=L.geoJSON(g,opts);if(opts.on!==false)LY[key].addTo(map);return g;}).catch(()=>null);}

geo(base+'boundary.geojson','bound',{style:{color:'#00173a',weight:2.5,dashArray:'6 5',fill:false}})
  .then(g=>{try{map.fitBounds(LY.bound.getBounds(),{padding:[18,18]});}catch(_){}
    const gm=g&&g.features&&g.features[0]&&g.features[0].geometry;
    if(gm){BG=gm.type==='MultiPolygon'?gm.coordinates:gm.type==='Polygon'?[gm.coordinates]:null;}
    bgResolve();});

const pc=['#7a94ca','#0369a1','#16a34a','#d97706','#c8102e','#9333ea','#0891b2','#65a30d','#db2777','#15803d','#44474f'];let pi=0;
geo(base+'municipios.geojson','muni',{
  style:()=>({color:'#00173a',weight:1,fillColor:pc[(pi++)%pc.length],fillOpacity:.12}),
  onEachFeature:(f,l)=>l.bindPopup('<b>'+ge(f.properties.name)+'</b>'+(f.properties.population?'<br>Pob. '+fmt(f.properties.population):''))
}).then(g=>{ // municipios table
  const fs=(g&&g.features||[]).map(f=>f.properties).sort((a,b)=>String(a.name).localeCompare(String(b.name),'es'));
  document.getElementById('muniN').textContent='('+fs.length+')';
  document.getElementById('muniBody').innerHTML = fs.length? fs.map(p=>'<tr><td>'+ge(p.name)+'</td><td class="qk">'+fmt(p.population)+'</td></tr>').join('') : '<tr><td colspan=2 class="text-on-surface-variant">Sin datos.</td></tr>';
});

geo(base+'roads-major.geojson','roads',{style:f=>roadStyle(f.properties.highway),
  onEachFeature:(f,l)=>{const p=f.properties;if(p.name||p.ref)l.bindPopup('<b>'+ge(p.name||'(sin nombre)')+'</b><br>'+ge(p.highway||'')+(p.ref?' · '+ge(p.ref):''));}});

geo(base+'places.geojson','places',{
  pointToLayer:(f,ll)=>{const t=f.properties.place,r=t==='city'?7:t==='town'?5:3;return L.circleMarker(ll,{radius:r,color:'#fff',weight:1,fillColor:'#0369a1',fillOpacity:.9});},
  onEachFeature:(f,l)=>{const p=f.properties;l.bindPopup('<b>'+ge(p.name)+'</b><br>'+ge(p.place)+(p.population?' · pob. '+fmt(p.population):''));
    if(['city','town'].includes(f.properties.place))l.bindTooltip(f.properties.name,{permanent:true,direction:'top',opacity:.8});}
}).then(g=>{ // poblados con población
  const fs=(g&&g.features||[]).map(f=>f.properties).filter(p=>p.population).sort((a,b)=>(parseInt(String(b.population).replace(/\\D/g,''))||0)-(parseInt(String(a.population).replace(/\\D/g,''))||0));
  document.getElementById('popN').textContent='('+fs.length+')';
  document.getElementById('popBody').innerHTML = fs.length? fs.map(p=>'<tr><td>'+ge(p.name)+'</td><td>'+ge(p.place)+'</td><td class="qk">'+fmt(p.population)+'</td></tr>').join('') : '<tr><td colspan=3 class="text-on-surface-variant">OSM no registra población para estos poblados.</td></tr>';
});

// Live quakes (USGS) — bbox del estado
const qColor=m=>m>=4.5?'#c8102e':m>=2.5?'#d97706':'#16a34a',qR=m=>Math.max(4,Math.min(20,(m||1)*3));
LY.quakes=L.layerGroup().addTo(map);
Promise.all([fetch('/api/events?limit=300').then(r=>r.json()),bgReady]).then(([d])=>{
  const ev=(d.events||[]).filter(x=>inState(x.lon,x.lat)); ev.sort((a,b)=>(a.time_ms||0)-(b.time_ms||0));
  ev.forEach((q,i)=>{const m=q.mag||0,latest=i===ev.length-1;
    const mk=L.circleMarker([q.lat,q.lon],{radius:qR(m),color:'#fff',weight:1,fillColor:qColor(m),fillOpacity:.82,className:latest?'pulse':''});
    const when=q.time_ms?new Date(q.time_ms).toLocaleString('es-VE',{dateStyle:'short',timeStyle:'short'}):'';
    mk.bindPopup('<b>M '+m.toFixed(1)+'</b> · '+ge(q.place_es||q.place||'')+'<br>Prof. '+(q.depth_km!=null?q.depth_km+' km':'?')+'<br><span style="color:#5b6b82">'+when+'</span>');
    mk.addTo(LY.quakes);});
  STAT.quakes=ev.length; STAT.big=ev.reduce((a,b)=>(b.mag||0)>(a.mag||0)?b:a,{mag:0}); renderStat();
}).catch(()=>{});

// Daños estructurales (sosvenezuela2026.com) — bbox del estado
LY.damage=L.layerGroup().addTo(map);
const dColor=c=>c==='collapsed_building'?'#c8102e':c==='damaged_building'?'#d97706':'#7c1d1d';
const sevColor=s=>({rojo:'#c8102e',amarillo:'#d97706',verde:'#16a34a'}[s]||'#7c1d1d');
const imgUrl=u=>!u?null:(u.indexOf('http')===0?u:u[0]==='/'?'https://sosvenezuela2026.com'+u:u);
Promise.all([fetch('/api/danos-estructurales').then(r=>r.json()),bgReady]).then(([d])=>{
  const all=(d.reports||[]).filter(x=>inState(x.lng,x.lat));
  all.forEach(x=>{const iu=imgUrl(x.image_url);
    L.circleMarker([x.lat,x.lng],{radius:x.category==='collapsed_building'?7:5,color:'#fff',weight:1,fillColor:dColor(x.category),fillOpacity:.85})
    .addTo(LY.damage).bindPopup('<div style="max-width:220px">'+(iu?'<img src="'+ge(iu)+'" style="width:100%;max-height:130px;object-fit:cover;border-radius:6px;margin-bottom:5px" loading="lazy" onerror="this.remove()">':'')+
    '<b>'+ge(x.title||'(sin nombre)')+'</b><br>'+ge(x.category==='collapsed_building'?'Colapsado':x.category==='damaged_building'?'Dañado':x.category)+
    (x.municipio?' · '+ge(x.municipio):'')+(x.parroquia?' / '+ge(x.parroquia):'')+(x.people_trapped?'<br>Atrapados: '+x.people_trapped:'')+
    (x.source_url?'<br><a href="'+ge(x.source_url)+'" target="_blank" rel="noopener">fuente ↗</a>':'')+'</div>');});
  // Galería de fotos (reportes con imagen)
  const ph=all.map(x=>({u:imgUrl(x.image_url),t:x.title,c:x.category,s:x.source_url})).filter(p=>p.u);
  const fg=document.getElementById('fotoGrid');
  document.getElementById('fotoN').textContent='('+ph.length+')';
  fg.innerHTML = ph.length? ph.map(p=>'<a class="ftile block relative aspect-square overflow-hidden rounded-lg bg-surface-container" href="'+ge(p.s||p.u)+'" target="_blank" rel="noopener" title="'+ge(p.t||'')+'">'+
    '<img src="'+ge(p.u)+'" loading="lazy" class="w-full h-full object-cover" onerror="this.closest(\\'.ftile\\').remove()">'+
    '<span class="absolute bottom-0 inset-x-0 text-[10px] text-white px-1.5 py-1 leading-tight" style="background:linear-gradient(transparent,rgba(0,0,0,.75))">'+ge((p.t||'').slice(0,46))+'</span></a>').join('')
    : '<div class="text-[13px] text-on-surface-variant col-span-full">Aún no hay fotos adjuntas a los reportes de este estado.</div>';
  const col=all.filter(x=>x.category==='collapsed_building'), dam=all.filter(x=>x.category==='damaged_building');
  document.getElementById('colN').textContent='('+col.length+')';
  document.getElementById('damN').textContent='('+dam.length+')';
  document.getElementById('colBody').innerHTML = col.length? col.map(x=>'<tr><td>'+ge(x.title||'—')+'</td><td>'+ge(x.municipio||'—')+'</td><td>'+ge(x.parroquia||'—')+'</td><td class="qk">'+(x.people_trapped||'')+'</td></tr>').join('') : '<tr><td colspan=4 class="text-on-surface-variant">Sin colapsos reportados en este estado.</td></tr>';
  document.getElementById('damBody').innerHTML = dam.length? dam.map(x=>'<tr><td>'+ge(x.title||'—')+'</td><td>'+ge(x.municipio||'—')+'</td><td>'+ge(x.parroquia||'—')+'</td><td><span class="sev" style="background:'+sevColor(x.severity)+'"></span>'+ge(x.severity||'')+'</td></tr>').join('') : '<tr><td colspan=4 class="text-on-surface-variant">Sin edificios dañados reportados.</td></tr>';
  STAT.col=col.length; STAT.dam=dam.length; renderStat();
}).catch(()=>{const m='<tr><td colspan=4 class="text-on-surface-variant">No se pudo cargar el feed de daños.</td></tr>';
  document.getElementById('colBody').innerHTML=m; document.getElementById('damBody').innerHTML=m;
  document.getElementById('fotoGrid').innerHTML='<div class="text-[13px] text-on-surface-variant col-span-full">No se pudo cargar el feed de fotos.</div>';});

// Stats strip
const STAT={muni:${st.municipios},places:${st.places},quakes:0,col:0,dam:0,big:{mag:0}};
function tile(v,l){return '<div class="card p-3 text-center"><div class="font-display text-xl font-extrabold text-primary qk">'+v+'</div><div class="text-[11px] text-on-surface-variant">'+l+'</div></div>';}
function renderStat(){document.getElementById('stats').innerHTML=
  tile(STAT.muni,'${isLG ? 'Municipio' : 'Municipios'}')+tile(STAT.places,'Poblados')+tile(STAT.quakes,'Sismos (30d)')+
  tile((STAT.big.mag||0).toFixed(1),'Mayor magnitud')+tile(STAT.col,'Colapsados')+tile(STAT.dam,'Dañados');
  document.getElementById('quakeStat').innerHTML='<b>'+STAT.quakes+'</b> sismos · <b>'+STAT.col+'</b> colapsos · <b>'+STAT.dam+'</b> daños';}
renderStat();

${isLG ? `
// ---- Capas propias de La Guaira ----
geo('/data/laguaira/parroquias.geojson','parr',{on:false,style:{color:'#0891b2',weight:1.2,fillColor:'#0891b2',fillOpacity:.08},onEachFeature:(f,l)=>l.bindPopup('<b>'+ge(f.properties.name)+'</b>')});
geo('/data/laguaira/extra/viaduct.geojson','viad',{on:false,style:f=>f.properties.kind==='viaducto'?{color:'#c8102e',weight:4}:{color:'#e57200',weight:2.5},onEachFeature:(f,l)=>l.bindPopup('<b>'+ge(f.properties.name)+'</b><br>'+ge(f.properties.kind))});
geo('/data/laguaira/extra/facilities.geojson','fac',{on:false,pointToLayer:(f,ll)=>L.circleMarker(ll,{radius:8,color:'#fff',weight:2,fillColor:'#00173a',fillOpacity:1}),onEachFeature:(f,l)=>l.bindPopup('<b>'+ge(f.properties.name)+'</b><br>'+ge(f.properties.note))});
geo('/data/laguaira/extra/deslave-corridors.geojson','quebr',{on:false,style:{color:'#0891b2',weight:1.2,opacity:.7}});
geo('/data/laguaira/extra/deslave-localities.geojson','des',{on:false,pointToLayer:(f,ll)=>L.circleMarker(ll,{radius:7,color:'#fff',weight:2,fillColor:'#9333ea',fillOpacity:.95}),onEachFeature:(f,l)=>{l.bindPopup('<b>'+ge(f.properties.name)+'</b><br>'+ge(f.properties.note)+'<br><span style="color:#9333ea;font-size:11px">'+ge(f.properties.ref)+'</span>');l.bindTooltip(f.properties.name,{permanent:true,direction:'top',opacity:.8});}});
` : ''}

// Layer toggles
const ids={l_bound:'bound',l_muni:'muni',l_roads:'roads',l_places:'places',l_quakes:'quakes',l_damage:'damage'${isLG ? ",l_parr:'parr',l_viad:'viad',l_fac:'fac',l_quebr:'quebr',l_des:'des'" : ''}};
Object.keys(ids).forEach(id=>{const el=document.getElementById(id);if(!el)return;
  el.addEventListener('change',ev=>{const ly=LY[ids[id]];if(!ly)return;ev.target.checked?ly.addTo(map):map.removeLayer(ly);});});
// Base-map switch
document.querySelectorAll('input[name=base]').forEach(r=>r.addEventListener('change',e=>{if(e.target.checked)setBase(e.target.value);}));
</script>${FOOT}`;
  return c.html(html);
});
