import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Movimientos (stock transactions). Table: sum_transacciones +
// sum_transaccion_lineas, mutating sum_existencias atomically via D1 batch().
// Mounted at /api/suministros/movimientos. Writes gated centrally; GET public.
//
// Sign convention (delta applied to the PRIMARY location `ubicacion_id`):
//   recepcion +  · despacho −  · traslado −origen/+destino · ajuste = signed delta
//   · conteo = (conteo − existencia actual).  No location may go below 0.

export const sumMovimientos = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const qty = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const txCode = () => `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Build the per-(ubicacion,item) delta upsert statement (delta add, never set).
const upsert = (db: D1Database, ubicacion: string, item: string, delta: number, now: number) =>
  db.prepare(
    `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(ubicacion_id, item_id)
       DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
  ).bind(ubicacion, item, delta, now);

// Read current on-hand for a set of items at one location → Map<item_id, cantidad>.
async function onHand(env: Env, ubicacion: string, items: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!items.length) return map;
  const ph = items.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT item_id, cantidad FROM sum_existencias WHERE ubicacion_id = ? AND item_id IN (${ph})`
  ).bind(ubicacion, ...items).all<{ item_id: string; cantidad: number }>();
  for (const r of results ?? []) map.set(r.item_id, r.cantidad);
  return map;
}

async function ubicacionExists(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT 1 FROM sum_ubicaciones WHERE id = ?`).bind(id).first();
  return !!r;
}

// ── GET history ───────────────────────────────────────────────────────────────
sumMovimientos.get('/', async (c) => {
  const tipo = c.req.query('tipo');
  const ubicacion = c.req.query('ubicacion_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (tipo) { where.push('t.tipo = ?'); vals.push(tipo); }
  if (ubicacion) { where.push('(t.ubicacion_id = ? OR t.ubicacion_dest_id = ?)'); vals.push(ubicacion, ubicacion); }

  const sql = `SELECT t.*, u.nombre AS ubicacion_nombre, ud.nombre AS ubicacion_dest_nombre,
      (SELECT COUNT(*) FROM sum_transaccion_lineas l WHERE l.transaccion_id = t.id) AS n_lineas
    FROM sum_transacciones t
    LEFT JOIN sum_ubicaciones u ON u.id = t.ubicacion_id
    LEFT JOIN sum_ubicaciones ud ON ud.id = t.ubicacion_dest_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── GET one transaction + lines ───────────────────────────────────────────────
sumMovimientos.get('/:id', async (c) => {
  const id = c.req.param('id');
  const t = await c.env.DB.prepare(
    `SELECT t.*, u.nombre AS ubicacion_nombre, ud.nombre AS ubicacion_dest_nombre
     FROM sum_transacciones t
     LEFT JOIN sum_ubicaciones u ON u.id = t.ubicacion_id
     LEFT JOIN sum_ubicaciones ud ON ud.id = t.ubicacion_dest_id WHERE t.id = ?`
  ).bind(id).first();
  if (!t) return c.json({ error: 'no encontrado' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, p.nombre AS producto_nombre, p.codigo, p.unidad, i.lote, i.caducidad_ms
     FROM sum_transaccion_lineas l
     JOIN sum_items i ON i.id = l.item_id
     JOIN sum_productos p ON p.id = i.producto_id
     WHERE l.transaccion_id = ? ORDER BY l.created_ms`
  ).bind(id).all();
  return c.json({ transaccion: t, lineas: results ?? [] });
});

