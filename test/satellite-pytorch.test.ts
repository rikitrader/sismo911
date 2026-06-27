import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { satellite } from '../src/routes/satellite';

function makeEnv() {
  const writes: any[] = [];
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...next: any[]) => stmt(sql, next),
    run: async () => {
      writes.push({ sql, args });
      return { meta: { changes: 1 } };
    },
    all: async () => ({ results: [] }),
    first: async () => null,
  });
  return { DB: { prepare: (sql: string) => stmt(sql) }, SATELLITE_INGEST_TOKEN: 'sat-secret', _writes: writes } as any;
}

describe('satellite PyTorch result ingest', () => {
  it('rejects missing bearer token', async () => {
    const res = await satellite.request('/pytorch-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 10.6, lon: -68.7, severity: 'grave' }),
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('stores external PyTorch damage detections as unverified sat_damage records', async () => {
    const env = makeEnv();
    const res = await satellite.request('/pytorch-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sat-secret' },
      body: JSON.stringify({
        lat: 10.6,
        lon: -68.7,
        zoom: 18,
        severity: 'grave',
        summary: 'Daño probable en techos e infraestructura.',
        hazards: ['escombros', 'vía bloqueada'],
        model: 'pytorch:test-model.pt',
      }),
    }, env);
    expect(res.status).toBe(201);
    const j = await res.json() as any;
    expect(j).toMatchObject({ ok: true, severity: 'grave', verification: 'unverified' });
    expect(env._writes[0].sql).toContain('INSERT OR REPLACE INTO sat_damage');
    expect(env._writes[0].args).toContain('pytorch:test-model.pt');
  });

  it('passes through the Worker auth gate with the dedicated ingest token only', async () => {
    const env = makeEnv();
    const body = JSON.stringify({
      lat: 10.6,
      lon: -68.7,
      zoom: 18,
      severity: 'grave',
      summary: 'Daño probable en infraestructura crítica.',
      model: 'pytorch:boundary-test.pt',
    });
    const ok = await worker.fetch(new Request('https://sismo911.test/api/sat/pytorch-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sat-secret' },
      body,
    }), env);
    expect(ok.status).toBe(201);
    expect(env._writes[0].sql).toContain('INSERT OR REPLACE INTO sat_damage');

    const blocked = await worker.fetch(new Request('https://sismo911.test/api/sat/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sat-secret' },
      body,
    }), makeEnv());
    expect(blocked.status).toBe(401);
  });
});
