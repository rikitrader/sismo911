import type { Env } from '../types';

// Cross-source seismic de-duplication.
// -----------------------------------------------------------------------------
// USGS and FUNVISIS independently report the SAME physical earthquake with
// slightly different origin time, epicenter, magnitude and depth. They carry
// different ids, so they persist as two rows and render as two map markers.
// This module finds those cross-source pairs and marks the non-preferred row
// (`dup_of = kept.id`); public reads filter `dup_of IS NULL`. Non-destructive,
// so the hourly re-ingest can't resurrect a visible duplicate — re-marking is a
// no-op.
//
// Matching is intentionally conservative to avoid collapsing distinct quakes in
// a swarm: a pair must agree on time AND location AND (loosely) magnitude, and
// each event is matched at most once (greedy nearest-first).

export interface DedupeEvent {
  id: string;
  source: string;
  mag: number | null;
  time_ms: number;
  lat: number;
  lon: number;
}

export interface DedupeOptions {
  /** Max origin-time gap. FUNVISIS times are minute-rounded, so allow ≥60s. */
  windowMs?: number;
  /** Max epicenter separation (km). */
  distKm?: number;
  /** Reject a pair whose magnitudes differ by more than this (sanity guard). */
  magTol?: number;
  /** Flag (don't reject) a matched pair whose magnitudes differ by ≥ this. */
  divergeMag?: number;
}

export const DEFAULTS: Required<DedupeOptions> = {
  windowMs: 90_000, // 90s — covers FUNVISIS minute-rounding + small disagreement
  distKm: 60,
  magTol: 2.5, // never merge an M2 with an M6 even if coincidentally close
  divergeMag: 1.0,
};

// Which source wins when two rows are the same quake. Higher = kept as
// canonical. USGS wins: it carries the impact metadata the app already uses
// (PAGER alert, MMI, felt, ShakeMap url). FUNVISIS still surfaces the quakes
// USGS misses (those have no USGS counterpart, so they're never marked).
export const SOURCE_PRIORITY: Record<string, number> = { usgs: 2, funvisis: 1 };
const priorityOf = (s: string) => SOURCE_PRIORITY[String(s).toLowerCase()] ?? 0;

const R_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface DupPair {
  keepId: string;
  dropId: string;
  keepSource: string;
  dropSource: string;
  dtMs: number;
  distKm: number;
  dMag: number | null; // |keep.mag - drop.mag|, null if either mag missing
  diverges: boolean;   // dMag >= divergeMag — agencies disagree on size
}

/**
 * Pure matcher: given events from mixed sources, return the cross-source
 * duplicate pairs (keep = higher-priority source). Greedy nearest-first so each
 * event is consumed once — distinct swarm quakes minutes apart stay separate.
 */
export function findCrossSourceDups(events: DedupeEvent[], opts: DedupeOptions = {}): DupPair[] {
  const o = { ...DEFAULTS, ...opts };
  // Build all candidate cross-source pairs that pass time + distance + mag gates.
  type Cand = { a: DedupeEvent; b: DedupeEvent; dt: number; dist: number; score: number };
  const cands: Cand[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (String(a.source).toLowerCase() === String(b.source).toLowerCase()) continue; // cross-source only
      const dt = Math.abs(a.time_ms - b.time_ms);
      if (dt > o.windowMs) continue;
      const dist = haversineKm(a, b);
      if (dist > o.distKm) continue;
      if (a.mag != null && b.mag != null && Math.abs(a.mag - b.mag) > o.magTol) continue;
      // Normalized closeness score: 0 = identical, 2 = at both limits.
      const score = dt / o.windowMs + dist / o.distKm;
      cands.push({ a, b, dt, dist, score });
    }
  }
  cands.sort((x, y) => x.score - y.score);

  const used = new Set<string>();
  const pairs: DupPair[] = [];
  for (const { a, b, dt, dist } of cands) {
    if (used.has(a.id) || used.has(b.id)) continue;
    used.add(a.id); used.add(b.id);
    // Keep the higher-priority source; tie-break by lexicographic id for determinism.
    const aWins = priorityOf(a.source) > priorityOf(b.source) ||
      (priorityOf(a.source) === priorityOf(b.source) && a.id <= b.id);
    const keep = aWins ? a : b;
    const drop = aWins ? b : a;
    const dMag = keep.mag != null && drop.mag != null ? Math.abs(keep.mag - drop.mag) : null;
    pairs.push({
      keepId: keep.id, dropId: drop.id,
      keepSource: keep.source, dropSource: drop.source,
      dtMs: dt, distKm: Math.round(dist * 10) / 10,
      dMag: dMag == null ? null : Math.round(dMag * 100) / 100,
      diverges: dMag != null && dMag >= o.divergeMag,
    });
  }
  return pairs;
}

export interface DedupeResult {
  scanned: number;
  pairs: number;
  marked: number;
  divergences: DupPair[];
}

/**
 * Load recent canonical events from D1, find cross-source duplicates, and mark
 * the dropped rows (`dup_of`). Idempotent. Returns a summary incl. any
 * magnitude divergences (agencies disagreeing on size) for the ops panel.
 *
 * `lookbackDays` bounds the scan (duplicates are always near-simultaneous, so a
 * short window suffices and keeps the query cheap).
 */
export async function dedupeCrossSource(
  env: Env,
  opts: DedupeOptions & { lookbackDays?: number; apply?: boolean } = {},
): Promise<DedupeResult> {
  const apply = opts.apply !== false; // default: apply
  const sinceMs = Date.now() - (opts.lookbackDays ?? 7) * 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT id, source, mag, time_ms, lat, lon FROM events
     WHERE dup_of IS NULL AND lat IS NOT NULL AND lon IS NOT NULL AND time_ms >= ?
     ORDER BY time_ms DESC LIMIT 1000`
  ).bind(sinceMs).all<DedupeEvent>();
  const events = results ?? [];

  const pairs = findCrossSourceDups(events, opts);
  let marked = 0;
  if (apply && pairs.length) {
    const stmt = env.DB.prepare(`UPDATE events SET dup_of = ? WHERE id = ? AND dup_of IS NULL`);
    await env.DB.batch(pairs.map((p) => stmt.bind(p.keepId, p.dropId)));
    marked = pairs.length;
  }
  return {
    scanned: events.length,
    pairs: pairs.length,
    marked,
    divergences: pairs.filter((p) => p.diverges),
  };
}