// ── RECEPCIÓN — receive new stock into a location (creates lots as needed) ─────
sumMovimientos.post('/recepcion', async (c) => {
  const b = await c.req.json().catch(() => null);
  const ubicacion = str(b?.ubicacion_id, 40);
  if (!ubicacion || !(await ubicacionExists(c.env, ubicacion))) return c.json({ error: 'ubicacion_id inválido' }, 400);
  const lineasIn = Array.isArray(b?.lineas) ? b.lineas : [];
  if (!lineasIn.length) return c.json({ error: 'sin líneas' }, 400);

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const txId = uid('tx');
  const code = txCode();

  // Resolve (or create) an item per line by (producto, lote, caducidad).
  const lineRows: { item_id: string; cantidad: number }[] = [];
  for (const ln of lineasIn) {
    const producto = str(ln?.producto_id, 40);
    const cantidad = qty(ln?.cantidad);
    if (!producto) return c.json({ error: 'producto_id requerido en cada línea' }, 400);
    if (!(cantidad > 0)) return c.json({ error: 'cantidad debe ser > 0' }, 400);
    const prod = await c.env.DB.prepare(`SELECT id FROM sum_productos WHERE id = ?`).bind(producto).first();
    if (!prod) return c.json({ error: `producto no encontrado: ${producto}` }, 400);

    const lote = str(ln?.lote, 80);
    const cad = ln?.caducidad_ms == null || ln?.caducidad_ms === '' ? null : Number(ln.caducidad_ms);
    let item = await c.env.DB.prepare(
      `SELECT id FROM sum_items WHERE producto_id = ?
         AND COALESCE(lote,'') = COALESCE(?,'') AND COALESCE(caducidad_ms,0) = COALESCE(?,0)`
    ).bind(producto, lote, cad).first<{ id: string }>();
    let itemId = item?.id;
    if (!itemId) {
      itemId = uid('item');
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_items (id, producto_id, lote, caducidad_ms, created_ms) VALUES (?,?,?,?,?)`
      ).bind(itemId, producto, lote, cad, now));
    }
    lineRows.push({ item_id: itemId, cantidad });
  }

  stmts.unshift(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(txId, code, 'recepcion', ubicacion, str(b?.referencia, 200), str(b?.actor, 120), str(b?.nota, 1000), now));
  for (const lr of lineRows) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, lr.item_id, lr.cantidad, now));
    stmts.push(upsert(c.env.DB, ubicacion, lr.item_id, lr.cantidad, now));
  }
  await c.env.DB.batch(stmts);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first();
  return c.json({ transaccion: row }, 201);
});

// Shared builder for item-referencing movements (despacho/traslado/ajuste/conteo).
async function itemMovement(
  c: any,
  tipo: 'despacho' | 'traslado' | 'ajuste' | 'conteo',
  parse: (ln: any, current: number) => { delta: number } | { error: string },
) {
  const b = await c.req.json().catch(() => null);
  const ubicacion = str(b?.ubicacion_id, 40);
  if (!ubicacion || !(await ubicacionExists(c.env, ubicacion))) return c.json({ error: 'ubicacion_id inválido' }, 400);
  let dest: string | null = null;
  if (tipo === 'traslado') {
    dest = str(b?.ubicacion_dest_id, 40);
    if (!dest || !(await ubicacionExists(c.env, dest))) return c.json({ error: 'ubicacion_dest_id inválido' }, 400);
    if (dest === ubicacion) return c.json({ error: 'origen y destino deben diferir' }, 400);
  }
  const lineasIn = Array.isArray(b?.lineas) ? b.lineas : [];
  if (!lineasIn.length) return c.json({ error: 'sin líneas' }, 400);

  const itemIds: string[] = [];
  for (const ln of lineasIn) {
    const it = str(ln?.item_id, 40);
    if (!it) return c.json({ error: 'item_id requerido en cada línea' }, 400);
    itemIds.push(it);
  }
  const current = await onHand(c.env, ubicacion, itemIds);

  const now = Date.now();
  const txId = uid('tx');
  const stmts: D1PreparedStatement[] = [];
  const lineRows: { item_id: string; delta: number }[] = [];

  for (const ln of lineasIn) {
    const itemId = str(ln?.item_id, 40)!;
    const cur = current.get(itemId) ?? 0;
    const parsed = parse(ln, cur);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const delta = parsed.delta;
    if (delta === 0) continue;
    // Primary location must not go negative.
    if (cur + delta < 0) {
      return c.json({ error: `existencia insuficiente para item ${itemId} (disponible ${cur})` }, 409);
    }
    lineRows.push({ item_id: itemId, delta });
  }
  if (!lineRows.length) return c.json({ error: 'sin cambios que aplicar' }, 400);

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, ubicacion_dest_id, referencia, motivo, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    txId, txCode(), tipo, ubicacion, dest,
    str(b?.referencia, 200), str(b?.motivo, 400), str(b?.actor, 120), str(b?.nota, 1000), now
  ));
  for (const lr of lineRows) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, lr.item_id, lr.delta, now));
    stmts.push(upsert(c.env.DB, ubicacion, lr.item_id, lr.delta, now));
    if (tipo === 'traslado' && dest) stmts.push(upsert(c.env.DB, dest, lr.item_id, -lr.delta, now));
  }
  await c.env.DB.batch(stmts);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first();
  return c.json({ transaccion: row }, 201);
}

// ── DESPACHO — issue stock out of a location ──────────────────────────────────
sumMovimientos.post('/despacho', (c) =>
  itemMovement(c, 'despacho', (ln) => {
    const n = qty(ln?.cantidad);
    if (!(n > 0)) return { error: 'cantidad debe ser > 0' };
    return { delta: -n };
  }));

// ── TRASLADO — move stock between two locations ───────────────────────────────
sumMovimientos.post('/traslado', (c) =>
  itemMovement(c, 'traslado', (ln) => {
    const n = qty(ln?.cantidad);
    if (!(n > 0)) return { error: 'cantidad debe ser > 0' };
    return { delta: -n };
  }));

// ── AJUSTE — signed correction (+/−) at a location ────────────────────────────
sumMovimientos.post('/ajuste', (c) =>
  itemMovement(c, 'ajuste', (ln) => {
    const n = qty(ln?.delta ?? ln?.cantidad);
    if (!Number.isFinite(n) || n === 0) return { error: 'delta inválido (≠ 0)' };
    return { delta: n };
  }));

// ── CONTEO — set on-hand to a counted absolute value (records the delta) ───────
sumMovimientos.post('/conteo', (c) =>
  itemMovement(c, 'conteo', (ln, current) => {
    const n = qty(ln?.cantidad);
    if (!Number.isFinite(n) || n < 0) return { error: 'conteo inválido (≥ 0)' };
    return { delta: n - current };
  }));
