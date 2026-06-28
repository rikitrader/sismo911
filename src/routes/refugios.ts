import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import {
  scoreSite, computeCapacity, scoreTier, assignPopulation, computeLogistics,
  orgTable, DEFAULT_LOGISTICS,
  type SiteInput, type SiteForAssign, type ZoneInput, type LogisticsParams,
} from '../refugios/engine';

// REFUGIOS / EVACUACIÓN (/api/refugios) — shelter siting + evacuation logistics
// for La Guaira. Reads are PUBLIC (citizens + responders need the map, scores
// and the logistics calculator). Writes (site CRUD, status, persisting an
// assignment run) require refugios:manage — gated centrally in route-policy.ts.
export const refugios = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const SITE_COLS = `id,nombre,tipo,municipio,parroquia,lat,lon,area_m2,techado_m2,bed_type,
  capacity_estimate,road_access,road_distance_m,services_water,services_power,
  services_sanitation,services_kitchen,elevation_m,flood_risk,coast_distance_m,
  status,current_occupancy,notes,moderation,created_ms,updated_ms`;

/** Enrich a DB row with the live engine score, breakdown, capacity and tier. */
function enrich(row: any) {
  const breakdown = scoreSite(row as SiteInput);
  const capacity = computeCapacity(row as SiteInput);
  return {
    ...row,
    capacity,
    score: breakdown.total,
    score_breakdown: breakdown,
    tier: scoreTier(breakdown.total),
    free: Math.max(0, capacity - (row.current_occupancy ?? 0)),
  };
}

// ── GET /api/refugios — all sites with live scores (public, for the map) ───────
refugios.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${SITE_COLS} FROM refugios_sites WHERE moderation='approved' ORDER BY nombre LIMIT 1000`,
  ).all();
  const sites = (results ?? []).map(enrich);
  return c.json({ sites });
});

// ── GET /api/refugios/zones — at-risk population zones ─────────────────────────
refugios.get('/zones', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id,nombre,municipio,lat,lon,population,risk_level,notes FROM refugios_zones ORDER BY population DESC`,
  ).all();
  return c.json({ zones: results ?? [] });
});

// ── GET /api/refugios/org — incident-command (SCI) org table ───────────────────
refugios.get('/org', (c) => c.json({ org: orgTable() }));

// ── GET /api/refugios/params — default logistics planning factors ──────────────
refugios.get('/params', (c) => c.json({ params: DEFAULT_LOGISTICS }));

// ── GET /api/refugios/summary — coverage overview (capacity vs population) ──────
refugios.get('/summary', async (c) => {
  const [{ results: sites }, { results: zones }] = await Promise.all([
    c.env.DB.prepare(`SELECT ${SITE_COLS} FROM refugios_sites WHERE moderation='approved'`).all(),
    c.env.DB.prepare(`SELECT population FROM refugios_zones`).all(),
  ]);
  const enriched = (sites ?? []).map(enrich);
  const capacityTotal = enriched.reduce((a, s: any) => a + (s.status === 'cerrado' ? 0 : s.capacity), 0);
  const population = (zones ?? []).reduce((a: number, z: any) => a + (z.population ?? 0), 0);
  const byTier = enriched.reduce((m: Record<string, number>, s: any) => ((m[s.tier] = (m[s.tier] ?? 0) + 1), m), {});
  return c.json({
    sites: enriched.length,
    population,
    capacityTotal,
    coveragePct: population > 0 ? Math.round((Math.min(capacityTotal, population) / population) * 100) : 0,
    deficit: Math.max(0, population - capacityTotal),
    byTier,
  });
});

// ── POST /api/refugios/score — preview a score for arbitrary inputs (public) ───
refugios.post('/score', async (c) => {
  const b = (await c.req.json().catch(() => null)) as SiteInput | null;
  if (!b) return c.json({ error: 'json_required' }, 400);
  const breakdown = scoreSite(b);
  return c.json({ capacity: computeCapacity(b), score: breakdown.total, breakdown, tier: scoreTier(breakdown.total) });
});

// ── GET /api/refugios/logistics?people=&days= — logistics + staffing (public) ──
refugios.get('/logistics', (c) => {
  const people = num(c.req.query('people')) ?? 0;
  const days = num(c.req.query('days')) ?? 7;
  return c.json(computeLogistics(people, days));
});

// ── GET /api/refugios/assign — live capacity-based assignment plan (public) ────
// Computes the allocation in-memory from current sites+zones; does not persist.
refugios.get('/assign', async (c) => {
  const [{ results: siteRows }, { results: zoneRows }] = await Promise.all([
    c.env.DB.prepare(`SELECT ${SITE_COLS} FROM refugios_sites WHERE moderation='approved'`).all(),
    c.env.DB.prepare(`SELECT id,nombre,lat,lon,population FROM refugios_zones`).all(),
  ]);
  const sites: SiteForAssign[] = (siteRows ?? [])
    .filter((s: any) => s.lat != null && s.lon != null)
    .map((s: any) => {
      const e = enrich(s);
      return { id: e.id, nombre: e.nombre, lat: e.lat, lon: e.lon, capacity: e.capacity, score: e.score, status: e.status };
    });
  const zones: ZoneInput[] = (zoneRows ?? [])
    .filter((z: any) => z.lat != null && z.lon != null)
    .map((z: any) => ({ id: z.id, nombre: z.nombre, lat: z.lat, lon: z.lon, population: z.population }));
  const result = assignPopulation(zones, sites);
  // attach logistics for the total sheltered population (7-day default)
  const logistics = computeLogistics(result.totals.sheltered, 7);
  return c.json({ ...result, logistics });
});

