import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// FLOTA — response-units (vehicles) CRUD. Table: flota_unidades.
// Mounted at /api/flota/unidades. Writes are gated centrally by
// index.ts ADMIN_WRITE_PREFIXES ('/api/flota'); GET reads are public.

export const flotaUnidades = new Hono<{ Bindings: Env }>();

const TIPOS = ['ambulancia', 'rescate', 'bomberos', 'carga', 'moto', 'dron', 'otro'];
const ESTADOS_OP = ['disponible', 'en_mision', 'fuera_servicio', 'mantenimiento'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

// GET / → list units; optional ?estado_op= and ?tipo= filters; ?limit (default 200).
flotaUnidades.get('/', async (c) => {
  const estado_op = c.req.query('estado_op');
  const tipo = c.req.query('tipo');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado_op && ESTADOS_OP.includes(estado_op)) { where.push('estado_op = ?'); vals.push(estado_op); }
  if (tipo && TIPOS.includes(tipo)) { where.push('tipo = ?'); vals.push(tipo); }
  const sql = `SELECT * FROM flota_unidades${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// POST / → create a unit.
flotaUnidades.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 160);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  let tipo = str(b?.tipo, 40) ?? 'rescate';
  if (!TIPOS.includes(tipo)) return c.json({ error: 'tipo inválido' }, 400);
  let estado_op = str(b?.estado_op, 40) ?? 'disponible';
  if (!ESTADOS_OP.includes(estado_op)) return c.json({ error: 'estado_op inválido' }, 400);

  const id = uid('uni');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO flota_unidades
       (id, tipo, nombre, placa, estado_op, capacidad, organizacion, estado_region, lat, lon, rumbo, ult_pos_ms, notas, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, tipo, nombre, str(b?.placa, 40), estado_op, num(b?.capacidad),
    str(b?.organizacion, 160), str(b?.estado_region, 80),
    num(b?.lat), num(b?.lon), num(b?.rumbo), num(b?.ult_pos_ms),
    str(b?.notas, 1000), now, now
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM flota_unidades WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// GET /:id → one unit or 404.
flotaUnidades.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM flota_unidades WHERE id = ?`).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  return c.json(row);
});

// PATCH /:id → update mutable fields; bump updated_ms; 404 if missing.
flotaUnidades.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.nombre != null) {
    const nombre = str(b.nombre, 160);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.tipo != null) {
    if (!TIPOS.includes(b.tipo)) return c.json({ error: 'tipo inválido' }, 400);
    sets.push('tipo = ?'); vals.push(b.tipo);
  }
  if (b?.estado_op != null) {
    if (!ESTADOS_OP.includes(b.estado_op)) return c.json({ error: 'estado_op inválido' }, 400);
    sets.push('estado_op = ?'); vals.push(b.estado_op);
  }
  if (b?.placa !== undefined) { sets.push('placa = ?'); vals.push(str(b.placa, 40)); }
  if (b?.capacidad !== undefined) { sets.push('capacidad = ?'); vals.push(num(b.capacidad)); }
  if (b?.organizacion !== undefined) { sets.push('organizacion = ?'); vals.push(str(b.organizacion, 160)); }
  if (b?.estado_region !== undefined) { sets.push('estado_region = ?'); vals.push(str(b.estado_region, 80)); }
  if (b?.notas !== undefined) { sets.push('notas = ?'); vals.push(str(b.notas, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE flota_unidades SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM flota_unidades WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → delete; 404 if missing.
flotaUnidades.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const r = await c.env.DB.prepare(`DELETE FROM flota_unidades WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});
