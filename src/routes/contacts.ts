import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

export const contacts = new Hono<{ Bindings: Env }>();

// GET /api/contacts?category=civil_protection&region=Falcón
contacts.get('/', async (c) => {
  const cat = c.req.query('category');
  const region = c.req.query('region');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (cat) { where.push('category = ?'); binds.push(cat); }
  if (region) { where.push('region = ?'); binds.push(region); }
  const sql = `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_hotline DESC, agency ASC`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ contacts: results ?? [] });
});

// POST /api/contacts — add/curate a directory entry (admin).
contacts.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.agency || !b?.category) return c.json({ error: 'agency_and_category_required' }, 400);
  const id = b.id ?? uid('con');
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO contacts (id, agency, category, region, phone, alt_phone, radio, email, lat, lon, is_hotline, source, verified_ms, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, b.agency, b.category, b.region ?? null, b.phone ?? null, b.alt_phone ?? null,
    b.radio ?? null, b.email ?? null, b.lat ?? null, b.lon ?? null,
    b.is_hotline ? 1 : 0, b.source ?? 'manual', b.verified ? Date.now() : null, Date.now()
  ).run();
  return c.json({ ok: true, id }, 201);
});
