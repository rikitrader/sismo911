import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Ubicaciones (stock-holding sites). Table: sum_ubicaciones.
// Mounted at /api/suministros/ubicaciones. Writes gated centrally by index.ts
// ADMIN_WRITE_PREFIXES ('/api/suministros'); GET reads are public.

export const sumUbicaciones = new Hono<{ Bindings: Env }>();

const TIPOS = ['deposito', 'refugio', 'almacen', 'hospital', 'punto_distribucion', 'proveedor'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const bool = (v: unknown, dflt: number) => (v == null ? dflt : v ? 1 : 0);

// GET / → list; optional ?tipo= ?estado_region= ?activa= filters; ?limit (default 300).
sumUbicaciones.get('/', async (c) => {
  const tipo = c.req.query('tipo');
  const estado = c.req.query('estado_region');
  const activa = c.req.query('activa');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 300;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (tipo && TIPOS.includes(tipo)) { where.push('tipo = ?'); vals.push(tipo); }
  if (estado) { where.push('estado_region = ?'); vals.push(estado); }
  if (activa === '0' || activa === '1') { where.push('activa = ?'); vals.push(Number(activa)); }
  const sql = `SELECT * FROM sum_ubicaciones${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY nombre LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// POST / → create.
sumUbicaciones.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 160);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  let tipo = str(b?.tipo, 40) ?? 'deposito';
  if (!TIPOS.includes(tipo)) return c.json({ error: 'tipo inválido' }, 400);

  const id = uid('ubi');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sum_ubicaciones
       (id, nombre, tipo, codigo, estado_region, direccion, lat, lon, responsable, telefono, activa, notas, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, nombre, tipo, str(b?.codigo, 40), str(b?.estado_region, 80), str(b?.direccion, 400),
    num(b?.lat), num(b?.lon), str(b?.responsable, 160), str(b?.telefono, 40),
    bool(b?.activa, 1), str(b?.notas, 1000), now, now
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM sum_ubicaciones WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// GET /:id → one or 404.
sumUbicaciones.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM sum_ubicaciones WHERE id = ?`).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  return c.json(row);
});

// PATCH /:id → update mutable fields.
sumUbicaciones.patch('/:id', async (c) => {
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
  if (b?.codigo !== undefined) { sets.push('codigo = ?'); vals.push(str(b.codigo, 40)); }
  if (b?.estado_region !== undefined) { sets.push('estado_region = ?'); vals.push(str(b.estado_region, 80)); }
  if (b?.direccion !== undefined) { sets.push('direccion = ?'); vals.push(str(b.direccion, 400)); }
  if (b?.lat !== undefined) { sets.push('lat = ?'); vals.push(num(b.lat)); }
  if (b?.lon !== undefined) { sets.push('lon = ?'); vals.push(num(b.lon)); }
  if (b?.responsable !== undefined) { sets.push('responsable = ?'); vals.push(str(b.responsable, 160)); }
  if (b?.telefono !== undefined) { sets.push('telefono = ?'); vals.push(str(b.telefono, 40)); }
  if (b?.activa !== undefined) { sets.push('activa = ?'); vals.push(b.activa ? 1 : 0); }
  if (b?.notas !== undefined) { sets.push('notas = ?'); vals.push(str(b.notas, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_ubicaciones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_ubicaciones WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → blocked if it still holds stock.
sumUbicaciones.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const stock = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sum_existencias WHERE ubicacion_id = ? AND cantidad <> 0`
  ).bind(id).first<{ n: number }>();
  if ((stock?.n ?? 0) > 0) return c.json({ error: 'la ubicación tiene existencias; trasládalas o ajústalas primero' }, 409);
  const r = await c.env.DB.prepare(`DELETE FROM sum_ubicaciones WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});
