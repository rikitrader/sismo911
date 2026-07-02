import { Hono } from 'hono';
import type { Env } from '../types';
import { rateLimit } from '../lib/security';
import { edgeCached } from '../lib/edge-cache';
import {
  scoreCurated, scoreOsm, computeSar, linkLiveMissing,
  type Sector, type Curated, type Osm, type Scored, type Sar, type MissingReport, PRIOR_BLEND,
} from '../lib/building-score';
import { mapTvBuilding, type TvBuilding } from '../lib/tv-buildings';
import sectorsRaw from '../data/buildings/sectors.json';
import curatedRaw from '../data/buildings/curated.json';
import osmRaw from '../data/buildings/osm.json';
import osmDpmRaw from '../data/buildings/osm_dpm.json'; // observed NASA Sentinel-1 DPM per footprint, keyed "lat,lon"

// BUILDINGS DAMAGE ENGINE (/api/buildings) — el "motor" de daño estructural.
//
// Puntúa cada edificio 0–100 con un modelo de fragilidad anclado a satélite
// (NASA DPM + Microsoft AI4Good), alineado al esquema tier/confianza de
// /api/casualties. Lecturas PÚBLICAS, sin PII. La verdad de campo (CIV/Protección
// Civil) aún no existe; esto es estimación + reportes de prensa, nunca censo.
export const buildings = new Hono<{ Bindings: Env }>();

const SECTORS = sectorsRaw as Record<string, Sector>;
const CURATED = curatedRaw as Curated[];
const OSM = osmRaw as Osm[];
const OSM_DPM = osmDpmRaw as Record<string, number>; // "lat,lon" -> observed damage_probability

// Score everything once at module load (deterministic, cheap).
const SCORED_CURATED: Scored[] = CURATED
  .filter((b) => SECTORS[b.sector])
  .map((b) => scoreCurated(b, SECTORS[b.sector]))
  .sort((a, z) => z.score - a.score);
const SCORED_OSM: Scored[] = OSM
  .filter((o) => SECTORS[o.sector])
  .map((o) => scoreOsm(o, SECTORS[o.sector], OSM_DPM[`${o.lat},${o.lon}`]))
  .sort((a, z) => z.score - a.score);
const DPM_OBSERVED = SCORED_OSM.filter((r) => r.dpmProb != null).length;

// SAR triage. Candidates = damaged buildings that pass the SAR filter, scored once.
// At request time we LINK the live missing-persons DB (persons.last_seen /
// personas.ubicacion) by building name, merge with curated names, and re-rank.
interface SarRow extends Sar { name: string; addr: string; sector: string; state: string;
  status: string; dq: string; lat: number; lon: number; caseQuery: string;
  liveMatched: number; sectorReports: number; missingSource: string; }
const SAR_CANDIDATES: Scored[] = [...SCORED_CURATED, ...SCORED_OSM]
  .filter((b) => computeSar(b, b.missing ?? []) !== null);

// Pull approved, still-missing reports for this event from both registries (one D1
// batch). Returns lowercased {name, loc} for in-memory name matching. Fail-soft: on
// any DB error the SAR list still works off curated names.
async function fetchMissingReports(env: Env): Promise<MissingReport[]> {
  try {
    const [a, b] = await env.DB.batch([
      env.DB.prepare(
        `SELECT full_name AS name, last_seen AS loc FROM persons
         WHERE review='approved' AND status='missing' AND COALESCE(last_seen,'')<>'' LIMIT 8000`),
      env.DB.prepare(
        `SELECT nombre AS name, ubicacion AS loc FROM personas
         WHERE moderation='approved' AND COALESCE(ubicacion,'')<>''
           AND estado NOT IN ('localizado','aparecido','hospitalizado','fallecido') LIMIT 8000`),
    ]);
    const rows = [...(a.results ?? []), ...(b.results ?? [])] as { name: string; loc: string }[];
    return rows.filter((r) => r.name && r.loc).map((r) => ({ name: r.name, loc: r.loc.toLowerCase() }));
  } catch { return []; }
}

