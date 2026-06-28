import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Donaciones (donation registry + receipt into stock).
// Tables: sum_donaciones + sum_donacion_lineas, mutating sum_existencias via D1 batch().
// Mounted at /api/suministros/donaciones. Writes gated centrally; GET public.

export const sumDonaciones = new Hono<{ Bindings: Env }>();

const TIPOS_DONANTE = ['individual', 'empresa', 'ong', 'gobierno', 'internacional'];
const ESTADOS = ['registrada', 'recibida', 'cancelada'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const qty = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const donCode = () => `DON-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Per-(ubicacion,item) delta upsert — same ON CONFLICT pattern as movimientos.
const upsert = (db: D1Database, ubicacion: string, item: string, delta: number, now: number) =>
  db.prepare(
    `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(ubicacion_id, item_id)
       DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
  ).bind(ubicacion, item, delta, now);

// ── GET / — list donaciones ───────────────────────────────────────────────────
sumDonaciones.get('/', async (c) => {
  const estado = c.req.query('estado');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('d.estado = ?'); vals.push(estado); }

  const sql = `SELECT d.*,
      u.nombre AS ubicacion_nombre,
      (SELECT COUNT(*) FROM sum_donacion_lineas l WHERE l.donacion_id = d.id) AS n_lineas
    FROM sum_donaciones d
    LEFT JOIN sum_ubicaciones u ON u.id = d.ubicacion_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST / — create donacion + líneas ─────────────────────────────────────────
sumDonaciones.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const donante = str(b?.donante, 200);
  if (!donante) return c.json({ error: 'donante requerido' }, 400);
  const ubicacion = str(b?.ubicacion_id, 40);
  if (!ubicacion) return c.json({ error: 'ubicacion_id requerido' }, 400);
  const ubi = await c.env.DB.prepare(`SELECT id FROM sum_ubicaciones WHERE id = ?`).bind(ubicacion).first();
  if (!ubi) return c.json({ error: 'ubicacion_id no encontrado' }, 400);
  const tipo_donante = str(b?.tipo_donante, 40) ?? 'individual';
  if (!TIPOS_DONANTE.includes(tipo_donante)) return c.json({ error: 'tipo_donante inválido' }, 400);

  const lineasIn: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  for (const ln of lineasIn) {
    const pid = str(ln?.producto_id, 40);
    if (!pid) return c.json({ error: 'producto_id requerido en cada línea' }, 400);
    if (!(qty(ln?.cantidad) > 0)) return c.json({ error: 'cantidad debe ser > 0 en cada línea' }, 400);
    const prod = await c.env.DB.prepare(`SELECT id FROM sum_productos WHERE id = ?`).bind(pid).first();
    if (!prod) return c.json({ error: `producto no encontrado: ${pid}` }, 400);
  }

  const now = Date.now();
  const id = uid('don');
  const codigo = donCode();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_donaciones
       (id, codigo, donante, tipo_donante, ubicacion_id, referencia, estado, valor_estimado, moneda, nota, actor, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, donante, tipo_donante, ubicacion,
    str(b?.referencia, 200), 'registrada',
    num(b?.valor_estimado), str(b?.moneda, 10) ?? 'USD',
    str(b?.nota, 1000), str(b?.actor, 120), now, now
  ));

  for (const ln of lineasIn) {
    const cad = ln?.caducidad_ms == null || ln?.caducidad_ms === '' ? null : Number(ln.caducidad_ms);
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_donacion_lineas (id, donacion_id, producto_id, lote, caducidad_ms, cantidad, valor_unitario, created_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(uid('dol'), id, str(ln.producto_id, 40), str(ln?.lote, 80), cad, qty(ln.cantidad), num(ln?.valor_unitario), now));
  }

  await c.env.DB.batch(stmts);
  const donacion = await c.env.DB.prepare(`SELECT * FROM sum_donaciones WHERE id = ?`).bind(id).first();
  return c.json({ donacion }, 201);
});

// ── GET /:id — one donacion + líneas ─────────────────────────────────────────
sumDonaciones.get('/:id', async (c) => {
  const id = c.req.param('id');
  const donacion = await c.env.DB.prepare(
    `SELECT d.*, u.nombre AS ubicacion_nombre
     FROM sum_donaciones d
     LEFT JOIN sum_ubicaciones u ON u.id = d.ubicacion_id
     WHERE d.id = ?`
  ).bind(id).first();
  if (!donacion) return c.json({ error: 'no encontrado' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, p.nombre AS producto_nombre, p.codigo, p.unidad
     FROM sum_donacion_lineas l
     JOIN sum_productos p ON p.id = l.producto_id
     WHERE l.donacion_id = ? ORDER BY l.created_ms`
  ).bind(id).all();
  return c.json({ donacion, lineas: results ?? [] });
});

