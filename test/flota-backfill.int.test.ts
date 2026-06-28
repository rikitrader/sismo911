import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { flotaAdmin } from '../src/routes/flota-admin';
import { issueUnitToken } from '../src/lib/flota-token';
import { ingestGps, backfillBatch } from '../src/lib/flota-ingest';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Offline GPS buffering — backfill mode + the token-authed flush endpoint.

let db: D1Mock;
let env: TestEnv;
const admin = mount([['/api/admin/flota', flotaAdmin]]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function unit(status = 'active') {
  return (await call(admin, 'POST', '/api/admin/flota/units', env, { name: 'U', type: 'ambulancia', status })).json.id as string;
}
const fix = (over: any = {}) => ({ lat: 10.5, lng: -66.9, accuracy: 12, heading: 90, speed: 8, battery: 80, recordedAt: new Date().toISOString(), ...over });

describe('backfill ingest mode', () => {
  it('accepts a 30-min-old fix that LIVE mode rejects as stale, and tags source=buffered', async () => {
    const id = await unit();
    const now = Date.now();
    const old = fix({ recordedAt: new Date(now - 30 * 60_000).toISOString() });
    // live rejects
    expect(await ingestGps(env as any, { unitId: id }, old, now, 'live')).toEqual({ ok: false, error: 'timestamp_stale' });
    // backfill accepts
    const r = await ingestGps(env as any, { unitId: id }, old, now, 'backfill');
    expect(r.ok).toBe(true);
    const row = db.raw.prepare('SELECT source FROM flota_locations WHERE unit_id=?').get(id) as any;
    expect(row.source).toBe('buffered');
  });

  it('skips the impossible-jump guard in backfill (a contiguous buffer is trusted)', async () => {
    const id = await unit();
    const now = Date.now();
    await ingestGps(env as any, { unitId: id }, fix({ lat: 10.5, lng: -66.9, recordedAt: new Date(now - 3000).toISOString() }), now - 3000, 'live');
    const teleport = fix({ lat: 19.4, lng: -99.1, recordedAt: new Date(now).toISOString() });
    expect(await ingestGps(env as any, { unitId: id }, teleport, now, 'live')).toEqual({ ok: false, error: 'impossible_jump' });
    expect((await ingestGps(env as any, { unitId: id }, teleport, now, 'backfill')).ok).toBe(true);
  });

  it('still rejects future timestamps, bad coords, and inactive units in backfill', async () => {
    const id = await unit();
    const now = Date.now();
    expect((await ingestGps(env as any, { unitId: id }, fix({ recordedAt: new Date(now + 5 * 60_000).toISOString() }), now, 'backfill')) as any).toEqual({ ok: false, error: 'timestamp_future' });
    expect((await ingestGps(env as any, { unitId: id }, fix({ lat: 999 }), now, 'backfill')) as any).toEqual({ ok: false, error: 'coords_out_of_range' });
    const off = await unit('suspended');
    expect((await ingestGps(env as any, { unitId: off }, fix(), now, 'backfill')) as any).toEqual({ ok: false, error: 'unit_inactive' });
  });
});

describe('backfillBatch', () => {
  it('accepts the good fixes and reports per-index rejects', async () => {
    const id = await unit();
    const now = Date.now();
    const res = await backfillBatch(env as any, id, [
      fix({ recordedAt: new Date(now - 10 * 60_000).toISOString() }), // ok (stale-but-within-window)
      fix({ lat: 999 }),                                              // bad coords
      fix({ recordedAt: new Date(now - 20 * 60_000).toISOString() }), // ok
    ], now);
    expect(res.accepted).toBe(2);
    expect(res.rejected).toEqual([{ i: 1, error: 'coords_out_of_range' }]);
    const n = db.raw.prepare("SELECT COUNT(*) n FROM flota_locations WHERE unit_id=? AND source='buffered'").get(id) as any;
    expect(n.n).toBe(2);
  });
});

describe('POST /flota/track/backfill (token-authed flush endpoint)', () => {
  async function tokenFor(id: string) {
    return (await issueUnitToken(env as any, id, { expiresInHours: 12 })).token;
  }
  function post(token: string | null, body: unknown) {
    const headers: any = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    return worker.fetch(new Request('https://sismo911.test/flota/track/backfill', { method: 'POST', headers, body: JSON.stringify(body) }), env as any, {} as any);
  }

  it('401 without a valid token', async () => {
    const res = await post(null, { fixes: [fix()] });
    expect(res.status).toBe(401);
  });

  it('403 for an inactive unit', async () => {
    const id = await unit('suspended');
    const res = await post(await tokenFor(id), { fixes: [fix()] });
    expect(res.status).toBe(403);
  });

  it('200 + inserts buffered rows for a valid token', async () => {
    const id = await unit();
    const now = Date.now();
    const res = await post(await tokenFor(id), { fixes: [
      fix({ recordedAt: new Date(now - 8 * 60_000).toISOString() }),
      fix({ recordedAt: new Date(now - 6 * 60_000).toISOString() }),
    ] });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.accepted).toBe(2);
    const n = db.raw.prepare("SELECT COUNT(*) n FROM flota_locations WHERE unit_id=? AND source='buffered'").get(id) as any;
    expect(n.n).toBe(2);
  });

  it('400 when fixes[] is missing', async () => {
    const id = await unit();
    const res = await post(await tokenFor(id), { nope: true });
    expect(res.status).toBe(400);
  });
});