function buildSarRows(reports: MissingReport[]): SarRow[] {
  return SAR_CANDIDATES.map((b) => {
    const curated = b.missing ?? [];
    const live = linkLiveMissing(b.name, reports);
    const merged = [...new Set([...curated, ...live])];
    const sectorReports = reports.filter((r) => r.loc.includes(b.sector.toLowerCase())).length;
    const sar = computeSar(b, merged)!;
    const missingSource = live.length && curated.length ? 'live+curated' : live.length ? 'live' : curated.length ? 'curated' : 'none';
    return {
      ...sar, name: b.name, addr: b.addr, sector: b.sector, state: b.state,
      status: b.status, dq: b.dq, lat: b.lat, lon: b.lon,
      caseQuery: merged[0] ?? b.name, liveMatched: live.length, sectorReports, missingSource,
    };
  }).sort((a, z) => z.sarScore - a.sarScore || z.occupantsEst - a.occupantsEst);
}

const COLLAPSED_STATUSES = new Set(['COLAPSO_TOTAL', 'COLAPSO_PARCIAL', 'CONDENADO', 'DANADO']);

function applyFilters(rows: Scored[], q: Record<string, string | undefined>): Scored[] {
  let out = rows;
  if (q.sector) out = out.filter((r) => r.sector.toLowerCase() === q.sector!.toLowerCase());
  if (q.state) out = out.filter((r) => r.state.toLowerCase() === q.state!.toLowerCase());
  if (q.parish) out = out.filter((r) => r.parish.toLowerCase() === q.parish!.toLowerCase());
  if (q.band) out = out.filter((r) => r.band === q.band!.toUpperCase());
  if (q.min) { const n = Number(q.min); if (Number.isFinite(n)) out = out.filter((r) => r.score >= n); }
  return out;
}

const METHODOLOGY = {
  formula: 'Score = 0.60·(1−(1−Hazard)^(Suelo·Vuln)) + 0.40·Prior_satelital',
  hazard: 'f(MMI ShakeMap): 8→0.60, 9→0.85',
  priorBlend: PRIOR_BLEND,
  priorSources: ['NASA Sentinel-1 DPM (Oregon State)', 'Microsoft AI for Good Lab'],
  bands: { CRITICO: '80-100', ALTO: '60-79', MODERADO: '40-59', BAJO: '20-39', MINIMO: '0-19' },
  dataQuality: { DIRECT: 'daño reportado por fuente', 'OBSERVED-DPM': 'NASA Sentinel-1 detectó daño en la huella (damage_probability)', MODELED: 'estimado por el modelo', LOW_DATA: 'suelo/construcción desconocidos' },
  dpmOverlay: 'Huellas OSM cruzadas (≤40m) con estructuras dañadas de NASA Sentinel-1 (damage=1); cuando hay coincidencia, la probabilidad observada reemplaza al MMI como término de peligro.',
  costModel: 'Costo de reemplazo = sup. construida (huella OSM real × pisos) × USD/m² (real VE 2026: La Guaira 700, Caracas 1000, Miranda 1200, interior 500; ×uso). Reparación = reemplazo × ratio HAZUS (Complete 100% · Extensive 50% · Moderate 10% · Slight 2%). cost.costConf: HIGH=área+pisos reales.',
  costSources: ['micasaenvenezuela.com 2026', 'proyectoscecor.com', 'FEMA HAZUS-MH Technical Manual'],
  tiers: { HIGH: 'T1/0.85', 'NASA-DPM': 'T2/0.85', MEDIUM: 'T2/0.60', LOW: 'T3/0.35' },
  event: 've-eq-2026-06-24 · Mw 7.2 (us6000t7zc) + Mw 7.5 (us6000t7zp) · ShakeMap MMI max 9.05',
  caveat: 'No existe censo oficial certificado (CIV + Min. Hábitat). Estimación + prensa; reportes ciudadanos no verificados.',
};

// ── GET /api/buildings — scored inventory (curated named buildings) ───────────
// Query: ?sector= ?state= ?parish= ?band= ?min= ?source=curated|osm|all ?limit=
buildings.get('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_browse', 60, 60);
  if (limited) return limited;
  const q = {
    sector: c.req.query('sector'), state: c.req.query('state'), parish: c.req.query('parish'),
    band: c.req.query('band'), min: c.req.query('min'),
  };
  const source = (c.req.query('source') || 'curated').toLowerCase();
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 500, 1), 5000);
  return edgeCached(c, 300, async () => {
    const base = source === 'osm' ? SCORED_OSM : source === 'all' ? [...SCORED_CURATED, ...SCORED_OSM] : SCORED_CURATED;
    const rows = applyFilters(base, q).slice(0, limit);
    return {
      event: METHODOLOGY.event, source, count: rows.length,
      total_curated: SCORED_CURATED.length, total_osm: SCORED_OSM.length,
      methodology: METHODOLOGY, buildings: rows,
    };
  });
});