// ── PATCH /:id — update mutable fields (blocked once recibida) ────────────────
sumDonaciones.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const existing = await c.env.DB.prepare(
    `SELECT estado FROM sum_donaciones WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!existing) return c.json({ error: 'no encontrado' }, 404);
  if (existing.estado === 'recibida') return c.json({ error: 'la donación ya fue recibida; no se puede modificar' }, 409);

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.estado != null) {
    if (!ESTADOS.includes(b.estado)) return c.json({ error: 'estado inválido' }, 400);
    if (b.estado === 'recibida') return c.json({ error: 'usa el endpoint /recibir para marcar como recibida' }, 400);
    sets.push('estado = ?'); vals.push(b.estado);
  }
  if (b?.donante != null) {
    const d = str(b.donante, 200);
    if (!d) return c.json({ error: 'donante inválido' }, 400);
    sets.push('donante = ?'); vals.push(d);
  }
  if (b?.nota !== undefined) { sets.push('nota = ?'); vals.push(str(b.nota, 1000)); }
  if (b?.valor_estimado !== undefined) { sets.push('valor_estimado = ?'); vals.push(num(b.valor_estimado)); }
  if (b?.tipo_donante != null) {
    if (!TIPOS_DONANTE.includes(b.tipo_donante)) return c.json({ error: 'tipo_donante inválido' }, 400);
    sets.push('tipo_donante = ?'); vals.push(b.tipo_donante);
  }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  await c.env.DB.prepare(`UPDATE sum_donaciones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  const row = await c.env.DB.prepare(`SELECT * FROM sum_donaciones WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// ── POST /:id/recibir — receive donation into stock ───────────────────────────
// Mirrors the RECEPCIÓN pattern from suministros-movimientos.ts:
//   resolve-or-create sum_items per línea (COALESCE match), then ONE D1 batch:
//   [tx_header, new_item_inserts?, tx_lineas + existencias_upserts, donacion_update].
sumDonaciones.post('/:id/recibir', async (c) => {
  const donId = c.req.param('id');
  const b = await c.req.json().catch(() => null);

  const don = await c.env.DB.prepare(`SELECT * FROM sum_donaciones WHERE id = ?`)
    .bind(donId).first<{ id: string; codigo: string; estado: string; ubicacion_id: string }>();
  if (!don) return c.json({ error: 'no encontrado' }, 404);
  if (don.estado !== 'registrada') {
    return c.json({ error: `la donación está en estado '${don.estado}'; solo 'registrada' puede recibirse` }, 409);
  }

  const { results: lineas } = await c.env.DB.prepare(
    `SELECT producto_id, lote, caducidad_ms, cantidad FROM sum_donacion_lineas WHERE donacion_id = ?`
  ).bind(donId).all<{ producto_id: string; lote: string | null; caducidad_ms: number | null; cantidad: number }>();
  if (!lineas?.length) return c.json({ error: 'la donación no tiene líneas' }, 400);

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const txId = uid('tx');
  const txCod = `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const lineRows: { item_id: string; cantidad: number }[] = [];

  // Resolve (or create) a sum_items row per línea by (producto, lote, caducidad).
  for (const ln of lineas) {
    const lote = ln.lote ?? null;
    const cad = ln.caducidad_ms ?? null;
    const item = await c.env.DB.prepare(
      `SELECT id FROM sum_items WHERE producto_id = ?
         AND COALESCE(lote,'') = COALESCE(?,'') AND COALESCE(caducidad_ms,0) = COALESCE(?,0)`
    ).bind(ln.producto_id, lote, cad).first<{ id: string }>();
    let itemId = item?.id;
    if (!itemId) {
      itemId = uid('item');
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_items (id, producto_id, lote, caducidad_ms, created_ms) VALUES (?,?,?,?,?)`
      ).bind(itemId, ln.producto_id, lote, cad, now));
    }
    lineRows.push({ item_id: itemId, cantidad: ln.cantidad });
  }

  // Prepend the transaction header (item inserts, if any, follow at index 1+).
  stmts.unshift(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(txId, txCod, 'recepcion', don.ubicacion_id, don.codigo, str(b?.actor, 120), str(b?.nota, 1000), now));

  for (const lr of lineRows) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, lr.item_id, lr.cantidad, now));
    stmts.push(upsert(c.env.DB, don.ubicacion_id, lr.item_id, lr.cantidad, now));
  }

  // Mark the donation received in the same batch.
  stmts.push(c.env.DB.prepare(
    `UPDATE sum_donaciones SET estado = 'recibida', recibida_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(now, now, donId));

  await c.env.DB.batch(stmts);

  const [donacion, transaccion] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM sum_donaciones WHERE id = ?`).bind(donId).first(),
    c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first(),
  ]);
  return c.json({ donacion, transaccion }, 201);
});

// ── DELETE /:id — delete when not recibida ────────────────────────────────────
sumDonaciones.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const don = await c.env.DB.prepare(`SELECT estado FROM sum_donaciones WHERE id = ?`)
    .bind(id).first<{ estado: string }>();
  if (!don) return c.json({ error: 'no encontrado' }, 404);
  if (don.estado === 'recibida') return c.json({ error: 'la donación ya fue recibida; no se puede eliminar' }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_donacion_lineas WHERE donacion_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_donaciones WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});
