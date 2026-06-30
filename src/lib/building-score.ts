// Building damage-scoring engine ("motor") — fragility/HAZUS-style P(daño severo) 0–100.
//
// Score = 0.60·Físico + 0.40·Prior_satelital
//   Físico   = 1 − (1 − Hazard)^(Suelo · Vulnerabilidad)   (bounded, never saturates)
//   Hazard   = f(MMI ShakeMap)                              (8→0.60, 9→0.85)
//   Suelo    = amplificación/licuefacción por sector        (relleno costero ↑, roca ↓)
//   Vuln     = Misión-Vivienda ×1.45, planta-baja-blanda ×1.25, pre-norma ×1.20, media-altura ×1.15
//   Prior    = base-rate satelital por sector (NASA DPM / Microsoft AI4Good)
//
// Confianza→tier alineado a /api/casualties: HIGH=T1/0.85 · MEDIUM=T2/0.60 · LOW=T3/0.35.
// DIRECT = daño reportado por fuente (score observado). MODELED = sólo estimado.

export interface Sector {
  parish: string; city: string; state: string; lat: number; lon: number;
  soil: number; mmi: number; soilNote: string; prior: number;
}
export type Vuln = Partial<Record<
  'mision' | 'soft_story' | 'pre_code' | 'midrise' | 'lowrise' | 'informal' | 'unknown_constr', number>>;
// area/levels carried per building (resolved offline; area_src/lev_src = 'OSM' real | 'EST' estimated | 'NA').
export interface CostInputs { area: number; levels: number; area_src: string; lev_src: string; }
export interface Curated extends Partial<CostInputs> {
  name: string; use: string; sector: string; status: string;
  cas: string; conf: string; notes: string; src: string; vuln: Vuln; missing?: string[];
}
export interface Osm extends Partial<CostInputs> {
  name: string; type: string; addr: string; sector: string; lat: number; lon: number; use?: string;
}
export interface Cost {
  areaM2: number; areaSrc: string; levels: number; levSrc: string; floorM2: number;
  unitUsdM2: number; replacementUsd: number; damageRatio: number; repairUsd: number; costConf: string;
}

export interface Scored {
  score: number; band: string; dq: string;
  name: string; use: string; addr: string;
  sector: string; parish: string; city: string; state: string;
  status: string; notes: string; conf: string; tier: number; confNum: number;
  lat: number; lon: number; soil: number; prior: number; mmi: number; vulnX: number; modeled: number;
  source: string; dpmProb?: number; cost?: Cost; missing?: string[];
}

// ===== SAR (search & rescue) triage =====
// Ranks DAMAGED buildings for rescue priority. The quake hit 18:04 VET (evening),
// so we use evening/residential occupancy. We report ESTIMATED OCCUPANTS (people
// likely inside) — NOT a "trapped" count, which would require casualty modeling.
export interface Sar {
  sarScore: number; severity: number; sevLabel: string;
  occupantsEst: number; occBasis: string; missing: string[]; missingCount: number; priority: string;
}
// Gross floor area per person (m²) — occupancy density. Residential evening occupancy
// (HAZUS occupancy-class population models, rounded for transparency).
const OCC_DENSITY: Record<string, number> = {
  RESIDENCIAL: 30, MISION_VIVIENDA: 22, HOTEL: 35, SALUD: 25, ESCUELA: 10,
  COMERCIAL: 20, GOBIERNO: 20, IGLESIA: 8, CLUB: 25, BARRIO_INFORMAL: 15,
};
export function estimateOccupants(use: string, floorM2?: number): number {
  if (!floorM2) return 0;
  return Math.round(floorM2 / (OCC_DENSITY[use] ?? 30));
}
export function sarSeverity(status: string, band: string, dpmProb?: number): number {
  const byStatus: Record<string, number> = {
    COLAPSO_TOTAL: 1.0, COLAPSO_PARCIAL: 0.75, CONDENADO: 0.45, DPM_DANADO: 0.55, DANADO: 0.35,
  };
  if (status in byStatus) return byStatus[status];
  if (dpmProb != null && dpmProb > 0) return Math.max(0.5, Math.min(0.7, dpmProb * 0.6));
  const byBand: Record<string, number> = { CRITICO: 0.5, ALTO: 0.3 };
  return byBand[band] ?? 0;
}
// Returns null when the building is NOT search-&-rescue relevant.
export function computeSar(b: Scored, missing: string[] = []): Sar | null {
  const severity = sarSeverity(b.status, b.band, b.dpmProb);
  const hasMissing = missing.length > 0;
  if (severity < 0.35 && !hasMissing && b.score < 70) return null;
  const occupantsEst = estimateOccupants(b.use, b.cost?.floorM2);
  let s = 100 * severity * Math.min(1, occupantsEst / 150);
  if (hasMissing) s *= 1 + 0.15 * Math.min(missing.length, 4); // named missing = active rescue need
  const sarScore = Math.min(100, Math.round(s));
  const sevLabel = severity >= 1 ? 'Colapso total' : severity >= 0.7 ? 'Colapso parcial'
    : severity >= 0.5 ? 'Daño grave' : severity >= 0.35 ? 'Dañado' : 'Riesgo';
  const priority = sarScore >= 70 ? 'INMEDIATA' : sarScore >= 45 ? 'ALTA' : sarScore >= 25 ? 'MEDIA' : 'BAJA';
  return {
    sarScore, severity, sevLabel, occupantsEst,
    occBasis: b.cost?.floorM2 ? `${b.cost.floorM2} m² / ${OCC_DENSITY[b.use] ?? 30} m²·p` : 'sin área',
    missing, missingCount: missing.length, priority,
  };
}