// ── GET /api/buildings/collapsed — only reported collapses/damage ─────────────
buildings.get('/collapsed', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_collapsed', 60, 60);
  if (limited) return limited;
  return edgeCached(c, 300, async () => {
    const rows = SCORED_CURATED.filter((r) => COLLAPSED_STATUSES.has(r.status));
    return { event: METHODOLOGY.event, count: rows.length, buildings: rows };
  });
});

// ── GET /api/buildings/summary — counts by band/sector + methodology ──────────
buildings.get('/summary', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_summary', 60, 60);
  if (limited) return limited;
  return edgeCached(c, 300, async () => {
    const all = [...SCORED_CURATED, ...SCORED_OSM];
    const byBand: Record<string, number> = {};
    const byState: Record<string, number> = {};
    const bySector: Record<string, { count: number; critico: number }> = {};
    for (const r of all) {
      byBand[r.band] = (byBand[r.band] || 0) + 1;
      byState[r.state] = (byState[r.state] || 0) + 1;
      const s = (bySector[r.sector] ||= { count: 0, critico: 0 });
      s.count++; if (r.band === 'CRITICO') s.critico++;
    }
    const reported = SCORED_CURATED.filter((r) => COLLAPSED_STATUSES.has(r.status)).length;
    // Aggregate cost (USD). OSM named set = comprehensive lower bound (named buildings only).
    const sumRepl = (rs: Scored[]) => Math.round(rs.reduce((s, r) => s + (r.cost?.replacementUsd ?? 0), 0));
    const sumRepair = (rs: Scored[]) => Math.round(rs.reduce((s, r) => s + (r.cost?.repairUsd ?? 0), 0));
    const confirmed = SCORED_CURATED.filter((r) => COLLAPSED_STATUSES.has(r.status));
    return {
      event: METHODOLOGY.event, total: all.length, curated: SCORED_CURATED.length, osm: SCORED_OSM.length,
      reported_damaged: reported, dpm_observed: DPM_OBSERVED, by_band: byBand, by_state: byState, by_sector: bySector,
      costs_usd: {
        osm_replacement: sumRepl(SCORED_OSM), osm_repair: sumRepair(SCORED_OSM),
        confirmed_replacement: sumRepl(confirmed), confirmed_repair: sumRepair(confirmed),
        note: 'Estimación de ingeniería (HAZUS + costos reales VE 2026), NO tasación oficial. Total OSM cubre solo edificios con nombre → subestima el agregado real.',
      },
      methodology: METHODOLOGY,
    };
  });
});

// ── GET /api/buildings/sar — search & rescue priority list ────────────────────
// Damaged buildings ranked by rescue priority (severity × estimated occupants,
// boosted by reported missing). ?state= ?priority=INMEDIATA|ALTA|MEDIA ?limit=
buildings.get('/sar', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_sar', 60, 60);
  if (limited) return limited;
  const state = c.req.query('state');
  const priority = c.req.query('priority');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 300, 1), 2000);
  return edgeCached(c, 300, async () => {
    const reports = await fetchMissingReports(c.env);
    let rows = buildSarRows(reports);
    if (state) rows = rows.filter((r) => r.state.toLowerCase() === state.toLowerCase());
    if (priority) rows = rows.filter((r) => r.priority === priority.toUpperCase());
    return {
      event: METHODOLOGY.event,
      count: rows.length,
      live_reports_indexed: reports.length,
      note: 'Triage de rescate: prioridad = severidad × ocupantes estimados (ocupación nocturna; sismo 18:04 VET), realzado por desaparecidos reportados. Los desaparecidos provienen EN VIVO de /api/persons (last_seen) + Familia (ubicacion), cruzados por nombre del edificio. "Ocupantes estimados" = personas probablemente dentro, NO un conteo de atrapados. Estimación, no censo de campo.',
      methodology: {
        priority: 'sarScore≥70 INMEDIATA · ≥45 ALTA · ≥25 MEDIA · resto BAJA',
        occupants: 'área construida ÷ densidad (RESIDENCIAL 30 m²/persona; HAZUS occupancy)',
        missing: 'missingSource: live = del DB de desaparecidos · curated = de prensa · liveMatched = nº enlazados en vivo · sectorReports = desaparecidos del sector',
        cases: 'caseQuery → /personas?q= (buscar desaparecidos vinculados)',
      },
      buildings: rows.slice(0, limit),
    };
  });
});

