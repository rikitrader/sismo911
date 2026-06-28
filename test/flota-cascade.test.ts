import { describe, it, expect, beforeEach } from 'vitest';
import { flotaUnidades } from '../src/routes/flota-unidades';
import { flotaMisiones } from '../src/routes/flota-misiones';
import { flotaFlotas } from '../src/routes/flota-flotas';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Referential-integrity / cascade behaviour, exercised against a real in-memory
// SQLite via the D1 adapter. Routes are mounted on a bare Hono app (the global
// auth gate is a separate concern verified elsewhere).

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/flota/unidades', flotaUnidades],
  ['/api/flota/misiones', flotaMisiones],
  ['/api/flota/flotas', flotaFlotas],
]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function makeUnit(estado_op = 'disponible') {
  const r = await call(app, 'POST', '/api/flota/unidades', env, { nombre: 'U1', tipo: 'ambulancia', estado_op });
  return r.json.id as string;
}
async function makeMission() {
  const r = await call(app, 'POST', '/api/flota/misiones', env, { tipo: 'rescate', descripcion: 'X' });
  return r.json.id as string;
}

describe('cascade — deleting a unit on an active mission is blocked', () => {
  it('returns 409 unidad_en_mision_activa', async () => {
    const unit = await makeUnit();
    const mis = await makeMission();
    await call(app, 'POST', `/api/flota/misiones/${mis}/despachar`, env, { unidad_id: unit });
    const del = await call(app, 'DELETE', `/api/flota/unidades/${unit}`, env);
    expect(del.status).toBe(409);
    expect(del.json.error).toBe('unidad_en_mision_activa');
  });

  it('allows deletion once the mission is completed', async () => {
    const unit = await makeUnit();
    const mis = await makeMission();
    await call(app, 'POST', `/api/flota/misiones/${mis}/despachar`, env, { unidad_id: unit });
    await call(app, 'POST', `/api/flota/misiones/${mis}/estado`, env, { estado: 'en_ruta' });
    await call(app, 'POST', `/api/flota/misiones/${mis}/estado`, env, { estado: 'en_sitio' });
    await call(app, 'POST', `/api/flota/misiones/${mis}/estado`, env, { estado: 'completada' });
    const del = await call(app, 'DELETE', `/api/flota/unidades/${unit}`, env);
    expect(del.status).toBe(200);
  });
});

describe('cascade — deleting a mission removes its waypoints + activity', () => {
  it('waypoints and activity rows are gone and the unit is freed', async () => {
    const unit = await makeUnit();
    const create = await call(app, 'POST', '/api/flota/misiones', env, {
      tipo: 'rescate', descripcion: 'X', waypoints: [{ lat: 1, lon: 2, direccion: 'A' }],
    });
    const mis = create.json.id;
    await call(app, 'POST', `/api/flota/misiones/${mis}/despachar`, env, { unidad_id: unit });

    const del = await call(app, 'DELETE', `/api/flota/misiones/${mis}`, env);
    expect(del.status).toBe(200);

    const wp = db.raw.prepare('SELECT COUNT(*) n FROM flota_mision_waypoints WHERE mision_id=?').get(mis) as { n: number };
    const act = db.raw.prepare('SELECT COUNT(*) n FROM flota_mision_actividad WHERE mision_id=?').get(mis) as { n: number };
    expect(wp.n).toBe(0);
    expect(act.n).toBe(0);
    const u = db.raw.prepare('SELECT estado_op FROM flota_unidades WHERE id=?').get(unit) as { estado_op: string };
    expect(u.estado_op).toBe('disponible');
  });
});

describe('cascade — deleting a fleet removes its membership', () => {
  it('membership rows for the fleet are gone', async () => {
    const unit = await makeUnit();
    const flt = (await call(app, 'POST', '/api/flota/flotas', env, { nombre: 'Flota 1' })).json.id;
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: unit });
    let m = db.raw.prepare('SELECT COUNT(*) n FROM flota_flota_unidades WHERE flota_id=?').get(flt) as { n: number };
    expect(m.n).toBe(1);
    await call(app, 'DELETE', `/api/flota/flotas/${flt}`, env);
    m = db.raw.prepare('SELECT COUNT(*) n FROM flota_flota_unidades WHERE flota_id=?').get(flt) as { n: number };
    expect(m.n).toBe(0);
  });

  it('deleting a unit also clears its fleet membership', async () => {
    const unit = await makeUnit();
    const flt = (await call(app, 'POST', '/api/flota/flotas', env, { nombre: 'Flota 1' })).json.id;
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: unit });
    await call(app, 'DELETE', `/api/flota/unidades/${unit}`, env);
    const m = db.raw.prepare('SELECT COUNT(*) n FROM flota_flota_unidades WHERE unidad_id=?').get(unit) as { n: number };
    expect(m.n).toBe(0);
  });
});
