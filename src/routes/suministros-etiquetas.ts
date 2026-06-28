import { Hono } from 'hono';
import type { Env } from '../types';

// SUMINISTROS — Etiquetas / barcode label data (read-only). Returns the data
// needed by the SPA to render Code128 barcodes via JsBarcode; barcode value =
// product `codigo`. Mounted at /api/suministros/etiquetas. All GET, all public.

export const sumEtiquetas = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

// Shared helper: fetch full label payload for a single producto by ID.
async function labelDataForProducto(env: Env, productoId: string) {
  const producto = await env.DB.prepare(
    `SELECT p.id, p.codigo, p.nombre, p.unidad, cat.nombre AS categoria_nombre
     FROM sum_productos p
     LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id
     WHERE p.id = ?`
  ).bind(productoId).first<{
    id: string; codigo: string; nombre: string; unidad: string; categoria_nombre: string | null;
  }>();
  if (!producto) return null;

  const { results } = await env.DB.prepare(
    `SELECT i.id AS item_id, i.lote, i.caducidad_ms,
       COALESCE(SUM(e.cantidad), 0) AS total_existencia
     FROM sum_items i
     LEFT JOIN sum_existencias e ON e.item_id = i.id
     WHERE i.producto_id = ?
     GROUP BY i.id, i.lote, i.caducidad_ms
     ORDER BY (i.caducidad_ms IS NULL), i.caducidad_ms`
  ).bind(productoId).all<{
    item_id: string; lote: string | null; caducidad_ms: number | null; total_existencia: number;
  }>();

  const items = results ?? [];
  const etiquetas = items.length > 0
    ? items.map(r => ({ ...r, barcode: producto.codigo }))
    : [{ item_id: null, lote: null, caducidad_ms: null, barcode: producto.codigo, total_existencia: 0 }];

  return { producto, etiquetas };
}

// GET /catalogo → printable label sheet feed. Filters: ?categoria_id= ?q= ?limit=.
// Returns {results:[{id, codigo, nombre, unidad, categoria_nombre, n_lotes}]}.
sumEtiquetas.get('/catalogo', async (c) => {
  const categoria = str(c.req.query('categoria_id'), 40);
  const q = str(c.req.query('q'), 100);
  let limit = num(c.req.query('limit')) ?? 200;
  if (!Number.isFinite(limit) || (limit as number) <= 0) limit = 200;
  limit = Math.min(limit as number, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (categoria) { where.push('p.categoria_id = ?'); vals.push(categoria); }
  if (q) { where.push('(p.nombre LIKE ? OR p.codigo LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }

  const sql = `SELECT p.id, p.codigo, p.nombre, p.unidad,
      cat.nombre AS categoria_nombre,
      COUNT(i.id) AS n_lotes
    FROM sum_productos p
    LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id
    LEFT JOIN sum_items i ON i.producto_id = p.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY p.id, p.codigo, p.nombre, p.unidad, cat.nombre
    ORDER BY p.nombre LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// GET /lote/:itemId → single-lot label: {item_id, producto_nombre, codigo,
// lote, caducidad_ms, barcode, unidad} or 404.
sumEtiquetas.get('/lote/:itemId', async (c) => {
  const itemId = c.req.param('itemId');
  const row = await c.env.DB.prepare(
    `SELECT i.id AS item_id, p.nombre AS producto_nombre, p.codigo,
       i.lote, i.caducidad_ms, p.unidad
     FROM sum_items i
     JOIN sum_productos p ON p.id = i.producto_id
     WHERE i.id = ?`
  ).bind(itemId).first<{
    item_id: string; producto_nombre: string; codigo: string;
    lote: string | null; caducidad_ms: number | null; unidad: string;
  }>();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ...row, barcode: row.codigo });
});

// GET /producto/:productoId → RESTful alias for GET /?producto_id=.
// Same payload: {producto, etiquetas:[…]} or 404.
sumEtiquetas.get('/producto/:productoId', async (c) => {
  const data = await labelDataForProducto(c.env, c.req.param('productoId'));
  if (!data) return c.json({ error: 'no encontrado' }, 404);
  return c.json(data);
});

// GET / → label data for ONE product. ?producto_id= required.
// {producto:{id,codigo,nombre,unidad,categoria_nombre},
//  etiquetas:[{item_id,lote,caducidad_ms,barcode,total_existencia}]}
// When the product has no sum_items rows yet, returns a single synthetic etiqueta
// so a base product label can still print.
sumEtiquetas.get('/', async (c) => {
  const productoId = str(c.req.query('producto_id'), 40);
  if (!productoId) return c.json({ error: 'producto_id requerido' }, 400);
  const data = await labelDataForProducto(c.env, productoId);
  if (!data) return c.json({ error: 'no encontrado' }, 404);
  return c.json(data);
});
