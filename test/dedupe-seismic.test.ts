import { describe, it, expect } from 'vitest';
import { findCrossSourceDups, haversineKm, SANITY_WIDE, type DedupeEvent } from '../src/lib/dedupe-seismic';

const T = Date.UTC(2026, 5, 27, 19, 20); // FUNVISIS M5 "41km N de Maracay" origin

// Same physical quake, two agencies: FUNVISIS minute-rounded, USGS precise; a
// few km / tens of seconds apart — the canonical cross-source duplicate.
const funMaracay: DedupeEvent = { id: 'funvisis-27062026-1520-10.62--67.62', source: 'funvisis', mag: 5.0, time_ms: T, lat: 10.62, lon: -67.62 };
const usgsMaracay: DedupeEvent = { id: 'us7000maracay', source: 'usgs', mag: 4.8, time_ms: T + 38_000, lat: 10.70, lon: -67.66 };

describe('haversineKm', () => {
  it('measures the Maracay pair as a few km apart', () => {
    const d = haversineKm(funMaracay, usgsMaracay);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(15);
  });
});

describe('findCrossSourceDups', () => {
  it('pairs the same quake across sources and KEEPS the USGS row (richer metadata)', () => {
    const pairs = findCrossSourceDups([funMaracay, usgsMaracay]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keepId).toBe('us7000maracay');
    expect(pairs[0].dropId).toBe(funMaracay.id);
    expect(pairs[0].keepSource).toBe('usgs');
  });

  it('does NOT merge two quakes separated in time (swarm safety)', () => {
    // Same spot, but 600s apart — well beyond the 150s window. Distinct events.
    const later: DedupeEvent = { ...usgsMaracay, id: 'us7000later', time_ms: T + 600_000 };
    expect(findCrossSourceDups([funMaracay, later])).toHaveLength(0);
  });

  it('catches a minute-rounded match the old 90s window would have missed', () => {
    // FUNVISIS truncates to the minute → its time can sit up to ~59s before the
    // true origin; with clock/solution slop a real pair can be ~120s apart.
    // The tuned 150s window keeps it; the original 90s window would have dropped it.
    const rounded: DedupeEvent = { ...usgsMaracay, id: 'us7000rounded', time_ms: T + 120_000 };
    expect(findCrossSourceDups([funMaracay, rounded], { windowMs: 90_000 })).toHaveLength(0);
    expect(findCrossSourceDups([funMaracay, rounded])).toHaveLength(1); // default 150s
  });

  it('does NOT merge distant epicenters even at the same instant', () => {
    const farUsgs: DedupeEvent = { id: 'us7000far', source: 'usgs', mag: 4.9, time_ms: T, lat: 12.4, lon: -62.1 }; // ~600km E
    expect(findCrossSourceDups([funMaracay, farUsgs])).toHaveLength(0);
  });

  it('never merges across a huge magnitude gap (sanity guard)', () => {
    const tiny: DedupeEvent = { ...usgsMaracay, id: 'us7000tiny', mag: 1.8 }; // Δmag 3.2 > magTol 2.5
    expect(findCrossSourceDups([funMaracay, tiny])).toHaveLength(0);
  });

  it('flags a matched pair whose magnitudes diverge by ≥ 1.0', () => {
    const bigUsgs: DedupeEvent = { ...usgsMaracay, id: 'us7000big', mag: 6.2 }; // Δmag 1.2, within magTol
    const [p] = findCrossSourceDups([funMaracay, bigUsgs]);
    expect(p.diverges).toBe(true);
    expect(p.dMag).toBeCloseTo(1.2, 5);
  });

  it('does not flag divergence when agencies roughly agree', () => {
    expect(findCrossSourceDups([funMaracay, usgsMaracay])[0].diverges).toBe(false);
  });

  it('leaves a FUNVISIS-only quake (no USGS counterpart) unmatched — the gap-filler case', () => {
    const losTeques: DedupeEvent = { id: 'funvisis-27062026-1023-10.57--67.24', source: 'funvisis', mag: 4.1, time_ms: Date.UTC(2026, 5, 27, 14, 23), lat: 10.57, lon: -67.24 };
    const pairs = findCrossSourceDups([funMaracay, usgsMaracay, losTeques]);
    expect(pairs).toHaveLength(1); // only the Maracay pair
    expect(pairs.some((p) => p.keepId === losTeques.id || p.dropId === losTeques.id)).toBe(false);
  });

  it('matches each event at most once (greedy, no double-counting in a cluster)', () => {
    // Two USGS rows near one FUNVISIS row — only the closest should consume it.
    const usgsNear: DedupeEvent = { ...usgsMaracay, id: 'us7000near', time_ms: T + 5_000, lat: 10.63, lon: -67.63 };
    const usgsFarther: DedupeEvent = { ...usgsMaracay, id: 'us7000farther', time_ms: T + 80_000, lat: 10.78, lon: -67.70 };
    const pairs = findCrossSourceDups([funMaracay, usgsNear, usgsFarther]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keepId).toBe('us7000near'); // the nearest in time+space won
  });
});

describe('sanity (borderline) detection', () => {
  // The hourly self-check (dedupeCrossSource) compares production tolerances to
  // SANITY_WIDE; a pair caught only by the wide pass is "borderline" — the
  // signal that the tuning may be too tight. This tests that comparison logic.
  it('flags a pair just outside prod tolerances but inside the wide pass', () => {
    const justOutside: DedupeEvent = { ...usgsMaracay, id: 'us7000_300s', time_ms: T + 300_000 }; // 300s: > 150s prod, < 600s wide
    const prod = findCrossSourceDups([funMaracay, justOutside]);
    const wide = findCrossSourceDups([funMaracay, justOutside], SANITY_WIDE);
    expect(prod).toHaveLength(0);
    expect(wide).toHaveLength(1);
    const prodIds = new Set(prod.map((p) => p.dropId));
    const borderline = wide.filter((p) => !prodIds.has(p.dropId));
    expect(borderline).toHaveLength(1); // would warn → "revisit DEFAULTS"
  });

  it('reports no borderline when prod tolerances already catch the pair', () => {
    const prod = findCrossSourceDups([funMaracay, usgsMaracay]); // 38s — inside prod
    const wide = findCrossSourceDups([funMaracay, usgsMaracay], SANITY_WIDE);
    const prodIds = new Set(prod.map((p) => p.dropId));
    expect(wide.filter((p) => !prodIds.has(p.dropId))).toHaveLength(0);
  });
});
