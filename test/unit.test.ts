import { describe, it, expect } from 'vitest';
import {
  allowedOrigins, isAllowedOrigin, validLatLon, blurCoord, isImageBytes, rateLimit, requestIp,
} from '../src/lib/security';
import { hashPassword, verifyPassword } from '../src/lib/auth';
import { estimatePager } from '../src/lib/pager';
import { inBbox, normalizeFeature } from '../src/lib/usgs';

// ---- helpers ----
const envWith = (over: any = {}) => ({ ...over } as any);
const fakeKvEnv = () => {
  const store = new Map<string, string>();
  return {
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    },
  } as any;
};
const fakeCtx = (ip = '203.0.113.7') => ({
  req: { header: (k: string) => (k === 'cf-connecting-ip' ? ip : undefined) },
  json: (obj: any, status = 200) => new Response(JSON.stringify(obj), { status }),
} as any);

// ===================================================================
describe('security: CORS origins', () => {
  it('always allows the canonical hosts', () => {
    const env = envWith();
    expect(isAllowedOrigin(env, 'https://sismo911.com')).toBe(true);
    expect(isAllowedOrigin(env, 'https://app.sismo911.com')).toBe(true);
  });
  it('allows localhost dev origins', () => {
    expect(isAllowedOrigin(envWith(), 'http://localhost:8787')).toBe(true);
    expect(isAllowedOrigin(envWith(), 'http://127.0.0.1:3000')).toBe(true);
  });
  it('rejects unknown origins', () => {
    expect(isAllowedOrigin(envWith(), 'https://evil.example.com')).toBe(false);
  });
  it('honors ALLOWED_ORIGINS extras', () => {
    const env = envWith({ ALLOWED_ORIGINS: 'https://staging.sismo911.com, https://x.test' });
    expect(allowedOrigins(env)).toContain('https://staging.sismo911.com');
    expect(isAllowedOrigin(env, 'https://x.test')).toBe(true);
  });
});

describe('security: validLatLon', () => {
  it('accepts valid Venezuela coords', () => expect(validLatLon(10.4, -68.3)).toBe(true));
  it('rejects out-of-range', () => {
    expect(validLatLon(95, 0)).toBe(false);
    expect(validLatLon(0, 200)).toBe(false);
  });
  it('rejects non-numbers / NaN', () => {
    expect(validLatLon('10', '-68')).toBe(false);
    expect(validLatLon(NaN, 0)).toBe(false);
    expect(validLatLon(null, null)).toBe(false);
  });
});

describe('security: blurCoord (PII coarsening)', () => {
  it('rounds to 2 decimals by default', () => expect(blurCoord(10.409812)).toBe(10.41));
  it('honors custom precision', () => expect(blurCoord(10.409812, 1)).toBe(10.4));
  it('returns null for non-finite', () => {
    expect(blurCoord('abc')).toBe(null);
    expect(blurCoord(undefined)).toBe(null);
  });
});

describe('security: isImageBytes (magic-number check)', () => {
  it('detects JPEG', () => expect(isImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg')).toBe(true));
  it('detects PNG', () => expect(isImageBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]), 'image/png')).toBe(true));
  it('rejects content-type/byte mismatch', () => expect(isImageBytes(new Uint8Array([0xff, 0xd8, 0xff]), 'image/png')).toBe(false));
  it('rejects non-image bytes', () => expect(isImageBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'image/jpeg')).toBe(false));
});

describe('security: requestIp + rateLimit', () => {
  it('extracts cf-connecting-ip', () => expect(requestIp(fakeCtx('9.9.9.9'))).toBe('9.9.9.9'));
  it('allows under the limit then blocks with 429', async () => {
    const env = fakeKvEnv(); const c = fakeCtx();
    expect(await rateLimit(env, c, 'login', 3, 60)).toBe(null);
    expect(await rateLimit(env, c, 'login', 3, 60)).toBe(null);
    expect(await rateLimit(env, c, 'login', 3, 60)).toBe(null);
    const blocked = await rateLimit(env, c, 'login', 3, 60);
    expect(blocked).not.toBe(null);
    expect((blocked as Response).status).toBe(429);
  });
  it('keys per-IP independently', async () => {
    const env = fakeKvEnv();
    await rateLimit(env, fakeCtx('1.1.1.1'), 'sos', 1, 60);
    expect(await rateLimit(env, fakeCtx('2.2.2.2'), 'sos', 1, 60)).toBe(null); // different IP, fresh
  });
});

// ===================================================================
describe('auth: PBKDF2 password hashing', () => {
  it('round-trips a correct password', async () => {
    const { hash, salt } = await hashPassword('proteccion-civil-2026');
    expect(hash).toBeTruthy();
    expect(salt).toBeTruthy();
    expect(await verifyPassword('proteccion-civil-2026', hash, salt)).toBe(true);
  });
  it('rejects the wrong password', async () => {
    const { hash, salt } = await hashPassword('correct horse');
    expect(await verifyPassword('battery staple', hash, salt)).toBe(false);
  });
  it('produces a unique salt per call', async () => {
    const a = await hashPassword('same'); const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

// ===================================================================
describe('pager: provisional impact estimate', () => {
  const ev = (over: any) => ({ id: 'x', source: 'usgs', mag: 5, place: 'VE', time_ms: 0, updated_ms: 0, lat: 10, lon: -68, depth_km: 10, mmi: null, alert: null, tsunami: 0, felt: null, url: null, ...over });
  it('flags a great quake red', () => expect(estimatePager(ev({ mag: 7.5 })).alert).toBe('red'));
  it('flags a small quake green', () => expect(estimatePager(ev({ mag: 2.0 })).alert).toBe('green'));
  it('passes through an official USGS alert + marks it non-provisional', () => {
    const p = estimatePager(ev({ mag: 5.5, alert: 'orange' }));
    expect(p.alert).toBe('orange');
    expect(p.official).toBe(true);
    expect(p.provisional).toBe(false);
  });
});

// ===================================================================
describe('usgs: bbox filter + feature normalization', () => {
  const env = envWith({ USGS_MINLAT: '-2', USGS_MAXLAT: '16', USGS_MINLON: '-76', USGS_MAXLON: '-58' });
  it('keeps Venezuela-region features', () => expect(inBbox(env, { geometry: { coordinates: [-68.3, 10.4] } })).toBe(true));
  it('drops out-of-region features', () => expect(inBbox(env, { geometry: { coordinates: [139.7, 35.6] } })).toBe(false));
  it('normalizes a GeoJSON feature', () => {
    const f = { id: 'us123', geometry: { coordinates: [-68.3, 10.4, 12.5] }, properties: { mag: 7.5, place: '23 km SE of Yumare', time: 1000, updated: 2000, alert: 'red', tsunami: 1, felt: 9, url: 'http://u' } };
    const e = normalizeFeature(f);
    expect(e).toMatchObject({ id: 'us123', mag: 7.5, lat: 10.4, lon: -68.3, depth_km: 12.5, alert: 'red', tsunami: 1 });
  });
});
