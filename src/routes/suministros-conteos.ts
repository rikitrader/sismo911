import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Conteos cíclicos (cycle counts: snapshot → conteo físico → conciliación AJUSTE).
// Tables: sum_conteos, sum_conteo_lineas. conciliar emits AJUSTE via D1 batch().
// Mounted at /api/suministros/conteos. Writes gated centrally; GET public.

export const sumConteos = new Hono<{ Bindings: Env }>();

const ESTADOS = ['programado', 'en_proceso', 'conciliado', 'cancelado'];
const ESTADOS_MODIFICABLES = ['programado', 'en_proceso'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const qty = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const cntCode = () => `CNT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const txCode  = () => `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Per-(ubicacion,item) delta upsert — same ON CONFLICT pattern as movimientos.
const upsert = (db: D1Database, ubicacion: string, item: string, delta: number, now: number) =>
  db.prepare(
    `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(ubicacion_id, item_id)
       DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
  ).bind(ubicacion, item, delta, now);

// ── Shared conteo creation (POST / and POST /generar both delegate here) ──────
async function doCreateConteo(c: any, body: {
  ubicacion_id: string | null;
  asignado_a: string | null;
  programado_ms: number | null;
  nota: string | null;
  auto: boolean;
  lineasIn: any[];
}) {
  const env: Env = c.env;
  const { ubicacion_id, auto, lineasIn } = body;
  if (!ubicacion_id) return c.json({ error: 'ubicacion_id requerido' }, 400);
  const ubi = await env.DB.prepare(`SELECT id FROM sum_ubicaciones WHERE id = ?`).bind(ubicacion_id).first();
  if (!ubi) return c.json({ error: 'ubicacion_id no encontrado' }, 404);
  if (!auto && !lineasIn.length) return c.json({ error: 'lineas requerido cuando auto no es true' }, 400);

  const now = Date.now();
  const id = uid('cnt');
  const codigo = cntCode();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(env.DB.prepare(
    `INSERT INTO sum_conteos
       (id, codigo, ubicacion_id, estado, programado_ms, asignado_a, nota, conciliado_ms, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, codigo, ubicacion_id, 'programado', body.programado_ms, body.asignado_a, body.nota, null, now, now));

  if (auto) {
    const { results } = await env.DB.prepare(
      `SELECT item_id, cantidad FROM sum_existencias WHERE ubicacion_id = ? AND cantidad > 0`
    ).bind(ubicacion_id).all<{ item_id: string; cantidad: number }>();
    for (const r of results ?? []) {
      stmts.push(env.DB.prepare(
        `INSERT INTO sum_conteo_lineas
           (id, conteo_id, item_id, cantidad_sistema, cantidad_contada, created_ms)
         VALUES (?,?,?,?,?,?)`
      ).bind(uid('cnl'), id, r.item_id, r.cantidad, null, now));
    }
  } else {
    for (const ln of lineasIn) {
      const itemId = str(ln?.item_id, 40);
      if (!itemId) return c.json({ error: 'item_id requerido en cada línea' }, 400);
      const ex = await env.DB.prepare(
        `SELECT COALESCE(cantidad, 0) AS cantidad FROM sum_existencias WHERE ubicacion_id = ? AND item_id = ?`
      ).bind(ubicacion_id, itemId).first<{ cantidad: number }>();
      stmts.push(env.DB.prepare(
        `INSERT INTO sum_conteo_lineas
           (id, conteo_id, item_id, cantidad_sistema, cantidad_contada, created_ms)
         VALUES (?,?,?,?,?,?)`
      ).bind(uid('cnl'), id, itemId, ex?.cantidad ?? 0, null, now));
    }
  }

  await env.DB.batch(stmts);
  const conteo = await env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`).bind(id).first();
  return c.json({ conteo }, 201);
}

// ── GET / — listar conteos ────────────────────────────────────────────────────
sumConteos.get('/', async (c) => {
  const estado      = c.req.query('estado');
  const ubicacionId = c.req.query('ubicacion_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('c.estado = ?'); vals.push(estado); }
  if (ubicacionId) { where.push('c.ubicacion_id = ?'); vals.push(ubicacionId); }

  const sql = `SELECT c.*,
      u.nombre AS ubicacion_nombre,
      (SELECT COUNT(*) FROM sum_conteo_lineas l WHERE l.conteo_id = c.id) AS n_lineas,
      (SELECT COUNT(*) FROM sum_conteo_lineas l WHERE l.conteo_id = c.id
         AND l.cantidad_contada IS NOT NULL AND l.cantidad_contada <> l.cantidad_sistema) AS n_varianza
    FROM sum_conteos c
    LEFT JOIN sum_ubicaciones u ON u.id = c.ubicacion_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// ── POST / — crear conteo (estado 'programado') ───────────────────────────────
sumConteos.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  return doCreateConteo(c, {
    ubicacion_id:  str(b?.ubicacion_id, 40),
    asignado_a:    str(b?.asignado_a, 160),
    programado_ms: num(b?.programado_ms),
    nota:          str(b?.nota, 1000),
    auto:          b?.auto === true,
    lineasIn:      Array.isArray(b?.lineas) ? b.lineas : [],
  });
});

