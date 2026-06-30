import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Catálogo de productos (SKU master). Table: sum_productos.
// Mounted at /api/suministros/productos. Writes gated centrally; GET public.

export const sumProductos = new Hono<{ Bindings: Env }>();

const UNIDADES = ['unidad', 'caja', 'kg', 'litro', 'paquete', 'saco', 'blister'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

// Aggregate quantity-on-hand across all of a product's items + locations.
const ON_HAND = `(SELECT COALESCE(SUM(e.cantidad),0) FROM sum_existencias e
  JOIN sum_items i ON i.id = e.item_id WHERE i.producto_id = p.id)`;

// Effective unit cost: manual override (costo_unit>0) → preferred supplier → MIN → 0.
const COSTO_EFECTIVO = `COALESCE(
    NULLIF(p.costo_unit, 0),
    (SELECT precio FROM sum_producto_proveedor WHERE producto_id = p.id AND preferido = 1 LIMIT 1),
    (SELECT MIN(precio) FROM sum_producto_proveedor WHERE producto_id = p.id),
    0)`;

// GET / → list with categoria name + on_hand; ?categoria_id= ?activo= ?q= filters.
sumProductos.get('/', async (c) => {
  const categoria = c.req.query('categoria_id');
  const activo = c.req.query('activo');
  const q = c.req.query('q');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  limit = Math.min(limit, 2000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (categoria) { where.push('p.categoria_id = ?'); vals.push(categoria); }
  if (activo === '0' || activo === '1') { where.push('p.activo = ?'); vals.push(Number(activo)); }
  if (q) { where.push('(p.nombre LIKE ? OR p.codigo LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }

  const sql = `SELECT p.*, cat.nombre AS categoria_nombre, cat.color AS categoria_color,
      ${ON_HAND} AS on_hand, ${COSTO_EFECTIVO} AS costo_efectivo
    FROM sum_productos p LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.nombre LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  const rows = (results ?? []).map((r: any) => ({
    ...r,
    valor_inventario: Math.round((Number(r.on_hand) || 0) * (Number(r.costo_efectivo) || 0) * 100) / 100,
  }));
  return c.json({ results: rows });
});

// POST / → create. Auto-generates a codigo (PRD-XXXXXX) when blank.
sumProductos.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 200);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  let unidad = str(b?.unidad, 20) ?? 'unidad';
  if (!UNIDADES.includes(unidad)) return c.json({ error: 'unidad inválida' }, 400);
  let codigo = str(b?.codigo, 40);
  if (!codigo) codigo = `PRD-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

  const dup = await c.env.DB.prepare(`SELECT id FROM sum_productos WHERE codigo = ?`).bind(codigo).first();
  if (dup) return c.json({ error: 'código ya existe' }, 409);

  const id = uid('prod');
  const now = Date.now();
  const costoUnit = Math.max(0, num(b?.costo_unit) ?? 0);
  await c.env.DB.prepare(
    `INSERT INTO sum_productos
       (id, codigo, nombre, categoria_id, unidad, perecedero, stock_min, descripcion, costo_unit, activo, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, nombre, str(b?.categoria_id, 40), unidad,
    b?.perecedero ? 1 : 0, num(b?.stock_min) ?? 0, str(b?.descripcion, 1000), costoUnit,
    b?.activo === undefined ? 1 : (b.activo ? 1 : 0), now, now
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM sum_productos WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// GET /:id → product + categoria + on_hand + effective cost + inventory value
//   + preferred supplier (name + price).
sumProductos.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT p.*, cat.nombre AS categoria_nombre, cat.color AS categoria_color,
        ${ON_HAND} AS on_hand, ${COSTO_EFECTIVO} AS costo_efectivo,
        (SELECT pr.nombre FROM sum_producto_proveedor pp JOIN sum_proveedores pr ON pr.id = pp.proveedor_id
           WHERE pp.producto_id = p.id AND pp.preferido = 1 LIMIT 1) AS proveedor_preferido,
        (SELECT pp.precio FROM sum_producto_proveedor pp
           WHERE pp.producto_id = p.id AND pp.preferido = 1 LIMIT 1) AS precio_preferido
     FROM sum_productos p LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id WHERE p.id = ?`
  ).bind(c.req.param('id')).first<any>();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  row.valor_inventario = Math.round((Number(row.on_hand) || 0) * (Number(row.costo_efectivo) || 0) * 100) / 100;
  return c.json(row);
});

// PATCH /:id → update.
sumProductos.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.nombre != null) {
    const nombre = str(b.nombre, 200);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.unidad != null) {
    if (!UNIDADES.includes(b.unidad)) return c.json({ error: 'unidad inválida' }, 400);
    sets.push('unidad = ?'); vals.push(b.unidad);
  }
  if (b?.codigo !== undefined) {
    const codigo = str(b.codigo, 40);
    if (!codigo) return c.json({ error: 'código inválido' }, 400);
    const dup = await c.env.DB.prepare(`SELECT id FROM sum_productos WHERE codigo = ? AND id <> ?`).bind(codigo, id).first();
    if (dup) return c.json({ error: 'código ya existe' }, 409);
    sets.push('codigo = ?'); vals.push(codigo);
  }
  if (b?.categoria_id !== undefined) { sets.push('categoria_id = ?'); vals.push(str(b.categoria_id, 40)); }
  if (b?.perecedero !== undefined) { sets.push('perecedero = ?'); vals.push(b.perecedero ? 1 : 0); }
  if (b?.stock_min !== undefined) { sets.push('stock_min = ?'); vals.push(num(b.stock_min) ?? 0); }
  if (b?.costo_unit !== undefined) { sets.push('costo_unit = ?'); vals.push(Math.max(0, num(b.costo_unit) ?? 0)); }
  if (b?.descripcion !== undefined) { sets.push('descripcion = ?'); vals.push(str(b.descripcion, 1000)); }
  if (b?.activo !== undefined) { sets.push('activo = ?'); vals.push(b.activo ? 1 : 0); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_productos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_productos WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → blocked if the product still has stock on hand anywhere.
sumProductos.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const stock = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(e.cantidad),0) AS n FROM sum_existencias e
     JOIN sum_items i ON i.id = e.item_id WHERE i.producto_id = ? AND e.cantidad <> 0`
  ).bind(id).first<{ n: number }>();
  if ((stock?.n ?? 0) > 0) return c.json({ error: 'el producto tiene existencias; despáchalas o ajústalas primero' }, 409);
  await c.env.DB.prepare(`DELETE FROM sum_items WHERE producto_id = ?`).bind(id).run();
  const r = await c.env.DB.prepare(`DELETE FROM sum_productos WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});
