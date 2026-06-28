import { describe, it, expect, beforeEach } from 'vitest';
import { flotaUnidades } from '../src/routes/flota-unidades';
import { flotaRastreo } from '../src/routes/flota-rastreo';
import { issueUnitToken, verifyUnitToken } from '../src/lib/flota-token';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

const MIGRATIONS = ['migrations/0037_flota.sql', 'migrations/0038_flota_unit_tokens.sql'];

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/flota/unidades', flotaUnidades],
  ['/api/flota/rastreo', flotaRastreo],
]);

beforeEach(() => {
  db = makeDb(MIGRATIONS);
  env = makeEnv(db);
});

async function makeUnit() {
  const r = await call(app, 'POST', '/api/flota/unidades', env, { nombre: 'U1', tipo: 'ambulancia' });
  return r.json.id as string;
}

describe('FLOTA unit tokens — lib', () => {
  it('issues a token and verifies it back to its unit', async () => {
    const unit = await makeUnit();
    const issued = await issueUnitToken(env as any, unit, 'device-1');
    expect(issued.token).toMatch(/^fbu_[0-9a-f]{8}_[0-9a-f]{32}$/);
    const who = await verifyUnitToken(env as any, issued.token);
    expect(who).toBe(unit);
  });

  it('rejects a bogus / tampered / revoked token', async () => {
    const unit = await makeUnit();
    const issued = await issueUnitToken(env as any, unit, null);
    expect(await verifyUnitToken(env as any, 'fbu_deadbeef_00000000000000000000000000000000')).toBeNull();
    expect(await verifyUnitToken(env as any, issued.token.slice(0, -1) + '0')).toBeNull();
    // revoke via the route, then it must fail
    const list = await call(app, 'GET', `/api/flota/unidades/${unit}/tokens`, env);
    const tokId = list.json.results[0].id;
    await call(app, 'DELETE', `/api/flota/unidades/${unit}/token/${tokId}`, env);
    expect(await verifyUnitToken(env as any, issued.token)).toBeNull();
  });
});

describe('FLOTA unit-token GPS ingest — issue route + position derivation', () => {
  it('a token-authenticated posicion records the position for the token\'s unit', async () => {
    const unit = await makeUnit();
    const issued = await issueUnitToken(env as any, unit, null);
    // No body unidad_id — the token must supply it. Mount-level call sets the
    // token via header; the route derives unidad from it.
    const res = await app.request(
      '/api/flota/rastreo/posicion',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
        body: JSON.stringify({ lat: 10.5, lon: -66.9, rumbo: 90 }),
      },
      env as any,
    );
    expect(res.status).toBe(200);
    const u = db.raw.prepare('SELECT lat, lon FROM flota_unidades WHERE id = ?').get(unit) as { lat: number; lon: number };
    expect(u.lat).toBe(10.5);
    expect(u.lon).toBe(-66.9);
    const n = db.raw.prepare('SELECT COUNT(*) n FROM flota_posiciones WHERE unidad_id = ?').get(unit) as { n: number };
    expect(n.n).toBe(1);
  });
});
