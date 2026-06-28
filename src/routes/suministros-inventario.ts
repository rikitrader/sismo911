import { Hono } from 'hono';
import type { Env } from '../types';

// SUMINISTROS — Inventario (read-only stock views). Joins sum_existencias with
// items/productos/ubicaciones/categorias. Mounted at /api/suministros/inventario.
// All GET, all public.

export const sumInventario = new Hono<{ Bindings: Env }>();

// Product-level on-hand total (across every item + location) for low-stock checks.
const PROD_TOTAL = `(SELECT COALESCE(SUM(e2.cantidad),0) FROM sum_existencias e2
  JOIN sum_items i2 ON i2.id = e2.item_id WHERE i2.producto_id = p.id)`;

// GET / → existencias rows with on hand > 0. Filters: ?ubicacion_id ?producto_id
// ?categoria_id ?bajo=1 (product total below its stock_min) ?limit.
sumInventario.get('/', async (c) => {
  const ubicacion = c.req.query('ubicacion_id');
  const producto = c.req.query('producto_id');
  const categoria = c.req.query('categoria_id');
  const bajo = c.req.query('bajo');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 1000;
  limit = Math.min(limit, 5000);

  const where: string[] = ['e.cantidad <> 0'];
  const vals: unknown[] = [];
  if (ubicacion) { where.push('e.ubicacion_id = ?'); vals.push(ubicacion); }
  if (producto) { where.push('p.id = ?'); vals.push(producto); }
  if (categoria) { where.push('p.categoria_id = ?'); vals.push(categoria); }
  if (bajo === '1') where.push(`${PROD_TOTAL} < p.stock_min AND p.stock_min > 0`);

  const sql = `SELECT e.ubicacion_id, u.nombre AS ubicacion_nombre, u.tipo AS ubicacion_tipo,
      e.item_id, e.cantidad, e.updated_ms,
      i.lote, i.caducidad_ms,
      p.id AS producto_id, p.nombre AS producto_nombre, p.codigo, p.unidad, p.stock_min, p.perecedero,
      cat.nombre AS categoria_nombre, cat.color AS categoria_color,
      ${PROD_TOTAL} AS producto_total
    FROM sum_existencias e
    JOIN sum_items i ON i.id = e.item_id
    JOIN sum_productos p ON p.id = i.producto_id
    JOIN sum_ubicaciones u ON u.id = e.ubicacion_id
    LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.nombre, u.nombre, i.caducidad_ms LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// GET /items?ubicacion_id= → items with disponible > 0 at a location (FEFO order).
// Powers the despacho / traslado / ajuste item pickers.
sumInventario.get('/items', async (c) => {
  const ubicacion = c.req.query('ubicacion_id');
  if (!ubicacion) return c.json({ error: 'ubicacion_id requerido' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT e.item_id, e.cantidad AS disponible, i.lote, i.caducidad_ms,
        p.id AS producto_id, p.nombre AS producto_nombre, p.codigo, p.unidad
     FROM sum_existencias e
     JOIN sum_items i ON i.id = e.item_id
     JOIN sum_productos p ON p.id = i.producto_id
     WHERE e.ubicacion_id = ? AND e.cantidad > 0
     ORDER BY p.nombre, (i.caducidad_ms IS NULL), i.caducidad_ms`
  ).bind(ubicacion).all();
  return c.json({ results: results ?? [] });
});

// GET /producto/:id → per-location breakdown of one product's stock.
sumInventario.get('/producto/:id', async (c) => {
  const id = c.req.param('id');
  const producto = await c.env.DB.prepare(`SELECT * FROM sum_productos WHERE id = ?`).bind(id).first();
  if (!producto) return c.json({ error: 'no encontrado' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT e.ubicacion_id, u.nombre AS ubicacion_nombre, e.item_id, i.lote, i.caducidad_ms, e.cantidad
     FROM sum_existencias e
     JOIN sum_items i ON i.id = e.item_id
     JOIN sum_ubicaciones u ON u.id = e.ubicacion_id
     WHERE i.producto_id = ? AND e.cantidad <> 0
     ORDER BY u.nombre, i.caducidad_ms`
  ).bind(id).all();
  return c.json({ producto, existencias: results ?? [] });
});
