import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';

export const aidOrgs = new Hono<{ Bindings: Env }>();

const FIELDS = ['region', 'scope', 'name', 'type', 'web', 'phone', 'email', 'focus', 'sort_order'] as const;

// GET /api/aid-orgs?region=África — public directory of disaster-relief orgs.
aidOrgs.get('/', async (c) => {
  const region = c.req.query('region');
  const where = region ? 'WHERE region = ?' : '';
  const binds = region ? [region] : [];
  const { results } = await c.env.DB.prepare(
    `SELECT id, region, scope, name, type, web, phone, email, focus
     FROM aid_orgs ${where} ORDER BY sort_order ASC, region ASC, name ASC`
  ).bind(...binds).all();
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ orgs: results ?? [] });
});

// POST /api/aid-orgs — create or replace an entry (admin).
aidOrgs.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.name || !b?.region) return c.json({ error: 'name_and_region_required' }, 400);
  const id = b.id ?? uid('aid');
  await c.env.DB.prepare(
    `INSERT INTO aid_orgs (id, region, scope, name, type, web, phone, email, focus, sort_order, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       region=excluded.region, scope=excluded.scope, name=excluded.name, type=excluded.type,
       web=excluded.web, phone=excluded.phone, email=excluded.email, focus=excluded.focus,
       sort_order=excluded.sort_order, updated_ms=excluded.updated_ms`
  ).bind(
    id, b.region, b.scope ?? null, b.name, b.type ?? null, b.web ?? null,
    b.phone ?? null, b.email ?? null, b.focus ?? null,
    Number.isFinite(b.sort_order) ? b.sort_order : 0, Date.now()
  ).run();
  await audit(c, 'aid_orgs.upsert', { id, name: b.name, region: b.region });
  return c.json({ ok: true, id }, 201);
});

// PATCH /api/aid-orgs/:id — partial update (admin).
aidOrgs.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  if (!b) return c.json({ error: 'bad_body' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM aid_orgs WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not_found' }, 404);
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of FIELDS) {
    if (f in b) { sets.push(`${f} = ?`); binds.push(b[f]); }
  }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  binds.push(id);
  await c.env.DB.prepare(`UPDATE aid_orgs SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(c, 'aid_orgs.update', { id, fields: Object.keys(b).filter((k) => (FIELDS as readonly string[]).includes(k)) });
  return c.json({ ok: true, id });
});

// DELETE /api/aid-orgs/:id — remove an entry (admin).
aidOrgs.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM aid_orgs WHERE id = ?').bind(id).run();
  await audit(c, 'aid_orgs.delete', { id });
  return c.json({ ok: true });
});