const MMI_MAP: Record<number, number> = { 5: 0.05, 6: 0.15, 7: 0.35, 8: 0.6, 9: 0.85, 10: 0.95 };
const STATUS_SCORE: Record<string, number> = {
  COLAPSO_TOTAL: 98, COLAPSO_PARCIAL: 85, CONDENADO: 80, DANADO: 62, HABITABLE: 15,
};
const CONF_TIER: Record<string, [number, number]> = {
  HIGH: [1, 0.85], MEDIUM: [2, 0.6], LOW: [3, 0.35], '': [3, 0.4],
};
export const PRIOR_BLEND = 0.4;

export function mmiToHaz(m: number): number {
  const lo = Math.floor(m), hi = lo + 1;
  const a = MMI_MAP[lo] ?? (lo >= 10 ? 0.95 : 0.05);
  const c = MMI_MAP[hi] ?? 0.95;
  return a + (c - a) * (m - lo);
}

export function vulnFactor(v: Vuln): number {
  let f = 1;
  if (v.mision) f *= 1.45;
  if (v.soft_story) f *= 1.25;
  if (v.pre_code) f *= 1.2;
  if (v.midrise) f *= 1.15;
  if (v.lowrise) f *= 0.85;
  if (v.informal) f *= 1.3;
  if (v.unknown_constr) f *= 1.1;
  return Math.max(0.6, Math.min(1.7, f));
}

// ===== COST MODEL: replacement + repair (REAL VE 2026 unit costs + FEMA HAZUS damage ratios) =====
// Construction/replacement cost USD/m2 — Venezuela 2026 (materiales+mano de obra+honorarios, sin terreno).
// Fuente: micasaenvenezuela.com 2026 (interior 400-700; Caracas 900-1500); proyectoscecor.com.
const COST_USD_M2: Record<string, number> = {
  'La Guaira': 700, 'Distrito Capital': 1000, 'Miranda': 1200, Aragua: 500, Yaracuy: 500, Carabobo: 550,
};
const DEFAULT_COST_M2 = 600;
const MISION_COST_M2 = 450; // vivienda social, menor especificación
const USE_MULT: Record<string, number> = {
  SALUD: 1.5, HOTEL: 1.3, GOBIERNO: 1.25, IGLESIA: 1.2, ESCUELA: 1.15,
  COMERCIAL: 1.0, RESIDENCIAL: 1.0, MISION_VIVIENDA: 1.0, CLUB: 1.0, BARRIO_INFORMAL: 0.6,
};
// FEMA HAZUS-MH central damage factors (% del costo de reemplazo): Slight 2, Moderate 10, Extensive 50, Complete 100.
export function damageRatio(status: string, band: string): number {
  const byStatus: Record<string, number> = {
    COLAPSO_TOTAL: 1.0, COLAPSO_PARCIAL: 0.55, CONDENADO: 0.5, DANADO: 0.3, DPM_DANADO: 0.4,
  };
  if (status in byStatus) return byStatus[status];
  const byBand: Record<string, number> = { CRITICO: 0.5, ALTO: 0.25, MODERADO: 0.1, BAJO: 0.03, MINIMO: 0.0 };
  return byBand[band] ?? 0.1;
}
export function computeCost(
  use: string, state: string, status: string, bandName: string, ci?: Partial<CostInputs>,
): Cost | undefined {
  if (use === 'INFRAESTRUCTURA') return undefined;
  const area = ci?.area ?? 350;
  const levels = ci?.levels ?? 3;
  const areaSrc = ci?.area_src ?? 'EST';
  const levSrc = ci?.lev_src ?? 'EST';
  const floor = area * levels;
  let unit = use === 'MISION_VIVIENDA' ? MISION_COST_M2 : (COST_USD_M2[state] ?? DEFAULT_COST_M2);
  unit = Math.round(unit * (USE_MULT[use] ?? 1));
  const replacementUsd = floor * unit;
  const ratio = damageRatio(status, bandName);
  const repairUsd = Math.round(replacementUsd * ratio);
  const costConf = areaSrc === 'OSM' && levSrc === 'OSM' ? 'HIGH'
    : areaSrc === 'EST' && levSrc === 'EST' ? 'LOW' : 'MEDIUM';
  return {
    areaM2: area, areaSrc, levels, levSrc, floorM2: floor,
    unitUsdM2: unit, replacementUsd, damageRatio: ratio, repairUsd, costConf,
  };
}

