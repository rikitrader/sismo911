import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Picklists (hojas de picking para recoger y despachar ítems desde una ubicación).
// Tables: sum_picklists, sum_picklist_lineas. completar emits DESPACHO via D1 batch().
// Mounted at /api/suministros/picklists. Writes gated centrally; GET public.

export const sumPicklists = new Hono<{ Bindings: Env }>();

const ESTADOS = ['pendiente', 'en_proceso', 'completada', 'cancelada'];
const ESTADOS_MODIFICABLES = ['pendiente', 'en_proceso'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const qty = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const pickCode = () => `PICK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const txCode   = () => `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Per-(ubicacion,item) delta upsert — same ON CONFLICT pattern as movimientos/ordenes.
const upsert = (db: D1Database, ubicacion: string, item: string, delta: number, now: number) =>
  db.prepare(
    `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(ubicacion_id, item_id)
       DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
  ).bind(ubicacion, item, delta, now);

// ── GET / — list picklists ────────────────────────────────────────────────────
sumPicklists.get('/', async (c) => {
  const estado      = c.req.query('estado');
  const ubicacionId = c.req.query('ubicacion_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('p.estado = ?'); vals.push(estado); }
  if (ubicacionId) { where.push('p.ubicacion_id = ?'); vals.push(ubicacionId); }

  const sql = `SELECT p.*,
      u.nombre AS ubicacion_nombre,
      (SELECT COUNT(*) FROM sum_picklist_lineas l WHERE l.picklist_id = p.id) AS n_lineas
    FROM sum_picklists p
    LEFT JOIN sum_ubicaciones u ON u.id = p.ubicacion_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST / — create picklist (estado 'pendiente') ─────────────────────────────
sumPicklists.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);

  const ubicacionId = str(b?.ubicacion_id, 40);
  if (!ubicacionId) return c.json({ error: 'ubicacion_id requerido' }, 400);
  const ubi = await c.env.DB.prepare(`SELECT id FROM sum_ubicaciones WHERE id = ?`).bind(ubicacionId).first();
  if (!ubi) return c.json({ error: 'ubicacion_id no encontrado' }, 404);

  const lineasIn: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  for (const ln of lineasIn) {
    const itemId = str(ln?.item_id, 40);
    if (!itemId) return c.json({ error: 'item_id requerido en cada línea' }, 400);
    if (!(qty(ln?.cantidad_sol) > 0)) return c.json({ error: 'cantidad_sol debe ser > 0 en cada línea' }, 400);
    const item = await c.env.DB.prepare(`SELECT id FROM sum_items WHERE id = ?`).bind(itemId).first();
    if (!item) return c.json({ error: `item no encontrado: ${itemId}` }, 404);
  }

  const now = Date.now();
  const id = uid('pck');
  const codigo = pickCode();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_picklists
       (id, codigo, ubicacion_id, requisicion_id, referencia, estado, asignado_a, nota, completada_ms, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, ubicacionId,
    str(b?.requisicion_id, 40), str(b?.referencia, 200),
    'pendiente',
    str(b?.asignado_a, 160), str(b?.nota, 1000), null, now, now
  ));

  for (const ln of lineasIn) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_picklist_lineas (id, picklist_id, item_id, cantidad_sol, created_ms)
       VALUES (?,?,?,?,?)`
    ).bind(uid('pkl'), id, str(ln.item_id, 40), qty(ln.cantidad_sol), now));
  }

  await c.env.DB.batch(stmts);
  const picklist = await c.env.DB.prepare(`SELECT * FROM sum_picklists WHERE id = ?`).bind(id).first();
  return c.json({ picklist }, 201);
});

// ── GET /:id — picklist + líneas con detalle de ítem/producto y disponible ────
sumPicklists.get('/:id', async (c) => {
  const id = c.req.param('id');
  const picklist = await c.env.DB.prepare(
    `SELECT p.*, u.nombre AS ubicacion_nombre
     FROM sum_picklists p
     LEFT JOIN sum_ubicaciones u ON u.id = p.ubicacion_id
     WHERE p.id = ?`
  ).bind(id).first<{ id: string; ubicacion_id: string } & Record<string, unknown>>();
  if (!picklist) return c.json({ error: 'no encontrado' }, 404);
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT l.*,
       pr.nombre AS producto_nombre, pr.codigo, pr.unidad,
       i.lote, i.caducidad_ms,
       COALESCE(e.cantidad, 0) AS disponible
     FROM sum_picklist_lineas l
     JOIN sum_items i ON i.id = l.item_id
     JOIN sum_productos pr ON pr.id = i.producto_id
     LEFT JOIN sum_existencias e ON e.ubicacion_id = ? AND e.item_id = l.item_id
     WHERE l.picklist_id = ? ORDER BY l.created_ms`
  ).bind(picklist.ubicacion_id, id).all();
  return c.json({ picklist, lineas: lineas ?? [] });
});