// ── POST /generar — conveniencia: auto-snapshot todos los ítems con stock>0 ───
sumConteos.post('/generar', async (c) => {
  const b = await c.req.json().catch(() => null);
  return doCreateConteo(c, {
    ubicacion_id:  str(b?.ubicacion_id, 40),
    asignado_a:    str(b?.asignado_a, 160),
    programado_ms: num(b?.programado_ms),
    nota:          null,
    auto:          true,
    lineasIn:      [],
  });
});

// ── GET /:id — conteo + líneas con detalle de ítem/producto y disponible ──────
sumConteos.get('/:id', async (c) => {
  const id = c.req.param('id');
  const conteo = await c.env.DB.prepare(
    `SELECT c.*, u.nombre AS ubicacion_nombre
     FROM sum_conteos c
     LEFT JOIN sum_ubicaciones u ON u.id = c.ubicacion_id
     WHERE c.id = ?`
  ).bind(id).first<{ id: string; ubicacion_id: string } & Record<string, unknown>>();
  if (!conteo) return c.json({ error: 'no encontrado' }, 404);
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT l.*,
       pr.nombre AS producto_nombre, pr.codigo, pr.unidad,
       i.lote, i.caducidad_ms,
       COALESCE(e.cantidad, 0) AS disponible,
       CASE WHEN l.cantidad_contada IS NOT NULL
            THEN l.cantidad_contada - l.cantidad_sistema
            ELSE NULL END AS varianza
     FROM sum_conteo_lineas l
     JOIN sum_items i ON i.id = l.item_id
     JOIN sum_productos pr ON pr.id = i.producto_id
     LEFT JOIN sum_existencias e ON e.ubicacion_id = ? AND e.item_id = l.item_id
     WHERE l.conteo_id = ? ORDER BY l.created_ms`
  ).bind(conteo.ubicacion_id, id).all();
  return c.json({ conteo, lineas: lineas ?? [] });
});

// ── PATCH /:id — estado / asignado_a / programado_ms / nota ──────────────────
sumConteos.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const existing = await c.env.DB.prepare(
    `SELECT estado FROM sum_conteos WHERE id = ?`
  ).bind(id).first<{ estado: string }>();
  if (!existing) return c.json({ error: 'no encontrado' }, 404);
  if (existing.estado === 'conciliado') {
    return c.json({ error: 'el conteo ya fue conciliado; no se puede modificar' }, 409);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const now = Date.now();

  if (b?.estado != null) {
    const nuevoEstado = String(b.estado);
    if (nuevoEstado === 'conciliado') {
      return c.json({ error: 'usa /conciliar para conciliar el conteo' }, 400);
    }
    if (!ESTADOS.includes(nuevoEstado)) return c.json({ error: 'estado inválido' }, 400);
    const transicionesValidas: Record<string, string[]> = {
      programado: ['en_proceso', 'cancelado'],
      en_proceso: ['programado',  'cancelado'],
      cancelado:  [],
    };
    const permitidos = transicionesValidas[existing.estado] ?? [];
    if (!permitidos.includes(nuevoEstado)) {
      return c.json({ error: `no se puede pasar de '${existing.estado}' a '${nuevoEstado}'` }, 409);
    }
    sets.push('estado = ?'); vals.push(nuevoEstado);
  }
  if (b?.asignado_a !== undefined)    { sets.push('asignado_a = ?');    vals.push(str(b.asignado_a, 160)); }
  if (b?.programado_ms !== undefined) { sets.push('programado_ms = ?'); vals.push(num(b.programado_ms)); }
  if (b?.nota !== undefined)          { sets.push('nota = ?');          vals.push(str(b.nota, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(now);
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_conteos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// ── POST /:id/contar — registrar cantidades físicamente contadas ───────────────
sumConteos.post('/:id/contar', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);

  const conteo = await c.env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`)
    .bind(id).first<{ id: string; estado: string; ubicacion_id: string }>();
  if (!conteo) return c.json({ error: 'no encontrado' }, 404);
  if (!ESTADOS_MODIFICABLES.includes(conteo.estado)) {
    return c.json({ error: `conteo en estado '${conteo.estado}'; no se pueden registrar conteos` }, 409);
  }

  const lineasBody: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  if (!lineasBody.length) return c.json({ error: 'sin líneas' }, 400);

  const stmts: D1PreparedStatement[] = [];
  const now = Date.now();

  for (const lb of lineasBody) {
    const lineaId = str(lb?.linea_id, 40);
    if (!lineaId) return c.json({ error: 'linea_id requerido en cada línea' }, 400);
    const cantContada = qty(lb?.cantidad_contada);
    if (!Number.isFinite(cantContada) || cantContada < 0) {
      return c.json({ error: `línea ${lineaId}: cantidad_contada debe ser ≥ 0` }, 400);
    }
    const linea = await c.env.DB.prepare(
      `SELECT id FROM sum_conteo_lineas WHERE id = ? AND conteo_id = ?`
    ).bind(lineaId, id).first<{ id: string }>();
    if (!linea) return c.json({ error: `línea no encontrada o no pertenece a este conteo: ${lineaId}` }, 400);
    stmts.push(c.env.DB.prepare(
      `UPDATE sum_conteo_lineas SET cantidad_contada = ? WHERE id = ?`
    ).bind(cantContada, lineaId));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE sum_conteos SET estado = 'en_proceso', updated_ms = ? WHERE id = ?`
  ).bind(now, id));

  await c.env.DB.batch(stmts);

  const conteoFinal = await c.env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`).bind(id).first();
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT * FROM sum_conteo_lineas WHERE conteo_id = ? ORDER BY created_ms`
  ).bind(id).all();
  return c.json({ conteo: conteoFinal, lineas: lineas ?? [] });
});

// ── POST /:id/conciliar — reconciliar varianzas emitiendo AJUSTE ──────────────
// Varianza = cantidad_contada − existencia actual en la ubicación.
// Un único DB.batch() aplica TX header + líneas + upserts de existencias + update conteo.
sumConteos.post('/:id/conciliar', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);

  const conteo = await c.env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`)
    .bind(id).first<{ id: string; codigo: string; estado: string; ubicacion_id: string }>();
  if (!conteo) return c.json({ error: 'no encontrado' }, 404);
  if (!ESTADOS_MODIFICABLES.includes(conteo.estado)) {
    return c.json({ error: `conteo en estado '${conteo.estado}'; no se puede conciliar` }, 409);
  }

  const { results: todasLineas } = await c.env.DB.prepare(
    `SELECT * FROM sum_conteo_lineas WHERE conteo_id = ? ORDER BY created_ms`
  ).bind(id).all<{ id: string; item_id: string; cantidad_sistema: number; cantidad_contada: number | null }>();

  const lineasContadas = (todasLineas ?? []).filter(l => l.cantidad_contada !== null);
  if (!lineasContadas.length) {
    return c.json({ error: 'sin líneas con cantidad_contada; use /contar antes de conciliar' }, 400);
  }

  // Fetch current on-hand for all counted items.
  const itemIds = lineasContadas.map(l => l.item_id);
  const ph = itemIds.map(() => '?').join(',');
  const { results: existencias } = await c.env.DB.prepare(
    `SELECT item_id, cantidad FROM sum_existencias WHERE ubicacion_id = ? AND item_id IN (${ph})`
  ).bind(conteo.ubicacion_id, ...itemIds).all<{ item_id: string; cantidad: number }>();
  const onHandMap = new Map<string, number>();
  for (const e of existencias ?? []) onHandMap.set(e.item_id, e.cantidad);

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const ajustes: { item_id: string; varianza: number }[] = [];

  const lineasConVarianza = lineasContadas.filter(l => {
    const cur = onHandMap.get(l.item_id) ?? 0;
    return (l.cantidad_contada! - cur) !== 0;
  });

  if (lineasConVarianza.length > 0) {
    const txId  = uid('tx');
    const actor = str(b?.actor, 120);

    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_transacciones
         (id, codigo, tipo, ubicacion_id, ubicacion_dest_id, referencia, motivo, actor, nota, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(txId, txCode(), 'ajuste', conteo.ubicacion_id, null, null,
      'Conciliación conteo ' + conteo.codigo, actor, null, now));

    for (const ln of lineasConVarianza) {
      const cur = onHandMap.get(ln.item_id) ?? 0;
      const varianza = ln.cantidad_contada! - cur;
      ajustes.push({ item_id: ln.item_id, varianza });
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms)
         VALUES (?,?,?,?,?)`
      ).bind(uid('txl'), txId, ln.item_id, varianza, now));
      stmts.push(upsert(c.env.DB, conteo.ubicacion_id, ln.item_id, varianza, now));
    }

    stmts.push(c.env.DB.prepare(
      `UPDATE sum_conteos SET estado = 'conciliado', conciliado_ms = ?, updated_ms = ? WHERE id = ?`
    ).bind(now, now, id));

    await c.env.DB.batch(stmts);

    const [conteoFinal, transaccion] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`).bind(id).first(),
      c.env.DB.prepare(`SELECT * FROM sum_transacciones WHERE id = ?`).bind(txId).first(),
    ]);
    return c.json({ conteo: conteoFinal, transaccion, ajustes });
  }

  // Todos los conteos coinciden con la existencia actual — conciliar sin transacciones.
  await c.env.DB.prepare(
    `UPDATE sum_conteos SET estado = 'conciliado', conciliado_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(now, now, id).run();
  const conteoFinal = await c.env.DB.prepare(`SELECT * FROM sum_conteos WHERE id = ?`).bind(id).first();
  return c.json({ conteo: conteoFinal, transaccion: null, ajustes: [] });
});

// ── DELETE /:id — eliminar cuando estado ≠ 'conciliado' ──────────────────────
sumConteos.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const conteo = await c.env.DB.prepare(`SELECT estado FROM sum_conteos WHERE id = ?`)
    .bind(id).first<{ estado: string }>();
  if (!conteo) return c.json({ error: 'no encontrado' }, 404);
  if (conteo.estado === 'conciliado') {
    return c.json({ error: 'no se puede eliminar un conteo ya conciliado' }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_conteo_lineas WHERE conteo_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_conteos WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});
