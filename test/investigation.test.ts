import { describe, it, expect } from 'vitest';
import { investigation } from '../src/routes/investigation';
import { identitySources, verifyCedula, normalizeCedula, namesRoughlyMatch } from '../src/lib/identity';
import { evaluateGate } from '../src/rbac/route-policy';

// Minimal D1/KV stub: records run() binds, answers caseExists, returns no rows.
function makeEnv(extra: any = {}) {
  const runs: { sql: string; binds: any[] }[] = [];
  const stmt = (sql: string, binds: any[] = []): any => ({
    bind: (...n: any[]) => stmt(sql, n),
    first: async () => (/FROM persons WHERE id = \?/.test(sql) ? { id: 'abc', full_name: 'JUAN PEREZ' } : null),
    all: async () => ({ results: [] }),
    run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
  });
  const env: any = {
    DB: { prepare: (s: string) => stmt(s) },
    CACHE: { get: async () => null, put: async () => {} },
    ...extra,
  };
  return { env, runs };
}

describe('identity lib — honest source status', () => {
  it('CNE is unavailable without a resolver, available with one', () => {
    expect(identitySources({} as any).find((s) => s.key === 'cne')!.available).toBe(false);
    expect(identitySources({ CNE_RESOLVER_URL: 'https://r' } as any).find((s) => s.key === 'cne')!.available).toBe(true);
  });
  it('RIF/SAIME/IVSS are always unavailable (no reachable source)', () => {
    const s = identitySources({ CNE_RESOLVER_URL: 'https://r' } as any);
    for (const k of ['rif', 'saime', 'ivss']) expect(s.find((x) => x.key === k)!.available).toBe(false);
  });
  it('verifyCedula returns unavailable for CNE without a resolver, never throws', async () => {
    const out = await verifyCedula({} as any, 'cne', 'V-12.345.678', 'Juan Perez');
    expect(out.result).toBe('unavailable');
    expect(out.reason).toBe('resolver_no_configurado');
  });
  it('normalizeCedula strips prefix/dots; namesRoughlyMatch is loose', () => {
    expect(normalizeCedula('V-12.345.678')).toBe('12345678');
    expect(namesRoughlyMatch('Juan Carlos Perez', 'PEREZ JUAN')).toBe(true);
    expect(namesRoughlyMatch('Juan Perez', 'Maria Lopez')).toBe(false);
  });
});

describe('investigation routes', () => {
  it('POST /:id/identity/verify stores a record with the result and audits without the cédula', async () => {
    const { env, runs } = makeEnv();
    const res = await investigation.request('/abc/identity/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'manual', cedula: 'V-12.345.678' }),
    }, env);
    expect(res.status).toBe(201);
    const j = await res.json() as any;
    expect(j.result).toBe('match');
    const insert = runs.find((r) => /INSERT INTO case_identity/.test(r.sql));
    expect(insert, 'identity INSERT happened').toBeTruthy();
    expect(insert!.binds).toContain('12345678'); // cédula normalized + stored (operator table)
    const auditRow = runs.find((r) => /INSERT INTO audit/.test(r.sql));
    if (auditRow) expect(JSON.stringify(auditRow.binds)).not.toContain('12345678'); // never audited in plaintext
  });

  it('POST /:id/tip rejects spam/links and requires content', async () => {
    const { env } = makeEnv();
    const spam = await investigation.request('/abc/tip', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ detail: 'visita http://spam.xyz ya' }),
    }, env);
    expect(spam.status).toBe(400);
    const empty = await investigation.request('/abc/tip', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    }, env);
    expect(empty.status).toBe(400);
  });

  it('POST /:id/tip accepts a clean sighting as pending', async () => {
    const { env, runs } = makeEnv();
    const res = await investigation.request('/abc/tip', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'sighting', detail: 'Lo vi cerca de la plaza Bolivar esta manana' }),
    }, env);
    expect(res.status).toBe(201);
    const j = await res.json() as any;
    expect(j.status).toBe('pending');
    const insert = runs.find((r) => /INSERT INTO case_intel/.test(r.sql));
    expect(insert!.binds).toContain('citizen');
    expect(insert!.binds).toContain('pending');
  });
});

describe('investigation gating', () => {
  it('intel & identity are operator-gated (persons:moderate); tip is public', () => {
    expect(evaluateGate('/api/persons/abc/intel', 'GET')).toEqual({ kind: 'perm', perm: 'persons:moderate' });
    expect(evaluateGate('/api/persons/abc/identity/verify', 'POST')).toEqual({ kind: 'perm', perm: 'persons:moderate' });
    expect(evaluateGate('/api/persons/abc/tip', 'POST').kind).toBe('open');
  });
});
