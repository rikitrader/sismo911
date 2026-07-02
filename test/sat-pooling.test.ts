import { describe, it, expect } from 'vitest';
import {
  satDamageLevel, mapSatEdificacion, poolSatellite, groundDistM, satMatchOf, zoneTokens,
  SAT_MATCH_M, SAT_DUP_BAND_M, SAT_SOURCE, type SatEdifRow, type TvBuilding,
} from '../src/lib/tv-buildings';

// Satellite layer (sat_edificaciones: Copernicus EMS + AI4G) cross-matched into
// the reported-buildings pool by proximity. Invariants:
//  - severidad maps to the pooled damage_level vocabulary
//  - a sat point ≤SAT_MATCH_M of a building ENRICHES it (no new row)
//  - a sat point with no nearby building APPENDS a satellite-only building
//  - conservation: result.length === pooled.length + unmatched count
//  - unlocatable sat rows (null coords) are dropped, never fabricated

const sat = (over: Partial<SatEdifRow> = {}): SatEdifRow => ({
  id: 'sat-1', lat: 10.6, lng: -66.9, severidad: 'colapso', oficial: 1,
  zona: 'Caraballeda / La Guaira', uso: 'Residential', maps_url: 'https://maps.google.com/x',
  updated_ms: 1_780_000_000_000, ...over,
});

const bld = (over: Partial<TvBuilding> = {}): TvBuilding => ({
  id: 'b-1', name: 'Edificio X', addr: 'Av. 1', city: 'Caraballeda', zone: '', state: 'La Guaira',
  lat: 10.6, lon: -66.9, damageLevel: 'total', status: 'COLAPSO_TOTAL', band: 'CRITICO',
  verified: false, hasMissing: false, notes: '', source: 'terremotovenezuela.com',
  photo: null, media: [], mediaCount: 0, updatedAt: null, ...over,
});

describe('satDamageLevel', () => {
  it('maps colapso→total, grave→severo, else parcial', () => {
    expect(satDamageLevel('colapso')).toBe('total');
    expect(satDamageLevel('Colapso')).toBe('total');
    expect(satDamageLevel('grave')).toBe('severo');
    expect(satDamageLevel('')).toBe('parcial');
    expect(satDamageLevel(null)).toBe('parcial');
  });
});

describe('mapSatEdificacion', () => {
  it('produces a pooled building with HAZUS cost and satellite provenance', () => {
    const b = mapSatEdificacion(sat());
    expect(b.id).toBe('sat-1');
    expect(b.damageLevel).toBe('total');
    expect(b.status).toBe('COLAPSO_TOTAL');
    expect(b.verified).toBe(true); // oficial=1 (Copernicus-verified)
    expect(b.source).toBe(SAT_SOURCE);
    expect(b.cost?.replacementUsd).toBeGreaterThan(0);
    expect(b.cost?.repairUsd).toBeGreaterThan(0);
    expect(b.sat?.distM).toBe(0);
    expect(b.sat?.detectedAt).toMatch(/^20/);
  });
  it('grave + oficial=0 → severo, unverified', () => {
    const b = mapSatEdificacion(sat({ severidad: 'grave', oficial: 0 }));
    expect(b.damageLevel).toBe('severo');
    expect(b.verified).toBe(false);
  });
});

describe('groundDistM', () => {
  it('~111 m per 0.001° latitude', () => {
    const d = groundDistM(10.6, -66.9, 10.601, -66.9);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(125);
  });
});

