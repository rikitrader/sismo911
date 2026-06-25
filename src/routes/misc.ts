import { Hono } from 'hono';
import type { Env } from '../types';
import { uid, getEvent } from '../lib/db';
import { estimatePager } from '../lib/pager';
import { rateLimit, validLatLon } from '../lib/security';

// Heat map, comms directory, web-push, and AI situation reports.
export const misc = new Hono<{ Bindings: Env }>();

// ---- Risk heat map: [lat, lon, intensity] weighted by magnitude ----
misc.get('/heatmap', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT lat, lon, mag FROM events WHERE mag IS NOT NULL ORDER BY time_ms DESC LIMIT 500`
  ).all<any>();
  const points = (results ?? []).map((e) => [e.lat, e.lon, Math.max(0.1, Math.min(1, e.mag / 8))]);
  return c.json({ updated_ms: Date.now(), count: points.length, points });
});

// ---- HAM / emergency comms directory ----
misc.get('/comms', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM comms_channels ORDER BY band, frequency`).all();
  return c.json({ channels: results ?? [] });
});

// ---- Web Push (VAPID) ----
misc.get('/push/vapid', (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? '' }));
misc.post('/push/subscribe', async (c) => {
  const limited = await rateLimit(c.env, c, 'push_subscribe', 10, 300);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const sub = b?.subscription || b;
  if (!sub?.endpoint || !sub?.keys?.p256dh) return c.json({ error: 'invalid_subscription' }, 400);
  if (b?.lat != null || b?.lon != null) {
    if (!validLatLon(Number(b.lat), Number(b.lon))) return c.json({ error: 'bad_lat_lon' }, 400);
  }
  const id = uid('sub');
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO push_subs (id,endpoint,p256dh,auth,min_mag,lat,lon,radius_km,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, b.min_mag ?? 4.0, b.lat ?? null, b.lon ?? null, b.radius_km ?? 300, Date.now()).run();
  return c.json({ ok: true, id }, 201);
});

// ---- AI situation report (Cloudflare Workers AI; falls back to heuristic) ----
misc.get('/sitrep/:id', async (c) => {
  const ev: any = await getEvent(c.env, c.req.param('id'));
  if (!ev) return c.json({ error: 'not_found' }, 404);
  const pager = estimatePager(ev);
  const base = `Sismo M${ev.mag} en ${ev.place}. Nivel ${pager.alert.toUpperCase()}. ${pager.summaryEs}`;
  if (!c.env.AI) return c.json({ provisional: true, ai: false, event: ev.place, pager, report: base + ' (IA no configurada — informe base.)' });
  try {
    const prompt = `Eres un oficial de Protección Civil de Venezuela. Redacta un informe de situación breve (5-7 líneas, en español) para este sismo. Incluye resumen, riesgo para la población y 3 acciones inmediatas.\nMagnitud: ${ev.mag}\nLugar: ${ev.place}\nProfundidad: ${ev.depth_km} km\nNivel de alerta: ${pager.alert}\nMMI estimada: ${pager.maxMMI}`;
    const r: any = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: prompt }] });
    return c.json({ provisional: true, ai: true, event: ev.place, pager, report: r.response ?? r.result?.response ?? base });
  } catch (e: any) {
    return c.json({ provisional: true, ai: false, event: ev.place, pager, report: base, error: String(e?.message ?? e) });
  }
});
