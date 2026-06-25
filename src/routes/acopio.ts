import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon } from '../lib/security';
import { audit } from '../lib/audit';

export const acopio = new Hono<{ Bindings: Env }>();

const VALID = new Set(['operativo', 'saturado', 'cerrado']);
const TIPOS = new Set([
  'centro_acopio', 'universidad', 'estadio', 'polideportivo',
  'hospital', 'proteccion_civil', 'bomberos', 'otro',
]);
const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

// Public: current operator-set status overrides for every center.
// Centers without a row default to "operativo" on the client.
acopio.get('/status', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, status, note, updated_ms FROM acopio_status`
  ).all();
  const status: Record<string, { status: string; note: string | null; updated_ms: number }> = {};
  for (const r of results ?? []) {
    status[(r as any).id] = {
      status: (r as any).status,
      note: (r as any).note,
      updated_ms: (r as any).updated_ms,
    };
  }
  return c.json({ status });
});

// Operator/admin only (gated in index.ts): set a center's live status.
acopio.patch('/status/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 120) return c.json({ error: 'bad_id' }, 400);
  const b = await c.req.json().catch(() => null);
  if (!b?.status || !VALID.has(b.status)) return c.json({ error: 'bad_status' }, 400);
  const note = b.note != null ? String(b.note).slice(0, 300) : null;
  await c.env.DB.prepare(
    `INSERT INTO acopio_status (id, status, note, updated_ms) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, note=excluded.note, updated_ms=excluded.updated_ms`
  ).bind(id, b.status, note, Date.now()).run();
  await audit(c, 'acopio.status', { id, status: b.status });
  return c.json({ ok: true, id, status: b.status, note, updated_ms: Date.now() });
});

// Public: approved citizen-proposed centers, merged onto the /acopio map.
// Contacto is operator-only and is NOT returned here.
acopio.get('/centers', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, tipo, estado, ciudad, dir, lat, lon, note, created_ms
     FROM acopio_submissions WHERE status='approved' ORDER BY created_ms DESC LIMIT 1000`
  ).all();
  return c.json({ centers: results ?? [] });
});

// Public: a citizen reports / proposes a new centro de acopio.
// Enters the moderation queue (status='pending'); operators approve in /admin.
// (Exempted from the operator-write gate for /api/acopio in index.ts.)
acopio.post('/report', async (c) => {
  const limited = await rateLimit(c.env, c, 'acopio_report', 10, 600);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 160);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  let tipo = str(b?.tipo, 40) ?? 'centro_acopio';
  if (!TIPOS.has(tipo)) tipo = 'otro';
  const lat = b?.lat == null ? null : Number(b.lat);
  const lon = b?.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const now = Date.now();
  const id = uid('acs');
  await c.env.DB.prepare(
    `INSERT INTO acopio_submissions
      (id, nombre, tipo, estado, ciudad, dir, lat, lon, contacto, reporter, note, status, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, nombre, tipo, str(b?.estado, 60), str(b?.ciudad, 80), str(b?.dir, 240),
    lat, lon, str(b?.contacto, 120), str(b?.reporter, 120), str(b?.note, 600),
    'pending', now, now
  ).run();
  return c.json({ ok: true, id, status: 'pending', message: 'Recibido. Aparecerá en el mapa tras revisión.' }, 201);
});

// Operator/admin only (GET gated in index.ts; PATCH gated by /api/acopio write rule).
// Review queue of citizen submissions. ?status=pending|approved|rejected (default pending).
acopio.get('/submissions', async (c) => {
  const status = c.req.query('status') || 'pending';
  if (!['pending', 'approved', 'rejected'].includes(status)) return c.json({ error: 'bad_status' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, tipo, estado, ciudad, dir, lat, lon, contacto, reporter, note, status, created_ms
     FROM acopio_submissions WHERE status = ? ORDER BY created_ms DESC LIMIT 500`
  ).bind(status).all();
  return c.json({ submissions: results ?? [] });
});

// Operator/admin only: approve or reject a submission.
acopio.patch('/submissions/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  if (!b?.status || !['approved', 'rejected'].includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  const r = await c.env.DB.prepare(
    `UPDATE acopio_submissions SET status = ?, updated_ms = ? WHERE id = ?`
  ).bind(b.status, Date.now(), id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  await audit(c, 'acopio.submission.moderate', { id, status: b.status });
  return c.json({ ok: true, id, status: b.status });
});
