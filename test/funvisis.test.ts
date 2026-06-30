import { describe, it, expect } from 'vitest';
import { normalizeFunvisisFeature, parseFunvisisTime } from '../src/lib/funvisis';

// FUNVISIS reuses a generic store-locator GeoJSON template, so property names
// are misleading. These fixtures mirror the real maravilla.json shape exactly.
const feature = (over: Record<string, any> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-67.62, 10.62] },
  properties: {
    phoneFormatted: '8.8 km',
    phone: '5.0',            // magnitud
    address: '41 km al norte de Maracay',
    city: '15:20',          // hora local (VET)
    country: 'Venezuela',
    postalCode: '27-06-2026', // fecha DD-MM-YYYY
    state: '8.8 km',        // profundidad
    lat: '10.62',
    long: '-67.62',
    ...over,
  },
});

describe('parseFunvisisTime', () => {
  it('reads VET (UTC-4) local time and returns UTC epoch ms', () => {
    // 09:44 VET => 13:44 UTC
    expect(parseFunvisisTime('27-06-2026', '9:44')).toBe(Date.UTC(2026, 5, 27, 13, 44));
  });
  it('returns null on malformed date/time', () => {
    expect(parseFunvisisTime('2026/06/27', '9:44')).toBeNull();
    expect(parseFunvisisTime('27-06-2026', 'nope')).toBeNull();
    expect(parseFunvisisTime('40-13-2026', '9:44')).toBeNull();
  });
});

describe('normalizeFunvisisFeature', () => {
  it('re-maps the disguised fields into a SeismicEvent', () => {
    const e = normalizeFunvisisFeature(feature())!;
    expect(e).not.toBeNull();
    expect(e.source).toBe('funvisis');
    expect(e.mag).toBe(5.0);
    expect(e.depth_km).toBe(8.8);
    expect(e.place).toBe('41 km al norte de Maracay');
    expect(e.lat).toBe(10.62);
    expect(e.lon).toBe(-67.62);
    expect(e.time_ms).toBe(Date.UTC(2026, 5, 27, 19, 20)); // 15:20 VET -> 19:20 UTC
  });

  it('drops physically-impossible future-dated events (bad feed timestamp)', () => {
    // A quake can never originate in the future; such a row would otherwise sort
    // as "el último sismo" and freeze the elapsed-time cronómetro at 00:00:00.
    expect(normalizeFunvisisFeature(feature({ postalCode: '01-01-2099', city: '12:00' }))).toBeNull();
  });

  it('synthesizes a STABLE id (same event re-polls to the same key)', () => {
    expect(normalizeFunvisisFeature(feature())!.id)
      .toBe(normalizeFunvisisFeature(feature())!.id);
    expect(normalizeFunvisisFeature(feature())!.id)
      .toBe('funvisis-27062026-1520-10.62--67.62');
  });

  it('falls back to lat/long properties when geometry is missing', () => {
    const f: any = feature();
    delete f.geometry;
    const e = normalizeFunvisisFeature(f)!;
    expect(e.lat).toBe(10.62);
    expect(e.lon).toBe(-67.62);
  });

  it('drops features with no magnitude, coords, or parseable time', () => {
    expect(normalizeFunvisisFeature(feature({ phone: '' }))).toBeNull();
    expect(normalizeFunvisisFeature(feature({ postalCode: '' }))).toBeNull();
    const noGeo: any = feature({ lat: '', long: '' });
    delete noGeo.geometry;
    expect(normalizeFunvisisFeature(noGeo)).toBeNull();
  });
});
