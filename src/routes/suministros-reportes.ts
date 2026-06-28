import { Hono } from 'hono';
import type { Env } from '../types';

// SUMINISTROS — Reportes (reporting engine). Read-only analytic endpoints that
// power valuación, rotación, caducidad, ledger de movimientos y fill-rate de
// requisiciones. Mounted at /api/suministros/reportes. All GET, public.

export const sumReportes = new Hono<{ Bindings: Env }>();

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ── GET /valuacion — stock valuation by product, category, and location ───────
// Unit cost = preferido=1 supplier price → MIN(price) → 0. valor = qty × cost.
sumReportes.get('/valuacion', async (c) => {
  const [itemsRes, catRes, ubRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT producto_id, nombre, codigo, cantidad, costo_unit FROM (
         SELECT p.id AS producto_id, p.nombre, p.codigo,
           COALESCE(SUM(e.cantidad), 0) AS cantidad,
           COALESCE(
             (SELECT precio FROM sum_producto_proveedor WHERE producto_id = p.id AND preferido = 1 LIMIT 1),
             (SELECT MIN(precio) FROM sum_producto_proveedor WHERE producto_id = p.id),
             0
           ) AS costo_unit
         FROM sum_productos p
         LEFT JOIN sum_items i ON i.producto_id = p.id
         LEFT JOIN sum_existencias e ON e.item_id = i.id
         GROUP BY p.id, p.nombre, p.codigo
         HAVING COALESCE(SUM(e.cantidad), 0) > 0
       )
       ORDER BY (cantidad * costo_unit) DESC LIMIT 100`
    ).all(),
    c.env.DB.prepare(
      `SELECT COALESCE(cat.nombre, 'Sin categoría') AS k,
         COALESCE(SUM(e.cantidad * COALESCE(
           (SELECT precio FROM sum_producto_proveedor WHERE producto_id = p.id AND preferido = 1 LIMIT 1),
           (SELECT MIN(precio) FROM sum_producto_proveedor WHERE producto_id = p.id),
           0
         )), 0) AS v
       FROM sum_existencias e
       JOIN sum_items i ON i.id = e.item_id
       JOIN sum_productos p ON p.id = i.producto_id
       LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id
       GROUP BY cat.id, cat.nombre`
    ).all(),
    c.env.DB.prepare(
      `SELECT u.nombre AS k,
         COALESCE(SUM(e.cantidad * COALESCE(
           (SELECT precio FROM sum_producto_proveedor WHERE producto_id = p.id AND preferido = 1 LIMIT 1),
           (SELECT MIN(precio) FROM sum_producto_proveedor WHERE producto_id = p.id),
           0
         )), 0) AS v
       FROM sum_existencias e
       JOIN sum_items i ON i.id = e.item_id
       JOIN sum_productos p ON p.id = i.producto_id
       JOIN sum_ubicaciones u ON u.id = e.ubicacion_id
       GROUP BY u.id, u.nombre`
    ).all(),
  ]);

  const items = (itemsRes.results ?? []).map((r: any) => {
    const cantidad = num(r.cantidad);
    const costo_unit = round2(num(r.costo_unit));
    return {
      producto_id: r.producto_id,
      nombre: r.nombre,
      codigo: r.codigo,
      cantidad,
      costo_unit,
      valor: round2(cantidad * costo_unit),
    };
  });
  const total = round2(items.reduce((s, x) => s + x.valor, 0));

  const por_categoria: Record<string, number> = {};
  for (const r of catRes.results ?? []) por_categoria[String((r as any).k)] = round2(num((r as any).v));
  const por_ubicacion: Record<string, number> = {};
  for (const r of ubRes.results ?? []) por_ubicacion[String((r as any).k)] = round2(num((r as any).v));

  return c.json({ total, moneda: 'USD', por_categoria, por_ubicacion, items });
});

// ── GET /rotacion?dias=90 — consumption / turnover per product ────────────────
// consumo = Σ absolute value of negative transaction lines in the window.
// rotacion = consumo / existencia_actual (null when stock is zero).
sumReportes.get('/rotacion', async (c) => {
  let dias = Number(c.req.query('dias'));
  if (!Number.isFinite(dias) || dias <= 0) dias = 90;
  const desde = Date.now() - dias * DAY;

  const { results } = await c.env.DB.prepare(
    `SELECT p.id AS producto_id, p.nombre, p.codigo,
       COALESCE(SUM(-tl.cantidad), 0) AS consumo,
       (SELECT COALESCE(SUM(e.cantidad), 0) FROM sum_existencias e
        JOIN sum_items i2 ON i2.id = e.item_id WHERE i2.producto_id = p.id) AS existencia_actual
     FROM sum_productos p
     JOIN sum_items i ON i.producto_id = p.id
     JOIN sum_transaccion_lineas tl ON tl.item_id = i.id
     JOIN sum_transacciones t ON t.id = tl.transaccion_id
     WHERE t.created_ms >= ? AND tl.cantidad < 0
     GROUP BY p.id, p.nombre, p.codigo
     ORDER BY consumo DESC LIMIT 100`
  ).bind(desde).all();

  const productos = (results ?? []).map((r: any) => {
    const consumo = num(r.consumo);
    const existencia_actual = num(r.existencia_actual);
    const rotacion = existencia_actual > 0 ? round2(consumo / existencia_actual) : null;
    return { producto_id: r.producto_id, nombre: r.nombre, codigo: r.codigo, consumo, existencia_actual, rotacion };
  });

  return c.json({ dias, productos });
});

// ── GET /caducidad — expiry buckets for items with stock > 0 ─────────────────
// Buckets relative to now (computed in JS; `now` is NOT called in SQL).
// vencido: dias < 0 | d0_30: 0-30 | d31_90: 31-90 | d91_mas: >90.
sumReportes.get('/caducidad', async (c) => {
  const now = Date.now();

  const { results } = await c.env.DB.prepare(
    `SELECT i.id AS item_id, p.nombre AS producto_nombre, p.codigo, i.lote, i.caducidad_ms,
       COALESCE(SUM(e.cantidad), 0) AS cantidad, u.nombre AS ubicacion_nombre
     FROM sum_items i
     JOIN sum_existencias e ON e.item_id = i.id
     JOIN sum_productos p ON p.id = i.producto_id
     JOIN sum_ubicaciones u ON u.id = e.ubicacion_id
     WHERE e.cantidad > 0 AND i.caducidad_ms IS NOT NULL
     GROUP BY i.id, p.nombre, p.codigo, i.lote, i.caducidad_ms, u.nombre
     ORDER BY i.caducidad_ms ASC LIMIT 200`
  ).all();

  type BucketEntry = { items: number; cantidad: number };
  const buckets: Record<string, BucketEntry> = {
    vencido:  { items: 0, cantidad: 0 },
    d0_30:    { items: 0, cantidad: 0 },
    d31_90:   { items: 0, cantidad: 0 },
    d91_mas:  { items: 0, cantidad: 0 },
  };

  const detalle = (results ?? []).map((r: any) => {
    const dias = Math.round((num(r.caducidad_ms) - now) / DAY);
    const bucket = dias < 0 ? 'vencido' : dias <= 30 ? 'd0_30' : dias <= 90 ? 'd31_90' : 'd91_mas';
    const cantidad = num(r.cantidad);
    buckets[bucket].items++;
    buckets[bucket].cantidad += cantidad;
    return {
      item_id: r.item_id,
      producto_nombre: r.producto_nombre,
      codigo: r.codigo,
      lote: r.lote,
      caducidad_ms: r.caducidad_ms,
      cantidad,
      ubicacion_nombre: r.ubicacion_nombre,
      dias,
      bucket,
    };
  });

  return c.json({ generado_ms: now, buckets, detalle });
});

// ── GET /ledger — movement ledger with optional filters ───────────────────────
// Filters (all optional): from/to (epoch ms on created_ms), producto_id,
// ubicacion_id, tipo. Default limit 500, max 2000.
sumReportes.get('/ledger', async (c) => {
  const from        = c.req.query('from');
  const to          = c.req.query('to');
  const productoId  = c.req.query('producto_id');
  const ubicacionId = c.req.query('ubicacion_id');
  const tipo        = c.req.query('tipo');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  limit = Math.min(limit, 2000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (from)        { where.push('t.created_ms >= ?');   vals.push(Number(from)); }
  if (to)          { where.push('t.created_ms <= ?');   vals.push(Number(to)); }
  if (productoId)  { where.push('p.id = ?');            vals.push(productoId); }
  if (ubicacionId) { where.push('t.ubicacion_id = ?');  vals.push(ubicacionId); }
  if (tipo)        { where.push('t.tipo = ?');           vals.push(tipo); }
  vals.push(limit);

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { results } = await c.env.DB.prepare(
    `SELECT t.codigo AS tx_codigo, t.tipo, t.created_ms AS fecha_ms,
       p.nombre AS producto_nombre, p.codigo, i.lote, tl.cantidad, u.nombre AS ubicacion_nombre
     FROM sum_transaccion_lineas tl
     JOIN sum_transacciones t ON t.id = tl.transaccion_id
     JOIN sum_items i ON i.id = tl.item_id
     JOIN sum_productos p ON p.id = i.producto_id
     JOIN sum_ubicaciones u ON u.id = t.ubicacion_id
     ${whereClause}
     ORDER BY t.created_ms DESC LIMIT ?`
  ).bind(...vals).all();

  return c.json({ results: results ?? [] });
});

// ── GET /fill-rate — requisition fill-rate (overall + per requisición) ────────
// overall = Σcantidad_surt / Σcantidad_sol across all lines.
// Also per-estado counts and per-requisición detail (top 100 most recent).
sumReportes.get('/fill-rate', async (c) => {
  const [totals, porEstado, detalleRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(cantidad_sol), 0) AS total_sol,
         COALESCE(SUM(cantidad_surt), 0) AS total_surt
       FROM sum_requisicion_lineas`
    ).first<{ total_sol: number; total_surt: number }>(),
    c.env.DB.prepare(
      `SELECT estado AS k, COUNT(*) AS n FROM sum_requisiciones GROUP BY estado`
    ).all(),
    c.env.DB.prepare(
      `SELECT r.codigo,
         COALESCE(SUM(rl.cantidad_sol), 0) AS solicitado,
         COALESCE(SUM(rl.cantidad_surt), 0) AS surtido
       FROM sum_requisiciones r
       JOIN sum_requisicion_lineas rl ON rl.requisicion_id = r.id
       GROUP BY r.id, r.codigo
       ORDER BY r.created_ms DESC LIMIT 100`
    ).all(),
  ]);

  const total_solicitado = num(totals?.total_sol);
  const total_surtido    = num(totals?.total_surt);
  const overall_fill_rate = total_solicitado > 0
    ? round4(total_surtido / total_solicitado)
    : null;

  const requisiciones_por_estado: Record<string, number> = {};
  for (const r of porEstado.results ?? [])
    requisiciones_por_estado[String((r as any).k)] = num((r as any).n);

  const detalle = (detalleRes.results ?? []).map((r: any) => {
    const solicitado = num(r.solicitado);
    const surtido    = num(r.surtido);
    return {
      codigo: r.codigo,
      solicitado,
      surtido,
      fill_rate: solicitado > 0 ? round4(surtido / solicitado) : null,
    };
  });

  return c.json({ overall_fill_rate, total_solicitado, total_surtido, requisiciones_por_estado, detalle });
});