// ── PATCH /:id — estado (pendiente↔en_proceso, →cancelada) / asignado_a / nota ─
sumPicklists.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const existing = await c.env.DB.prepare(
    `SELECT estado FROM sum_picklists WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!existing) return c.json({ error: 'no encontrado' }, 404);
  if (existing.estado === 'completada') {
    return c.json({ error: 'la picklist ya fue completada; no se puede modificar' }, 409);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const now = Date.now();

  if (b?.estado != null) {
    const nuevoEstado = String(b.estado);
    if (!ESTADOS.includes(nuevoEstado)) return c.json({ error: 'estado inválido' }, 400);
    if (nuevoEstado === 'completada') {
      return c.json({ error: 'usa el endpoint /completar para completar la picklist' }, 400);
    }
    const transicionesValidas: Record<string, string[]> = {
      pendiente:  ['en_proceso', 'cancelada'],
      en_proceso: ['pendiente',  'cancelada'],
      cancelada:  [],
    };
    const permitidos = transicionesValidas[existing.estado] ?? [];
    if (!permitidos.includes(nuevoEstado)) {
      return c.json({ error: `no se puede pasar de '${existing.estado}' a '${nuevoEstado}'` }, 409);
    }
    sets.push('estado = ?'); vals.push(nuevoEstado);
  }
  if (b?.asignado_a !== undefined) { sets.push('asignado_a = ?'); vals.push(str(b.asignado_a, 160)); }
  if (b?.nota !== undefined)       { sets.push('nota = ?');       vals.push(str(b.nota, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(now);
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_picklists SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_picklists WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// ── POST /:id/pick — registrar cantidades recogidas ───────────────────────────
sumPicklists.post('/:id/pick', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);

  const picklist = await c.env.DB.prepare(`SELECT * FROM sum_picklists WHERE id = ?`)
    .bind(id).first<{ id: string; estado: string; ubicacion_id: string }>();
  if (!picklist) return c.json({ error: 'no encontrado' }, 404);
  if (!ESTADOS_MODIFICABLES.includes(picklist.estado)) {
    return c.json({ error: `picklist en estado '${picklist.estado}'; no se pueden registrar picks` }, 409);
  }

  const lineasBody: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  if (!lineasBody.length) return c.json({ error: 'sin líneas' }, 400);

  const stmts: D1PreparedStatement[] = [];
  const now = Date.now();

  for (const lb of lineasBody) {
    const lineaId = str(lb?.linea_id, 40);
    if (!lineaId) return c.json({ error: 'linea_id requerido en cada línea' }, 400);
    const cantPick = qty(lb?.cantidad_pick);
    if (!Number.isFinite(cantPick) || cantPick < 0) {
      return c.json({ error: `línea ${lineaId}: cantidad_pick debe ser ≥ 0` }, 400);
    }

    const linea = await c.env.DB.prepare(
      `SELECT id, item_id, cantidad_sol FROM sum_picklist_lineas WHERE id = ? AND picklist_id = ?`
    ).bind(lineaId, id).first<{ id: string; item_id: string; cantidad_sol: number }>();
    if (!linea) return c.json({ error: `línea no encontrada o no pertenece a esta picklist: ${lineaId}` }, 400);

    if (cantPick > linea.cantidad_sol) {
      return c.json({
        error: `línea ${lineaId}: cantidad_pick (${cantPick}) excede cantidad_sol (${linea.cantidad_sol})`
      }, 400);
    }

    const ex = await c.env.DB.prepare(
      `SELECT COALESCE(cantidad, 0) AS cantidad FROM sum_existencias WHERE ubicacion_id = ? AND item_id = ?`
    ).bind(picklist.ubicacion_id, linea.item_id).first<{ cantidad: number }>();
    const disponible = ex?.cantidad ?? 0;
    if (cantPick > disponible) {
      return c.json({
        error: `línea ${lineaId}: cantidad_pick (${cantPick}) excede disponible en ubicación (${disponible})`
      }, 409);
    }

    stmts.push(c.env.DB.prepare(
      `UPDATE sum_picklist_lineas SET cantidad_pick = ? WHERE id = ?`
    ).bind(cantPick, lineaId));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE sum_picklists SET estado = 'en_proceso', updated_ms = ? WHERE id = ?`
  ).bind(now, id));

  await c.env.DB.batch(stmts);

  const picklistFinal = await c.env.DB.prepare(`SELECT * FROM sum_picklists WHERE id = ?`).bind(id).first();
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT * FROM sum_picklist_lineas WHERE picklist_id = ? ORDER BY created_ms`
  ).bind(id).all();
  return c.json({ picklist: picklistFinal, lineas: lineas ?? [] });
});

// ── POST /:id/completar — emite DESPACHO por las cantidades recogidas ─────────
sumPicklists.post('/:id/completar', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);

  const picklist = await c.env.DB.prepare(`SELECT * FROM sum_picklists WHERE id = ?`)
    .bind(id).first<{ id: string; codigo: string; estado: string; ubicacion_id: string }>();
  if (!picklist) return c.json({ error: 'no encontrado' }, 404);
  if (!ESTADOS_MODIFICABLES.includes(picklist.estado)) {
    return c.json({ error: `picklist en estado '${picklist.estado}'; no se puede completar` }, 409);
  }

  const { results: todasLineas } = await c.env.DB.prepare(
    `SELECT id, item_id, cantidad_pick FROM sum_picklist_lineas WHERE picklist_id = ? ORDER BY created_ms`
  ).bind(id).all<{ id: string; item_id: string; cantidad_pick: number }>();

  const lineasActivas = (todasLineas ?? []).filter(l => l.cantidad_pick > 0);
  if (!lineasActivas.length) {
    return c.json({ error: 'sin líneas con cantidad_pick > 0; use /pick primero' }, 400);
  }

  // Validate disponible >= cantidad_pick at origin before building the batch.
  for (const ln of lineasActivas) {
    const ex = await c.env.DB.prepare(
      `SELECT COALESCE(cantidad, 0) AS cantidad FROM sum_existencias WHERE ubicacion_id = ? AND item_id = ?`
    ).bind(picklist.ubicacion_id, ln.item_id).first<{ cantidad: number }>();
    const disponible = ex?.cantidad ?? 0;
    if (disponible < ln.cantidad_pick) {
      return c.json({
        error: `item ${ln.item_id}: existencia insuficiente (disponible ${disponible}, pick ${ln.cantidad_pick})`
      }, 409);
    }
  }

  const now = Date.now();
  const txId  = uid('tx');
  const txCod = txCode();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(txId, txCod, 'despacho', picklist.ubicacion_id, picklist.codigo, str(b?.actor, 120), str(b?.nota, 1000), now));

  for (const ln of lineasActivas) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, ln.item_id, -ln.cantidad_pick, now));
    stmts.push(upsert(c.env.DB, picklist.ubicacion_id, ln.item_id, -ln.cantidad_pick, now));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE sum_picklists SET estado = 'completada', completada_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(now, now, id));

  await c.env.DB.batch(stmts);

  const [picklistFinal, transaccion] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM sum_picklists WHERE id = ?`).bind(id).first(),
    c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first(),
  ]);
  return c.json({ picklist: picklistFinal, transaccion }, 201);
});

// ── DELETE /:id — eliminar cuando no está completada ─────────────────────────
sumPicklists.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const picklist = await c.env.DB.prepare(`SELECT estado FROM sum_picklists WHERE id = ?`)
    .bind(id).first<{ estado: string }>();
  if (!picklist) return c.json({ error: 'no encontrado' }, 404);
  if (picklist.estado === 'completada') {
    return c.json({ error: 'no se puede eliminar una picklist ya completada' }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_picklist_lineas WHERE picklist_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_picklists WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});
