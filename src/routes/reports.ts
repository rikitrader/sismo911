import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// Citizen damage-report map (the "movement" core). PUBLIC reads of APPROVED
// reports; PUBLIC submission enters a moderation queue (status='pending').
// Moderation (PATCH/DELETE) is gated by the Access middleware in index.ts.
export const reports = new Hono<{ Bindings: Env }>();

const CATEGORIES = new Set([
  'damaged_building', 'collapsed_building', 'trapped_people', 'gas_leak',
  'aid_point', 'medical_need', 'water_point', 'shelter', 'other',
]);
const SEVERITIES = new Set(['rojo', 'naranja', 'amarillo']);

// Round published coords to ~100 m so exact home/location is never exposed.
const blur = (n: any) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);

// GET /api/reports?status=approved&category=&severity=&since=&limit=
reports.get('/', async (c) => {
  const status = c.req.query('status') ?? 'approved';
  const category = c.req.query('category');
  const severity = c.req.query('severity');
  const since = Number(c.req.query('since') ?? 0);
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000);
  const where: string[] = ['status = ?']; const args: any[] = [status];
  if (category) { where.push('category = ?'); args.push(category); }
  if (severity) { where.push('severity = ?'); args.push(severity); }
  if (since) { where.push('created_ms > ?'); args.push(since); }
  const { results } = await c.env.DB.prepare(
    `SELECT id, category, severity, verification, title, description, lat, lon,
            estado, municipio, parroquia, building_type, people_trapped,
            source, source_url, image_key, reactions_up, created_ms
     FROM map_reports WHERE ${where.join(' AND ')} ORDER BY created_ms DESC LIMIT ?`
  ).bind(...args, limit).all();
  return c.json(results ?? []);
});

// GET /api/reports/stats — live counters for the dashboard/movement banner.
reports.get('/stats', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN severity='rojo' THEN 1 ELSE 0 END) AS critical,
       SUM(CASE WHEN category IN ('aid_point','water_point','shelter','medical_need') THEN 1 ELSE 0 END) AS resources,
       SUM(CASE WHEN category='trapped_people' THEN 1 ELSE 0 END) AS trapped
     FROM map_reports WHERE status='approved'`
  ).first();
  const pending: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM map_reports WHERE status='pending'`
  ).first();
  return c.json({
    total: row?.total ?? 0, critical: row?.critical ?? 0,
    resources: row?.resources ?? 0, trapped: row?.trapped ?? 0,
    pending: pending?.n ?? 0,
  });
});

// POST /api/reports — citizen submission → moderation queue.
reports.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.category || !CATEGORIES.has(b.category)) return c.json({ error: 'categoría inválida' }, 400);
  if (!b?.title && !b?.description) return c.json({ error: 'título o descripción requerido' }, 400);
  if (b.severity && !SEVERITIES.has(b.severity)) return c.json({ error: 'severidad inválida' }, 400);
  const now = Date.now();
  const id = uid('rep');
  await c.env.DB.prepare(
    `INSERT INTO map_reports
      (id, category, severity, status, verification, title, description, lat, lon,
       estado, municipio, parroquia, building_type, people_trapped, source, reporter, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, b.category, b.severity ?? null, 'pending', 'unverified',
    (b.title ?? '').slice(0, 140) || null, (b.description ?? '').slice(0, 2000) || null,
    blur(b.lat), blur(b.lon), b.estado ?? null, b.municipio ?? null, b.parroquia ?? null,
    b.building_type ?? null, b.people_trapped ?? null, 'citizen', b.reporter ?? null, now, now
  ).run();
  return c.json({ ok: true, id, status: 'pending', message: 'Recibido. Aparecerá tras revisión.' }, 201);
});

// POST /api/reports/:id/react — bump support counter (no auth).
reports.post('/:id/react', async (c) => {
  const r = await c.env.DB.prepare(
    `UPDATE map_reports SET reactions_up = reactions_up + 1 WHERE id = ? AND status='approved'`
  ).bind(c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});

// GET /api/reports/:id/comments
reports.get('/:id/comments', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, body, created_ms FROM report_comments WHERE report_id = ? ORDER BY created_ms ASC LIMIT 200`
  ).bind(c.req.param('id')).all();
  return c.json(results ?? []);
});

// POST /api/reports/:id/comments
reports.post('/:id/comments', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.body) return c.json({ error: 'comentario vacío' }, 400);
  const id = uid('cmt');
  await c.env.DB.prepare(
    `INSERT INTO report_comments (id, report_id, name, body, created_ms) VALUES (?,?,?,?,?)`
  ).bind(id, c.req.param('id'), (b.name ?? 'Anónimo').slice(0, 60), b.body.slice(0, 1000), Date.now()).run();
  return c.json({ ok: true, id }, 201);
});

// --- Moderation (gated) ---
// GET /api/reports/queue — pending submissions for review.
reports.get('/queue', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM map_reports WHERE status='pending' ORDER BY created_ms ASC LIMIT 300`
  ).all();
  return c.json(results ?? []);
});

// PATCH /api/reports/:id — approve / reject / verify.
reports.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const sets: string[] = ['updated_ms = ?']; const args: any[] = [Date.now()];
  if (b.status) { sets.push('status = ?'); args.push(b.status); }
  if (b.verification) { sets.push('verification = ?'); args.push(b.verification); }
  if (b.severity) { sets.push('severity = ?'); args.push(b.severity); }
  const r = await c.env.DB.prepare(
    `UPDATE map_reports SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...args, c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});

// DELETE /api/reports/:id — remove (gated).
reports.delete('/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM map_reports WHERE id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
