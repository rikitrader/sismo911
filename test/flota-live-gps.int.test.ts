import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../src/index';
import { flotaAdmin } from '../src/routes/flota-admin';
import { issueUnitToken, verifyUnitToken, revokeUnitToken } from '../src/lib/flota-token';
import { ingestGps, withinRate } from '../src/lib/flota-ingest';
import { validateGps, isImpossibleJump } from '../src/lib/flota-gps';
import { FleetLive } from '../src/realtime/fleet-live';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Live-GPS system — real handlers + real SQL (better-sqlite3 D1 adapter).

let db: D1Mock;
let env: TestEnv;
const admin = mount([['/api/admin/flota', flotaAdmin]]);

beforeEach(() => {
  db = makeDb(); // 0037 + 0045
  env = makeEnv(db);
});

async function createUnit(name = 'Ambulancia 01', status = 'active') {
  const r = await call(admin, 'POST', '/api/admin/flota/units', env, { name, type: 'ambulancia', status });
  return r.json.id as string;
}

// ── Units + tokens (operator surface) ───────────────────────────────────────

describe('operator: units + tokens', () => {
  it('operator can create a unit', async () => {
    const r = await call(admin, 'POST', '/api/admin/flota/units', env, { name: 'Rescate 7', type: 'rescate' });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^unit_/);
    const row = db.raw.prepare('SELECT * FROM flota_units WHERE id=?').get(r.json.id) as any;
    expect(row.name).toBe('Rescate 7');
    expect(row.status).toBe('active');
    // audit row
    const a = db.raw.prepare("SELECT * FROM flota_audit_log WHERE action='unit.create' AND unit_id=?").get(r.json.id) as any;
    expect(a).toBeTruthy();
  });

  it('rejects a unit with no name', async () => {
    const r = await call(admin, 'POST', '/api/admin/flota/units', env, { type: 'rescate' });
    expect(r.status).toBe(400);
  });

  it('operator can issue a token (shown once, only hash stored) + audit', async () => {
    const id = await createUnit();
    const r = await call(admin, 'POST', `/api/admin/flota/units/${id}/token`, env, { label: 'tel-1', expiresInHours: 12 });
    expect(r.status).toBe(201);
    expect(r.json.token).toMatch(/^fbu_[0-9a-f]{48}$/);
    expect(r.json.trackUrl).toBe(`/flota/track/${r.json.token}`);
    const row = db.raw.prepare('SELECT * FROM flota_unit_tokens WHERE id=?').get(r.json.tokenId) as any;
    expect(row.token_hash).toBeTruthy();
    expect(row.token_hash).not.toContain('fbu_'); // never the raw token
    expect(row.expires_at).toBeGreaterThan(Date.now());
    // audit must NOT contain the raw token
    const a = db.raw.prepare("SELECT meta_json FROM flota_audit_log WHERE action='token.issue'").get() as any;
    expect(a.meta_json).not.toContain(r.json.token);
  });

  it('issuing a token for an unknown unit → 404', async () => {
    const r = await call(admin, 'POST', '/api/admin/flota/units/unit_missing/token', env, {});
    expect(r.status).toBe(404);
  });

  it('operator can revoke a token', async () => {
    const id = await createUnit();
    const t = await call(admin, 'POST', `/api/admin/flota/units/${id}/token`, env, {});
    const rev = await call(admin, 'POST', `/api/admin/flota/units/${id}/revoke-token`, env, { tokenId: t.json.tokenId });
    expect(rev.status).toBe(200);
    expect(rev.json.revoked).toBe(true);
    const a = db.raw.prepare("SELECT * FROM flota_audit_log WHERE action='token.revoke'").get() as any;
    expect(a).toBeTruthy();
  });
});

// ── Token verification ──────────────────────────────────────────────────────

describe('token verification', () => {
  it('a fresh token verifies back to its unit', async () => {
    const id = await createUnit();
    const issued = await issueUnitToken(env as any, id, { label: null, expiresInHours: 12 });
    const v = await verifyUnitToken(env as any, issued.token);
    expect(v?.unitId).toBe(id);
  });

  it('invalid / malformed token rejected', async () => {
    await createUnit();
    expect(await verifyUnitToken(env as any, 'fbu_' + '0'.repeat(48))).toBeNull();
    expect(await verifyUnitToken(env as any, 'not-a-token')).toBeNull();
    expect(await verifyUnitToken(env as any, '')).toBeNull();
  });

  it('revoked token rejected', async () => {
    const id = await createUnit();
    const issued = await issueUnitToken(env as any, id, {});
    await revokeUnitToken(env as any, issued.id);
    expect(await verifyUnitToken(env as any, issued.token)).toBeNull();
  });

  it('expired token rejected', async () => {
    const id = await createUnit();
    const issued = await issueUnitToken(env as any, id, { expiresInHours: 1 });
    db.raw.prepare('UPDATE flota_unit_tokens SET expires_at=? WHERE id=?').run(Date.now() - 1000, issued.id);
    expect(await verifyUnitToken(env as any, issued.token)).toBeNull();
  });
});

