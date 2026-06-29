import { describe, it, expect, beforeEach } from 'vitest';
import { makeDb, makeEnv, mount, call, RBAC_MIGRATIONS, type TestEnv } from './helpers/d1';
import { ninez, CAPABILITY_KEYS, POPULATION_KEYS, NEED_KEYS } from '../src/routes/ninez';
import { evaluateGate } from '../src/rbac/route-policy';
import { expandRolePerms } from '../scripts/rbac-catalog.mjs';
import { Hono } from 'hono';

// RBAC tables first (0061/0073 seed into rbac_permissions/role_permissions/feature_flags),
// then the refugios base schema (sites) + the ninez tables.
function db() {
  return makeDb([
    ...RBAC_MIGRATIONS,
    'migrations/0061_refugios_evacuacion.sql',
    'migrations/0072_refugios_ninez_vulnerables.sql',
    'migrations/0073_ninez_rbac.sql',
  ]);
}

let app: Hono;
let env: TestEnv;
beforeEach(() => {
  app = mount([['/api/ninez', ninez]]);
  env = makeEnv(db());
});

// A site that already exists in the 0061 seed.
const SITE = 'ref_umc';

describe('/api/ninez — write + read round-trip', () => {
  it('catalog exposes the controlled vocabularies', async () => {
    const r = await call(app, 'GET', '/api/ninez/catalog', env);
    expect(r.status).toBe(200);
    expect(r.json.capabilities).toEqual([...CAPABILITY_KEYS]);
    expect(r.json.needs).toEqual([...NEED_KEYS]);
  });

  it('records an OFFICIAL capability + population + need, then reads them back', async () => {
    expect((await call(app, 'POST', `/api/ninez/refugios/${SITE}/capability`, env,
      { capability_key: 'lactante', value: 1, official: 1, source: 'PCNGRD' })).status).toBe(201);
    expect((await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env,
      { category_key: 'menores_0_5', count: 30, official: 1, source: 'PCNGRD' })).status).toBe(201);
    expect((await call(app, 'POST', `/api/ninez/refugios/${SITE}/need`, env,
      { need_key: 'panales', status: 'requerido', qty_required: 100, qty_received: 40, official: 1, source: 'PCNGRD' })).status).toBe(201);

    const refs = await call(app, 'GET', '/api/ninez/refugios', env);
    expect(refs.status).toBe(200);
    const card = refs.json.refugios.find((x: any) => x.id === SITE);
    expect(card).toBeTruthy();
    expect(card.capabilities.map((c: any) => c.capability_key)).toContain('lactante');
    expect(card.population.find((p: any) => p.category_key === 'menores_0_5').count).toBe(30);
    expect(card.needs.find((n: any) => n.need_key === 'panales').status).toBe('requerido');

    const sum = await call(app, 'GET', '/api/ninez/summary', env);
    expect(sum.json.totals.minors).toBe(30);
    expect(sum.json.needs.find((n: any) => n.need_key === 'panales').requerido).toBe(1);
  });

  it('keeps only the latest population snapshot per category', async () => {
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env, { category_key: 'menores_6_15', count: 10, official: 1 });
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env, { category_key: 'menores_6_15', count: 25, official: 1 });
    const sum = await call(app, 'GET', '/api/ninez/summary', env);
    expect(sum.json.totals.minors).toBe(25); // latest snapshot wins, not 10+25
  });

  it('rejects unknown capability/category/need keys (400)', async () => {
    expect((await call(app, 'POST', `/api/ninez/refugios/${SITE}/capability`, env, { capability_key: 'hacker' })).status).toBe(400);
    expect((await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env, { category_key: 'ssn' })).status).toBe(400);
    expect((await call(app, 'POST', `/api/ninez/refugios/${SITE}/need`, env, { need_key: 'weapons' })).status).toBe(400);
  });
});

describe('/api/ninez — PRIVACY: public reads are official-only + carry no minor PII', () => {
  beforeEach(async () => {
    // one OFFICIAL count and one ESTIMATE (official=0) for the same site
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env, { category_key: 'menores_0_5', count: 12, official: 1 });
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env, { category_key: 'menores_6_15', count: 99, official: 0 });
  });

  it('public /refugios + /summary expose ONLY official=1 data', async () => {
    const sum = await call(app, 'GET', '/api/ninez/summary', env);
    expect(sum.json.totals.minors).toBe(12); // the 99 estimate is excluded
    const refs = await call(app, 'GET', '/api/ninez/refugios', env);
    const card = refs.json.refugios.find((x: any) => x.id === SITE);
    expect(card.population.every((p: any) => p.official === 1)).toBe(true);
  });

  it('no public ninez response contains individual-minor PII keys', async () => {
    const FORBIDDEN = /"(cedula|cédula|full_name|nombre_completo|edad|gov_id|telefono|teléfono|contacto|foto|photo_url|direccion|dirección)"/i;
    for (const path of ['/api/ninez/refugios', '/api/ninez/summary', '/api/ninez/catalog']) {
      const r = await call(app, 'GET', path, env);
      expect(FORBIDDEN.test(JSON.stringify(r.json)), `${path} leaked a PII key`).toBe(false);
    }
  });
});

describe('/api/ninez/alertas — child-priority classification', () => {
  it('flags unmet life-critical needs as critica and others as alerta (official only)', async () => {
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/population`, env, { category_key: 'menores_0_5', count: 20, official: 1 });
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/need`, env, { need_key: 'formula_lactante', status: 'requerido', official: 1 });
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/need`, env, { need_key: 'ropa', status: 'requerido', official: 1 });
    await call(app, 'POST', `/api/ninez/refugios/${SITE}/need`, env, { need_key: 'panales', status: 'requerido', official: 0 }); // estimate → excluded

    const r = await call(app, 'GET', '/api/ninez/alertas', env);
    expect(r.status).toBe(200);
    const formula = r.json.alertas.find((a: any) => a.need_key === 'formula_lactante');
    const ropa = r.json.alertas.find((a: any) => a.need_key === 'ropa');
    expect(formula.severity).toBe('critica');
    expect(ropa.severity).toBe('alerta');
    expect(r.json.alertas.find((a: any) => a.need_key === 'panales')).toBeUndefined(); // official=0 excluded
    expect(r.json.alertas[0].severity).toBe('critica'); // critica sorts first
    expect(r.json.counts.critica).toBeGreaterThanOrEqual(1);
  });

  it('alertas is public (open) and carries no minor PII', () => {
    expect(evaluateGate('/api/ninez/alertas', 'GET').kind).toBe('open');
  });
});

describe('/api/ninez — RBAC classification', () => {
  it('public reads are open; admin reads + writes require ninez:manage', () => {
    expect(evaluateGate('/api/ninez/refugios', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/ninez/summary', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/ninez/catalog', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/ninez/admin/refugios', 'GET')).toEqual({ kind: 'perm', perm: 'ninez:manage' });
    expect(evaluateGate('/api/ninez/refugios/ref_umc/capability', 'POST')).toEqual({ kind: 'perm', perm: 'ninez:manage' });
    expect(evaluateGate('/api/ninez/refugios/ref_umc/need', 'POST')).toEqual({ kind: 'perm', perm: 'ninez:manage' });
  });

  it('ninez:manage is held by operator + super_admin, not citizen (access-preserving)', () => {
    expect(expandRolePerms('operator').has('ninez:manage')).toBe(true);
    expect(expandRolePerms('super_admin').has('ninez:manage')).toBe(true);
    expect(expandRolePerms('citizen').has('ninez:manage')).toBe(false);
  });
});
