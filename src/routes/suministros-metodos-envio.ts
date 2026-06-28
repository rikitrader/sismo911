import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Métodos de Envío (carrier/mode catalogue).
// Mounted at /api/suministros/metodos-envio. Writes gated centrally; GET public.

export const sumMetodosEnvio = new Hono<{ Bindings: Env }>();

const MODOS = ['terrestre', 'aereo', 'maritimo', 'fluvial', 'courier'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

// ── GET / — list métodos de envío ─────────────────────────────────────────────
sumMetodosEnvio.get('/', async (c) => {
  const modo   = c.req.query('modo');
  const activo = c.req.query('activo');

  const where: string[] = [];
  const vals: unknown[] = [];
  if (modo && MODOS.includes(modo)) { where.push('modo = ?');   vals.push(modo); }
  if (activo != null)               { where.push('activo = ?'); vals.push(activo === '0' ? 0 : 1); }

  const sql = `SELECT * FROM sum_metodos_envio
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY nombre`;
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST / — create método de envío ──────────────────────────────────────────
sumMetodosEnvio.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 160);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const modo = str(b?.modo, 20) ?? 'terrestre';
  if (!MODOS.includes(modo)) return c.json({ error: `modo inválido; opciones: ${MODOS.join(', ')}` }, 400);
  const now = Date.now();
  const id  = uid('sm');
  await c.env.DB.prepare(
    `INSERT INTO sum_metodos_envio (id, nombre, transportista, modo, activo, created_ms)
     VALUES (?,?,?,?,?,?)`
  ).bind(id, nombre, str(b?.transportista, 160), modo, 1, now).run();
  const row = await c.env.DB.prepare(`SELECT * FROM sum_metodos_envio WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// ── PATCH /:id — update fields ────────────────────────────────────────────────
sumMetodosEnvio.patch('/:id', async (c) => {
  const id  = c.req.param('id');
  const b   = await c.req.json().catch(() => null);
  const row = await c.env.DB.prepare(`SELECT id FROM sum_metodos_envio WHERE id = ?`).bind(id).first();
  if (!row) return c.json({ error: 'no encontrado' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b?.nombre !== undefined) {
    const n = str(b.nombre, 160);
    if (!n) return c.json({ error: 'nombre no puede estar vacío' }, 400);
    sets.push('nombre = ?'); vals.push(n);
  }
  if (b?.transportista !== undefined) { sets.push('transportista = ?'); vals.push(str(b.transportista, 160)); }
  if (b?.modo !== undefined) {
    const m = str(b.modo, 20);
    if (!m || !MODOS.includes(m)) return c.json({ error: `modo inválido; opciones: ${MODOS.join(', ')}` }, 400);
    sets.push('modo = ?'); vals.push(m);
  }
  if (b?.activo !== undefined) { sets.push('activo = ?'); vals.push(b.activo ? 1 : 0); }
  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);

  vals.push(id);
  await c.env.DB.prepare(`UPDATE sum_metodos_envio SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return c.json(await c.env.DB.prepare(`SELECT * FROM sum_metodos_envio WHERE id = ?`).bind(id).first());
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
sumMetodosEnvio.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const r  = await c.env.DB.prepare(`DELETE FROM sum_metodos_envio WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});
