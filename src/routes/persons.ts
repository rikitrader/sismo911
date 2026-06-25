import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

export const persons = new Hono<{ Bindings: Env }>();

// GET /api/persons/stats — live missing/found counters for the movement banner.
persons.get('/stats', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status IN ('found_safe','found_deceased') THEN 1 ELSE 0 END) AS found,
       COUNT(*) AS total
     FROM persons`
  ).first();
  return c.json({ missing: row?.missing ?? 0, found: row?.found ?? 0, total: row?.total ?? 0 });
});

// GET /api/persons/search?q=  — name / phone lookup.
persons.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ persons: [] });
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, sex, last_seen, status, contact_phone, photo_url, updated_ms
     FROM persons WHERE full_name LIKE ? OR contact_phone LIKE ? ORDER BY updated_ms DESC LIMIT 100`
  ).bind(like, like).all();
  return c.json({ persons: results ?? [] });
});

// GET /api/persons?status=missing
persons.get('/', async (c) => {
  const status = c.req.query('status');
  const q = status
    ? c.env.DB.prepare(`SELECT * FROM persons WHERE status = ? ORDER BY updated_ms DESC LIMIT 500`).bind(status)
    : c.env.DB.prepare(`SELECT * FROM persons ORDER BY updated_ms DESC LIMIT 500`);
  const { results } = await q.all();
  return c.json({ persons: results ?? [] });
});

// POST /api/persons — register a missing person.
persons.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.full_name) return c.json({ error: 'full_name_required' }, 400);
  const now = Date.now();
  const id = uid('per');
  await c.env.DB.prepare(
    `INSERT INTO persons (id, full_name, age, sex, last_seen, last_seen_lat, last_seen_lon, event_id, status, contact_phone, notes, photo_url, reported_by, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, b.full_name, b.age ?? null, b.sex ?? null, b.last_seen ?? null,
    b.last_seen_lat ?? null, b.last_seen_lon ?? null, b.event_id ?? null,
    b.status ?? 'missing', b.contact_phone ?? null, b.notes ?? null,
    b.photo_url ?? null, b.reported_by ?? null, now, now
  ).run();
  return c.json({ ok: true, id }, 201);
});

// PATCH /api/persons/:id — update status (found_safe / found_deceased / ...).
persons.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.status) return c.json({ error: 'status_required' }, 400);
  const r = await c.env.DB.prepare(
    `UPDATE persons SET status = ?, notes = COALESCE(?, notes), updated_ms = ? WHERE id = ?`
  ).bind(b.status, b.notes ?? null, Date.now(), c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});
