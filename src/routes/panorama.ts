import { Hono } from 'hono';
import type { Env } from '../types';
import { edgeCached } from '../lib/edge-cache';

export const panorama = new Hono<{ Bindings: Env }>();

// ── Panorama de la emergencia — public read-only aggregates ────────────────
// Mirrors CIVIS Venezuela data ingested hourly by the civis-edificaciones cron
// job (sat_edificaciones + civis_stats_snapshots). Serves /panorama and the
// Satélite tab on /edificios. GET-only, no PII, edge-cached.

// GET /api/panorama/stats — latest CIVIS stats snapshot + our own satellite
// counts (computed live from sat_edificaciones so the sat tiles never lag the
// points layer) + snapshot age for the staleness indicator.
panorama.get('/stats', async (c) => edgeCached(c, 60, async () => {
  const snap: any = await c.env.DB.prepare(
    `SELECT taken_ms, stats_json, panorama_text, panorama_generated_at
     FROM civis_stats_snapshots ORDER BY taken_ms DESC LIMIT 1`
  ).first().catch(() => null);
  let stats: Record<string, number> = {};
  try { stats = JSON.parse(snap?.stats_json || '{}'); } catch { /* keep {} */ }

  const sat = await c.env.DB.prepare(
    `SELECT severidad, COUNT(*) AS n FROM sat_edificaciones GROUP BY severidad`
  ).all<any>().catch(() => ({ results: [] as any[] }));
  const bySev: Record<string, number> = {};
  for (const r of sat.results ?? []) bySev[String(r.severidad)] = Number(r.n) || 0;
  const satTotal = Object.values(bySev).reduce((a, b) => a + b, 0);

  const zonas = await c.env.DB.prepare(
    `SELECT zona, COUNT(*) AS n FROM sat_edificaciones GROUP BY zona ORDER BY n DESC LIMIT 12`
  ).all<any>().catch(() => ({ results: [] as any[] }));

  return {
    taken_ms: snap?.taken_ms ?? null,
    stats,
    panorama: { texto: snap?.panorama_text || '', generado_en: snap?.panorama_generated_at || '' },
    sat: {
      confirmadas: satTotal,
      colapso: bySev['colapso'] || 0,
      grave: bySev['grave'] || 0,
      zonas: (zonas.results ?? []).map((z: any) => ({ zona: z.zona, n: Number(z.n) || 0 })),
    },
    attribution: 'CIVIS Venezuela · Copernicus EMS (UE) · Microsoft AI4G',
  };
}));

// GET /api/panorama/edificaciones — satellite-detected damaged buildings
// (points layer). Optional ?zona= and ?severidad= filters; capped at 2000
// (dataset is ~975 today — the cap is headroom, not pagination).
panorama.get('/edificaciones', async (c) => {
  const zona = (c.req.query('zona') || '').slice(0, 120);
  const severidad = (c.req.query('severidad') || '').slice(0, 24);
  return edgeCached(c, 300, async () => {
    const where: string[] = ['lat IS NOT NULL', 'lng IS NOT NULL'];
    const binds: any[] = [];
    if (zona) { where.push('zona = ?'); binds.push(zona); }
    if (severidad) { where.push('severidad = ?'); binds.push(severidad); }
    const rows = await c.env.DB.prepare(
      `SELECT id, lat, lng, severidad, oficial, zona, uso, maps_url
       FROM sat_edificaciones WHERE ${where.join(' AND ')}
       ORDER BY updated_ms DESC LIMIT 2000`
    ).bind(...binds).all<any>().catch(() => ({ results: [] as any[] }));
    return { edificaciones: rows.results ?? [], attribution: 'CIVIS Venezuela · Copernicus EMS (UE) · Microsoft AI4G' };
  });
});
