import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Órdenes de Compra (PO registry + partial/full receipt into stock).
// Tables: sum_ordenes, sum_orden_lineas. Receipt mutates sum_existencias via D1 batch().
// Mounted at /api/suministros/ordenes. Writes gated centrally; GET public.

export const sumOrdenes = new Hono<{ Bindings: Env }>();

const ESTADOS = ['borrador', 'aprobada', 'recibida_parcial', 'recibida', 'cancelada'];
const ESTADOS_RECIBIBLES = ['aprobada', 'recibida_parcial'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const qty = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const ocCode = () => `OC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Per-(ubicacion,item) delta upsert — same ON CONFLICT pattern as movimientos/donaciones.
const upsert = (db: D1Database, ubicacion: string, item: string, delta: number, now: number) =>
  db.prepare(
    `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(ubicacion_id, item_id)
       DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
  ).bind(ubicacion, item, delta, now);

// ── GET / — list órdenes ──────────────────────────────────────────────────────
sumOrdenes.get('/', async (c) => {
  const estado     = c.req.query('estado');
  const proveedorId = c.req.query('proveedor_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('o.estado = ?'); vals.push(estado); }
  if (proveedorId) { where.push('o.proveedor_id = ?'); vals.push(proveedorId); }

  const sql = `SELECT o.*,
      p.nombre AS proveedor_nombre,
      u.nombre AS ubicacion_nombre,
      (SELECT COUNT(*) FROM sum_orden_lineas l WHERE l.orden_id = o.id) AS n_lineas,
      (SELECT SUM(l.cantidad_ped * l.precio_unit) FROM sum_orden_lineas l WHERE l.orden_id = o.id) AS total
    FROM sum_ordenes o
    LEFT JOIN sum_proveedores p ON p.id = o.proveedor_id
    LEFT JOIN sum_ubicaciones u ON u.id = o.ubicacion_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY o.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST / — create orden (borrador) ─────────────────────────────────────────
sumOrdenes.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);

  const proveedorId = str(b?.proveedor_id, 40);
  if (!proveedorId) return c.json({ error: 'proveedor_id requerido' }, 400);
  const prv = await c.env.DB.prepare(`SELECT id FROM sum_proveedores WHERE id = ?`).bind(proveedorId).first();
  if (!prv) return c.json({ error: 'proveedor_id no encontrado' }, 404);

  const ubicacionId = str(b?.ubicacion_id, 40);
  if (!ubicacionId) return c.json({ error: 'ubicacion_id requerido' }, 400);
  const ubi = await c.env.DB.prepare(`SELECT id FROM sum_ubicaciones WHERE id = ?`).bind(ubicacionId).first();
  if (!ubi) return c.json({ error: 'ubicacion_id no encontrado' }, 404);

  const lineasIn: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  for (const ln of lineasIn) {
    const pid = str(ln?.producto_id, 40);
    if (!pid) return c.json({ error: 'producto_id requerido en cada línea' }, 400);
    if (!(qty(ln?.cantidad_ped) > 0)) return c.json({ error: 'cantidad_ped debe ser > 0 en cada línea' }, 400);
    const prod = await c.env.DB.prepare(`SELECT id FROM sum_productos WHERE id = ?`).bind(pid).first();
    if (!prod) return c.json({ error: `producto no encontrado: ${pid}` }, 404);
  }

  const now = Date.now();
  const id = uid('oc');
  const codigo = ocCode();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_ordenes
       (id, codigo, proveedor_id, ubicacion_id, estado, moneda, referencia, solicitante, fecha_esperada_ms, nota, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, proveedorId, ubicacionId, 'borrador',
    str(b?.moneda, 10) ?? 'USD',
    str(b?.referencia, 200), str(b?.solicitante, 160),
    num(b?.fecha_esperada_ms), str(b?.nota, 1000), now, now
  ));

  for (const ln of lineasIn) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_orden_lineas (id, orden_id, producto_id, cantidad_ped, precio_unit, created_ms)
       VALUES (?,?,?,?,?,?)`
    ).bind(uid('ocl'), id, str(ln.producto_id, 40), qty(ln.cantidad_ped), num(ln?.precio_unit), now));
  }

  await c.env.DB.batch(stmts);
  const orden = await c.env.DB.prepare(`SELECT * FROM sum_ordenes WHERE id = ?`).bind(id).first();
  return c.json({ orden }, 201);
});

