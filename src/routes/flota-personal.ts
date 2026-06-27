import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// FLOTA — personnel/crew CRUD (flota_personal). Responders are assigned to
// units (unidad_id) and missions; `skills` is a JSON string array.
//
// Gating (src/index.ts ADMIN_WRITE_PREFIXES '/api/flota'): all writes here are
// operator-only; all GET reads are public. Mounted at /api/flota/personal.

export const flotaPersonal = new Hono<{ Bindings: Env }>();

const ROLES = ['paramedico', 'rescatista', 'conductor', 'coordinador', 'voluntario'];
const ESTADOS = ['activo', 'inactivo', 'en_mision'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

// Normalize a skills input (array | comma-string) into a clean string[] for JSON.
function toSkills(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',')
      : [];
  return raw
    .map((s) => String(s).trim().slice(0, 60))
    .filter((s) => s.length > 0)
    .slice(0, 40);
}

// Parse a stored skills JSON column back into an array (guarded).
function parseSkills(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

// ── List ──────────────────────────────────────────────────────────────────────
flotaPersonal.get('/', async (c) => {
  const rol = c.req.query('rol');
  const unidad_id = c.req.query('unidad_id');
  const estado = c.req.query('estado');
  const where: string[] = [];
  const vals: unknown[] = [];
  if (rol && ROLES.includes(rol)) { where.push('rol = ?'); vals.push(rol); }
  if (unidad_id) { where.push('unidad_id = ?'); vals.push(unidad_id); }
  if (estado && ESTADOS.includes(estado)) { where.push('estado = ?'); vals.push(estado); }
  const sql =
    `SELECT id, nombre, rol, telefono, email, unidad_id, estado, skills, created_ms, updated_ms
     FROM flota_personal${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY nombre LIMIT 1000`;
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  const out = (results ?? []).map((r) => ({ ...r, skills: parseSkills((r as { skills?: unknown }).skills) }));
  return c.json({ results: out });
});

// ── Create ────────────────────────────────────────────────────────────────────
flotaPersonal.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 160);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const rol = str(b?.rol, 20) ?? 'rescatista';
  if (!ROLES.includes(rol)) return c.json({ error: 'rol inválido' }, 400);
  const estado = str(b?.estado, 20) ?? 'activo';
  if (!ESTADOS.includes(estado)) return c.json({ error: 'estado inválido' }, 400);
  const now = Date.now();
  const id = uid('per');
  const skills = toSkills(b?.skills);
  await c.env.DB.prepare(
    `INSERT INTO flota_personal (id, nombre, rol, telefono, email, unidad_id, estado, skills, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, nombre, rol, str(b?.telefono, 40), str(b?.email, 160),
    str(b?.unidad_id, 120), estado, JSON.stringify(skills), now, now
  ).run();
  return c.json({ ok: true, id, nombre, rol, estado, skills }, 201);
});

// ── Read one ──────────────────────────────────────────────────────────────────
flotaPersonal.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, nombre, rol, telefono, email, unidad_id, estado, skills, created_ms, updated_ms
     FROM flota_personal WHERE id = ?`
  ).bind(id).first();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ...row, skills: parseSkills((row as { skills?: unknown }).skills) });
});

// ── Update ────────────────────────────────────────────────────────────────────
flotaPersonal.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b?.nombre != null) {
    const nombre = str(b.nombre, 160);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.rol != null) {
    const rol = str(b.rol, 20);
    if (!rol || !ROLES.includes(rol)) return c.json({ error: 'rol inválido' }, 400);
    sets.push('rol = ?'); vals.push(rol);
  }
  if (b?.estado != null) {
    const estado = str(b.estado, 20);
    if (!estado || !ESTADOS.includes(estado)) return c.json({ error: 'estado inválido' }, 400);
    sets.push('estado = ?'); vals.push(estado);
  }
  if (b?.telefono !== undefined) { sets.push('telefono = ?'); vals.push(str(b.telefono, 40)); }
  if (b?.email !== undefined) { sets.push('email = ?'); vals.push(str(b.email, 160)); }
  if (b?.unidad_id !== undefined) { sets.push('unidad_id = ?'); vals.push(str(b.unidad_id, 120)); }
  if (b?.skills !== undefined) { sets.push('skills = ?'); vals.push(JSON.stringify(toSkills(b.skills))); }
  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE flota_personal SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});

// ── Delete ────────────────────────────────────────────────────────────────────
flotaPersonal.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const r = await c.env.DB.prepare(`DELETE FROM flota_personal WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});
