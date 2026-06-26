import { Hono } from 'hono';
import type { Env } from '../types';

// La Guaira — mapa sísmico regional. El estado costero La Guaira (antes Vargas)
// concentra la mayor densidad poblacional expuesta a la falla de San Sebastián
// y al deslave; esta página superpone la cartografía GIS del estado (límite,
// 11 parroquias, vialidad, poblados — OpenStreetMap/ODbL) sobre el feed sísmico
// USGS en vivo de SISMO911. Server-rendered: /la-guaira. Las capas GeoJSON se
// sirven como assets estáticos desde /data/laguaira/*.geojson.
export const laguaira = new Hono<{ Bindings: Env }>();

const e = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

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
#map{width:100%;height:72vh;min-height:480px;border-radius:.7rem;background:#0b2b5b;z-index:0}
.lyr{display:flex;align-items:center;gap:.5rem;font-size:13px;padding:.18rem 0;cursor:pointer}
.lyr input{accent-color:#00173a}
.sw{width:15px;height:4px;border-radius:2px;display:inline-block;flex:0 0 auto}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block;flex:0 0 auto;border:1px solid rgba(0,0,0,.3)}
.qk{font-variant-numeric:tabular-nums}
.leaflet-popup-content{font:13px/1.4 Inter,sans-serif}
.leaflet-popup-content b{color:#00173a}
.pulse{animation:pl 1.8s ease-out infinite}@keyframes pl{0%{stroke-opacity:.9;stroke-width:2}70%{stroke-opacity:0;stroke-width:18}100%{stroke-opacity:0}}
</style>
<script src="/app-shell.js" defer></script></head>
<body class="font-sans text-on-surface">
<header class="bg-primary text-white sticky top-0 z-50"><div class="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3"><a href="/" class="flex items-center gap-2 shrink-0"><img src="/logo.svg" class="h-8 w-8" alt="SISMO911"><b class="font-display tracking-tight">SISMO911</b></a><nav class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium"><a href="/" class="hover:text-white/70">Panel</a><a href="/la-guaira" class="text-white font-bold">La Guaira</a><a href="/operaciones" class="hover:text-white/70">Operaciones</a><a href="/agencias" class="hover:text-white/70">Gobierno IA</a><a href="/sos" class="text-secondary-fixed font-bold">SOS</a></nav></div></header>`;
}
const FOOT = `</body></html>`;

