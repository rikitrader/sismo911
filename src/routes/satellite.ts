import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { validLatLon, timingSafeEqualStr } from '../lib/security';
import { getUserFromRequest } from '../lib/auth';

// Satellite / GIS damage analysis. Imagery is layered from Google (when a key is
// configured, proxied so the key stays server-side) plus free fallbacks (Esri
// World Imagery, NASA GIBS, Maxar Open Data). An operator picks an area and
// Workers AI vision assesses the overhead chip for earthquake damage.
export const satellite = new Hono<{ Bindings: Env }>();

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const SEVERITIES = ['ninguno', 'leve', 'moderado', 'grave', 'severo'];
const PROMPT = `Eres un analista de Protección Civil evaluando una IMAGEN SATELITAL (vista aérea/cenital) de una zona de Venezuela tras un sismo. Evalúa daños visibles en edificaciones e infraestructura. Responde EN ESPAÑOL en este formato exacto:
SEVERIDAD: <ninguno|leve|moderado|grave|severo>
RESUMEN: <2-3 frases sobre el daño visible desde el aire (techos colapsados, escombros, edificios destruidos, vías bloqueadas, etc.)>
PELIGROS: <lista separada por comas>
ACCIÓN: <recomendación inmediata>
Si la imagen no permite evaluar daño (nubes, baja resolución, sin estructuras), indica SEVERIDAD: indeterminado.`;

function parseAssessment(text: string) {
  const grab = (label: string) => { const m = text.match(new RegExp(label + ':\\s*(.+)', 'i')); return m ? m[1].trim() : ''; };
  let sev = grab('SEVERIDAD').toLowerCase();
  sev = SEVERITIES.find((s) => sev.includes(s)) || 'indeterminado';
  return { severity: sev, summary: grab('RESUMEN'), hazards: grab('PELIGROS').split(',').map((h) => h.trim()).filter(Boolean), action: grab('ACCIÓN') };
}

function readBearer(c: any): string {
  const raw = c.req.header('authorization') || '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// ---- slippy-map tile math ----
const lonToTileX = (lon: number, z: number) => Math.floor((lon + 180) / 360 * 2 ** z);
const latToTileY = (lat: number, z: number) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const tileToLon = (x: number, z: number) => x / 2 ** z * 360 - 180;
const tileToLat = (y: number, z: number) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

const esriTileUrl = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Google Map Tiles API session token (cached ~12 days in KV).
async function googleSession(env: Env): Promise<string | null> {
  const key = (env as any).GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const cached = await env.CACHE.get('google:session');
  if (cached) return cached;
  const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'satellite', language: 'es-VE', region: 'VE' }),
  });
  if (!r.ok) { console.error('[sat] google createSession failed', r.status); return null; }
  const j: any = await r.json();
  if (!j.session) return null;
  await env.CACHE.put('google:session', j.session, { expirationTtl: 60 * 60 * 24 * 12 });
  return j.session;
}

// GET /api/sat/config — which imagery layers are available (public).
satellite.get('/config', async (c) => {
  // google:true only when the key actually creates a Map Tiles session — a key
  // without Map Tiles API enabled (e.g. a Gemini key) would otherwise advertise
  // a layer that 404s. The session is KV-cached, so this is cheap.
  const hasKey = Boolean((c.env as any).GOOGLE_MAPS_API_KEY);
  const google = hasKey ? Boolean(await googleSession(c.env)) : false;
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ google, esri: true, gibs: { date: '2026-06-24' }, maxar: await maxarInfo(c.env) });
});

