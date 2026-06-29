import { Hono } from 'hono';
import type { Env } from '../types';

// SUMINISTROS — Tablero (dashboard aggregates). Read-only counts + alert lists
// that power the overview. Mounted at /api/suministros/tablero. All GET, public.

export const sumTablero = new Hono<{ Bindings: Env }>();

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);
const DAY = 86_400_000;

// ── GET /resumen — headline counters ──────────────────────────────────────────
sumTablero.get('/resumen', async (c) => {
  const now = Date.now();
  const horizonte = now + 30 * DAY;
  const [productos, ubicaciones, unidades, bajo, porVencer, vencidos, porCat, mov7d, reqEstados] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sum_productos WHERE activo = 1`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sum_ubicaciones WHERE activa = 1`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(cantidad),0) AS n FROM sum_existencias`).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sum_productos p WHERE p.activo = 1 AND p.stock_min > 0
         AND (SELECT COALESCE(SUM(e.cantidad),0) FROM sum_existencias e
              JOIN sum_items i ON i.id = e.item_id WHERE i.producto_id = p.id) < p.stock_min`
    ).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT i.id) AS n FROM sum_items i
       JOIN sum_existencias e ON e.item_id = i.id
       WHERE e.cantidad > 0 AND i.caducidad_ms IS NOT NULL AND i.caducidad_ms >= ? AND i.caducidad_ms <= ?`
    ).bind(now, horizonte).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT i.id) AS n FROM sum_items i
       JOIN sum_existencias e ON e.item_id = i.id
       WHERE e.cantidad > 0 AND i.caducidad_ms IS NOT NULL AND i.caducidad_ms < ?`
    ).bind(now).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(cat.nombre,'Sin categoría') AS k, COALESCE(SUM(e.cantidad),0) AS n
       FROM sum_existencias e
       JOIN sum_items i ON i.id = e.item_id
       JOIN sum_productos p ON p.id = i.producto_id
       LEFT JOIN sum_categorias cat ON cat.id = p.categoria_id
       WHERE e.cantidad > 0 GROUP BY k ORDER BY n DESC`
    ).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sum_transacciones WHERE created_ms >= ?`).bind(now - 7 * DAY).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT estado AS k, COUNT(*) AS n FROM sum_requisiciones GROUP BY estado`).all(),
  ]);

  const por_categoria: Record<string, number> = {};
  for (const r of porCat.results ?? []) por_categoria[String((r as any).k)] = num((r as any).n);
  const requisiciones: Record<string, number> = {};
  for (const r of reqEstados.results ?? []) requisiciones[String((r as any).k)] = num((r as any).n);

  return c.json({
    productos: num(productos?.n),
    ubicaciones: num(ubicaciones?.n),
    unidades_total: num(unidades?.n),
    bajo_stock_n: num(bajo?.n),
    por_vencer_n: num(porVencer?.n),
    vencidos_n: num(vencidos?.n),
    por_categoria,
    movimientos_7d: num(mov7d?.n),
    requisiciones,
    generated_ms: now,
  });
});

// ── GET /alertas — actionable lists ───────────────────────────────────────────
sumTablero.get('/alertas', async (c) => {
  const now = Date.now();
  const horizonte = now + 30 * DAY;
  const [bajo, porVencer, vencidos] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM (
         SELECT p.id AS producto_id, p.nombre, p.codigo, p.unidad, p.stock_min,
           (SELECT COALESCE(SUM(e.cantidad),0) FROM sum_existencias e
            JOIN sum_items i ON i.id = e.item_id WHERE i.producto_id = p.id) AS total
         FROM sum_productos p WHERE p.activo = 1 AND p.stock_min > 0
       ) WHERE total < stock_min ORDER BY (total * 1.0 / stock_min) ASC LIMIT 50`
    ).all(),
    c.env.DB.prepare(
      `SELECT i.id AS item_id, p.nombre AS producto_nombre, p.codigo, i.lote, i.caducidad_ms,
         e.cantidad, u.nombre AS ubicacion_nombre
       FROM sum_items i
       JOIN sum_existencias e ON e.item_id = i.id
       JOIN sum_productos p ON p.id = i.producto_id
       JOIN sum_ubicaciones u ON u.id = e.ubicacion_id
       WHERE e.cantidad > 0 AND i.caducidad_ms IS NOT NULL AND i.caducidad_ms >= ? AND i.caducidad_ms <= ?
       ORDER BY i.caducidad_ms ASC LIMIT 50`
    ).bind(now, horizonte).all(),
    c.env.DB.prepare(
      `SELECT i.id AS item_id, p.nombre AS producto_nombre, p.codigo, i.lote, i.caducidad_ms,
         e.cantidad, u.nombre AS ubicacion_nombre
       FROM sum_items i
       JOIN sum_existencias e ON e.item_id = i.id
       JOIN sum_productos p ON p.id = i.producto_id
       JOIN sum_ubicaciones u ON u.id = e.ubicacion_id
       WHERE e.cantidad > 0 AND i.caducidad_ms IS NOT NULL AND i.caducidad_ms < ?
       ORDER BY i.caducidad_ms ASC LIMIT 50`
    ).bind(now).all(),
  ]);

  const withDays = (rows: unknown[]) => (rows ?? []).map((r) => {
    const row = r as any;
    return { ...row, dias: row.caducidad_ms != null ? Math.round((row.caducidad_ms - now) / DAY) : null };
  });

  return c.json({
    bajo_stock: bajo.results ?? [],
    por_vencer: withDays(porVencer.results ?? []),
    vencidos: withDays(vencidos.results ?? []),
  });
});

// ── GET /movimientos-recientes — last 20 transactions ─────────────────────────
sumTablero.get('/movimientos-recientes', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.codigo, t.tipo, t.referencia, t.created_ms,
        u.nombre AS ubicacion_nombre, ud.nombre AS ubicacion_dest_nombre,
        (SELECT COUNT(*) FROM sum_transaccion_lineas l WHERE l.transaccion_id = t.id) AS n_lineas
     FROM sum_transacciones t
     LEFT JOIN sum_ubicaciones u ON u.id = t.ubicacion_id
     LEFT JOIN sum_ubicaciones ud ON ud.id = t.ubicacion_dest_id
     ORDER BY t.created_ms DESC LIMIT 20`
  ).all();
  return c.json({ results: results ?? [] });
});

// ── GET /mapa — map markers: active sites with coords + total stock on hand ────
// Returns exactly `[{ id, nombre, tipo, lat, lng, total_unidades }]`. NOTE: the
// underlying column is `lon` (legacy); it is aliased to `lng` here for the map.
sumTablero.get('/mapa', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.nombre, u.tipo, u.lat, u.lon AS lng,
            COALESCE((SELECT SUM(e.cantidad) FROM sum_existencias e WHERE e.ubicacion_id = u.id), 0) AS total_unidades
     FROM sum_ubicaciones u
     WHERE u.activa = 1 AND u.lat IS NOT NULL AND u.lon IS NOT NULL
     ORDER BY u.nombre`
  ).all();
  return c.json(results ?? []);
});
