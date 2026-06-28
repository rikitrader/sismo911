import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Categorías de producto. Table: sum_categorias.
// Mounted at /api/suministros/categorias. Writes gated centrally; GET public.

export const sumCategorias = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

// GET / → all categories with their product count.
sumCategorias.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT cat.*, (SELECT COUNT(*) FROM sum_productos p WHERE p.categoria_id = cat.id) AS productos
     FROM sum_categorias cat ORDER BY cat.nombre`
  ).all();
  return c.json({ results: results ?? [] });
});

// POST / → create.
sumCategorias.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 80);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const id = uid('cat');
  await c.env.DB.prepare(
    `INSERT INTO sum_categorias (id, nombre, color, descripcion, created_ms) VALUES (?,?,?,?,?)`
  ).bind(id, nombre, str(b?.color, 16), str(b?.descripcion, 400), Date.now()).run();
  const row = await c.env.DB.prepare(`SELECT * FROM sum_categorias WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// PATCH /:id → update.
sumCategorias.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b?.nombre != null) {
    const nombre = str(b.nombre, 80);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.color !== undefined) { sets.push('color = ?'); vals.push(str(b.color, 16)); }
  if (b?.descripcion !== undefined) { sets.push('descripcion = ?'); vals.push(str(b.descripcion, 400)); }
  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_categorias SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_categorias WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → unlinks products (sets their categoria_id NULL), then deletes.
sumCategorias.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE sum_productos SET categoria_id = NULL WHERE categoria_id = ?`).bind(id).run();
  const r = await c.env.DB.prepare(`DELETE FROM sum_categorias WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});
