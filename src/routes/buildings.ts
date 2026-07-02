import { Hono } from 'hono';
import type { Env } from '../types';
import { rateLimit } from '../lib/security';
import { edgeCached } from '../lib/edge-cache';
import {
  scoreCurated, scoreOsm, computeSar, linkLiveMissing, estimateOccupants,
  type Sector, type Curated, type Osm, type Scored, type Sar, type MissingReport, PRIOR_BLEND,
} from '../lib/building-score';
import {
  mapTvBuilding, mapSosDamageBuilding, poolReportedBuildings, SOS_BUILDING_CATEGORIES,
  type TvBuilding, type SosDamageRow,
} from '../lib/tv-buildings';
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

// ── GET /api/buildings/reported — real reported buildings WITH photos ─────────
// Pooled inventory of REAL citizen-reported damaged buildings from two feeds,
// deduped by id: terremotovenezuela.com (rich photo galleries → tv_buildings) +
// the /danos structural-damage map (sos_damage: collapsed_building / damaged_building
// with Venezuela triage color + coords + people_trapped). Each row carries its
// address, a HAZUS replacement/repair cost, damage level, and a PHOTO GALLERY.
// ?damage=(total|severo|parcial) ?verified=1 ?withPhotos=1 ?state= ?q= ?limit=
buildings.get('/reported', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_reported', 60, 60);
  if (limited) return limited;
  const q = {
    damage: c.req.query('damage'), state: c.req.query('state'), q: (c.req.query('q') || '').toLowerCase(),
    verified: c.req.query('verified') === '1', withPhotos: c.req.query('withPhotos') === '1',
  };
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 2000, 1), 5000);
  return edgeCached(c, 300, async () => {
    // 1) terremotovenezuela.com (galleries)
    let tvRows: any[] = [];
    try {
      const res = await c.env.DB.prepare(
        `SELECT id, name, address, city, zone, lat, lng, damage_level, status,
                main_photo_url, media_urls, general_source, notes, has_missing_persons,
                tv_created_at, tv_updated_at
           FROM tv_buildings ORDER BY tv_updated_at DESC LIMIT 5000`,
      ).all();
      tvRows = (res.results ?? []) as any[];
    } catch { tvRows = []; }
    // 2) /danos structural-damage map (sos_damage building categories)
    let sosRows: SosDamageRow[] = [];
    try {
      const ph = SOS_BUILDING_CATEGORIES.map(() => '?').join(',');
      const res = await c.env.DB.prepare(
        `SELECT id, category, severity, verification, title, description, lat, lng,
                municipio, parroquia, building_type, people_trapped, source_url, image_url, created_at
           FROM sos_damage WHERE category IN (${ph}) ORDER BY created_at DESC LIMIT 5000`,
      ).bind(...SOS_BUILDING_CATEGORIES).all();
      sosRows = (res.results ?? []) as unknown as SosDamageRow[];
    } catch { sosRows = []; }

    // 3) pool + dedupe by id (tv galleries win; /danos adds triage/coords/trapped + new buildings)
    const pooled = poolReportedBuildings(tvRows.map(mapTvBuilding), sosRows.map(mapSosDamageBuilding));

    let mapped = pooled;
    if (q.damage) mapped = mapped.filter((b) => b.damageLevel.toLowerCase() === q.damage!.toLowerCase());
    if (q.state) mapped = mapped.filter((b) => b.state.toLowerCase() === q.state!.toLowerCase());
    if (q.verified) mapped = mapped.filter((b) => b.verified);
    if (q.withPhotos) mapped = mapped.filter((b) => b.mediaCount > 0);
    if (q.q) mapped = mapped.filter((b) => (b.name + ' ' + b.addr + ' ' + b.city).toLowerCase().includes(q.q));
    // rank: collapses first, then severity, then buildings that have photos
    const rank = (b: TvBuilding) => (b.damageLevel === 'total' ? 3 : b.damageLevel === 'severo' ? 2 : 1) * 10 + (b.mediaCount > 0 ? 1 : 0);
    mapped.sort((a, z) => rank(z) - rank(a));

    const withCoords = pooled.filter((b) => b.lat != null && b.lon != null).length;
    const withPhotos = pooled.filter((b) => b.mediaCount > 0).length;
    const sumRepair = Math.round(pooled.reduce((s, b) => s + (b.cost?.repairUsd ?? 0), 0));
    const sumRepl = Math.round(pooled.reduce((s, b) => s + (b.cost?.replacementUsd ?? 0), 0));
    return {
      event: METHODOLOGY.event,
      source: 'terremotovenezuela.com + sosvenezuela2026.com (/danos)',
      sources: ['terremotovenezuela.com', 'sosvenezuela2026.com'],
      count: mapped.length,
      total: pooled.length,
      from_tv: tvRows.length,
      from_danos: sosRows.length,
      with_coords: withCoords,
      with_photos: withPhotos,
      collapsed: pooled.filter((b) => b.damageLevel === 'total').length,
      people_trapped: pooled.reduce((s, b) => s + (b.peopleTrapped ?? 0), 0),
      costs_usd: { repair: sumRepair, replacement: sumRepl },
      by_damage: {
        total: pooled.filter((b) => b.damageLevel === 'total').length,
        severo: pooled.filter((b) => b.damageLevel === 'severo').length,
        parcial: pooled.filter((b) => b.damageLevel === 'parcial').length,
      },
      cost_note: 'Costo estimado por daño (HAZUS + costos reales VE 2026). Área/pisos desconocidos para reportes ciudadanos → confianza BAJA. No es tasación.',
      buildings: mapped.slice(0, limit),
    };
  });
});