// ── GET /api/buildings/sar/summary — SAR aggregate ────────────────────────────
buildings.get('/sar/summary', async (c) => {
  return edgeCached(c, 300, async () => {
    const reports = await fetchMissingReports(c.env);
    const rows = buildSarRows(reports);
    const byPriority: Record<string, number> = {};
    let occupants = 0; const missingNames = new Set<string>(); let withMissing = 0; let liveLinked = 0;
    for (const r of rows) {
      byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
      occupants += r.occupantsEst;
      if (r.liveMatched) liveLinked++;
      if (r.missingCount) { withMissing++; r.missing.forEach((n) => missingNames.add(n)); }
    }
    return {
      event: METHODOLOGY.event, sar_buildings: rows.length, by_priority: byPriority,
      estimated_occupants: occupants, buildings_with_reported_missing: withMissing,
      buildings_with_live_links: liveLinked, live_reports_indexed: reports.length,
      reported_missing_names: [...missingNames].slice(0, 200),
      note: 'Ocupantes = estimación de personas dentro (ocupación nocturna), NO atrapados. Desaparecidos enlazados EN VIVO desde /api/persons (last_seen) + Familia (ubicacion); nombres no verificados.',
    };
  });
});

// ── GET /api/buildings/reported — real citizen-reported buildings WITH photos ─
// Mirror of terremotovenezuela.com (ingested hourly into tv_buildings). Each row
// carries its address, a HAZUS replacement/repair cost, and a PHOTO GALLERY
// (media[]). Distinct from the modeled curated/OSM inventory above. ?damage= (total|
// severo|parcial) ?verified=1 ?withPhotos=1 ?state= ?q= ?limit=
buildings.get('/reported', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_reported', 60, 60);
  if (limited) return limited;
  const q = {
    damage: c.req.query('damage'), state: c.req.query('state'), q: (c.req.query('q') || '').toLowerCase(),
    verified: c.req.query('verified') === '1', withPhotos: c.req.query('withPhotos') === '1',
  };
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 2000, 1), 5000);
  return edgeCached(c, 300, async () => {
    let rows: any[] = [];
    try {
      const res = await c.env.DB.prepare(
        `SELECT id, name, address, city, zone, lat, lng, damage_level, status,
                main_photo_url, media_urls, general_source, notes, has_missing_persons,
                tv_created_at, tv_updated_at
           FROM tv_buildings ORDER BY tv_updated_at DESC LIMIT 5000`,
      ).all();
      rows = (res.results ?? []) as any[];
    } catch { rows = []; }
    let mapped: TvBuilding[] = rows.map(mapTvBuilding);
    if (q.damage) mapped = mapped.filter((b) => b.damageLevel.toLowerCase() === q.damage!.toLowerCase());
    if (q.state) mapped = mapped.filter((b) => b.state.toLowerCase() === q.state!.toLowerCase());
    if (q.verified) mapped = mapped.filter((b) => b.verified);
    if (q.withPhotos) mapped = mapped.filter((b) => b.mediaCount > 0);
    if (q.q) mapped = mapped.filter((b) => (b.name + ' ' + b.addr + ' ' + b.city).toLowerCase().includes(q.q));
    const mappedAll: TvBuilding[] = rows.map(mapTvBuilding);
    const withCoords = mapped.filter((b) => b.lat != null && b.lon != null).length;
    const withPhotos = mapped.filter((b) => b.mediaCount > 0).length;
    return {
      event: METHODOLOGY.event,
      source: 'terremotovenezuela.com',
      count: mapped.length,
      total: mappedAll.length,
      with_coords: withCoords,
      with_photos: withPhotos,
      by_damage: {
        total: mappedAll.filter((b) => b.damageLevel === 'total').length,
        severo: mappedAll.filter((b) => b.damageLevel === 'severo').length,
        parcial: mappedAll.filter((b) => b.damageLevel === 'parcial').length,
      },
      cost_note: 'Costo estimado por daño (HAZUS + costos reales VE 2026). Área/pisos desconocidos para reportes ciudadanos → confianza BAJA. No es tasación.',
      buildings: mapped.slice(0, limit),
    };
  });
});

// ── GET /api/buildings/sectors — sector registry (soil/MMI/prior) ─────────────
buildings.get('/sectors', async (c) => {
  return edgeCached(c, 600, async () =>
    Object.entries(SECTORS).map(([name, s]) => ({ sector: name, ...s })));
});
