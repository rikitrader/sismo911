import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Cuentas GL y presupuesto. Table: sum_cuentas.
// Mounted at /api/suministros/cuentas. Writes gated centrally; GET public.

export const sumCuentas = new Hono<{ Bindings: Env }>();

const TIPOS = ['gasto', 'activo', 'pasivo', 'ingreso', 'presupuesto'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

// GET / → list; ?tipo= ?activa=
sumCuentas.get('/', async (c) => {
  const tipo   = c.req.query('tipo');
  const activa = c.req.query('activa');
  const where: string[] = [];
  const vals: unknown[] = [];
  if (tipo && TIPOS.includes(tipo)) { where.push('tipo = ?'); vals.push(tipo); }
  if (activa === '0' || activa === '1') { where.push('activa = ?'); vals.push(Number(activa)); }
  const sql = `SELECT * FROM sum_cuentas${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY codigo`;
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// POST / → create (codigo + nombre required; tipo validated against enum).
sumCuentas.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const codigo = str(b?.codigo, 40);
  if (!codigo) return c.json({ error: 'codigo requerido' }, 400);
  const nombre = str(b?.nombre, 200);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const tipo = str(b?.tipo, 20) ?? 'gasto';
  if (!TIPOS.includes(tipo)) return c.json({ error: 'tipo inválido' }, 400);

  const id = uid('gl');
  await c.env.DB.prepare(
    `INSERT INTO sum_cuentas (id, codigo, nombre, tipo, descripcion, activa, created_ms)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, nombre, tipo,
    str(b?.descripcion, 400),
    b?.activa === false ? 0 : 1,
    Date.now()
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM sum_cuentas WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// PATCH /:id → update mutable fields.
sumCuentas.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.codigo != null) { sets.push('codigo = ?'); vals.push(str(b.codigo, 40)); }
  if (b?.nombre != null) {
    const nombre = str(b.nombre, 200);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.tipo != null) {
    if (!TIPOS.includes(b.tipo)) return c.json({ error: 'tipo inválido' }, 400);
    sets.push('tipo = ?'); vals.push(b.tipo);
  }
  if (b?.descripcion !== undefined) { sets.push('descripcion = ?'); vals.push(str(b.descripcion, 400)); }
  if (b?.activa !== undefined) { sets.push('activa = ?'); vals.push(b.activa ? 1 : 0); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_cuentas SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_cuentas WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → block if cuenta is referenced by any factura (409).
sumCuentas.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM sum_cuentas WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'no encontrado' }, 404);
  const ref = await c.env.DB.prepare(`SELECT id FROM sum_facturas WHERE cuenta_id = ? LIMIT 1`).bind(id).first();
  if (ref) return c.json({ error: 'cuenta referenciada por facturas' }, 409);
  await c.env.DB.prepare(`DELETE FROM sum_cuentas WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, id });
});