// ── GET /api/buildings/reported/:id — full FORENSIC building profile ──────────
// The court-case dossier for one building: field data + photo galleries + a
// structured forensic record (year built, structure, GIS, studies) + the
// evidence document list (PDFs, engineering/geological/national studies, news,
// complaints) + linked missing persons + computed occupancy/cost + GIS links +
// a chronological forensic timeline. Read-only, public, PII-free (missing persons
// are already public on /personas). 404 if the building id is unknown.
buildings.get('/reported/:id', async (c) => {
  const limited = await rateLimit(c.env, c, 'buildings_profile', 90, 60);
  if (limited) return limited;
  const id = c.req.param('id');
  // Not-found must return BEFORE edgeCached (it re-wraps any returned value with
  // c.json → a Response object would serialize to {} with status 200).
  const row = await c.env.DB.prepare(
    `SELECT id, name, address, city, zone, lat, lng, damage_level, status,
            main_photo_url, media_urls, general_source, notes, has_missing_persons,
            tv_created_at, tv_updated_at FROM tv_buildings WHERE id = ?`,
  ).bind(id).first();
  // Fall back to the /danos structural-damage feed for buildings that only exist there.
  let sosRow: any = null;
  if (!row) {
    try {
      sosRow = await c.env.DB.prepare(
        `SELECT id, category, severity, verification, title, description, lat, lng,
                municipio, parroquia, building_type, people_trapped, source_url, image_url, created_at
           FROM sos_damage WHERE id = ? AND category IN ('collapsed_building','damaged_building')`,
      ).bind(id).first();
    } catch { sosRow = null; }
  }
  if (!row && !sosRow) return c.json({ error: 'not_found', id }, 404);
  return edgeCached(c, 120, async () => {
    const b = row ? mapTvBuilding(row) : mapSosDamageBuilding(sosRow as SosDamageRow);

    // Forensic record + evidence docs (soft-referenced; may not exist yet).
    let profile: any = null; let docs: any[] = [];
    try {
      profile = await c.env.DB.prepare(`SELECT * FROM building_profile WHERE building_id = ?`).bind(id).first();
    } catch { profile = null; }
    try {
      const dr = await c.env.DB.prepare(
        `SELECT id, kind, title, url, source, author, published_at, notes, created_at
           FROM building_docs WHERE building_id = ? ORDER BY published_at DESC, created_at DESC`,
      ).bind(id).all();
      docs = (dr.results ?? []) as any[];
    } catch { docs = []; }

    // Linked missing persons — reuse the live-linkage engine (name-token match on
    // free-text last-seen locations). Fail-soft: an empty list on any DB hiccup.
    let missing: string[] = [];
    try {
      const reports = await fetchMissingReports(c.env);
      missing = linkLiveMissing(b.name, reports);
    } catch { missing = []; }

    // Occupancy: surveyed override on the profile wins; else model from built area.
    const floorM2 = profile?.gross_area_m2 ?? b.cost?.floorM2 ?? null;
    const occupancy = profile?.occupancy_est ?? (floorM2 ? estimateOccupants('RESIDENCIAL', floorM2) : null);

    // GIS / map links (no API key needed for the basic embed / street-view deep link).
    const gis = (b.lat != null && b.lon != null) ? {
      lat: b.lat, lon: b.lon,
      plusCode: profile?.plus_code ?? null,
      mapsEmbed: `https://maps.google.com/maps?q=${b.lat},${b.lon}&z=18&output=embed`,
      mapsLink: `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lon}`,
      streetView: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${b.lat},${b.lon}`,
      osm: `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lon}#map=19/${b.lat}/${b.lon}`,
    } : null;

    // Structure / build facts (surveyed on the profile; honest nulls otherwise).
    const structure = {
      yearBuilt: profile?.year_built ?? null,
      type: profile?.structure_type ?? null,
      system: profile?.structure_system ?? null,
      floors: profile?.floors ?? b.cost?.levels ?? null,
      floorsSurveyed: profile?.floors != null,
      units: profile?.units ?? null,
      soilType: profile?.soil_type ?? null,
      lastInspectionAt: profile?.last_inspection_at ?? null,
      firstBuiltPermit: profile?.first_built_permit ?? null,
    };

    // Cost — surveyed override wins, else the HAZUS estimate on the mapped row.
    const cost = {
      repairUsd: profile?.repair_cost_usd ?? b.cost?.repairUsd ?? null,
      replacementUsd: profile?.replacement_cost_usd ?? b.cost?.replacementUsd ?? null,
      unitUsdM2: b.cost?.unitUsdM2 ?? null,
      areaM2: profile?.gross_area_m2 ?? b.cost?.areaM2 ?? null,
      damageRatio: b.cost?.damageRatio ?? null,
      confidence: (profile?.repair_cost_usd != null) ? 'SURVEYED' : (b.cost?.costConf ?? 'LOW'),
    };

    // Studies quick-links pulled from the profile (also appear in docs).
    const studies = {
      engineering: profile?.engineer_study_url ?? null,
      geological: profile?.geological_study_url ?? null,
      national: profile?.national_study_url ?? null,
    };

    // Forensic timeline — chronological chain of custody / evidence events.
    const timeline: { at: string; kind: string; label: string }[] = [];
    if (b.updatedAt) timeline.push({ at: b.updatedAt, kind: 'report', label: 'Última actualización del reporte de campo' });
    const createdAt = (row?.tv_created_at ?? sosRow?.created_at) as string | undefined;
    if (createdAt) timeline.push({ at: String(createdAt), kind: 'report', label: 'Reporte ciudadano registrado' });
    if (structure.lastInspectionAt) timeline.push({ at: structure.lastInspectionAt, kind: 'inspection', label: 'Inspección técnica' });
    for (const d of docs) if (d.published_at) timeline.push({ at: d.published_at, kind: d.kind, label: d.title || d.kind });
    timeline.sort((a, z) => (z.at || '').localeCompare(a.at || ''));

    // Group docs by the tab they belong to.
    const docsByKind: Record<string, any[]> = {};
    for (const d of docs) (docsByKind[d.kind] ||= []).push(d);

    return {
      building: b,
      structure,
      cost,
      occupancy,
      gis,
      studies,
      missing,
      missingCount: missing.length,
      docs,
      docsByKind,
      docCount: docs.length,
      timeline,
      profileEnriched: !!profile,
      event: METHODOLOGY.event,
      methodology: METHODOLOGY,
      disclaimer: 'Expediente forense en construcción. Los campos sin dato están pendientes de estudio de campo (CIV / Protección Civil / FUNVISIS). Estimaciones de ingeniería, no tasación ni censo oficial.',
    };
  });
});

// ── GET /api/buildings/sectors — sector registry (soil/MMI/prior) ─────────────
buildings.get('/sectors', async (c) => {
  return edgeCached(c, 600, async () =>
    Object.entries(SECTORS).map(([name, s]) => ({ sector: name, ...s })));
});