// ── GPS ingest pipeline (real SQL) ──────────────────────────────────────────

describe('GPS ingest', () => {
  const goodFix = (over: any = {}) => ({ lat: 10.5, lng: -66.9, accuracy: 12, heading: 90, speed: 8, battery: 80, recordedAt: new Date().toISOString(), ...over });

  it('valid GPS inserts a location row + audit', async () => {
    const id = await createUnit();
    const r = await ingestGps(env as any, { unitId: id }, goodFix(), Date.now());
    expect(r.ok).toBe(true);
    const n = db.raw.prepare('SELECT COUNT(*) n FROM flota_locations WHERE unit_id=?').get(id) as any;
    expect(n.n).toBe(1);
    const a = db.raw.prepare("SELECT COUNT(*) n FROM flota_audit_log WHERE action='gps.ingest' AND unit_id=?").get(id) as any;
    expect(a.n).toBe(1);
  });

  it('bad lat/lng rejected (no row, audit gps.reject)', async () => {
    const id = await createUnit();
    const r = await ingestGps(env as any, { unitId: id }, goodFix({ lat: 999 }), Date.now());
    expect(r).toEqual({ ok: false, error: 'coords_out_of_range' });
    const n = db.raw.prepare('SELECT COUNT(*) n FROM flota_locations WHERE unit_id=?').get(id) as any;
    expect(n.n).toBe(0);
    const a = db.raw.prepare("SELECT COUNT(*) n FROM flota_audit_log WHERE action='gps.reject'").get() as any;
    expect(a.n).toBe(1);
  });

  it('stale timestamp rejected', async () => {
    const id = await createUnit();
    const now = Date.now();
    const r = await ingestGps(env as any, { unitId: id }, goodFix({ recordedAt: new Date(now - 10 * 60_000).toISOString() }), now);
    expect(r).toEqual({ ok: false, error: 'timestamp_stale' });
  });

  it('future timestamp rejected', async () => {
    const id = await createUnit();
    const now = Date.now();
    const r = await ingestGps(env as any, { unitId: id }, goodFix({ recordedAt: new Date(now + 5 * 60_000).toISOString() }), now);
    expect(r).toEqual({ ok: false, error: 'timestamp_future' });
  });

  it('impossible speed jump rejected', async () => {
    const id = await createUnit();
    const now = Date.now();
    // First fix in Caracas.
    await ingestGps(env as any, { unitId: id }, goodFix({ lat: 10.5, lng: -66.9, recordedAt: new Date(now - 2000).toISOString() }), now - 2000);
    // 2s later, ~1000 km away → impossible.
    const r = await ingestGps(env as any, { unitId: id }, goodFix({ lat: 19.4, lng: -99.1, recordedAt: new Date(now).toISOString() }), now);
    expect(r).toEqual({ ok: false, error: 'impossible_jump' });
  });

  it('ingest for an inactive unit rejected', async () => {
    const id = await createUnit('Suspendida', 'suspended');
    const r = await ingestGps(env as any, { unitId: id }, goodFix(), Date.now());
    expect(r).toEqual({ ok: false, error: 'unit_inactive' });
  });
});

// ── Pure validators ─────────────────────────────────────────────────────────