// GET /api/sat/google/:z/:x/:y — proxy a Google 2D satellite tile (key hidden).
satellite.get('/google/:z/:x/:y', async (c) => {
  const key = (c.env as any).GOOGLE_MAPS_API_KEY;
  if (!key) return c.notFound();
  const session = await googleSession(c.env);
  if (!session) return c.notFound();
  const { z, x, y } = c.req.param();
  const r = await fetch(`https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${session}&key=${key}`);
  if (!r.ok) return c.notFound();
  return new Response(r.body, { headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
});

// Maxar Open Data: find a Venezuela / Yumare event collection if activated.
async function maxarInfo(env: Env): Promise<any> {
  try {
    const cached = await env.CACHE.get('maxar:ve', 'json');
    if (cached) return cached;
    const r = await fetch('https://maxar-opendata.s3.amazonaws.com/events/catalog.json');
    if (!r.ok) return null;
    const j: any = await r.json();
    const links = (j.links || []).filter((l: any) => l.rel === 'child');
    const match = links.find((l: any) => /venezuela|yumare|caribe/i.test(l.href || l.title || ''));
    const info = match ? { event: match.title || match.href, catalog: new URL(match.href, 'https://maxar-opendata.s3.amazonaws.com/events/').href } : null;
    await env.CACHE.put('maxar:ve', JSON.stringify(info), { expirationTtl: 60 * 60 * 6 });
    return info;
  } catch (e: any) { console.error('[sat] maxar', e?.message ?? e); return null; }
}
satellite.get('/maxar', async (c) => c.json({ maxar: await maxarInfo(c.env) }));

// POST /api/sat/pytorch-results — ingest external PyTorch detections.
satellite.post('/pytorch-results', async (c) => {
  const token = (c.env as any).SATELLITE_INGEST_TOKEN;
  if (!token) return c.json({ error: 'ingest_token_not_configured' }, 503);
  if (!timingSafeEqualStr(readBearer(c), token)) return c.json({ error: 'unauthorized' }, 401);

  const b = await c.req.json().catch(() => ({} as any));
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const zoom = Math.min(19, Math.max(15, Number(b.zoom) || 18));
  const severity = SEVERITIES.includes(String(b.severity)) ? String(b.severity) : 'indeterminado';
  const summary = String(b.summary ?? '').slice(0, 2000);
  const hazards = Array.isArray(b.hazards) ? b.hazards.map((h: unknown) => String(h).trim()).filter(Boolean) : [];
  const model = String(b.model ?? 'pytorch:external').slice(0, 200);
  const x = lonToTileX(lon, zoom), y = latToTileY(lat, zoom);
  const id = uid('sat');
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO sat_damage (id, lat, lon, zoom, bbox_n, bbox_s, bbox_e, bbox_w, severity, summary, hazards, imagery_source, imagery_date, event_id, ai_model, analyzed_by, verification, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, lat, lon, zoom, tileToLat(y, zoom), tileToLat(y + 1, zoom), tileToLon(x + 1, zoom), tileToLon(x, zoom),
    severity, summary, JSON.stringify(hazards), 'pytorch', null, null, model, null, 'unverified', Date.now()
  ).run();
  return c.json({ ok: true, id, severity, verification: 'unverified', source: 'pytorch', hazards, summary, model }, 201);
});

// POST /api/sat/analyze — assess an AOI's overhead imagery (operator-gated).
satellite.post('/analyze', async (c) => {
  if (!c.env.AI) return c.json({ error: 'ai_unavailable' }, 503);
  const b = await c.req.json().catch(() => ({} as any));
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const zoom = Math.min(19, Math.max(15, Number(b.zoom) || 18));
  const key = (c.env as any).GOOGLE_MAPS_API_KEY;
  let bytes: Uint8Array | null = null; let source = 'esri';
  try {
    if (key) {
      const r = await fetch(`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${zoom}&size=640x640&maptype=satellite&key=${key}`);
      if (r.ok) { bytes = new Uint8Array(await r.arrayBuffer()); source = 'google'; }
    }
    if (!bytes) {
      const x = lonToTileX(lon, zoom), y = latToTileY(lat, zoom);
      const r = await fetch(esriTileUrl(zoom, x, y));
      if (r.ok) { bytes = new Uint8Array(await r.arrayBuffer()); source = 'esri'; }
    }
  } catch (e: any) { console.error('[sat] fetch chip', e?.message ?? e); }
  if (!bytes || !bytes.length) return c.json({ error: 'imagery_unavailable' }, 502);

  let raw = '';
  try {
    const out: any = await c.env.AI.run(VISION_MODEL, { prompt: PROMPT, image: Array.from(bytes), max_tokens: 320 });
    raw = out.response || out.description || '';
  } catch (e: any) { console.error('[sat] AI', e?.message ?? e); return c.json({ error: 'ai_failed' }, 502); }
  const parsed = parseAssessment(raw);

  const x = lonToTileX(lon, zoom), y = latToTileY(lat, zoom);
  const id = uid('sat'); const me = await getUserFromRequest(c.env, c).catch(() => null);
  await c.env.DB.prepare(
    `INSERT INTO sat_damage (id, lat, lon, zoom, bbox_n, bbox_s, bbox_e, bbox_w, severity, summary, hazards, imagery_source, imagery_date, event_id, ai_model, analyzed_by, verification, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, lat, lon, zoom, tileToLat(y, zoom), tileToLat(y + 1, zoom), tileToLon(x + 1, zoom), tileToLon(x, zoom),
    parsed.severity, raw.slice(0, 2000), JSON.stringify(parsed.hazards), source, null, 'us6000t7zp', VISION_MODEL,
    me?.email ?? me?.id ?? null, 'unverified', Date.now()
  ).run();
  return c.json({ ok: true, id, severity: parsed.severity, summary: parsed.summary, hazards: parsed.hazards, action: parsed.action, source }, 201);
});

// GET /api/sat/damage — public read of assessments for the map overlay.
satellite.get('/damage', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, lat, lon, zoom, severity, summary, hazards, imagery_source, verification, created_ms FROM sat_damage ORDER BY created_ms DESC LIMIT 500`
  ).all();
  return c.json({ assessments: results ?? [] });
});

// PATCH /api/sat/damage/:id — operator verification.
satellite.patch('/damage/:id', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  if (!['unverified', 'verified', 'disputed'].includes(b.verification)) return c.json({ error: 'bad_verification' }, 400);
  const r = await c.env.DB.prepare(`UPDATE sat_damage SET verification = ? WHERE id = ?`).bind(b.verification, c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});