export function band(score: number): string {
  return score >= 80 ? 'CRITICO' : score >= 60 ? 'ALTO' : score >= 40 ? 'MODERADO'
    : score >= 20 ? 'BAJO' : 'MINIMO';
}

// hazOverride: observed NASA Sentinel-1 DPM damage_probability for this footprint.
// When present it replaces the MMI prior as the hazard term (a real observation
// beats the shaking estimate) and lifts the satellite prior to the observed value.
function modeled(sec: Sector, vf: number, hazOverride?: number): number {
  const haz = hazOverride != null ? Math.max(mmiToHaz(sec.mmi), hazOverride) : mmiToHaz(sec.mmi);
  const prior = hazOverride != null ? Math.max(sec.prior, hazOverride) : sec.prior;
  const phys = 100 * (1 - Math.pow(1 - haz, sec.soil * vf));
  return Math.round(((1 - PRIOR_BLEND) * phys + PRIOR_BLEND * prior * 100) * 10) / 10;
}

export function scoreCurated(b: Curated, sec: Sector): Scored {
  const vf = vulnFactor(b.vuln);
  const m = modeled(sec, vf);
  const [tier, confNum] = CONF_TIER[b.conf] ?? CONF_TIER[''];
  let score: number, dq: string;
  if (b.status in STATUS_SCORE) { score = STATUS_SCORE[b.status]; dq = 'DIRECT'; }
  else if (b.status === 'DESCONOCIDO' && b.cas) { score = Math.max(m, 60); dq = 'DIRECT'; }
  else { score = m; dq = 'MODELED'; }
  if (sec.soil >= 1.5 || b.vuln.unknown_constr) dq += '+LOW_DATA';
  const bandName = band(score);
  return {
    score, band: bandName, dq, name: b.name, use: b.use,
    addr: `${b.sector}, ${sec.parish}, ${sec.city}, ${sec.state}`,
    sector: b.sector, parish: sec.parish, city: sec.city, state: sec.state,
    status: b.status, notes: b.cas || b.notes, conf: b.conf, tier, confNum,
    lat: sec.lat, lon: sec.lon, soil: sec.soil, prior: sec.prior, mmi: sec.mmi,
    vulnX: Math.round(vf * 100) / 100, modeled: m, source: b.src,
    cost: computeCost(b.use, sec.state, b.status, bandName, b),
    ...(b.missing && b.missing.length ? { missing: b.missing } : {}),
  };
}

// dpm: observed NASA Sentinel-1 damage_probability for this footprint (0–1), if any.
export function scoreOsm(o: Osm, sec: Sector, dpm?: number): Scored {
  const t = (o.type || '').toLowerCase();
  const vuln: Vuln = {};
  if (t.includes('apartments') || t.includes('residential') || t.includes('house')) vuln.midrise = 1;
  if (t === 'yes' || t === '') vuln.unknown_constr = 1;
  const vf = vulnFactor(vuln);
  const observed = dpm != null && dpm > 0;
  const m = modeled(sec, vf, observed ? dpm : undefined);
  const bandName = band(m);
  const useCat = o.use || (t.includes('apartments') || t.includes('residential') || t.includes('house') ? 'RESIDENCIAL' : 'RESIDENCIAL');
  const costStatus = observed ? 'DPM_DANADO' : '';
  return {
    score: m, band: bandName,
    dq: observed ? 'OBSERVED-DPM' : 'MODELED+LOW_DATA',
    name: o.name, use: useCat,
    addr: o.addr, sector: o.sector, parish: sec.parish, city: sec.city, state: sec.state,
    status: observed ? 'DPM_DANADO' : 'DESCONOCIDO', notes: observed ? `NASA DPM p=${dpm}` : '',
    // observed = NASA satellite (tier 2, like nasa_dpm in /api/casualties); modeled stays tier 3
    conf: observed ? 'NASA-DPM' : 'LOW', tier: observed ? 2 : 3, confNum: observed ? 0.85 : 0.35,
    lat: o.lat, lon: o.lon, soil: sec.soil, prior: sec.prior, mmi: sec.mmi,
    vulnX: Math.round(vf * 100) / 100, modeled: m, source: observed ? 'OSM + NASA Sentinel-1 DPM' : 'OSM/Overpass',
    cost: computeCost(useCat, sec.state, costStatus, bandName, o),
    ...(observed ? { dpmProb: dpm } : {}),
  };
}
