import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Envíos (two-step inter-location shipment).
// Mounted at /api/suministros/envios. Writes gated centrally; GET public.
//
// Stock lifecycle:
//   pendiente → [POST /despachar] → despachado  (−origen, stock in transit)
//             → [PATCH estado=en_transito]       (optional, in-transit marker)
//             → [POST /recibir]  → recibido      (+destino, stock at destination)
//
// despachar + recibir together equal a traslado split across time.
// Each action touches ONLY ONE location — never both in the same batch.

export const sumEnvios = new Hono<{ Bindings: Env }>();

const ESTADOS           = ['pendiente', 'despachado', 'en_transito', 'recibido', 'cancelado'];
const TIPOS_CONTENEDOR  = ['caja', 'pallet', 'saco', 'nevera', 'bidon'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const qty = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const envCode = () => `ENV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const txCode  = () => `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Per-(ubicacion,item) delta upsert — same ON CONFLICT pattern as movimientos/ordenes.
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

// ── GET / — list envíos ────────────────────────────────────────────────────────
sumEnvios.get('/', async (c) => {
  const estado   = c.req.query('estado');
  const origenId = c.req.query('origen_id');
  const destId   = c.req.query('destino_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals:  unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('e.estado = ?');    vals.push(estado); }
  if (origenId)                           { where.push('e.origen_id = ?');  vals.push(origenId); }
  if (destId)                             { where.push('e.destino_id = ?'); vals.push(destId); }

  const sql = `SELECT e.*,
      uo.nombre AS origen_nombre,
      ud.nombre AS destino_nombre,
      m.nombre  AS metodo_nombre,
      (SELECT COUNT(*) FROM sum_envio_lineas        l  WHERE l.envio_id  = e.id) AS n_lineas,
      (SELECT COUNT(*) FROM sum_envio_contenedores  ct WHERE ct.envio_id = e.id) AS n_contenedores
    FROM sum_envios e
    LEFT JOIN sum_ubicaciones   uo ON uo.id = e.origen_id
    LEFT JOIN sum_ubicaciones   ud ON ud.id = e.destino_id
    LEFT JOIN sum_metodos_envio m  ON m.id  = e.metodo_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST / — create envío (estado='pendiente') ────────────────────────────────
sumEnvios.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);

  const origenId = str(b?.origen_id, 40);
  if (!origenId) return c.json({ error: 'origen_id requerido' }, 400);
  const destId = str(b?.destino_id, 40);
  if (!destId) return c.json({ error: 'destino_id requerido' }, 400);
  if (origenId === destId) return c.json({ error: 'origen y destino deben diferir' }, 400);

  const origen = await c.env.DB.prepare(`SELECT id FROM sum_ubicaciones WHERE id = ?`).bind(origenId).first();
  if (!origen) return c.json({ error: 'origen_id no encontrado' }, 404);
  const dest = await c.env.DB.prepare(`SELECT id FROM sum_ubicaciones WHERE id = ?`).bind(destId).first();
  if (!dest) return c.json({ error: 'destino_id no encontrado' }, 404);

  const metodoId = str(b?.metodo_id, 40);
  if (metodoId) {
    const m = await c.env.DB.prepare(`SELECT id FROM sum_metodos_envio WHERE id = ?`).bind(metodoId).first();
    if (!m) return c.json({ error: 'metodo_id no encontrado' }, 404);
  }

  const contenedoresIn: any[] = Array.isArray(b?.contenedores) ? b.contenedores : [];
  const lineasIn:       any[] = Array.isArray(b?.lineas)       ? b.lineas       : [];

  // Validate contenedor tipos.
  for (const ct of contenedoresIn) {
    const tipo = str(ct?.tipo, 20) ?? 'caja';
    if (!TIPOS_CONTENEDOR.includes(tipo)) {
      return c.json({ error: `tipo de contenedor inválido '${tipo}'; opciones: ${TIPOS_CONTENEDOR.join(', ')}` }, 400);
    }
  }

  // Validate líneas (item exists, cantidad > 0, contenedor_idx in range).
  for (const ln of lineasIn) {
    const itemId = str(ln?.item_id, 40);
    if (!itemId) return c.json({ error: 'item_id requerido en cada línea' }, 400);
    if (!(qty(ln?.cantidad) > 0)) return c.json({ error: 'cantidad debe ser > 0 en cada línea' }, 400);
    const it = await c.env.DB.prepare(`SELECT id FROM sum_items WHERE id = ?`).bind(itemId).first();
    if (!it) return c.json({ error: `item no encontrado: ${itemId}` }, 404);
    if (ln.contenedor_idx != null) {
      const idx = Number(ln.contenedor_idx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= contenedoresIn.length) {
        return c.json({ error: `contenedor_idx ${ln.contenedor_idx} fuera de rango` }, 400);
      }
    }
  }

  const now     = Date.now();
  const envioId = uid('env');
  const codigo  = envCode();
  const stmts:  D1PreparedStatement[] = [];

  // Pre-assign container ids so líneas can reference them by array index.
  const contIds = contenedoresIn.map(() => uid('cont'));

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_envios
       (id, codigo, origen_id, destino_id, metodo_id, estado, num_referencia, transportista, nota, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    envioId, codigo, origenId, destId, metodoId, 'pendiente',
    str(b?.num_referencia, 200), str(b?.transportista, 160), str(b?.nota, 1000),
    now, now
  ));

  for (let i = 0; i < contenedoresIn.length; i++) {
    const ct   = contenedoresIn[i];
    const tipo = str(ct?.tipo, 20) ?? 'caja';
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_envio_contenedores (id, envio_id, tipo, codigo, descripcion, created_ms)
       VALUES (?,?,?,?,?,?)`
    ).bind(contIds[i], envioId, tipo, str(ct?.codigo, 80), str(ct?.descripcion, 400), now));
  }

  for (const ln of lineasIn) {
    const contId = ln.contenedor_idx != null ? contIds[Number(ln.contenedor_idx)] : null;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_envio_lineas (id, envio_id, contenedor_id, item_id, cantidad, created_ms)
       VALUES (?,?,?,?,?,?)`
    ).bind(uid('envl'), envioId, contId, str(ln.item_id, 40), qty(ln.cantidad), now));
  }

  await c.env.DB.batch(stmts);
  const envio = await c.env.DB.prepare(`SELECT * FROM sum_envios WHERE id = ?`).bind(envioId).first();
  return c.json({ envio }, 201);
});

// ── GET /:id — one envío + contenedores + líneas ──────────────────────────────
sumEnvios.get('/:id', async (c) => {
  const id = c.req.param('id');
  const envio = await c.env.DB.prepare(
    `SELECT e.*,
       uo.nombre AS origen_nombre,
       ud.nombre AS destino_nombre,
       m.nombre  AS metodo_nombre
     FROM sum_envios e
     LEFT JOIN sum_ubicaciones   uo ON uo.id = e.origen_id
     LEFT JOIN sum_ubicaciones   ud ON ud.id = e.destino_id
     LEFT JOIN sum_metodos_envio m  ON m.id  = e.metodo_id
     WHERE e.id = ?`
  ).bind(id).first();
  if (!envio) return c.json({ error: 'no encontrado' }, 404);

  const { results: contenedores } = await c.env.DB.prepare(
    `SELECT * FROM sum_envio_contenedores WHERE envio_id = ? ORDER BY created_ms`
  ).bind(id).all();

  const { results: lineas } = await c.env.DB.prepare(
    `SELECT l.*, p.nombre AS producto_nombre, p.codigo, p.unidad,
            i.lote, i.caducidad_ms,
            ct.codigo AS contenedor_codigo
     FROM sum_envio_lineas l
     JOIN sum_items i ON i.id = l.item_id
     JOIN sum_productos p ON p.id = i.producto_id
     LEFT JOIN sum_envio_contenedores ct ON ct.id = l.contenedor_id
     WHERE l.envio_id = ? ORDER BY l.created_ms`
  ).bind(id).all();

  return c.json({ envio, contenedores: contenedores ?? [], lineas: lineas ?? [] });
});

// ── PATCH /:id — mutable fields + optional en_transito transition ─────────────
sumEnvios.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b  = await c.req.json().catch(() => null);
  const existing = await c.env.DB.prepare(
    `SELECT estado FROM sum_envios WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!existing) return c.json({ error: 'no encontrado' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const now = Date.now();

  if (b?.estado !== undefined) {
    if (b.estado !== 'en_transito') {
      return c.json({ error: "solo se puede cambiar estado a 'en_transito' mediante PATCH (desde 'despachado')" }, 400);
    }
    if (existing.estado !== 'despachado') {
      return c.json({ error: `estado '${existing.estado}' no admite transición a en_transito; debe estar despachado` }, 409);
    }
    sets.push('estado = ?'); vals.push('en_transito');
  }
  if (b?.metodo_id !== undefined) {
    const mid = str(b.metodo_id, 40);
    if (mid) {
      const m = await c.env.DB.prepare(`SELECT id FROM sum_metodos_envio WHERE id = ?`).bind(mid).first();
      if (!m) return c.json({ error: 'metodo_id no encontrado' }, 404);
    }
    sets.push('metodo_id = ?'); vals.push(mid);
  }
  if (b?.num_referencia !== undefined) { sets.push('num_referencia = ?'); vals.push(str(b.num_referencia, 200)); }
  if (b?.transportista  !== undefined) { sets.push('transportista = ?');  vals.push(str(b.transportista, 160)); }
  if (b?.nota           !== undefined) { sets.push('nota = ?');           vals.push(str(b.nota, 1000)); }
  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);

  sets.push('updated_ms = ?'); vals.push(now); vals.push(id);
  await c.env.DB.prepare(`UPDATE sum_envios SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return c.json(await c.env.DB.prepare(`SELECT * FROM sum_envios WHERE id = ?`).bind(id).first());
});

// ── POST /:id/contenedores — add a container to a pending/dispatched envío ─────
sumEnvios.post('/:id/contenedores', async (c) => {
  const id = c.req.param('id');
  const b  = await c.req.json().catch(() => null);
  const envio = await c.env.DB.prepare(
    `SELECT estado FROM sum_envios WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!envio) return c.json({ error: 'no encontrado' }, 404);
  if (!['pendiente', 'despachado'].includes(envio.estado)) {
    return c.json({ error: `no se puede agregar contenedores en estado '${envio.estado}'` }, 409);
  }
  const tipo = str(b?.tipo, 20) ?? 'caja';
  if (!TIPOS_CONTENEDOR.includes(tipo)) {
    return c.json({ error: `tipo inválido; opciones: ${TIPOS_CONTENEDOR.join(', ')}` }, 400);
  }
  const now    = Date.now();
  const contId = uid('cont');
  await c.env.DB.prepare(
    `INSERT INTO sum_envio_contenedores (id, envio_id, tipo, codigo, descripcion, created_ms)
     VALUES (?,?,?,?,?,?)`
  ).bind(contId, id, tipo, str(b?.codigo, 80), str(b?.descripcion, 400), now).run();
  return c.json(
    await c.env.DB.prepare(`SELECT * FROM sum_envio_contenedores WHERE id = ?`).bind(contId).first(),
    201
  );
});