describe('poolSatellite', () => {
  it('enriches a building within the match radius instead of adding a row', () => {
    const pooled = [bld()];
    // ~22 m north of the building
    const out = poolSatellite(pooled, [sat({ lat: 10.6002 })]);
    expect(out.length).toBe(1);
    expect(out[0].sat).toBeTruthy();
    expect(out[0].sat!.severidad).toBe('colapso');
    expect(out[0].sat!.distM).toBeLessThanOrEqual(SAT_MATCH_M);
    expect(out[0].verified).toBe(true); // oficial upgrades verification
    expect(out[0].sources).toContain(SAT_SOURCE);
  });
  it('appends a satellite-only building when nothing is nearby', () => {
    const pooled = [bld()];
    // ~1.1 km away → no match
    const out = poolSatellite(pooled, [sat({ id: 'sat-far', lat: 10.61 })]);
    expect(out.length).toBe(2);
    expect(out[0].sat ?? null).toBeNull();
    expect(out[1].id).toBe('sat-far');
    expect(out[1].source).toBe(SAT_SOURCE);
  });
  it('conserves counts: result = pooled + unmatched', () => {
    const pooled = [bld(), bld({ id: 'b-2', lat: 10.7, lon: -66.8 })];
    const sats = [
      sat({ id: 's-match', lat: 10.6001 }),          // matches b-1
      sat({ id: 's-only', lat: 11.0, lng: -67.5 }),  // unmatched
      sat({ id: 's-null', lat: null }),              // unlocatable → dropped
    ];
    const out = poolSatellite(pooled, sats);
    expect(out.length).toBe(3); // 2 pooled + 1 unmatched (null-coord row dropped)
  });
  it('nearest sat point wins when several match one building', () => {
    const pooled = [bld()];
    const out = poolSatellite(pooled, [
      sat({ id: 's-far', lat: 10.6004 }),  // ~44 m
      sat({ id: 's-near', lat: 10.6001 }), // ~11 m
    ]);
    expect(out.length).toBe(1);
    expect(out[0].sat!.id).toBe('s-near');
  });
  it('never matches a building without coordinates', () => {
    const pooled = [bld({ lat: null, lon: null })];
    const out = poolSatellite(pooled, [sat()]);
    expect(out.length).toBe(2); // appended as satellite-only, no false match
  });
  it('satMatchOf carries the maps link and detection date', () => {
    const m = satMatchOf(sat(), 12.4);
    expect(m.distM).toBe(12);
    expect(m.mapsUrl).toContain('maps.google');
    expect(m.oficial).toBe(true);
  });
});

describe('possible-duplicate band (60–150 m)', () => {
  it('59 m → enriches the building, no new row, no flag', () => {
    const out = poolSatellite([bld()], [sat({ lat: 10.6005 })]); // ~55 m
    expect(out.length).toBe(1);
    expect(out[0].sat).toBeTruthy();
    expect(out[0].possibleDuplicateOf ?? null).toBeNull();
  });
  it('~100 m → satellite-only row FLAGGED as possible duplicate', () => {
    const out = poolSatellite([bld()], [sat({ id: 's-dup', lat: 10.6009 })]); // ~100 m
    expect(out.length).toBe(2);
    const sb = out[1];
    expect(sb.id).toBe('s-dup');
    expect(sb.possibleDuplicateOf).toBeTruthy();
    expect(sb.possibleDuplicateOf!.id).toBe('b-1');
    expect(sb.possibleDuplicateOf!.distM).toBeGreaterThan(SAT_MATCH_M);
    expect(sb.possibleDuplicateOf!.distM).toBeLessThanOrEqual(SAT_DUP_BAND_M);
  });
  it('~200 m → satellite-only row clean (outside the band)', () => {
    const out = poolSatellite([bld()], [sat({ id: 's-clean', lat: 10.6018 })]); // ~200 m
    expect(out.length).toBe(2);
    expect(out[1].possibleDuplicateOf ?? null).toBeNull();
  });
});

describe('zoneTokens', () => {
  it('extracts meaningful accent-stripped tokens, drops generic words', () => {
    expect(zoneTokens('Edificación satélite — Caraballeda / La Guaira', 'Residential'))
      .toEqual(['caraballeda', 'guaira']);
  });
  it('caps at 6 and dedupes', () => {
    const t = zoneTokens('Macuto Macuto Tanaguarena Naiguatá Carayaca Catia Maiquetía Caruao');
    expect(t.length).toBeLessThanOrEqual(6);
    expect(new Set(t).size).toBe(t.length);
    expect(t).toContain('naiguata');
  });
  it('empty input → empty list', () => {
    expect(zoneTokens(null, undefined, '')).toEqual([]);
  });
});
