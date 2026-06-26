import { describe, it, expect } from 'vitest';
import { haversineKm, rankMatches, type CenterGeo, type InvRow, type NeedRow } from '../src/routes/logistica';
import { COMMODITIES, COMMODITY_IDS, COMMODITY_UNIT } from '../src/data/commodities';

describe('commodity taxonomy', () => {
  it('has stable ids, units and unique keys', () => {
    expect(COMMODITIES.length).toBeGreaterThanOrEqual(8);
    expect(COMMODITY_IDS.has('agua')).toBe(true);
    expect(COMMODITY_IDS.has('inventado')).toBe(false);
    expect(COMMODITY_UNIT['agua']).toBe('l');
    const ids = COMMODITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});

describe('haversineKm', () => {
  it('returns 0 for the same point and null when coords missing', () => {
    expect(haversineKm({ lat: 10, lon: -66 }, { lat: 10, lon: -66 })).toBe(0);
    expect(haversineKm(null, { lat: 10, lon: -66 })).toBeNull();
    expect(haversineKm({ lat: 10, lon: -66 }, undefined)).toBeNull();
    expect(haversineKm({ lat: NaN, lon: -66 }, { lat: 10, lon: -66 })).toBeNull();
  });
  it('approximates Caracas↔Maracaibo (~520 km) within tolerance', () => {
    const km = haversineKm({ lat: 10.48, lon: -66.90 }, { lat: 10.65, lon: -71.64 })!;
    expect(km).toBeGreaterThan(490);
    expect(km).toBeLessThan(540);
  });
});

describe('rankMatches (needs ↔ surplus, distance-ranked)', () => {
  const geo = new Map<string, CenterGeo>([
    ['dest',  { id: 'dest',  lat: 10.0, lon: -66.0 }],
    ['near',  { id: 'near',  lat: 10.1, lon: -66.0 }], // ~11 km
    ['far',   { id: 'far',   lat: 11.0, lon: -66.0 }], // ~111 km
    ['nogeo', { id: 'nogeo', lat: NaN,  lon: NaN }],
  ]);

  it('prefers the nearest surplus center for a need', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 100, priority: 1 }];
    const inv: InvRow[] = [
      { center_id: 'far', commodity: 'agua', qty: 50 },
      { center_id: 'near', commodity: 'agua', qty: 50 },
    ];
    const m = rankMatches(needs, inv, geo);
    expect(m[0].origin_id).toBe('near'); // nearest first
    expect(m[1].origin_id).toBe('far');
    expect(m.every((x) => x.dest_id === 'dest')).toBe(true);
  });

  it('never suggests a center supplying itself', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 100, priority: 2 }];
    const inv: InvRow[] = [{ center_id: 'dest', commodity: 'agua', qty: 999 }];
    expect(rankMatches(needs, inv, geo)).toHaveLength(0);
  });

  it('ignores zero/negative inventory and commodity mismatches', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 10, priority: 2 }];
    const inv: InvRow[] = [
      { center_id: 'near', commodity: 'agua', qty: 0 },
      { center_id: 'far', commodity: 'medicinas', qty: 50 },
    ];
    expect(rankMatches(needs, inv, geo)).toHaveLength(0);
  });

  it('orders global suggestions by priority then distance', () => {
    const needs: NeedRow[] = [
      { id: 'low', center_id: 'dest', commodity: 'agua', qty: 10, priority: 3 },
      { id: 'crit', center_id: 'far', commodity: 'agua', qty: 10, priority: 1 },
    ];
    const inv: InvRow[] = [{ center_id: 'near', commodity: 'agua', qty: 100 }];
    const m = rankMatches(needs, inv, geo);
    expect(m[0].priority).toBe(1); // critical surfaces first
  });

  it('caps suggestions per need (perNeed)', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 10, priority: 2 }];
    const inv: InvRow[] = Array.from({ length: 10 }, (_, i) => ({ center_id: 'near', commodity: 'agua', qty: i + 1 }));
    expect(rankMatches(needs, inv, geo, 3).length).toBeLessThanOrEqual(3);
  });
});