describe('pure validators', () => {
  it('validateGps rejects malformed/missing/out-of-range/accuracy', () => {
    const now = Date.now();
    expect(validateGps(null as any, now).ok).toBe(false);
    expect((validateGps({ lng: 1, recordedAt: now } as any, now) as any).error).toBe('missing_coords');
    expect((validateGps({ lat: 91, lng: 1, recordedAt: now }, now) as any).error).toBe('coords_out_of_range');
    expect((validateGps({ lat: 1, lng: 1, accuracy: 99999, recordedAt: now }, now) as any).error).toBe('accuracy_insane');
  });
  it('isImpossibleJump: null prev never impossible; sane move ok; teleport impossible', () => {
    expect(isImpossibleJump(null, { lat: 1, lng: 1, recorded_at: 1000 })).toBe(false);
    expect(isImpossibleJump({ lat: 10.5, lng: -66.9, recorded_at: 0 }, { lat: 10.5009, lng: -66.9, recorded_at: 10_000 })).toBe(false);
    expect(isImpossibleJump({ lat: 10.5, lng: -66.9, recorded_at: 0 }, { lat: 19.4, lng: -99.1, recorded_at: 2000 })).toBe(true);
  });
  it('withinRate slides the window', () => {
    const now = 1_000_000;
    let kept: number[] = [];
    for (let i = 0; i < 60; i++) { const r = withinRate(kept, now, 60, 60_000); kept = r.kept; expect(r.allowed).toBe(true); }
    expect(withinRate(kept, now, 60, 60_000).allowed).toBe(false);       // 61st blocked
    expect(withinRate(kept, now + 61_000, 60, 60_000).allowed).toBe(true); // window passed
  });
});

// ── Auth gate ───────────────────────────────────────────────────────────────

describe('admin surface requires an operator session', () => {
  it('GET /api/admin/flota/live without a session → 401', async () => {
    const res = await worker.fetch(new Request('https://sismo911.test/api/admin/flota/live'), env as any, {} as any);
    expect(res.status).toBe(401);
  });
  it('POST /api/admin/flota/units without a session → 401', async () => {
    const res = await worker.fetch(
      new Request('https://sismo911.test/api/admin/flota/units', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      env as any, {} as any,
    );
    expect(res.status).toBe(401);
  });
});

// ── Live broadcast (FleetLive DO logic, real ingest + SQL, fake sockets) ─────

class FakeWS {
  attachment: any = null;
  sent: string[] = [];
  serializeAttachment(a: any) { this.attachment = a; }
  deserializeAttachment() { return this.attachment; }
  send(d: string) { this.sent.push(d); }
  close() {}
}
class FakeState {
  sockets: { ws: FakeWS; tags: string[] }[] = [];
  acceptWebSocket(ws: FakeWS, tags: string[]) { this.sockets.push({ ws, tags }); }
  getWebSockets(tag?: string) { return this.sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws); }
}

describe('FleetLive broadcast', () => {
  it("a unit's valid GPS message is stored AND broadcast to admin subscribers", async () => {
    const id = await createUnit();
    const state = new FakeState();
    const admin = new FakeWS();
    state.sockets.push({ ws: admin, tags: ['admin'] }); // an admin is subscribed
    const unit = new FakeWS();
    unit.attachment = { role: 'unit', unitId: id };

    const do_ = new FleetLive(state as any, env as any);
    await do_.webSocketMessage(unit as any, JSON.stringify({ type: 'gps', lat: 10.5, lng: -66.9, accuracy: 10, recordedAt: new Date().toISOString() }));

    // unit got an ack
    expect(unit.sent.some((m) => m.includes('"type":"ack"'))).toBe(true);
    // admin got the live location
    const bc = admin.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'unit_location');
    expect(bc).toBeTruthy();
    expect(bc.unitId).toBe(id);
    expect(bc.lat).toBe(10.5);
    // and it persisted
    const n = db.raw.prepare('SELECT COUNT(*) n FROM flota_locations WHERE unit_id=?').get(id) as any;
    expect(n.n).toBe(1);
  });

  it('a malformed unit message is rejected, not stored', async () => {
    const id = await createUnit();
    const state = new FakeState();
    const unit = new FakeWS();
    unit.attachment = { role: 'unit', unitId: id };
    const do_ = new FleetLive(state as any, env as any);
    await do_.webSocketMessage(unit as any, '{not json');
    expect(unit.sent.some((m) => m.includes('error'))).toBe(true);
    const n = db.raw.prepare('SELECT COUNT(*) n FROM flota_locations WHERE unit_id=?').get(id) as any;
    expect(n.n).toBe(0);
  });
});

// ── No fake data in production ──────────────────────────────────────────────

describe('no production seed/fake units', () => {
  it('the migration creates schema only — no INSERT of units/locations', () => {
    const sql = readFileSync('migrations/0045_fleet_live_gps.sql', 'utf8');
    expect(/INSERT\s+INTO/i.test(sql)).toBe(false);
  });
  it('a freshly migrated DB has zero units and zero locations', () => {
    const u = db.raw.prepare('SELECT COUNT(*) n FROM flota_units').get() as any;
    const l = db.raw.prepare('SELECT COUNT(*) n FROM flota_locations').get() as any;
    expect(u.n).toBe(0);
    expect(l.n).toBe(0);
  });
});
