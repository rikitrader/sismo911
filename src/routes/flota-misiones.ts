import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon } from '../lib/security';

// FLOTA — the "order" in FleetOps: mission dispatch for the national fleet.
// Tables: flota_misiones + flota_mision_waypoints + flota_mision_actividad;
// also reads/updates flota_unidades.estado_op when a unit is assigned/freed.
//
// Mounted at /api/flota/misiones. Gating: the whole /api/flota surface is
// operator/admin-only (src/index.ts isFlotaApi) — including GET reads.

export const flotaMisiones = new Hono<{ Bindings: Env }>();

const TIPOS = ['rescate', 'evacuacion', 'suministro', 'evaluacion', 'medico', 'traslado'];
const ESTADOS = ['creada', 'despachada', 'en_ruta', 'en_sitio', 'completada', 'cancelada'];
const WPT_ESTADOS = ['pendiente', 'llegada', 'completado'];
// Linear lifecycle; 'cancelada' is reachable from any non-terminal state.
const ORDER = ['creada', 'despachada', 'en_ruta', 'en_sitio', 'completada'];
const TERMINAL = new Set(['completada', 'cancelada']);

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

// A transition is valid if it advances exactly one step along ORDER, or cancels
// a non-terminal mission. 'despachada' is only reachable via /despachar.
export function canTransition(from: string, to: string): boolean {
  if (TERMINAL.has(from)) return false;
  if (to === 'cancelada') return true;
  const fi = ORDER.indexOf(from);
  return fi >= 0 && ORDER[fi + 1] === to;
}

function parseMeta(v: unknown): unknown {
  if (v == null) return null;
  try { return JSON.parse(String(v)); } catch { return null; }
}

// ── List ──────────────────────────────────────────────────────────────────
flotaMisiones.get('/', async (c) => {
  const estado = c.req.query('estado');
  const tipo = c.req.query('tipo');
  const evento_id = c.req.query('evento_id');
  const prioridad = c.req.query('prioridad');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('estado = ?'); vals.push(estado); }
  if (tipo && TIPOS.includes(tipo)) { where.push('tipo = ?'); vals.push(tipo); }
  if (evento_id) { where.push('evento_id = ?'); vals.push(evento_id); }
  if (prioridad != null && prioridad !== '') {
    const p = Number(prioridad);
    if (Number.isInteger(p)) { where.push('prioridad = ?'); vals.push(p); }
  }
  const sql = `SELECT * FROM flota_misiones ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_ms DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...vals, limit).all();
  return c.json({ results: results ?? [] });
});

// ── Create ────────────────────────────────────────────────────────────────
flotaMisiones.post('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'flota_mision', 60, 60);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const tipo = str(b?.tipo, 20) ?? 'rescate';
  const descripcion = str(b?.descripcion, 2000);
  if (!TIPOS.includes(tipo)) return c.json({ error: 'tipo inválido' }, 400);
  if (!descripcion) return c.json({ error: 'descripcion requerida' }, 400);

  // Coordinates are optional, but a present-but-out-of-range pair is rejected
  // (mirrors flota-rastreo.ts validLatLon gating on /posicion).
  const origen_lat = num(b?.origen_lat), origen_lon = num(b?.origen_lon);
  const destino_lat = num(b?.destino_lat), destino_lon = num(b?.destino_lon);
  if ((origen_lat != null || origen_lon != null) && !validLatLon(origen_lat, origen_lon)) {
    return c.json({ error: 'bad_origen_lat_lon' }, 400);
  }
  if ((destino_lat != null || destino_lon != null) && !validLatLon(destino_lat, destino_lon)) {
    return c.json({ error: 'bad_destino_lat_lon' }, 400);
  }

  let prioridad = Number(b?.prioridad);
  if (!Number.isInteger(prioridad) || prioridad < 1 || prioridad > 5) prioridad = 3;

  const now = Date.now();
  const id = uid('mis');
  const codigo = 'MIS-' + crypto.randomUUID().slice(0, 8).toUpperCase();

  const writes = [
    c.env.DB.prepare(
      `INSERT INTO flota_misiones
        (id, codigo, tipo, prioridad, estado, unidad_id, personal_id, evento_id, caso_ref,
         origen_lat, origen_lon, origen_dir, destino_lat, destino_lon, destino_dir,
         descripcion, despachada_ms, completada_ms, meta, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, codigo, tipo, prioridad, 'creada',
      str(b?.unidad_id, 64), str(b?.personal_id, 64), str(b?.evento_id, 64), str(b?.caso_ref, 200),
      origen_lat, origen_lon, str(b?.origen_dir, 400),
      destino_lat, destino_lon, str(b?.destino_dir, 400),
      descripcion, null, null, b?.meta != null ? JSON.stringify(b.meta) : null, now, now
    ),
    c.env.DB.prepare(
      `INSERT INTO flota_mision_actividad (id, mision_id, estado, nota, lat, lon, actor, created_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(uid('act'), id, 'creada', str(b?.nota, 400), null, null, str(b?.actor, 120), now),
  ];

  const rawWp = Array.isArray(b?.waypoints) ? b.waypoints : [];
  const waypoints = rawWp
    .map((w: any) => ({ lat: num(w?.lat), lon: num(w?.lon), direccion: str(w?.direccion, 400) }))
    .filter((w: any) => w.lat != null && w.lon != null)
    .slice(0, 50);
  waypoints.forEach((w: any, i: number) => {
    writes.push(
      c.env.DB.prepare(
        `INSERT INTO flota_mision_waypoints (id, mision_id, seq, lat, lon, direccion, estado, created_ms)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(uid('wpt'), id, i + 1, w.lat, w.lon, w.direccion, 'pendiente', now)
    );
  });

  await c.env.DB.batch(writes);
  return c.json({ ok: true, id, codigo, estado: 'creada' }, 201);
});

