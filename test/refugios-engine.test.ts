import { describe, it, expect } from 'vitest';
import {
  scoreSite, computeCapacity, scoreTier, assignPopulation, computeLogistics,
  orgTable, haversineKm, SPACE, DEFAULT_LOGISTICS,
  type SiteInput, type ZoneInput, type SiteForAssign,
} from '../src/refugios/engine';

// Cross-check gate: the engine's numeric invariants are asserted, not assumed.
// Standards mirrored from the engine's documented planning factors (Sphere/WFP).

describe('computeCapacity — Sphere space standards', () => {
  it('permanent beds use covered area / 3.5 m²', () => {
    expect(computeCapacity({ techado_m2: 3500, bed_type: 'permanente' }))
      .toBe(Math.floor(3500 / SPACE.coveredPerPerson)); // 1000
  });
  it('temporary uses total area / 4.5 m²', () => {
    expect(computeCapacity({ area_m2: 4500, bed_type: 'temporal' }))
      .toBe(Math.floor(4500 / SPACE.temporaryPerPerson)); // 1000
  });
  it('mixed = covered permanent + remaining open temporary', () => {
    const cap = computeCapacity({ area_m2: 10000, techado_m2: 3500, bed_type: 'mixto' });
    const perm = Math.floor(3500 / SPACE.coveredPerPerson);
    const temp = Math.floor((10000 - 3500) / SPACE.temporaryPerPerson);
    expect(cap).toBe(perm + temp);
  });
  it('manual override wins', () => {
    expect(computeCapacity({ area_m2: 999999, capacity_estimate: 250 })).toBe(250);
  });
  it('never negative / NaN on empty input', () => {
    expect(computeCapacity({})).toBe(0);
  });
});

describe('scoreSite — bounded 0-100 and weighted', () => {
  const samples: SiteInput[] = [
    {}, // empty
    { road_access: 5, road_distance_m: 0, services_water: 5, services_power: 5, services_sanitation: 5, services_kitchen: 5, area_m2: 1e6, techado_m2: 1e6, bed_type: 'permanente', elevation_m: 200, flood_risk: 0, coast_distance_m: 5000 }, // best
    { road_access: 0, road_distance_m: 5000, services_water: 0, services_power: 0, services_sanitation: 0, services_kitchen: 0, area_m2: 1, bed_type: 'temporal', elevation_m: 0, flood_risk: 5, coast_distance_m: 0 }, // worst
    { road_access: 3, services_water: 3, services_sanitation: 3, area_m2: 20000, bed_type: 'temporal', elevation_m: 30, flood_risk: 2, coast_distance_m: 500 },
  ];
  it('every sub-score and total stay within [0,100]', () => {
    for (const s of samples) {
      const b = scoreSite(s);
      for (const v of [b.roads, b.services, b.bedCapacity, b.safety, b.total]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
  it('best site scores higher than worst', () => {
    expect(scoreSite(samples[1]).total).toBeGreaterThan(scoreSite(samples[2]).total);
  });
  it('flood risk lowers safety (Vargas deslave discipline)', () => {
    const safe = scoreSite({ elevation_m: 60, flood_risk: 0, coast_distance_m: 1000 }).safety;
    const risky = scoreSite({ elevation_m: 60, flood_risk: 5, coast_distance_m: 1000 }).safety;
    expect(safe).toBeGreaterThan(risky);
  });
  it('tier mapping is monotonic', () => {
    expect(scoreTier(80)).toBe('optimo');
    expect(scoreTier(60)).toBe('apto');
    expect(scoreTier(45)).toBe('marginal');
    expect(scoreTier(20)).toBe('no_apto');
  });
});

describe('assignPopulation — conservation + capacity safety', () => {
  const zones: ZoneInput[] = [
    { id: 'z1', lat: 10.6, lon: -66.9, population: 1000 },
    { id: 'z2', lat: 10.61, lon: -66.85, population: 500 },
  ];
  const sites: SiteForAssign[] = [
    { id: 's1', lat: 10.6, lon: -66.9, capacity: 800, score: 90 },
    { id: 's2', lat: 10.61, lon: -66.85, capacity: 400, score: 70 },
    { id: 's3', lat: 10.62, lon: -66.8, capacity: 200, score: 50, status: 'cerrado' }, // excluded
  ];
  const r = assignPopulation(zones, sites);

  it('conserves people: sheltered + unsheltered === population', () => {
    expect(r.totals.sheltered + r.totals.unsheltered).toBe(r.totals.population);
    expect(r.totals.population).toBe(1500);
  });
  it('never over-fills a site beyond capacity', () => {
    const used: Record<string, number> = {};
    for (const a of r.assignments) used[a.site_id] = (used[a.site_id] ?? 0) + a.people;
    for (const s of sites) expect(used[s.id] ?? 0).toBeLessThanOrEqual(s.capacity);
  });
  it('excludes closed sites entirely', () => {
    expect(r.assignments.some((a) => a.site_id === 's3')).toBe(false);
  });
  it('with capacity 1200 < population 1500, 300 are unsheltered', () => {
    expect(r.totals.unsheltered).toBe(300);
  });
  it('sheltered equals sum of assigned people', () => {
    const assigned = r.assignments.reduce((a, x) => a + x.people, 0);
    expect(assigned).toBe(r.totals.sheltered);
  });
});

describe('computeLogistics — Sphere/WFP planning factors', () => {
  const p = 10000, days = 7;
  const r = computeLogistics(p, days);
  it('water = people × 15 L/day', () => {
    expect(r.water.litersPerDay).toBe(p * DEFAULT_LOGISTICS.waterLPerPersonDay);
    expect(r.water.litersTotal).toBe(p * 15 * days);
  });
  it('food kcal = people × 2100', () => {
    expect(r.food.kcalPerDay).toBe(p * 2100);
  });
  it('latrines = ceil(people/20), water taps = ceil(people/250)', () => {
    expect(r.sanitation.latrines).toBe(Math.ceil(p / 20));
    expect(r.sanitation.waterTaps).toBe(Math.ceil(p / 250));
  });
  it('doctors = ceil(people/2000); total personnel is the sum of roles', () => {
    expect(r.personnel.doctors).toBe(Math.ceil(p / 2000));
    const pp = r.personnel;
    expect(pp.total).toBe(pp.doctors + pp.nurses + pp.paramedics + pp.psychologists + pp.security + pp.cooks + pp.washTechs + pp.shelterStaff);
  });
  it('zero people → zero everything', () => {
    const z = computeLogistics(0, 7);
    expect(z.water.litersTotal).toBe(0);
    expect(z.personnel.total).toBe(0);
  });
});

describe('geo + org', () => {
  it('haversine: ~0 for same point, ~111 km per degree of latitude', () => {
    expect(haversineKm(10, -66, 10, -66)).toBeCloseTo(0, 5);
    expect(haversineKm(10, -66, 11, -66)).toBeGreaterThan(110);
  });
  it('org table has a single Incident Commander at the top', () => {
    const org = orgTable();
    expect(org.length).toBeGreaterThan(8);
    expect(org[0].rol).toMatch(/Comandante de Incidente/);
    expect(org[0].reporta_a).toBeUndefined();
  });
});
