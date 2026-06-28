import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// FLOTA module — fleets (flotas): named groupings of response units. A fleet is
// a label over a set of flota_unidades, tracked via the flota_flota_unidades
// membership table. Mounted at /api/flota/flotas.
//
// Gating: the whole /api/flota surface is operator/admin-only (src/index.ts
// isFlotaApi) — including GET reads. Single-tenant national app — no org
// scoping.

export const flotaFlotas = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

// ── List fleets (with member-unit counts) ────────────────────────────────────
flotaFlotas.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.nombre, f.organizacion, f.estado_region, f.descripcion, f.created_ms,
            (SELECT COUNT(*) FROM flota_flota_unidades m WHERE m.flota_id = f.id) AS unidades_count
       FROM flota_flotas f
      ORDER BY f.created_ms DESC
      LIMIT 1000`
  ).all();
  return c.json({ results: results ?? [] });
});

// ── Create a fleet ───────────────────────────────────────────────────────────
flotaFlotas.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 160);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const id = uid('flt');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO flota_flotas (id, nombre, organizacion, estado_region, descripcion, created_ms)
     VALUES (?,?,?,?,?,?)`
  ).bind(id, nombre, str(b?.organizacion, 160), str(b?.estado_region, 120), str(b?.descripcion, 1000), now).run();
  return c.json({ ok: true, id, nombre }, 201);
});

// ── Fleet detail + member units ──────────────────────────────────────────────
flotaFlotas.get('/:id', async (c) => {
  const id = c.req.param('id');
  const fleet = await c.env.DB.prepare(
    `SELECT id, nombre, organizacion, estado_region, descripcion, created_ms FROM flota_flotas WHERE id = ?`
  ).bind(id).first();
  if (!fleet) return c.json({ error: 'no encontrado' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.nombre, u.tipo, u.estado_op
       FROM flota_flota_unidades m
       JOIN flota_unidades u ON u.id = m.unidad_id
      WHERE m.flota_id = ?
      ORDER BY u.nombre`
  ).bind(id).all();
  return c.json({ ...fleet, unidades: results ?? [] });
});

// ── Update a fleet ───────────────────────────────────────────────────────────
flotaFlotas.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [], vals: unknown[] = [];
  if (b?.nombre != null) {
    const nombre = str(b.nombre, 160);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.organizacion !== undefined) { sets.push('organizacion = ?'); vals.push(str(b.organizacion, 160)); }
  if (b?.estado_region !== undefined) { sets.push('estado_region = ?'); vals.push(str(b.estado_region, 120)); }
  if (b?.descripcion !== undefined) { sets.push('descripcion = ?'); vals.push(str(b.descripcion, 1000)); }
  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE flota_flotas SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});

// ── Delete a fleet (+ its membership rows) ───────────────────────────────────
flotaFlotas.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM flota_flotas WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'no encontrado' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM flota_flota_unidades WHERE flota_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM flota_flotas WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});

// ── Add a unit to the fleet ──────────────────────────────────────────────────
flotaFlotas.post('/:id/unidades', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const unidad_id = str(b?.unidad_id, 120);
  if (!unidad_id) return c.json({ error: 'unidad_id requerido' }, 400);
  const fleet = await c.env.DB.prepare(`SELECT id FROM flota_flotas WHERE id = ?`).bind(id).first();
  if (!fleet) return c.json({ error: 'flota no encontrada' }, 404);
  const unit = await c.env.DB.prepare(`SELECT id FROM flota_unidades WHERE id = ?`).bind(unidad_id).first();
  if (!unit) return c.json({ error: 'unidad no encontrada' }, 404);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO flota_flota_unidades (flota_id, unidad_id) VALUES (?,?)`
  ).bind(id, unidad_id).run();
  return c.json({ ok: true, flota_id: id, unidad_id });
});

// ── Remove a unit from the fleet ─────────────────────────────────────────────
flotaFlotas.delete('/:id/unidades/:unidadId', async (c) => {
  const id = c.req.param('id');
  const unidadId = c.req.param('unidadId');
  const r = await c.env.DB.prepare(
    `DELETE FROM flota_flota_unidades WHERE flota_id = ? AND unidad_id = ?`
  ).bind(id, unidadId).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, flota_id: id, unidad_id: unidadId });
});