// ── Detail ────────────────────────────────────────────────────────────────
flotaMisiones.get('/:id', async (c) => {
  const id = c.req.param('id');
  const mision = await c.env.DB.prepare(`SELECT * FROM flota_misiones WHERE id = ?`).bind(id).first();
  if (!mision) return c.json({ error: 'no encontrado' }, 404);
  const [wp, act] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM flota_mision_waypoints WHERE mision_id = ? ORDER BY seq`).bind(id).all(),
    c.env.DB.prepare(`SELECT * FROM flota_mision_actividad WHERE mision_id = ? ORDER BY created_ms DESC`).bind(id).all(),
  ]);
  return c.json({
    mision: { ...(mision as any), meta: parseMeta((mision as any).meta) },
    waypoints: wp.results ?? [],
    actividad: act.results ?? [],
  });
});

// ── Patch (editable fields) ─────────────────────────────────────────────────
flotaMisiones.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.prioridad != null) {
    const p = Number(b.prioridad);
    if (!Number.isInteger(p) || p < 1 || p > 5) return c.json({ error: 'prioridad inválida' }, 400);
    sets.push('prioridad = ?'); vals.push(p);
  }
  if (b?.tipo != null) {
    if (!TIPOS.includes(b.tipo)) return c.json({ error: 'tipo inválido' }, 400);
    sets.push('tipo = ?'); vals.push(b.tipo);
  }
  if (b?.descripcion != null) { sets.push('descripcion = ?'); vals.push(str(b.descripcion, 2000)); }
  if (b?.caso_ref != null) { sets.push('caso_ref = ?'); vals.push(str(b.caso_ref, 200)); }
  // Coordinates update as a pair; a present-but-out-of-range pair is rejected
  // (mirrors validLatLon gating on create and flota-rastreo.ts /posicion).
  if (b?.origen_lat != null || b?.origen_lon != null) {
    const lat = num(b?.origen_lat), lon = num(b?.origen_lon);
    if (!validLatLon(lat, lon)) return c.json({ error: 'bad_origen_lat_lon' }, 400);
    sets.push('origen_lat = ?'); vals.push(lat);
    sets.push('origen_lon = ?'); vals.push(lon);
  }
  if (b?.origen_dir != null) { sets.push('origen_dir = ?'); vals.push(str(b.origen_dir, 400)); }
  if (b?.destino_lat != null || b?.destino_lon != null) {
    const lat = num(b?.destino_lat), lon = num(b?.destino_lon);
    if (!validLatLon(lat, lon)) return c.json({ error: 'bad_destino_lat_lon' }, 400);
    sets.push('destino_lat = ?'); vals.push(lat);
    sets.push('destino_lon = ?'); vals.push(lon);
  }
  if (b?.destino_dir != null) { sets.push('destino_dir = ?'); vals.push(str(b.destino_dir, 400)); }
  if (b?.meta != null) { sets.push('meta = ?'); vals.push(JSON.stringify(b.meta)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE flota_misiones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id });
});

// ── Dispatch: assign a unit (creada → despachada) ───────────────────────────
flotaMisiones.post('/:id/despachar', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const unidad_id = str(b?.unidad_id, 64);
  const personal_id = str(b?.personal_id, 64);
  if (!unidad_id) return c.json({ error: 'unidad_id requerido' }, 400);

  const mision = await c.env.DB.prepare(`SELECT estado FROM flota_misiones WHERE id = ?`).bind(id).first() as { estado: string } | null;
  if (!mision) return c.json({ error: 'no encontrado' }, 404);
  if (mision.estado !== 'creada') return c.json({ error: 'transicion_invalida' }, 409);

  // The assigned unit must exist and be free — never dispatch a bogus or
  // already-busy unit (would double-book it).
  const unidad = await c.env.DB.prepare(`SELECT estado_op FROM flota_unidades WHERE id = ?`).bind(unidad_id).first() as { estado_op: string } | null;
  if (!unidad) return c.json({ error: 'unidad_no_encontrada' }, 404);
  if (unidad.estado_op !== 'disponible') return c.json({ error: 'unidad_no_disponible', estado_op: unidad.estado_op }, 409);

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE flota_misiones SET estado='despachada', unidad_id=?, personal_id=?, despachada_ms=?, updated_ms=? WHERE id=?`
    ).bind(unidad_id, personal_id, now, now, id),
    c.env.DB.prepare(`UPDATE flota_unidades SET estado_op='en_mision', updated_ms=? WHERE id=?`).bind(now, unidad_id),
    c.env.DB.prepare(
      `INSERT INTO flota_mision_actividad (id, mision_id, estado, nota, lat, lon, actor, created_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(uid('act'), id, 'despachada', str(b?.nota, 400), null, null, str(b?.actor, 120), now),
  ]);
  return c.json({ ok: true, id, estado: 'despachada', unidad_id, personal_id });
});

// ── Transition: en_ruta | en_sitio | completada | cancelada ─────────────────
flotaMisiones.post('/:id/estado', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const estado = str(b?.estado, 20);
  if (!estado || !['en_ruta', 'en_sitio', 'completada', 'cancelada'].includes(estado)) {
    return c.json({ error: 'estado inválido' }, 400);
  }
  const mision = await c.env.DB.prepare(`SELECT estado, unidad_id FROM flota_misiones WHERE id = ?`).bind(id).first() as { estado: string; unidad_id: string | null } | null;
  if (!mision) return c.json({ error: 'no encontrado' }, 404);
  if (!canTransition(mision.estado, estado)) return c.json({ error: 'transicion_invalida' }, 409);

  const now = Date.now();
  const lat = num(b?.lat), lon = num(b?.lon);
  const sets = ['estado = ?', 'updated_ms = ?'];
  const vals: unknown[] = [estado, now];
  if (estado === 'completada') { sets.push('completada_ms = ?'); vals.push(now); }
  vals.push(id);

  const writes = [
    c.env.DB.prepare(`UPDATE flota_misiones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals),
    c.env.DB.prepare(
      `INSERT INTO flota_mision_actividad (id, mision_id, estado, nota, lat, lon, actor, created_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(uid('act'), id, estado, str(b?.nota, 400), lat, lon, str(b?.actor, 120), now),
  ];
  // Free the assigned unit when the mission ends (completed or cancelled).
  if ((estado === 'completada' || estado === 'cancelada') && mision.unidad_id) {
    writes.push(c.env.DB.prepare(`UPDATE flota_unidades SET estado_op='disponible', updated_ms=? WHERE id=?`).bind(now, mision.unidad_id));
  }
  await c.env.DB.batch(writes);

  const updated = await c.env.DB.prepare(`SELECT * FROM flota_misiones WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, mision: { ...(updated as any), meta: parseMeta((updated as any)?.meta) } });
});

