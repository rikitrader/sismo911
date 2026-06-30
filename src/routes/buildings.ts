import { Hono } from 'hono';
import type { Env } from '../types';
import { rateLimit } from '../lib/security';
import { edgeCached } from '../lib/edge-cache';
import {
  scoreCurated, scoreOsm, type Sector, type Curated, type Osm, type Scored, PRIOR_BLEND,
} from '../lib/building-score';
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
    return {
      event: METHODOLOGY.event, total: all.length, curated: SCORED_CURATED.length, osm: SCORED_OSM.length,
      reported_damaged: reported, dpm_observed: DPM_OBSERVED, by_band: byBand, by_state: byState, by_sector: bySector,
      methodology: METHODOLOGY,
    };
  });
});

// ── GET /api/buildings/sectors — sector registry (soil/MMI/prior) ─────────────
buildings.get('/sectors', async (c) => {
  return edgeCached(c, 600, async () =>
    Object.entries(SECTORS).map(([name, s]) => ({ sector: name, ...s })));
});
