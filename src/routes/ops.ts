import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon, blurCoord } from '../lib/security';
import { audit } from '../lib/audit';
import { syncSosSheet } from '../lib/sheets-sync';

// Citizen-facing operational endpoints. SOS + check-ins are intentionally PUBLIC
// (emergencies can't require login). Admin curation/triage is gated separately.
export const ops = new Hono<{ Bindings: Env }>();

// ---- Family safety check-ins ----
ops.get('/checkins', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id,name,status,message,event_id,created_ms FROM checkins ORDER BY created_ms DESC LIMIT 200`
  ).all();
  return c.json({ checkins: results ?? [] });
});
ops.post('/checkins', async (c) => {
  // Life-safety ("I'm safe") — fail OPEN: count for abuse visibility but never
  // reject. Dropping a real check-in is worse than accepting a few extra.
  await rateLimit(c.env, c, 'checkins_post', 20, 300);
  const b = await c.req.json().catch(() => null);
  if (!b?.name) return c.json({ error: 'name_required' }, 400);
  if (b.status && !['safe', 'need_help', 'unknown'].includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const id = uid('chk');
  await c.env.DB.prepare(
    `INSERT INTO checkins (id,name,status,message,lat,lon,event_id,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, String(b.name).slice(0, 80), b.status ?? 'safe', String(b.message ?? '').slice(0, 500) || null, blurCoord(lat, 2), blurCoord(lon, 2), b.event_id ?? null, Date.now()).run();
  return c.json({ ok: true, id }, 201);
});

// ---- Resource & supply tracking ----
ops.get('/resources', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM resources ORDER BY kind, label`).all();
  return c.json({ resources: results ?? [] });
});
ops.post('/resources', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.kind || !b?.label) return c.json({ error: 'kind_label_required' }, 400);
  if (b.lat != null || b.lon != null) {
    if (!validLatLon(Number(b.lat), Number(b.lon))) return c.json({ error: 'bad_lat_lon' }, 400);
  }
  const id = b.id ?? uid('res');
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO resources (id,kind,label,quantity,status,region,lat,lon,updated_ms) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, b.kind, b.label, b.quantity ?? null, b.status ?? 'available', b.region ?? null, b.lat ?? null, b.lon ?? null, Date.now()).run();
  await audit(c, 'resources.upsert', { id, kind: b.kind, status: b.status ?? 'available' });
  return c.json({ ok: true, id }, 201);
});

// ---- Emergency SOS ----
ops.get('/sos', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM sos_alerts WHERE status != 'resolved' ORDER BY created_ms DESC LIMIT 200`
  ).all();
  // Operator-only PII (names/phones/coords) — never cache in browsers/proxies.
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'Cookie');
  return c.json({ sos: results ?? [] });
});
ops.post('/sos', async (c) => {
  // Life-safety (SOS) — fail OPEN: count for abuse visibility but never reject.
  // A dropped emergency SOS is the worst possible failure mode here.
  await rateLimit(c.env, c, 'sos_post', 10, 300);
  const b = await c.req.json().catch(() => null);
  const lat = Number(b?.lat);
  const lon = Number(b?.lon);
  if (!validLatLon(lat, lon)) return c.json({ error: 'lat_lon_required' }, 400);
  const id = uid('sos'); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sos_alerts (id,lat,lon,name,phone,note,status,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, lat, lon, b.name ? String(b.name).slice(0, 80) : null, b.phone ? String(b.phone).slice(0, 40) : null, b.note ? String(b.note).slice(0, 1000) : null, 'active', now, now).run();
  // Mirror into the Google Sheet immediately (best-effort, never blocks the SOS).
  c.executionCtx.waitUntil(syncSosSheet(c.env).catch((e: any) => console.error('[sos] sheet sync failed:', e?.message ?? e)));
  return c.json({ ok: true, id }, 201);
});
ops.patch('/sos/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!['active', 'acknowledged', 'resolved'].includes(b.status ?? 'acknowledged')) return c.json({ error: 'bad_status' }, 400);
  await c.env.DB.prepare(`UPDATE sos_alerts SET status = ?, updated_ms = ? WHERE id = ?`)
    .bind(b.status ?? 'acknowledged', Date.now(), c.req.param('id')).run();
  await audit(c, 'sos.status_update', { id: c.req.param('id'), status: b.status ?? 'acknowledged' });
  // Reflect the new status (or resolution) in the sheet right away.
  c.executionCtx.waitUntil(syncSosSheet(c.env).catch((e: any) => console.error('[sos] sheet sync failed:', e?.message ?? e)));
  return c.json({ ok: true });
});
