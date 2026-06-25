import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// Citizen-facing operational endpoints. SOS + check-ins are intentionally PUBLIC
// (emergencies can't require login). Admin curation/triage is gated separately.
export const ops = new Hono<{ Bindings: Env }>();

// ---- Family safety check-ins ----
ops.get('/checkins', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM checkins ORDER BY created_ms DESC LIMIT 200`
  ).all();
  return c.json({ checkins: results ?? [] });
});
ops.post('/checkins', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.name) return c.json({ error: 'name_required' }, 400);
  const id = uid('chk');
  await c.env.DB.prepare(
    `INSERT INTO checkins (id,name,status,message,lat,lon,event_id,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, b.name, b.status ?? 'safe', b.message ?? null, b.lat ?? null, b.lon ?? null, b.event_id ?? null, Date.now()).run();
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
  const id = b.id ?? uid('res');
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO resources (id,kind,label,quantity,status,region,lat,lon,updated_ms) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, b.kind, b.label, b.quantity ?? null, b.status ?? 'available', b.region ?? null, b.lat ?? null, b.lon ?? null, Date.now()).run();
  return c.json({ ok: true, id }, 201);
});

// ---- Emergency SOS ----
ops.get('/sos', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM sos_alerts WHERE status != 'resolved' ORDER BY created_ms DESC LIMIT 200`
  ).all();
  return c.json({ sos: results ?? [] });
});
ops.post('/sos', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (b?.lat == null || b?.lon == null) return c.json({ error: 'lat_lon_required' }, 400);
  const id = uid('sos'); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sos_alerts (id,lat,lon,name,phone,note,status,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, b.lat, b.lon, b.name ?? null, b.phone ?? null, b.note ?? null, 'active', now, now).run();
  return c.json({ ok: true, id }, 201);
});
ops.patch('/sos/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(`UPDATE sos_alerts SET status = ?, updated_ms = ? WHERE id = ?`)
    .bind(b.status ?? 'acknowledged', Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});