// ── POST /api/refugios/assign/save — persist a run (gated: refugios:manage) ────
refugios.post('/assign/save', async (c) => {
  const [{ results: siteRows }, { results: zoneRows }] = await Promise.all([
    c.env.DB.prepare(`SELECT ${SITE_COLS} FROM refugios_sites WHERE moderation='approved'`).all(),
    c.env.DB.prepare(`SELECT id,nombre,lat,lon,population FROM refugios_zones`).all(),
  ]);
  const sites: SiteForAssign[] = (siteRows ?? [])
    .filter((s: any) => s.lat != null && s.lon != null)
    .map((s: any) => { const e = enrich(s); return { id: e.id, nombre: e.nombre, lat: e.lat, lon: e.lon, capacity: e.capacity, score: e.score, status: e.status }; });
  const zones: ZoneInput[] = (zoneRows ?? [])
    .filter((z: any) => z.lat != null && z.lon != null)
    .map((z: any) => ({ id: z.id, nombre: z.nombre, lat: z.lat, lon: z.lon, population: z.population }));
  const result = assignPopulation(zones, sites);
  const runId = uid('run');
  const now = Date.now();
  if (result.assignments.length) {
    const stmt = c.env.DB.prepare(
      `INSERT INTO refugios_assignments (id,run_id,zone_id,site_id,people,distance_km,created_ms) VALUES (?,?,?,?,?,?,?)`,
    );
    await c.env.DB.batch(result.assignments.map((a) => stmt.bind(uid('asg'), runId, a.zone_id, a.site_id, a.people, a.distance_km, now)));
  }
  return c.json({ ok: true, run_id: runId, ...result.totals }, 201);
});

// ── POST /api/refugios — create a candidate site (gated) ───────────────────────
refugios.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 200);
  const tipo = str(b?.tipo, 40);
  if (!nombre || !tipo) return c.json({ error: 'nombre_y_tipo_requeridos' }, 400);
  const id = uid('ref');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO refugios_sites
      (id,nombre,tipo,municipio,parroquia,lat,lon,area_m2,techado_m2,bed_type,capacity_estimate,
       road_access,road_distance_m,services_water,services_power,services_sanitation,services_kitchen,
       elevation_m,flood_risk,coast_distance_m,status,notes,moderation,created_ms,updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved', ?, ?)`,
  ).bind(
    id, nombre, tipo, str(b?.municipio, 80), str(b?.parroquia, 80), num(b?.lat), num(b?.lon),
    num(b?.area_m2), num(b?.techado_m2), str(b?.bed_type, 20) ?? 'temporal', num(b?.capacity_estimate),
    num(b?.road_access) ?? 3, num(b?.road_distance_m), num(b?.services_water) ?? 2, num(b?.services_power) ?? 2,
    num(b?.services_sanitation) ?? 2, num(b?.services_kitchen) ?? 1, num(b?.elevation_m), num(b?.flood_risk) ?? 2,
    num(b?.coast_distance_m), str(b?.status, 20) ?? 'candidato', str(b?.notes, 1000), now, now,
  ).run();
  return c.json({ ok: true, id }, 201);
});

// ── PATCH /api/refugios/:id — update site fields (gated) ───────────────────────
const PATCHABLE = new Set([
  'nombre', 'tipo', 'municipio', 'parroquia', 'lat', 'lon', 'area_m2', 'techado_m2', 'bed_type',
  'capacity_estimate', 'road_access', 'road_distance_m', 'services_water', 'services_power',
  'services_sanitation', 'services_kitchen', 'elevation_m', 'flood_risk', 'coast_distance_m',
  'status', 'current_occupancy', 'notes',
]);
refugios.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'json_required' }, 400);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!PATCHABLE.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'string' ? v.slice(0, 1000) : v);
  }
  if (!sets.length) return c.json({ error: 'nada_que_actualizar' }, 400);
  vals.push(Date.now(), c.req.param('id'));
  const r = await c.env.DB.prepare(
    `UPDATE refugios_sites SET ${sets.join(', ')}, updated_ms = ? WHERE id = ?`,
  ).bind(...vals).run();
  return c.json({ ok: true, changes: r.meta.changes });
});

// ── DELETE /api/refugios/:id — remove a site (gated) ───────────────────────────
refugios.delete('/:id', async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM refugios_sites WHERE id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true, deleted: r.meta.changes });
});
