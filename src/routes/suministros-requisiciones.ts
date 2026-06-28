import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Requisiciones (stock requests + fulfillment). Tables:
// sum_requisiciones + sum_requisicion_lineas. Fulfillment (`surtir`) allocates
// from the origin location FEFO (first-expiry-first-out) and emits a traslado
// transaction. Mounted at /api/suministros/requisiciones. Writes gated centrally.

export const sumRequisiciones = new Hono<{ Bindings: Env }>();

const ESTADOS = ['borrador', 'enviada', 'aprobada', 'surtida', 'cancelada'];
const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const qty = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const reqCode = () => `REQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const txCode = () => `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

const upsert = (db: D1Database, ubicacion: string, item: string, delta: number, now: number) =>
  db.prepare(
    `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(ubicacion_id, item_id)
       DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
  ).bind(ubicacion, item, delta, now);

// ── GET list ──────────────────────────────────────────────────────────────────
sumRequisiciones.get('/', async (c) => {
  const estado = c.req.query('estado');
  const ubicacion = c.req.query('ubicacion_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('r.estado = ?'); vals.push(estado); }
  if (ubicacion) { where.push('r.ubicacion_id = ?'); vals.push(ubicacion); }

  const sql = `SELECT r.*, u.nombre AS ubicacion_nombre, o.nombre AS origen_nombre,
      (SELECT COUNT(*) FROM sum_requisicion_lineas l WHERE l.requisicion_id = r.id) AS n_lineas
    FROM sum_requisiciones r
    LEFT JOIN sum_ubicaciones u ON u.id = r.ubicacion_id
    LEFT JOIN sum_ubicaciones o ON o.id = r.origen_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.prioridad, r.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST create (borrador + líneas) ───────────────────────────────────────────
sumRequisiciones.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const ubicacion = str(b?.ubicacion_id, 40);
  if (!ubicacion) return c.json({ error: 'ubicacion_id requerido' }, 400);
  const u = await c.env.DB.prepare(`SELECT 1 FROM sum_ubicaciones WHERE id = ?`).bind(ubicacion).first();
  if (!u) return c.json({ error: 'ubicación no encontrada' }, 400);
  const lineasIn = Array.isArray(b?.lineas) ? b.lineas : [];
  if (!lineasIn.length) return c.json({ error: 'sin líneas' }, 400);

  let prioridad = Number(b?.prioridad);
  if (!Number.isInteger(prioridad) || prioridad < 1 || prioridad > 5) prioridad = 3;

  const now = Date.now();
  const id = uid('req');
  const stmts: D1PreparedStatement[] = [c.env.DB.prepare(
    `INSERT INTO sum_requisiciones (id, codigo, ubicacion_id, estado, prioridad, solicitante, nota, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, reqCode(), ubicacion, 'borrador', prioridad, str(b?.solicitante, 160), str(b?.nota, 1000), now, now)];

  for (const ln of lineasIn) {
    const producto = str(ln?.producto_id, 40);
    const cant = qty(ln?.cantidad_sol ?? ln?.cantidad);
    if (!producto) return c.json({ error: 'producto_id requerido en cada línea' }, 400);
    if (!(cant > 0)) return c.json({ error: 'cantidad_sol debe ser > 0' }, 400);
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_requisicion_lineas (id, requisicion_id, producto_id, cantidad_sol, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('rql'), id, producto, cant, now));
  }
  await c.env.DB.batch(stmts);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_requisiciones WHERE id = ?`).bind(id).first();
  return c.json({ requisicion: row }, 201);
});

