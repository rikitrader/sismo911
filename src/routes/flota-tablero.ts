import { Hono } from 'hono';
import type { Env } from '../types';

// FLOTA command dashboard: read-only aggregates that power the operations
// overview + live command map. Single-tenant national app — no org scoping.
// Mounted at /api/flota/tablero (see src/index.ts). All GET, all public — no
// writes, so no uid()/audit() here.

export const flotaTablero = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

// Fold rows of { key, n } (from a GROUP BY) into a { key: count } map.
function tally(rows: unknown[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const k = str(row[key], 40);
    const n = num(row.n);
    if (k != null && n != null) out[k] = (out[k] ?? 0) + n;
  }
  return out;
}

function sumValues(m: Record<string, number>): number {
  let t = 0;
  for (const k in m) t += m[k] ?? 0;
  return t;
}

// ── Operations resumen: one GROUP BY pass per table ───────────────────────────
flotaTablero.get('/resumen', async (c) => {
  const [uniEstado, uniTipo, misEstado, misPrioridad, perRol, respuesta] = await Promise.all([
    c.env.DB.prepare(`SELECT estado_op AS k, COUNT(*) AS n FROM flota_unidades GROUP BY estado_op`).all(),
    c.env.DB.prepare(`SELECT tipo AS k, COUNT(*) AS n FROM flota_unidades GROUP BY tipo`).all(),
    c.env.DB.prepare(`SELECT estado AS k, COUNT(*) AS n FROM flota_misiones GROUP BY estado`).all(),
    c.env.DB.prepare(`SELECT prioridad AS k, COUNT(*) AS n FROM flota_misiones GROUP BY prioridad`).all(),
    c.env.DB.prepare(`SELECT rol AS k, COUNT(*) AS n FROM flota_personal GROUP BY rol`).all(),
    c.env.DB.prepare(
      `SELECT AVG(completada_ms - despachada_ms) AS avg_ms FROM flota_misiones
       WHERE estado = 'completada' AND despachada_ms IS NOT NULL AND completada_ms IS NOT NULL
         AND completada_ms >= despachada_ms`
    ).first(),
  ]);

  const por_estado = tally(uniEstado.results ?? [], 'k');
  const por_tipo = tally(uniTipo.results ?? [], 'k');
  const por_estado_mis = tally(misEstado.results ?? [], 'k');
  const por_prioridad = tally(misPrioridad.results ?? [], 'k');
  const por_rol = tally(perRol.results ?? [], 'k');

  const activas = sumValues(por_estado_mis) -
    (por_estado_mis['completada'] ?? 0) - (por_estado_mis['cancelada'] ?? 0);

  const avgMs = num((respuesta as Record<string, unknown> | null)?.avg_ms);
  const tiempo_respuesta_prom_min =
    avgMs != null && Number.isFinite(avgMs) ? Math.round((avgMs / 60000) * 10) / 10 : null;

  return c.json({
    unidades: {
      total: sumValues(por_estado),
      por_estado,
      por_tipo,
    },
    misiones: {
      total: sumValues(por_estado_mis),
      activas,
      por_estado: por_estado_mis,
      por_prioridad,
    },
    personal: {
      total: sumValues(por_rol),
      por_rol,
    },
    tiempo_respuesta_prom_min,
    generated_ms: Date.now(),
  });
});

// ── Command map: everything the live map needs in one fetch ───────────────────
flotaTablero.get('/mapa', async (c) => {
  const [unidades, misiones] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, nombre, tipo, estado_op, lat, lon, ult_pos_ms
       FROM flota_unidades
       WHERE lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY ult_pos_ms DESC`
    ).all(),
    c.env.DB.prepare(
      `SELECT id, codigo, tipo, prioridad, estado, unidad_id,
              origen_lat, origen_lon, destino_lat, destino_lon, descripcion
       FROM flota_misiones
       WHERE estado NOT IN ('completada', 'cancelada')
       ORDER BY prioridad, created_ms DESC
       LIMIT 1000`
    ).all(),
  ]);

  return c.json({
    unidades: unidades.results ?? [],
    misiones_activas: misiones.results ?? [],
    generated_ms: Date.now(),
  });
});
