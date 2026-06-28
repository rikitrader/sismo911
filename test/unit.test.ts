import { describe, it, expect } from 'vitest';
import {
  allowedOrigins, isAllowedOrigin, validLatLon, blurCoord, isImageBytes, rateLimit, requestIp,
  nameHasSpam, textHasLink, nameHasMarkup,
} from '../src/lib/security';
import { hashPassword, verifyPassword } from '../src/lib/auth';
import { estimatePager } from '../src/lib/pager';
import { inBbox, normalizeFeature } from '../src/lib/usgs';
import { scoreThreat } from '../src/lib/threat';
import { bootstrapHistory } from '../src/ingest/usgs-history';
import { edgeCached } from '../src/lib/edge-cache';

// ---- helpers ----
const envWith = (over: any = {}) => ({ ...over } as any);
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
  it('allows the SUMINISTROS division subdomain (its SPA issues same-origin operator writes)', () => {
    // Regression: without this, every write from suministros.sismo911.com is
    // rejected with bad_origin even for a logged-in operator.
    expect(isAllowedOrigin(envWith(), 'https://suministros.sismo911.com')).toBe(true);
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

// rateLimit now delegates to the D1-atomic burstLimit (no KV writes — those
// exhausted the free-tier KV write cap). Fake the rate_buckets INSERT…ON
// CONFLICT…RETURNING so the counter semantics are exercised.
const fakeRlEnv = () => {
  const buckets = new Map<string, { count: number; reset_ms: number }>();
  return {
    DB: {
      prepare: (_sql: string) => ({
        bind: (key: string, reset: number, now: number) => ({
          first: async () => {
            const row = buckets.get(key);
            if (!row || row.reset_ms < now) buckets.set(key, { count: 1, reset_ms: reset });
            else row.count += 1;
            return buckets.get(key);
          },
        }),
      }),
    },
  } as any;
};

describe('security: requestIp + rateLimit (D1-backed)', () => {
  it('extracts cf-connecting-ip', () => expect(requestIp(fakeCtx('9.9.9.9'))).toBe('9.9.9.9'));
  it('allows under the limit then blocks with 429', async () => {
    const env = fakeRlEnv(); const c = fakeCtx();
    expect(await rateLimit(env, c, 'login', 3, 60)).toBe(null);
    expect(await rateLimit(env, c, 'login', 3, 60)).toBe(null);
    expect(await rateLimit(env, c, 'login', 3, 60)).toBe(null);
    const blocked = await rateLimit(env, c, 'login', 3, 60);
    expect(blocked).not.toBe(null);
    expect((blocked as Response).status).toBe(429);
  });
  it('keys per-IP independently', async () => {
    const env = fakeRlEnv();
    await rateLimit(env, fakeCtx('1.1.1.1'), 'sos', 1, 60);
    expect(await rateLimit(env, fakeCtx('2.2.2.2'), 'sos', 1, 60)).toBe(null); // different IP, fresh
  });
  it('fails OPEN on a DB error (never blocks a life-safety write on infra failure)', async () => {
    const env: any = { DB: { prepare: () => { throw new Error('D1 down'); } } };
    expect(await rateLimit(env, fakeCtx(), 'sos', 1, 60)).toBe(null);
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

describe('scoreThreat', () => {
  const now = 1_000_000_000_000;
  const H = 3_600_000;
  it('returns Alerta Máxima for a recent M7.5 red alert', () => {
    const t = scoreThreat([{ id: 'a', mag: 7.5, time_ms: now - 22 * H, alert: 'red', place: '28 km SE of Yumare, Venezuela' }], now);
    expect(t.level).toBe(4);
    expect(t.label).toBe('Alerta Máxima');
    expect(t.dot).toBe('bg-critical');
  });
  it('returns Vigilancia Normal when quakes are small', () => {
    const t = scoreThreat([{ id: 'b', mag: 3.1, time_ms: now - 2 * H, alert: null, place: 'x' }], now);
    expect(t.level).toBe(1);
    expect(t.label).toBe('Vigilancia Normal');
  });
  it('returns Atención for a moderate M4.6', () => {
    const t = scoreThreat([{ id: 'c', mag: 4.6, time_ms: now - 3 * H, alert: null, place: 'x' }], now);
    expect(t.level).toBe(2);
  });
  it('decays to Normal when the big quake is older than 48h', () => {
    const t = scoreThreat([{ id: 'd', mag: 7.5, time_ms: now - 60 * H, alert: 'red', place: 'x' }], now);
    expect(t.level).toBe(1);
  });
});

describe('security: link-spam gate for public submissions', () => {
  it('flags names containing a bare domain or URL', () => {
    expect(nameHasSpam('TRUSTEDF57 - infinityhotel.it')).toBe(true);
    expect(nameHasSpam('visit www.spam.example')).toBe(true);
    expect(nameHasSpam('http://x.io promo')).toBe(true);
  });
  it('accepts real human names', () => {
    expect(nameHasSpam('María José Pérez')).toBe(false);
    expect(nameHasSpam('Juan Carlos Rodríguez Méndez')).toBe(false);
    expect(nameHasSpam('')).toBe(false);
    expect(nameHasSpam(null)).toBe(false);
  });
  it('blocks links in free text but allows legitimate emails', () => {
    expect(textHasLink('contáctame en infinityhotel.it')).toBe(true);
    expect(textHasLink('mira https://bit.ly/x')).toBe(true);
    expect(textHasLink('escribe a maria.lopez@gmail.com')).toBe(false);
    expect(textHasLink('última vez visto cerca del Hotel Plaza, Catia')).toBe(false);
    expect(textHasLink(null)).toBe(false);
  });
});

describe('security: HTML/script-injection (stored-XSS) name gate', () => {
  it('flags the stored-XSS case-name payload', () => {
    expect(nameHasMarkup('"><svg/onload=("@jofpin");>')).toBe(true);
    expect(nameHasSpam('"><svg/onload=("@jofpin");>')).toBe(true);
  });
  it('flags assorted injection vectors', () => {
    expect(nameHasMarkup('<img src=x onerror=alert(1)>')).toBe(true);
    expect(nameHasMarkup('<script>alert(1)</script>')).toBe(true);
    expect(nameHasMarkup('javascript:alert(document.cookie)')).toBe(true);
    expect(nameHasMarkup('María<svg onload=1>')).toBe(true);
    expect(nameHasMarkup('</a><body onload=evil()>')).toBe(true);
  });
  it('does NOT flag legitimate names or measurement titles', () => {
    expect(nameHasMarkup('María José Pérez')).toBe(false);
    expect(nameHasMarkup('Juan Carlos Rodríguez Méndez')).toBe(false);
    expect(nameHasMarkup('Grieta de <5cm en la pared')).toBe(false);
    expect(nameHasMarkup('Muro inclinado >2m sobre la acera')).toBe(false);
    expect(nameHasMarkup('')).toBe(false);
    expect(nameHasMarkup(null)).toBe(false);
  });
});

describe('history bootstrap: one-time, count-gated (KV-free)', () => {
  const bbox = { USGS_MINLAT: '-2', USGS_MAXLAT: '16', USGS_MINLON: '-76', USGS_MAXLON: '-58' };
  // Gate depends ONLY on the D1 events count (KV writes were unreliable on this
  // deployment). DB.first() returns the count; DB.batch/bind power the upsert +
  // ingest_log writes.
  const fakeDb = (count: number) => ({
    prepare: () => ({ first: async () => ({ n: count }), bind: () => ({ run: async () => ({}) }) }),
    batch: async (s: any[]) => s.map(() => ({})),
  });

  it('skips the backfill (no network) when D1 already has the archive', async () => {
    const env: any = { ...bbox, DB: fakeDb(9968) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('must not fetch when already populated'); }) as any;
    try {
      const r = await bootstrapHistory(env);
      expect(r.skipped).toBe('already-populated');
      expect(r.count).toBe(9968);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('runs the backfill on a fresh/empty D1', async () => {
    const env: any = { ...bbox, DB: fakeDb(0) };
    const realFetch = globalThis.fetch;
    // No network in unit tests: empty FeatureCollection → backfill writes 0, no
    // failed spans.
    globalThis.fetch = (async () => new Response(JSON.stringify({ features: [] }), { status: 200 })) as any;
    try {
      const r = await bootstrapHistory(env);
      expect(r.bootstrapped).toBe(true);
      expect(r.priorCount).toBe(0);
      expect((r as any).failedYears).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('does not depend on KV at all (works with no CACHE binding present)', async () => {
    const env: any = { ...bbox, DB: fakeDb(9968) }; // note: no CACHE
    const r = await bootstrapHistory(env);
    expect(r.skipped).toBe('already-populated');
  });
});

describe('edgeCached: per-colo read-through cache', () => {
  const fakeCtx = (url = 'https://x.test/api/events?limit=5') => ({
    req: { url },
    json: (obj: any) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } }),
    executionCtx: { waitUntil: (_p: Promise<any>) => {} },
  } as any);

  it('builds and returns payload when no Cache API is present (graceful)', async () => {
    const saved = (globalThis as any).caches; delete (globalThis as any).caches;
    try {
      let builds = 0;
      const res = await edgeCached(fakeCtx(), 30, async () => { builds++; return { ok: true, n: 7 }; });
      expect((await res.json()).n).toBe(7);
      expect(builds).toBe(1);
    } finally { (globalThis as any).caches = saved; }
  });

  it('serves from cache on the second call (miss → hit), build runs once', async () => {
    const store = new Map<string, Response>();
    const saved = (globalThis as any).caches;
    (globalThis as any).caches = {
      default: {
        match: async (req: Request) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
        put: async (req: Request, res: Response) => { store.set(req.url, res.clone()); },
      },
    };
    try {
      let builds = 0;
      const build = async () => { builds++; return { v: 'data' }; };
      const r1 = await edgeCached(fakeCtx(), 30, build);
      expect(r1.headers.get('X-Edge-Cache')).toBe('miss');
      const r2 = await edgeCached(fakeCtx(), 30, build);
      expect(r2.headers.get('X-Edge-Cache')).toBe('hit');
      expect(builds).toBe(1); // second call served from cache
      expect((await r2.json()).v).toBe('data');
    } finally { (globalThis as any).caches = saved; }
  });
});
