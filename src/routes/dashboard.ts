import { Hono } from 'hono';
import type { Env } from '../types';
import { edgeCached } from '../lib/edge-cache';

export const dashboard = new Hono<{ Bindings: Env }>();

// GET /api/dashboard/geoseismic — aggregates the /terremotos dashboard's three
// LOAD-ONCE public overlays (risk heatmap + official stats + structural-damage)
// into ONE cacheable call, so the dashboard's initial public fetches drop 4→2.
// Live seismic events stay on /api/events (it has its own 90s refresh lifecycle,
// and its markers are re-rendered on a timer — folding it in here would either
// duplicate overlay markers or force the heavy overlay queries every 90s).
// Sub-objects mirror the individual endpoints' shapes so the page consumes them
// unchanged. Auth-invariant + public → wrapped in the per-colo edge cache.
dashboard.get('/geoseismic', async (c) => edgeCached(c, 30, async () => {
  // Risk heatmap (same query as /api/heatmap, misc.ts)
  const hm = await c.env.DB.prepare(
    `SELECT lat, lon, mag FROM events WHERE mag IS NOT NULL ORDER BY time_ms DESC LIMIT 500`
  ).all<any>().catch(() => ({ results: [] }));
  const points = (hm.results ?? []).map((e: any) => [e.lat, e.lon, Math.max(0.1, Math.min(1, e.mag / 8))]);

  // Official casualty stats (same as /api/stats/official, rav.ts)
  const stats = await c.env.DB.prepare(
    `SELECT fallecidos, heridos, refugiados, desaparecidos, source, origen, updated_at, pulled_at
     FROM official_stats WHERE id = 1`
  ).first().catch(() => null);

  // Structural-damage overlay (same as /api/danos-estructurales, damage-map.ts)
  const danos = (await c.env.DB.prepare(
    `SELECT * FROM sos_damage ORDER BY created_at DESC LIMIT 3000`
  ).all().catch(() => ({ results: [] }))).results ?? [];
  const counts = (await c.env.DB.prepare(
    `SELECT category, COUNT(*) AS n FROM sos_damage GROUP BY category`
  ).all().catch(() => ({ results: [] }))).results ?? [];

  return {
    heatmap: { updated_ms: Date.now(), count: points.length, points },
    stats: { ok: true, stats: stats ?? null },
    danos: { reports: danos, total: danos.length, counts, source: 'sosvenezuela2026.com' },
  };
}));
