// Seismic threat-level engine. Scores a civil-protection "nivel de vigilancia"
// from the live seismic events (USGS + FUNVISIS, already merged into the same
// `events` table and de-duplicated cross-source by the ingest, filtered to the
// Venezuela bbox). Drives the "Estado Actual" badge on the homepage/dashboard so
// it reflects reality (e.g. an active M7.5) instead of a hardcoded "Normal".
//
// The engine now produces TWO things:
//   1. `level` (1..4) — the discrete civil-protection alert tier. Uses the
//      proven categorical thresholds (magnitude / aftershock floors) so the
//      badge can never under-call a major quake, regardless of the score curve.
//   2. `score` (0..100) — a CONTINUOUS arithmetic threat index, the real-time
//      "score system" feed. It is a weighted sum of four physically-motivated
//      components (see scoreComponents below). The displayed level is the MAX of
//      the score-derived tier and the categorical tier, so both the smooth index
//      and the hard safety floors apply.

export interface ThreatComponents {
  magnitude: number; // 0..55  — strongest recent quake, recency-decayed
  impact: number;    // 0..25  — USGS PAGER alert level + peak shaking (MMI)
  swarm: number;     // 0..12  — aftershock pressure (M>=3.5 count in 6h)
  depth: number;     // 0..8   — shallow-quake damage amplifier
}

export interface ThreatLevel {
  level: 1 | 2 | 3 | 4;
  label: string;            // Spanish civil-protection label
  dot: string;              // tailwind bg-* class for the status dot
  reason: string;           // human explanation referencing the driving quake
  score: number;            // 0..100 continuous threat index (the "score system")
  components: ThreatComponents; // arithmetic breakdown of the score
  sources: string[];        // agencies feeding the score, e.g. ['USGS','FUNVISIS']
  max_mag_48h: number | null;
  recent_6h: number;        // count of M>=3.5 in the last 6h (aftershock pressure)
  driver_id: string | null;
}

const H = 3_600_000;

// Component weights (max points each) — the arithmetic "formula" the score uses.
// Sum of caps = 100, so a maxed-out reading is exactly 100.
const W_MAG = 55;
const W_IMPACT = 25;
const W_SWARM = 12;
const W_DEPTH = 8;

const PAGER_WEIGHT: Record<string, number> = { green: 0.25, yellow: 0.5, orange: 0.75, red: 1 };