// ── POST /:id/despachar — remove stock from origen, advance to despachado ──────
// Validates disponible ≥ cantidad for every línea at origen before committing.
// One D1 batch: tx header + tx líneas (−cantidad) + existencias upsert at origen + envío update.
sumEnvios.post('/:id/despachar', async (c) => {
  const id = c.req.param('id');
  const b  = await c.req.json().catch(() => null);
  const envio = await c.env.DB.prepare(`SELECT * FROM sum_envios WHERE id = ?`)
    .bind(id).first<{ id: string; codigo: string; estado: string; origen_id: string; destino_id: string }>();
  if (!envio) return c.json({ error: 'no encontrado' }, 404);
  if (envio.estado !== 'pendiente') {
    return c.json({ error: `despachar requiere estado='pendiente'; actual: '${envio.estado}'` }, 409);
  }

  const { results: lineas } = await c.env.DB.prepare(
    `SELECT item_id, cantidad FROM sum_envio_lineas WHERE envio_id = ?`
  ).bind(id).all<{ item_id: string; cantidad: number }>();
  if (!lineas?.length) return c.json({ error: 'el envío no tiene líneas' }, 400);

  // Check stock at origen before touching any row.
  const stock = await onHand(c.env, envio.origen_id, lineas.map(l => l.item_id));
  for (const l of lineas) {
    const disp = stock.get(l.item_id) ?? 0;
    if (disp < l.cantidad) {
      return c.json({
        error: `existencia insuficiente para item ${l.item_id} en origen (disponible ${disp}, requerido ${l.cantidad})`
      }, 409);
    }
  }

  const now  = Date.now();
  const txId = uid('tx');
  const stmts: D1PreparedStatement[] = [];

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(txId, txCode(), 'despacho', envio.origen_id, envio.codigo,
         str(b?.actor, 120), str(b?.nota, 1000), now));

  for (const l of lineas) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, l.item_id, -l.cantidad, now));
    stmts.push(upsert(c.env.DB, envio.origen_id, l.item_id, -l.cantidad, now));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE sum_envios SET estado = 'despachado', despachado_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(now, now, id));

  await c.env.DB.batch(stmts);
  const [envioFinal, transaccion] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM sum_envios WHERE id = ?`).bind(id).first(),
    c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first(),
  ]);
  return c.json({ envio: envioFinal, transaccion });
});

// ── POST /:id/recibir — add stock at destino, advance to recibido ──────────────
// One D1 batch: tx header + tx líneas (+cantidad) + existencias upsert at destino + envío update.
sumEnvios.post('/:id/recibir', async (c) => {
  const id = c.req.param('id');
  const b  = await c.req.json().catch(() => null);
  const envio = await c.env.DB.prepare(`SELECT * FROM sum_envios WHERE id = ?`)
    .bind(id).first<{ id: string; codigo: string; estado: string; origen_id: string; destino_id: string }>();
  if (!envio) return c.json({ error: 'no encontrado' }, 404);
  if (!['despachado', 'en_transito'].includes(envio.estado)) {
    return c.json({ error: `recibir requiere estado='despachado' o 'en_transito'; actual: '${envio.estado}'` }, 409);
  }

  const { results: lineas } = await c.env.DB.prepare(
    `SELECT item_id, cantidad FROM sum_envio_lineas WHERE envio_id = ?`
  ).bind(id).all<{ item_id: string; cantidad: number }>();
  if (!lineas?.length) return c.json({ error: 'el envío no tiene líneas' }, 400);

  const now  = Date.now();
  const txId = uid('tx');
  const stmts: D1PreparedStatement[] = [];

  stmts.push(c.env.DB.prepare(
    `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, actor, nota, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(txId, txCode(), 'recepcion', envio.destino_id, envio.codigo,
         str(b?.actor, 120), str(b?.nota, 1000), now));

  for (const l of lineas) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('txl'), txId, l.item_id, l.cantidad, now));
    stmts.push(upsert(c.env.DB, envio.destino_id, l.item_id, l.cantidad, now));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE sum_envios SET estado = 'recibido', recibido_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(now, now, id));

  await c.env.DB.batch(stmts);
  const [envioFinal, transaccion] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM sum_envios WHERE id = ?`).bind(id).first(),
    c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first(),
  ]);
  return c.json({ envio: envioFinal, transaccion });
});

// ── DELETE /:id — only when pendiente or cancelado ────────────────────────────
sumEnvios.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const envio = await c.env.DB.prepare(
    `SELECT estado FROM sum_envios WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!envio) return c.json({ error: 'no encontrado' }, 404);
  if (!['pendiente', 'cancelado'].includes(envio.estado)) {
    return c.json({ error: `no se puede eliminar un envío en estado '${envio.estado}'` }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_envio_lineas WHERE envio_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_envio_contenedores WHERE envio_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_envios WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});
