import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon } from '../lib/security';
import { verifyUnitToken, unitTokenFromRequest } from '../lib/flota-token';

// FLOTA — live unit tracking: GPS position ingest + map reads. Mounted at
// /api/flota/rastreo alongside the rest of the FLOTA module.
//
// flota_posiciones is an append-only track; each ingest also denormalizes the
// latest fix onto flota_unidades (lat/lon/rumbo/ult_pos_ms) for cheap map reads.
//
// Real-time: operator consoles subscribe at GET /ws (WebSocket → FlotaTracking
// Durable Object); each ingested fix is also published to that DO for instant
// fan-out. Polling GETs remain as a fallback.
//
// Gating (src/index.ts isFlotaApi): the whole module is operator/admin-only,
// EXCEPT POST /posicion which also accepts a scoped per-unit token (field GPS).

const TRACK_SCOPE = 'global';
const doStub = (env: Env) => env.FLOTA_TRACKING.get(env.FLOTA_TRACKING.idFromName(TRACK_SCOPE));

export const flotaRastreo = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

interface PosBody {
  unidad_id?: unknown;
  lat?: unknown;
  lon?: unknown;
  rumbo?: unknown;
  velocidad?: unknown;
  mision_id?: unknown;
}

// POST /posicion — ingest one GPS fix for a unit.
flotaRastreo.post('/posicion', async (c) => {
  const limited = await rateLimit(c.env, c, 'flota_posicion', 120, 60);
  if (limited) return limited;
  const b = (await c.req.json().catch(() => null)) as PosBody | null;
  // A field-unit token (if present) authoritatively identifies the posting unit —
  // a unit can only report its OWN position. Operator sessions use body.unidad_id.
  const tokenUnidad = (await verifyUnitToken(c.env, unitTokenFromRequest(c.req.raw)).catch(() => null))?.unitId ?? null;
  const unidad_id = tokenUnidad ?? str(b?.unidad_id, 120);
  const lat = num(b?.lat);
  const lon = num(b?.lon);
  if (!unidad_id) return c.json({ error: 'unidad_id requerido' }, 400);
  if (!validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const rumbo = num(b?.rumbo);
  const velocidad = num(b?.velocidad);
  const mision_id = str(b?.mision_id, 120);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO flota_posiciones (id, unidad_id, mision_id, lat, lon, rumbo, velocidad, ts_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(uid('pos'), unidad_id, mision_id, lat, lon, rumbo, velocidad, now),
    c.env.DB.prepare(
      `UPDATE flota_unidades SET lat = ?, lon = ?, rumbo = ?, ult_pos_ms = ?, updated_ms = ? WHERE id = ?`
    ).bind(lat, lon, rumbo, now, now, unidad_id),
  ]);
  // Fan out to live subscribers (best-effort; absent in tests / if DO unbound).
  if (c.env.FLOTA_TRACKING) {
    const pub = doStub(c.env)
      .fetch('https://flota-tracking/publish', {
        method: 'POST',
        body: JSON.stringify({ type: 'posicion', unidad_id, lat, lon, rumbo, mision_id, ts_ms: now }),
      })
      .catch(() => {});
    try { c.executionCtx.waitUntil(pub); } catch { /* no execution ctx (tests) */ }
  }
  return c.json({ ok: true });
});

// GET /ws — operator console subscribes to the live position stream (WebSocket).
flotaRastreo.get('/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.json({ error: 'expected_websocket' }, 426);
  return doStub(c.env).fetch(c.req.raw);
});

// GET /unidades — latest known position of every unit that has one (map markers).
flotaRastreo.get('/unidades', async (c) => {
  const limited = await rateLimit(c.env, c, 'flota_read', 120, 60);
  if (limited) return limited;
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, tipo, estado_op, lat, lon, rumbo, ult_pos_ms
     FROM flota_unidades WHERE lat IS NOT NULL ORDER BY ult_pos_ms DESC LIMIT 1000`
  ).all();
  return c.json({ results: results ?? [] });
});

// GET /unidad/:id/track — recent track points for one unit (polyline trail).
flotaRastreo.get('/unidad/:id/track', async (c) => {
  const limited = await rateLimit(c.env, c, 'flota_read', 120, 60);
  if (limited) return limited;
  const id = c.req.param('id');
  const lim = num(c.req.query('limit'));
  const limit = lim != null && lim > 0 ? Math.min(Math.floor(lim), 1000) : 200;
  const { results } = await c.env.DB.prepare(
    `SELECT lat, lon, rumbo, velocidad, ts_ms
     FROM flota_posiciones WHERE unidad_id = ? ORDER BY ts_ms DESC LIMIT ?`
  ).bind(id, limit).all();
  return c.json({ results: results ?? [] });
});