// ── GET one + líneas ──────────────────────────────────────────────────────────
sumRequisiciones.get('/:id', async (c) => {
  const id = c.req.param('id');
  const r = await c.env.DB.prepare(
    `SELECT r.*, u.nombre AS ubicacion_nombre, o.nombre AS origen_nombre
     FROM sum_requisiciones r
     LEFT JOIN sum_ubicaciones u ON u.id = r.ubicacion_id
     LEFT JOIN sum_ubicaciones o ON o.id = r.origen_id WHERE r.id = ?`
  ).bind(id).first();
  if (!r) return c.json({ error: 'no encontrado' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, p.nombre AS producto_nombre, p.codigo, p.unidad
     FROM sum_requisicion_lineas l JOIN sum_productos p ON p.id = l.producto_id
     WHERE l.requisicion_id = ? ORDER BY l.created_ms`
  ).bind(id).all();
  return c.json({ requisicion: r, lineas: results ?? [] });
});

// ── PATCH (estado workflow + origen_id + prioridad + meta) ─────────────────────
sumRequisiciones.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const cur = await c.env.DB.prepare(`SELECT * FROM sum_requisiciones WHERE id = ?`).bind(id).first<any>();
  if (!cur) return c.json({ error: 'no encontrado' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const now = Date.now();

  if (b?.estado != null) {
    if (!ESTADOS.includes(b.estado)) return c.json({ error: 'estado inválido' }, 400);
    if (cur.estado === 'surtida') return c.json({ error: 'una requisición surtida no se modifica' }, 409);
    sets.push('estado = ?'); vals.push(b.estado);
    if (b.estado === 'enviada' && !cur.enviada_ms) { sets.push('enviada_ms = ?'); vals.push(now); }
    if (b.estado === 'aprobada' && !cur.aprobada_ms) { sets.push('aprobada_ms = ?'); vals.push(now); }
  }
  if (b?.origen_id !== undefined) {
    const o = b.origen_id ? await c.env.DB.prepare(`SELECT 1 FROM sum_ubicaciones WHERE id = ?`).bind(b.origen_id).first() : true;
    if (b.origen_id && !o) return c.json({ error: 'origen no encontrado' }, 400);
    sets.push('origen_id = ?'); vals.push(str(b.origen_id, 40));
  }
  if (b?.prioridad !== undefined) {
    const p = Number(b.prioridad);
    if (!Number.isInteger(p) || p < 1 || p > 5) return c.json({ error: 'prioridad 1..5' }, 400);
    sets.push('prioridad = ?'); vals.push(p);
  }
  if (b?.solicitante !== undefined) { sets.push('solicitante = ?'); vals.push(str(b.solicitante, 160)); }
  if (b?.nota !== undefined) { sets.push('nota = ?'); vals.push(str(b.nota, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(now);
  vals.push(id);
  await c.env.DB.prepare(`UPDATE sum_requisiciones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  const row = await c.env.DB.prepare(`SELECT * FROM sum_requisiciones WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// ── POST /:id/surtir — FEFO allocate from origen → emit traslado, mark surtida ─
sumRequisiciones.post('/:id/surtir', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const req = await c.env.DB.prepare(`SELECT * FROM sum_requisiciones WHERE id = ?`).bind(id).first<any>();
  if (!req) return c.json({ error: 'no encontrado' }, 404);
  if (req.estado === 'surtida') return c.json({ error: 'ya surtida' }, 409);
  if (req.estado === 'cancelada') return c.json({ error: 'requisición cancelada' }, 409);

  const origen = str(b?.origen_id, 40) ?? req.origen_id;
  if (!origen) return c.json({ error: 'origen_id requerido (asigna un origen de surtido)' }, 400);
  if (origen === req.ubicacion_id) return c.json({ error: 'origen y destino deben diferir' }, 400);
  if (!(await c.env.DB.prepare(`SELECT 1 FROM sum_ubicaciones WHERE id = ?`).bind(origen).first()))
    return c.json({ error: 'origen no encontrado' }, 400);

  const { results: lineas } = await c.env.DB.prepare(
    `SELECT l.*, p.nombre AS producto_nombre FROM sum_requisicion_lineas l
     JOIN sum_productos p ON p.id = l.producto_id WHERE l.requisicion_id = ?`
  ).bind(id).all<any>();
  if (!lineas?.length) return c.json({ error: 'requisición sin líneas' }, 400);

  const now = Date.now();
  const txId = uid('tx');
  const stmts: D1PreparedStatement[] = [];
  const faltantes: { producto_id: string; producto_nombre: string; faltante: number }[] = [];
  let anyAllocated = false;
  let allComplete = true;

  for (const ln of lineas) {
    let remaining = (ln.cantidad_sol ?? 0) - (ln.cantidad_surt ?? 0);
    if (remaining <= 0) continue;
    // FEFO: pull the soonest-expiring lots at origen first.
    const { results: lots } = await c.env.DB.prepare(
      `SELECT e.item_id, e.cantidad FROM sum_existencias e
       JOIN sum_items i ON i.id = e.item_id
       WHERE e.ubicacion_id = ? AND i.producto_id = ? AND e.cantidad > 0
       ORDER BY (i.caducidad_ms IS NULL), i.caducidad_ms`
    ).bind(origen, ln.producto_id).all<{ item_id: string; cantidad: number }>();

    let allocatedLine = 0;
    for (const lot of lots ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.cantidad);
      if (take <= 0) continue;
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
      ).bind(uid('txl'), txId, lot.item_id, -take, now));
      stmts.push(upsert(c.env.DB, origen, lot.item_id, -take, now));
      stmts.push(upsert(c.env.DB, req.ubicacion_id, lot.item_id, take, now));
      remaining -= take;
      allocatedLine += take;
    }
    if (allocatedLine > 0) {
      anyAllocated = true;
      stmts.push(c.env.DB.prepare(
        `UPDATE sum_requisicion_lineas SET cantidad_surt = cantidad_surt + ? WHERE id = ?`
      ).bind(allocatedLine, ln.id));
    }
    if (remaining > 0) {
      allComplete = false;
      faltantes.push({ producto_id: ln.producto_id, producto_nombre: ln.producto_nombre, faltante: remaining });
    }
  }

  if (!anyAllocated) {
    return c.json({ error: 'sin existencias en el origen para surtir', faltantes }, 409);
  }

  // Prepend the transaction header now that we know there is something to ship.
  stmts.unshift(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, ubicacion_dest_id, referencia, requisicion_id, actor, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(txId, txCode(), 'traslado', origen, req.ubicacion_id, req.codigo, id, str(b?.actor, 120), now));

  const nuevoEstado = allComplete ? 'surtida' : 'aprobada';
  stmts.push(c.env.DB.prepare(
    `UPDATE sum_requisiciones SET origen_id = ?, estado = ?, surtida_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(origen, nuevoEstado, allComplete ? now : req.surtida_ms, now, id));

  await c.env.DB.batch(stmts);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_requisiciones WHERE id = ?`).bind(id).first();
  const tx = await c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first();
  return c.json({ requisicion: row, transaccion: tx, faltantes, completa: allComplete });
});

// ── DELETE (only non-surtida) ─────────────────────────────────────────────────
sumRequisiciones.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const cur = await c.env.DB.prepare(`SELECT estado FROM sum_requisiciones WHERE id = ?`).bind(id).first<{ estado: string }>();
  if (!cur) return c.json({ error: 'no encontrado' }, 404);
  if (cur.estado === 'surtida') return c.json({ error: 'una requisición surtida no se elimina' }, 409);
  await c.env.DB.prepare(`DELETE FROM sum_requisicion_lineas WHERE requisicion_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM sum_requisiciones WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, id });
});