// ── Waypoints ───────────────────────────────────────────────────────────────
flotaMisiones.post('/:id/waypoints', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const lat = num(b?.lat), lon = num(b?.lon);
  if (lat == null || lon == null) return c.json({ error: 'lat y lon requeridos' }, 400);

  const mision = await c.env.DB.prepare(`SELECT id FROM flota_misiones WHERE id = ?`).bind(id).first();
  if (!mision) return c.json({ error: 'no encontrado' }, 404);

  const row = await c.env.DB.prepare(`SELECT MAX(seq) AS maxSeq FROM flota_mision_waypoints WHERE mision_id = ?`).bind(id).first() as { maxSeq: number | null } | null;
  const seq = (row?.maxSeq ?? 0) + 1;
  const now = Date.now();
  const wpId = uid('wpt');
  await c.env.DB.prepare(
    `INSERT INTO flota_mision_waypoints (id, mision_id, seq, lat, lon, direccion, estado, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(wpId, id, seq, lat, lon, str(b?.direccion, 400), 'pendiente', now).run();
  return c.json({ ok: true, id: wpId, seq }, 201);
});

flotaMisiones.patch('/:id/waypoints/:wpId', async (c) => {
  const wpId = c.req.param('wpId');
  const misionId = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const estado = str(b?.estado, 20);
  if (!estado || !WPT_ESTADOS.includes(estado)) return c.json({ error: 'estado inválido' }, 400);
  const r = await c.env.DB.prepare(`UPDATE flota_mision_waypoints SET estado = ? WHERE id = ? AND mision_id = ?`)
    .bind(estado, wpId, misionId).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id: wpId, estado });
});

// ── Delete a mission → cascade waypoints + activity, free the assigned unit ──
flotaMisiones.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const mision = await c.env.DB.prepare(`SELECT unidad_id, estado FROM flota_misiones WHERE id = ?`).bind(id)
    .first() as { unidad_id: string | null; estado: string } | null;
  if (!mision) return c.json({ error: 'no encontrado' }, 404);

  const now = Date.now();
  const writes = [
    c.env.DB.prepare(`DELETE FROM flota_mision_waypoints WHERE mision_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM flota_mision_actividad WHERE mision_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM flota_misiones WHERE id = ?`).bind(id),
  ];
  // If the mission was still active, free its unit back to disponible.
  if (mision.unidad_id && mision.estado !== 'completada' && mision.estado !== 'cancelada') {
    writes.push(c.env.DB.prepare(`UPDATE flota_unidades SET estado_op='disponible', updated_ms=? WHERE id=?`).bind(now, mision.unidad_id));
  }
  await c.env.DB.batch(writes);
  return c.json({ ok: true, id });
});