laguaira.get('/', (c) => {
  const html = `${head(
    'Mapa sísmico de La Guaira — SISMO911',
    'Mapa GIS del estado La Guaira (Vargas): límite estatal, 11 parroquias, vialidad y poblados sobre el feed de sismos USGS en vivo. Zona de alta exposición a la falla de San Sebastián.',
    '/la-guaira',
  )}
<main class="mx-auto max-w-6xl px-4 py-6">
  <div class="flex flex-wrap items-end justify-between gap-3 mb-4">
    <div>
      <h1 class="font-display text-2xl sm:text-3xl font-extrabold text-primary leading-tight">Estado La Guaira — Mapa sísmico</h1>
      <p class="text-sm text-on-surface-variant mt-1">Cartografía GIS del estado costero + sismos USGS en vivo. Franja de máxima exposición sísmica del país.</p>
    </div>
    <div id="quakeStat" class="text-right text-[13px] text-on-surface-variant qk">Cargando sismos…</div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
    <div id="map" class="card"></div>

    <aside class="space-y-4">
      <div class="card p-4">
        <h2 class="font-display font-bold text-primary text-sm mb-2">Capas</h2>
        <label class="lyr"><input type="checkbox" id="l_state" checked><span class="sw" style="height:3px;background:#00173a;border:1px dashed #00173a"></span> Límite estatal</label>
        <label class="lyr"><input type="checkbox" id="l_parr" checked><span class="sw" style="background:#7a94ca"></span> Parroquias (11)</label>
        <label class="lyr"><input type="checkbox" id="l_roads" checked><span class="sw" style="background:#9aa3b2"></span> Vialidad principal</label>
        <label class="lyr"><input type="checkbox" id="l_roadsall"><span class="sw" style="background:#cdd3dc"></span> Toda la vialidad</label>
        <label class="lyr"><input type="checkbox" id="l_places" checked><span class="dot" style="background:#0369a1"></span> Poblados</label>
        <label class="lyr"><input type="checkbox" id="l_quakes" checked><span class="dot" style="background:#c8102e"></span> Sismos (USGS)</label>
      </div>
      <div class="card p-4">
        <h2 class="font-display font-bold text-primary text-sm mb-2">Magnitud</h2>
        <div class="space-y-1.5 text-[12.5px] text-on-surface-variant">
          <div class="flex items-center gap-2"><span class="dot" style="width:8px;height:8px;background:#16a34a"></span> M &lt; 2.5</div>
          <div class="flex items-center gap-2"><span class="dot" style="width:12px;height:12px;background:#d97706"></span> M 2.5–4.5</div>
          <div class="flex items-center gap-2"><span class="dot" style="width:17px;height:17px;background:#c8102e"></span> M 4.5+</div>
          <div class="pt-1 text-[11px]">El anillo pulsante marca el sismo más reciente.</div>
        </div>
      </div>
      <div class="card p-4 text-[11px] text-on-surface-variant leading-relaxed">
        GIS: OpenStreetMap (ODbL). Sismos: USGS (dominio público), vía el feed en vivo de SISMO911.
      </div>
    </aside>
  </div>
</main>
<script>
const map = L.map('map',{preferCanvas:true}).setView([10.55,-66.7],10);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  {attribution:'&copy; OpenStreetMap &copy; CARTO',subdomains:'abcd',maxZoom:19}).addTo(map);

const L_={};
const roadStyle=h=>({
  motorway:{color:'#c8102e',weight:3},trunk:{color:'#e57200',weight:2.4},trunk_link:{color:'#e57200',weight:1.5},
  primary:{color:'#d97706',weight:2},primary_link:{color:'#d97706',weight:1.3},
  secondary:{color:'#5b6b82',weight:1.5},secondary_link:{color:'#5b6b82',weight:1},
  tertiary:{color:'#8a96a8',weight:1.1}}[h]||{color:'#b6bdc8',weight:.6});

function loadGeo(url,key,opts){return fetch(url).then(r=>r.json()).then(g=>{
  L_[key]=L.geoJSON(g,opts); if(opts.on!==false)L_[key].addTo(map); return g;});}

loadGeo('/data/laguaira/state.geojson','state',{
  style:{color:'#00173a',weight:2.5,dashArray:'6 5',fill:false},
  onEachFeature:(f,l)=>l.bindPopup('<b>Estado La Guaira</b>')
}).then(g=>{try{map.fitBounds(L_.state.getBounds(),{padding:[20,20]});}catch(e){}});

const pc=['#7a94ca','#0369a1','#16a34a','#d97706','#c8102e','#9333ea','#0891b2','#65a30d','#db2777','#15803d','#44474f'];let pi=0;
loadGeo('/data/laguaira/parroquias.geojson','parr',{
  style:()=>({color:'#00173a',weight:1.1,fillColor:pc[(pi++)%pc.length],fillOpacity:.14}),
  onEachFeature:(f,l)=>l.bindPopup('<b>'+(f.properties.name||'Parroquia')+'</b><br>Parroquia · estado La Guaira')
});
loadGeo('/data/laguaira/roads-major.geojson','roads',{
  style:f=>roadStyle(f.properties.highway),
  onEachFeature:(f,l)=>{const p=f.properties;if(p.name||p.ref)l.bindPopup('<b>'+(p.name||'(sin nombre)')+'</b><br>'+(p.highway||'')+(p.ref?' · '+p.ref:''));}
});
loadGeo('/data/laguaira/roads.geojson','roadsall',{on:false,
  style:f=>roadStyle(f.properties.highway)});
loadGeo('/data/laguaira/places.geojson','places',{
  pointToLayer:(f,ll)=>{const t=f.properties.place;const r=t==='city'?7:t==='town'?5:3;
    return L.circleMarker(ll,{radius:r,color:'#fff',weight:1,fillColor:'#0369a1',fillOpacity:.9});},
  onEachFeature:(f,l)=>{const p=f.properties;l.bindPopup('<b>'+(p.name||'?')+'</b><br>'+p.place+(p.population?' · pob. '+p.population:''));
    if(['city','town'].includes(f.properties.place))l.bindTooltip(f.properties.name,{permanent:true,direction:'top',opacity:.8});}
});

// Live USGS quakes from SISMO911's own feed
const qColor=m=>m>=4.5?'#c8102e':m>=2.5?'#d97706':'#16a34a';
const qR=m=>Math.max(4,Math.min(20,(m||1)*3));
L_.quakes=L.layerGroup().addTo(map);
fetch('/api/events?limit=300').then(r=>r.json()).then(d=>{
  const ev=(d.events||[]).filter(x=>x.lat!=null&&x.lon!=null);
  ev.sort((a,b)=>(a.time_ms||0)-(b.time_ms||0));
  let near=0;
  ev.forEach((q,i)=>{
    const m=q.mag||0, latest=i===ev.length-1;
    const inReg=q.lat>9.8&&q.lat<11.2&&q.lon>-67.6&&q.lon<-65.8; if(inReg)near++;
    const mk=L.circleMarker([q.lat,q.lon],{radius:qR(m),color:'#fff',weight:1,
      fillColor:qColor(m),fillOpacity:.82,className:latest?'pulse':''});
    const when=q.time_ms?new Date(q.time_ms).toLocaleString('es-VE',{dateStyle:'short',timeStyle:'short'}):'';
    mk.bindPopup('<b>M '+m.toFixed(1)+'</b> · '+(q.place_es||q.place||'')+'<br>'+
      'Prof. '+(q.depth_km!=null?q.depth_km+' km':'?')+(q.alert?' · alerta '+q.alert:'')+'<br><span style="color:#5b6b82">'+when+'</span>');
    mk.addTo(L_.quakes);
  });
  const big=ev.reduce((a,b)=>(b.mag||0)>(a.mag||0)?b:a,{mag:0});
  document.getElementById('quakeStat').innerHTML=
    '<b>'+ev.length+'</b> sismos (30 d) · <b>'+near+'</b> en/junto a La Guaira<br>'+
    'mayor: M '+(big.mag||0).toFixed(1)+(big.place_es?' · '+big.place_es:'');
}).catch(()=>{document.getElementById('quakeStat').textContent='No se pudo cargar el feed sísmico.';});

const ids={l_state:'state',l_parr:'parr',l_roads:'roads',l_roadsall:'roadsall',l_places:'places',l_quakes:'quakes'};
Object.keys(ids).forEach(id=>document.getElementById(id).addEventListener('change',e=>{
  const ly=L_[ids[id]];if(!ly)return;e.target.checked?ly.addTo(map):map.removeLayer(ly);}));
</script>
${FOOT}`;
  return c.html(html);
});
