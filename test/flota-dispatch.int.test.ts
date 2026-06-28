import { describe, it, expect, beforeEach } from 'vitest';
import { flotaAdmin } from '../src/routes/flota-admin';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Dispatch assignment (flota_dispatches) — real handlers + SQL.

let db: D1Mock;
let env: TestEnv;
const admin = mount([['/api/admin/flota', flotaAdmin]]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function unit(name = 'Ambulancia 01', status = 'active') {
  return (await call(admin, 'POST', '/api/admin/flota/units', env, { name, type: 'ambulancia', status })).json.id as string;
}

describe('dispatch — create', () => {
  it('assigns a unit to a case (201) + audit + appears in the live snapshot as assigned', async () => {
    const id = await unit();
    const r = await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, { case_id: 'sos_123', status: 'assigned' });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^dsp_/);
    expect(r.json.case_id).toBe('sos_123');

    const row = db.raw.prepare('SELECT * FROM flota_dispatches WHERE id=?').get(r.json.id) as any;
    expect(row.unit_id).toBe(id);
    expect(row.status).toBe('assigned');
    expect(row.assigned_at).toBeGreaterThan(0);

    // live snapshot now reports the unit as dispatched (→ red marker)
    const live = await call(admin, 'GET', '/api/admin/flota/live', env);
    const u = live.json.units.find((x: any) => x.id === id);
    expect(u.dispatch_case_id).toBe('sos_123');
    expect(u.dispatch_status).toBe('assigned');
  });

  it('404 for an unknown unit', async () => {
    const r = await call(admin, 'POST', '/api/admin/flota/units/unit_x/dispatch', env, {});
    expect(r.status).toBe(404);
  });

  it('409 for an inactive unit', async () => {
    const id = await unit('Suspendida', 'suspended');
    const r = await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, {});
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('unit_inactive');
  });

  it('409 when the unit already has an open dispatch', async () => {
    const id = await unit();
    await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, { case_id: 'a' });
    const r = await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, { case_id: 'b' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('unit_ya_despachada');
  });
});

describe('dispatch — advance + clear', () => {
  it('advances status and clearing stamps cleared_at + frees the unit for a new dispatch', async () => {
    const id = await unit();
    const dsp = (await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, { case_id: 'c1' })).json.id;

    const enroute = await call(admin, 'PATCH', `/api/admin/flota/dispatches/${dsp}`, env, { status: 'enroute' });
    expect(enroute.status).toBe(200);
    expect(enroute.json.status).toBe('enroute');

    const cleared = await call(admin, 'PATCH', `/api/admin/flota/dispatches/${dsp}`, env, { status: 'cleared' });
    expect(cleared.status).toBe(200);
    expect(cleared.json.cleared_at).toBeGreaterThan(0);

    // a cleared dispatch can't be re-patched
    const again = await call(admin, 'PATCH', `/api/admin/flota/dispatches/${dsp}`, env, { status: 'onscene' });
    expect(again.status).toBe(409);

    // and the unit is now free to be dispatched again
    const r2 = await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, { case_id: 'c2' });
    expect(r2.status).toBe(201);
  });

  it('rejects an invalid status (400) and unknown dispatch (404)', async () => {
    expect((await call(admin, 'PATCH', '/api/admin/flota/dispatches/dsp_x', env, { status: 'enroute' })).status).toBe(404);
    const id = await unit();
    const dsp = (await call(admin, 'POST', `/api/admin/flota/units/${id}/dispatch`, env, {})).json.id;
    expect((await call(admin, 'PATCH', `/api/admin/flota/dispatches/${dsp}`, env, { status: 'bogus' })).status).toBe(400);
  });
});

describe('dispatch — list', () => {
  it('lists with filters (unit_id, status, open)', async () => {
    const a = await unit('A');
    const b = await unit('B');
    const da = (await call(admin, 'POST', `/api/admin/flota/units/${a}/dispatch`, env, { case_id: 'x' })).json.id;
    await call(admin, 'POST', `/api/admin/flota/units/${b}/dispatch`, env, { case_id: 'y' });
    await call(admin, 'PATCH', `/api/admin/flota/dispatches/${da}`, env, { status: 'cleared' });

    const all = await call(admin, 'GET', '/api/admin/flota/dispatches', env);
    expect(all.json.results.length).toBe(2);
    const open = await call(admin, 'GET', '/api/admin/flota/dispatches?open=1', env);
    expect(open.json.results.length).toBe(1);
    const byUnit = await call(admin, 'GET', `/api/admin/flota/dispatches?unit_id=${a}`, env);
    expect(byUnit.json.results.length).toBe(1);
    expect(byUnit.json.results[0].unit_name).toBe('A');
  });
});
