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
export interface Curated {
  name: string; use: string; sector: string; status: string;
  cas: string; conf: string; notes: string; src: string; vuln: Vuln;
}
export interface Osm { name: string; type: string; addr: string; sector: string; lat: number; lon: number; }

export interface Scored {
  score: number; band: string; dq: string;
  name: string; use: string; addr: string;
  sector: string; parish: string; city: string; state: string;
  status: string; notes: string; conf: string; tier: number; confNum: number;
  lat: number; lon: number; soil: number; prior: number; mmi: number; vulnX: number; modeled: number;
  source: string;
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

export function band(score: number): string {
  return score >= 80 ? 'CRITICO' : score >= 60 ? 'ALTO' : score >= 40 ? 'MODERADO'
    : score >= 20 ? 'BAJO' : 'MINIMO';
}

function modeled(sec: Sector, vf: number): number {
  const haz = mmiToHaz(sec.mmi);
  const phys = 100 * (1 - Math.pow(1 - haz, sec.soil * vf));
  return Math.round(((1 - PRIOR_BLEND) * phys + PRIOR_BLEND * sec.prior * 100) * 10) / 10;
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
  return {
    score, band: band(score), dq, name: b.name, use: b.use,
    addr: `${b.sector}, ${sec.parish}, ${sec.city}, ${sec.state}`,
    sector: b.sector, parish: sec.parish, city: sec.city, state: sec.state,
    status: b.status, notes: b.cas || b.notes, conf: b.conf, tier, confNum,
    lat: sec.lat, lon: sec.lon, soil: sec.soil, prior: sec.prior, mmi: sec.mmi,
    vulnX: Math.round(vf * 100) / 100, modeled: m, source: b.src,
  };
}

export function scoreOsm(o: Osm, sec: Sector): Scored {
  const t = (o.type || '').toLowerCase();
  const vuln: Vuln = {};
  if (t.includes('apartments') || t.includes('residential') || t.includes('house')) vuln.midrise = 1;
  if (t === 'yes' || t === '') vuln.unknown_constr = 1;
  const vf = vulnFactor(vuln);
  const m = modeled(sec, vf);
  return {
    score: m, band: band(m), dq: 'MODELED+LOW_DATA', name: o.name, use: o.type || 'edificio',
    addr: o.addr, sector: o.sector, parish: sec.parish, city: sec.city, state: sec.state,
    status: 'DESCONOCIDO', notes: '', conf: 'LOW', tier: 3, confNum: 0.35,
    lat: o.lat, lon: o.lon, soil: sec.soil, prior: sec.prior, mmi: sec.mmi,
    vulnX: Math.round(vf * 100) / 100, modeled: m, source: 'OSM/Overpass',
  };
}