// ── GET /:id — one orden + líneas + total ────────────────────────────────────
sumOrdenes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const orden = await c.env.DB.prepare(
    `SELECT o.*,
       p.nombre AS proveedor_nombre,
       u.nombre AS ubicacion_nombre,
       (SELECT SUM(l.cantidad_ped * l.precio_unit) FROM sum_orden_lineas l WHERE l.orden_id = o.id) AS total
     FROM sum_ordenes o
     LEFT JOIN sum_proveedores p ON p.id = o.proveedor_id
     LEFT JOIN sum_ubicaciones u ON u.id = o.ubicacion_id
     WHERE o.id = ?`
  ).bind(id).first();
  if (!orden) return c.json({ error: 'no encontrado' }, 404);
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT l.*, p.nombre AS producto_nombre, p.codigo, p.unidad
     FROM sum_orden_lineas l
     JOIN sum_productos p ON p.id = l.producto_id
     WHERE l.orden_id = ? ORDER BY l.created_ms`
  ).bind(id).all();
  return c.json({ orden, lineas: lineas ?? [] });
});

// ── PATCH /:id — estado transitions + mutable field updates ──────────────────
sumOrdenes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const existing = await c.env.DB.prepare(
    `SELECT estado FROM sum_ordenes WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!existing) return c.json({ error: 'no encontrado' }, 404);
  if (existing.estado === 'recibida') {
    return c.json({ error: 'la orden ya fue recibida; no se puede modificar' }, 409);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const now = Date.now();

  if (b?.estado != null) {
    if (!ESTADOS.includes(b.estado)) return c.json({ error: 'estado inválido' }, 400);
    if (b.estado === 'recibida' || b.estado === 'recibida_parcial') {
      return c.json({ error: 'usa el endpoint /recibir para recepcionar la orden' }, 400);
    }
    sets.push('estado = ?'); vals.push(b.estado);
    if (b.estado === 'aprobada') { sets.push('aprobada_ms = ?'); vals.push(now); }
  }
  if (b?.referencia !== undefined)        { sets.push('referencia = ?');        vals.push(str(b.referencia, 200)); }
  if (b?.solicitante !== undefined)       { sets.push('solicitante = ?');       vals.push(str(b.solicitante, 160)); }
  if (b?.fecha_esperada_ms !== undefined) { sets.push('fecha_esperada_ms = ?'); vals.push(num(b.fecha_esperada_ms)); }
  if (b?.nota !== undefined)              { sets.push('nota = ?');              vals.push(str(b.nota, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(now);
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_ordenes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_ordenes WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// ── POST /:id/recibir — receive against the PO (partial or full) ──────────────
// Mirrors the RECEPCIÓN pattern from donaciones: resolve-or-create sum_items by
// COALESCE(producto,lote,caducidad), then ONE D1 batch: [tx_header, new item inserts?,
// tx_lineas + existencias upserts + orden_lineas cantidad_rec updates]. Auto-advances
// estado to recibida_parcial or recibida after.
sumOrdenes.post('/:id/recibir', async (c) => {
  const ordenId = c.req.param('id');
  const b = await c.req.json().catch(() => null);

  const orden = await c.env.DB.prepare(`SELECT * FROM sum_ordenes WHERE id = ?`)
    .bind(ordenId).first<{ id: string; codigo: string; estado: string; ubicacion_id: string }>();
  if (!orden) return c.json({ error: 'no encontrado' }, 404);
  if (!ESTADOS_RECIBIBLES.includes(orden.estado)) {
    return c.json({
      error: `la orden está en estado '${orden.estado}'; solo aprobada o recibida_parcial puede recibirse`
    }, 409);
  }

  const lineasBody: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  if (!lineasBody.length) return c.json({ error: 'sin líneas' }, 400);

  // Phase 1: validate all incoming lines and build lineaMap.
  type LineaRec = { id: string; producto_id: string; cantidad_ped: number; cantidad_rec: number };
  const lineaMap = new Map<string, LineaRec>();
  for (const lbody of lineasBody) {
    const lineaId = str(lbody?.linea_id, 40);
    if (!lineaId) return c.json({ error: 'linea_id requerido en cada línea' }, 400);
    const cantidadRecibir = qty(lbody?.cantidad);
    if (!(cantidadRecibir > 0)) return c.json({ error: 'cantidad debe ser > 0 en cada línea' }, 400);

    if (!lineaMap.has(lineaId)) {
      const linea = await c.env.DB.prepare(
        `SELECT id, producto_id, cantidad_ped, cantidad_rec
         FROM sum_orden_lineas WHERE id = ? AND orden_id = ?`
      ).bind(lineaId, ordenId).first<LineaRec>();
      if (!linea) return c.json({ error: `línea no encontrada o no pertenece a esta orden: ${lineaId}` }, 400);
      lineaMap.set(lineaId, linea);
    }
    const linea = lineaMap.get(lineaId)!;
    if (linea.cantidad_rec + cantidadRecibir > linea.cantidad_ped) {
      return c.json({
        error: `línea ${lineaId}: excede cantidad pedida (pedido ${linea.cantidad_ped}, ya recibido ${linea.cantidad_rec}, solicita ${cantidadRecibir})`
      }, 400);
    }
  }

  // Phase 2: resolve/create sum_items and build the batch.
  const now = Date.now();
  const txId = uid('tx');
  const txCod = `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const stmts: D1PreparedStatement[] = [];
  const lineRows: { item_id: string; cantidad: number; linea_id: string }[] = [];

  for (const lbody of lineasBody) {
    const lineaId = str(lbody.linea_id, 40) as string;
    const linea = lineaMap.get(lineaId)!;
    const lote = str(lbody?.lote, 80);
    const cad = lbody?.caducidad_ms == null || lbody?.caducidad_ms === '' ? null : Number(lbody.caducidad_ms);
    const cantidadRecibir = qty(lbody.cantidad);

    // Resolve or create sum_items by (producto, lote, caducidad).
    const item = await c.env.DB.prepare(
      `SELECT id FROM sum_items WHERE producto_id = ?
         AND COALESCE(lote,'') = COALESCE(?,'') AND COALESCE(caducidad_ms,0) = COALESCE(?,0)`
    ).bind(linea.producto_id, lote, cad).first<{ id: string }>();
    let itemId = item?.id;
    if (!itemId) {
      itemId = uid('item');
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_items (id, producto_id, lote, caducidad_ms, created_ms) VALUES (?,?,?,?,?)`
      ).bind(itemId, linea.producto_id, lote, cad, now));
    }
    lineRows.push({ item_id: itemId, cantidad: cantidadRecibir, linea_id: lineaId });
  }

  // Tx header goes first (unshift after item inserts have been queued).
  stmts.unshift(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(txId, txCod, 'recepcion', orden.ubicacion_id, orden.codigo, str(b?.actor, 120), str(b?.nota, 1000), now));

  for (const lr of lineRows) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, lr.item_id, lr.cantidad, now));
    stmts.push(upsert(c.env.DB, orden.ubicacion_id, lr.item_id, lr.cantidad, now));
    stmts.push(c.env.DB.prepare(
      `UPDATE sum_orden_lineas SET cantidad_rec = cantidad_rec + ? WHERE id = ?`
    ).bind(lr.cantidad, lr.linea_id));
  }

  await c.env.DB.batch(stmts);

  // Advance estado based on whether all lines are now fully received.
  const { results: allLineas } = await c.env.DB.prepare(
    `SELECT cantidad_ped, cantidad_rec FROM sum_orden_lineas WHERE orden_id = ?`
  ).bind(ordenId).all<{ cantidad_ped: number; cantidad_rec: number }>();
  const fullyReceived = (allLineas ?? []).every(l => l.cantidad_rec >= l.cantidad_ped);
  if (fullyReceived) {
    await c.env.DB.prepare(
      `UPDATE sum_ordenes SET estado = 'recibida', recibida_ms = ?, updated_ms = ? WHERE id = ?`
    ).bind(now, now, ordenId).run();
  } else {
    await c.env.DB.prepare(
      `UPDATE sum_ordenes SET estado = 'recibida_parcial', updated_ms = ? WHERE id = ?`
    ).bind(now, ordenId).run();
  }

  const [ordenFinal, transaccion] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM sum_ordenes WHERE id = ?`).bind(ordenId).first(),
    c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first(),
  ]);
  return c.json({ orden: ordenFinal, transaccion }, 201);
});

// ── DELETE /:id — delete when not recibida or recibida_parcial ───────────────
sumOrdenes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const orden = await c.env.DB.prepare(`SELECT estado FROM sum_ordenes WHERE id = ?`)
    .bind(id).first<{ estado: string }>();
  if (!orden) return c.json({ error: 'no encontrado' }, 404);
  if (orden.estado === 'recibida' || orden.estado === 'recibida_parcial') {
    return c.json({ error: 'no se puede eliminar una orden ya recibida o en proceso de recepción' }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_orden_lineas WHERE orden_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_ordenes WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});
