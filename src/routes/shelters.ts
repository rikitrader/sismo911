import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { burstLimit, validLatLon, blurCoord } from '../lib/security';

// Crowd-sourced shelter status (/api/shelters). Anyone can report a shelter's
// operational state; submissions enter moderation and only approved ones are
// shown publicly + on the map. Operator-only: /queue (gated in index.ts) and
// /:id/approve (gated by the global `endsWith('/approve')` rule).
export const shelters = new Hono<{ Bindings: Env }>();

const STATUS = new Set(['activo', 'lleno', 'cerrado']);

// GET /api/shelters — approved shelter statuses (public, for the map).
shelters.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, lat, lon, status, capacity_note, updated_ms
     FROM shelter_status WHERE moderation='approved' ORDER BY updated_ms DESC LIMIT 500`
  ).all();
  return c.json({ shelters: results ?? [] });
});

// POST /api/shelters/status — crowd submission → moderation queue (no login).
shelters.post('/status', async (c) => {
  const burst = await burstLimit(c.env, c, 'shelter_status');
  if (burst) return burst;
  const b = await c.req.json().catch(() => null);
  const name = (b?.name ?? '').toString().trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (!b?.status || !STATUS.has(b.status)) return c.json({ error: 'status_invalid', allowed: [...STATUS] }, 400);
  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const id = uid('shl'); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO shelter_status (id, name, lat, lon, status, capacity_note, moderation, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?, 'pending', ?, ?)`
  ).bind(
    id, name.slice(0, 140), blurCoord(lat, 3), blurCoord(lon, 3), b.status,
    b.capacity_note ? String(b.capacity_note).slice(0, 200) : null, now, now
  ).run();
  return c.json({ ok: true, id, status: 'pending', message: 'Recibido. Aparecerá tras revisión.' }, 201);
});

// GET /api/shelters/queue — pending submissions (operator-only, gated in index.ts).
shelters.get('/queue', async (c) => {
  c.header('Cache-Control', 'no-store');
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, lat, lon, status, capacity_note, created_ms FROM shelter_status
     WHERE moderation='pending' ORDER BY created_ms ASC LIMIT 300`
  ).all();
  return c.json({ shelters: results ?? [] });
});

// POST /api/shelters/:id/approve — publish a pending status (operator-only).
shelters.post('/:id/approve', async (c) => {
  const r = await c.env.DB.prepare(
    `UPDATE shelter_status SET moderation='approved', updated_ms=? WHERE id=? AND moderation='pending'`
  ).bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true, approved: r.meta.changes });
});