function hoursAgo(now: number, ms: number): number {
  return Math.max(0, Math.round((now - ms) / H));
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Continuous threat index in [0,100]. Each term is independently bounded then
 * summed, so the calculation is fully auditable from the returned `components`.
 *
 *   magnitude = norm(maxMag48, 2.0..7.5) · 55 · recency(driver)
 *   impact    = max(pagerWeight, mmi/12) · 25
 *   swarm     = min(recent6 / 8, 1)      · 12
 *   depth     = shallowness(driver, <30km) · 8     (only when maxMag48 ≥ 4.5)
 *
 * recency(driver) decays linearly from 1.0 (now) to a 0.4 floor at 48h, so a
 * major quake stays "hot" for the whole 48h window then drops out.
 */
function scoreComponents(args: {
  maxMag48: number | null;
  driver: any | null;
  recent6: number;
  bestAlert: string | null;
  maxMmi: number;
  now: number;
}): ThreatComponents {
  const { maxMag48, driver, recent6, bestAlert, maxMmi, now } = args;

  let magnitude = 0;
  let depth = 0;
  if (maxMag48 != null && driver) {
    const recency = Math.max(0.4, 1 - hoursAgo(now, driver.time_ms) / 48);
    magnitude = clamp01((maxMag48 - 2.0) / (7.5 - 2.0)) * W_MAG * recency;
    // Shallow quakes shake harder; only amplify once we're at a moderate event.
    if (maxMag48 >= 4.5 && typeof driver.depth_km === 'number') {
      depth = clamp01((30 - driver.depth_km) / 30) * W_DEPTH;
    }
  }

  const pager = bestAlert ? (PAGER_WEIGHT[bestAlert] ?? 0) : 0;
  const impact = Math.max(pager, clamp01(maxMmi / 12)) * W_IMPACT;
  const swarm = clamp01(recent6 / 8) * W_SWARM;

  const round1 = (n: number) => Math.round(n * 10) / 10;
  return { magnitude: round1(magnitude), impact: round1(impact), swarm: round1(swarm), depth: round1(depth) };
}

/** Score the current threat level from VE-bbox seismic events (USGS + FUNVISIS). */
export function scoreThreat(events: any[], now: number): ThreatLevel {
  const list = (events ?? []).filter((e) => typeof e?.mag === 'number' && typeof e?.time_ms === 'number');
  const within = (h: number) => list.filter((e) => e.time_ms >= now - h * H);
  const last48 = within(48);
  const last24 = within(24);
  const last6 = within(6);

  const strongest = (arr: any[]) =>
    arr.reduce((a, b) => (a && a.mag >= b.mag ? a : b), null as any);

  const driver48 = strongest(last48);
  const maxMag48 = driver48 ? driver48.mag : null;
  const maxMag24 = last24.length ? strongest(last24).mag : 0;
  const recent6 = last6.filter((e) => e.mag >= 3.5).length;
  const redFlag = last48.some((e) => e.alert === 'red' || e.mag >= 7);
  const strong6 = last6.some((e) => e.mag >= 6);

  // Best PAGER alert + peak MMI in the window feed the impact component.
  const ALERT_RANK: Record<string, number> = { green: 1, yellow: 2, orange: 3, red: 4 };
  let bestAlert: string | null = null;
  let maxMmi = 0;
  for (const e of last48) {
    if (e.alert && (ALERT_RANK[e.alert] ?? 0) > (bestAlert ? ALERT_RANK[bestAlert] : 0)) bestAlert = e.alert;
    if (typeof e.mmi === 'number' && e.mmi > maxMmi) maxMmi = e.mmi;
  }

  const sources = [...new Set(last48.map((e) => e.source).filter(Boolean))]
    .map((s) => (({ usgs: 'USGS', funvisis: 'FUNVISIS' } as Record<string, string>)[String(s).toLowerCase()] || String(s).toUpperCase()))
    .sort();

  const components = scoreComponents({ maxMag48, driver: driver48, recent6, bestAlert, maxMmi, now });
  let score = components.magnitude + components.impact + components.swarm + components.depth;
  // Authoritative floor: a PAGER-red / M7+ / M6-in-6h reading is a maximum-alert
  // event even if recency has decayed the magnitude term — never let the index
  // under-report it.
  if (redFlag || strong6) score = Math.max(score, 90);
  score = Math.round(Math.max(0, Math.min(100, score)));

  const place = (e: any) => (e?.place ? String(e.place).replace(/^\d+\s*km\s+\w+\s+of\s+/i, '') : 'Venezuela');
  const drove = (e: any) => (e ? `M${e.mag} ${place(e)} hace ${hoursAgo(now, e.time_ms)} h` : 'actividad reciente');

  // Categorical tier (the proven safety floors) ...
  let catLevel: ThreatLevel['level'];
  if (redFlag || (maxMag48 != null && maxMag48 >= 6.5) || strong6) catLevel = 4;
  else if ((maxMag48 != null && maxMag48 >= 5.5) || maxMag24 >= 5 || recent6 >= 5) catLevel = 3;
  else if (maxMag48 != null && maxMag48 >= 4.5) catLevel = 2;
  else catLevel = 1;

  // ... and the score-derived tier. Displayed level = the higher of the two.
  const scoreLevel: ThreatLevel['level'] = score >= 75 ? 4 : score >= 50 ? 3 : score >= 25 ? 2 : 1;
  const level = Math.max(catLevel, scoreLevel) as ThreatLevel['level'];

  const LABELS: Record<number, { label: string; dot: string }> = {
    4: { label: 'Alerta Máxima', dot: 'bg-critical' },
    3: { label: 'Alerta', dot: 'bg-warning' },
    2: { label: 'Atención', dot: 'bg-advisory' },
    1: { label: 'Vigilancia Normal', dot: 'bg-safe' },
  };
  const { label, dot } = LABELS[level];

  let reason: string;
  if (level >= 4) reason = `Sismo mayor: ${drove(driver48)}${recent6 ? ` · ${recent6} réplicas en 6 h` : ''} · índice ${score}/100`;
  else if (level === 3) reason = `Actividad fuerte: ${drove(driver48)}${recent6 ? ` · ${recent6} réplicas en 6 h` : ''} · índice ${score}/100`;
  else if (level === 2) reason = `Sismo moderado: ${drove(driver48)} · índice ${score}/100`;
  else reason = maxMag48 != null ? `Sin sismos significativos · máx M${maxMag48} en 48 h · índice ${score}/100` : 'Sin sismos significativos en 48 h';

  return {
    level, label, dot, reason, score, components, sources,
    max_mag_48h: maxMag48, recent_6h: recent6, driver_id: driver48?.id ?? null,
  };
}
