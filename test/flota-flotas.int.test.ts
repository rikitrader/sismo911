import { describe, it, expect, beforeEach } from 'vitest';
import { flotaFlotas } from '../src/routes/flota-flotas';
import { flotaUnidades } from '../src/routes/flota-unidades';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Integration coverage for the FLOTA fleets route (/api/flota/flotas), exercised
// against a real in-memory SQLite via the D1 adapter. flotaUnidades is mounted
// too so member units can be created (the detail/add routes read flota_unidades).

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/flota/flotas', flotaFlotas],
  ['/api/flota/unidades', flotaUnidades],
]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function makeUnit(nombre = 'U1', tipo = 'ambulancia', estado_op = 'disponible') {
  const r = await call(app, 'POST', '/api/flota/unidades', env, { nombre, tipo, estado_op });
  return r.json.id as string;
}
async function makeFleet(nombre = 'Flota 1', extra: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/api/flota/flotas', env, { nombre, ...extra });
  return r.json.id as string;
}

describe('POST /api/flota/flotas — create', () => {
  it('creates a fleet and returns 201 with id + nombre', async () => {
    const r = await call(app, 'POST', '/api/flota/flotas', env, {
      nombre: '  Flota Caracas  ',
      organizacion: 'PC',
      estado_region: 'Distrito Capital',
      descripcion: 'Unidades de la capital',
    });
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.id).toBe('string');
    expect(r.json.id).toMatch(/^flt_/);
    expect(r.json.nombre).toBe('Flota Caracas'); // trimmed

    const row = db.raw
      .prepare('SELECT nombre, organizacion, estado_region, descripcion FROM flota_flotas WHERE id=?')
      .get(r.json.id) as any;
    expect(row.nombre).toBe('Flota Caracas');
    expect(row.organizacion).toBe('PC');
    expect(row.estado_region).toBe('Distrito Capital');
    expect(row.descripcion).toBe('Unidades de la capital');
  });

  it('stores null optionals when omitted', async () => {
    const id = await makeFleet('Solo nombre');
    const row = db.raw
      .prepare('SELECT organizacion, estado_region, descripcion FROM flota_flotas WHERE id=?')
      .get(id) as any;
    expect(row.organizacion).toBeNull();
    expect(row.estado_region).toBeNull();
    expect(row.descripcion).toBeNull();
  });

  it('rejects a missing nombre with 400 nombre requerido', async () => {
    const r = await call(app, 'POST', '/api/flota/flotas', env, { organizacion: 'PC' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre requerido');
  });

  it('rejects a blank/whitespace nombre with 400', async () => {
    const r = await call(app, 'POST', '/api/flota/flotas', env, { nombre: '   ' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre requerido');
  });

  it('rejects an invalid JSON body with 400', async () => {
    const res = await app.request(
      '/api/flota/flotas',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
      env,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect((json as any).error).toBe('nombre requerido');
  });
});

describe('GET /api/flota/flotas — list', () => {
  it('returns an empty list initially', async () => {
    const r = await call(app, 'GET', '/api/flota/flotas', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([]);
  });

  it('reflects membership in unidades_count', async () => {
    const u1 = await makeUnit('U1');
    const u2 = await makeUnit('U2');
    const flt = await makeFleet('Con miembros');
    const empty = await makeFleet('Vacia');
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u1 });
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u2 });

    const r = await call(app, 'GET', '/api/flota/flotas', env);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.results.map((f: any) => [f.id, f]));
    expect(byId[flt].unidades_count).toBe(2);
    expect(byId[empty].unidades_count).toBe(0);
  });
});

describe('GET /api/flota/flotas/:id — detail', () => {
  it('returns the fleet with member units joined (nombre/tipo/estado_op)', async () => {
    const u1 = await makeUnit('Alfa', 'ambulancia', 'disponible');
    const u2 = await makeUnit('Bravo', 'rescate', 'en_mision');
    const flt = await makeFleet('Detalle');
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u1 });
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u2 });

    const r = await call(app, 'GET', `/api/flota/flotas/${flt}`, env);
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(flt);
    expect(r.json.nombre).toBe('Detalle');
    expect(Array.isArray(r.json.unidades)).toBe(true);
    expect(r.json.unidades).toHaveLength(2);
    // ordered by u.nombre → Alfa before Bravo
    expect(r.json.unidades[0]).toEqual({
      id: u1, nombre: 'Alfa', tipo: 'ambulancia', estado_op: 'disponible',
    });
    expect(r.json.unidades[1]).toEqual({
      id: u2, nombre: 'Bravo', tipo: 'rescate', estado_op: 'en_mision',
    });
  });

  it('returns an empty unidades array for a fleet with no members', async () => {
    const flt = await makeFleet('Vacia');
    const r = await call(app, 'GET', `/api/flota/flotas/${flt}`, env);
    expect(r.status).toBe(200);
    expect(r.json.unidades).toEqual([]);
  });

  it('returns 404 no encontrado for an unknown fleet', async () => {
    const r = await call(app, 'GET', '/api/flota/flotas/flt_nope', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('PATCH /api/flota/flotas/:id — update', () => {
  it('updates provided fields and returns ok', async () => {
    const flt = await makeFleet('Antes', { organizacion: 'X' });
    const r = await call(app, 'PATCH', `/api/flota/flotas/${flt}`, env, {
      nombre: 'Despues', organizacion: 'PC', estado_region: 'Miranda', descripcion: 'd',
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.id).toBe(flt);
    const row = db.raw
      .prepare('SELECT nombre, organizacion, estado_region, descripcion FROM flota_flotas WHERE id=?')
      .get(flt) as any;
    expect(row.nombre).toBe('Despues');
    expect(row.organizacion).toBe('PC');
    expect(row.estado_region).toBe('Miranda');
    expect(row.descripcion).toBe('d');
  });

  it('can null out an optional field by passing null', async () => {
    const flt = await makeFleet('F', { organizacion: 'X' });
    const r = await call(app, 'PATCH', `/api/flota/flotas/${flt}`, env, { organizacion: null });
    expect(r.status).toBe(200);
    const row = db.raw.prepare('SELECT organizacion FROM flota_flotas WHERE id=?').get(flt) as any;
    expect(row.organizacion).toBeNull();
  });

  it('rejects a blank nombre with 400 nombre inválido', async () => {
    const flt = await makeFleet('F');
    const r = await call(app, 'PATCH', `/api/flota/flotas/${flt}`, env, { nombre: '   ' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre inválido');
  });

  it('rejects an empty patch with 400 nada que actualizar', async () => {
    const flt = await makeFleet('F');
    const r = await call(app, 'PATCH', `/api/flota/flotas/${flt}`, env, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nada que actualizar');
  });

  it('returns 404 no encontrado for an unknown fleet', async () => {
    const r = await call(app, 'PATCH', '/api/flota/flotas/flt_nope', env, { nombre: 'X' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('DELETE /api/flota/flotas/:id — delete (cascades membership)', () => {
  it('deletes the fleet and its membership rows', async () => {
    const u1 = await makeUnit('U1');
    const flt = await makeFleet('Borrar');
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u1 });

    const r = await call(app, 'DELETE', `/api/flota/flotas/${flt}`, env);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.id).toBe(flt);

    const fleetRow = db.raw.prepare('SELECT id FROM flota_flotas WHERE id=?').get(flt);
    expect(fleetRow).toBeUndefined();
    const mem = db.raw
      .prepare('SELECT COUNT(*) n FROM flota_flota_unidades WHERE flota_id=?')
      .get(flt) as { n: number };
    expect(mem.n).toBe(0);
    // the unit itself survives
    const unit = db.raw.prepare('SELECT id FROM flota_unidades WHERE id=?').get(u1) as any;
    expect(unit.id).toBe(u1);
  });

  it('returns 404 no encontrado for an unknown fleet', async () => {
    const r = await call(app, 'DELETE', '/api/flota/flotas/flt_nope', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('POST /api/flota/flotas/:id/unidades — add unit', () => {
  it('adds a unit and is idempotent (INSERT OR IGNORE)', async () => {
    const u1 = await makeUnit('U1');
    const flt = await makeFleet('F');

    const r1 = await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u1 });
    expect(r1.status).toBe(200);
    expect(r1.json).toEqual({ ok: true, flota_id: flt, unidad_id: u1 });

    const r2 = await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u1 });
    expect(r2.status).toBe(200);

    const mem = db.raw
      .prepare('SELECT COUNT(*) n FROM flota_flota_unidades WHERE flota_id=? AND unidad_id=?')
      .get(flt, u1) as { n: number };
    expect(mem.n).toBe(1);
  });

  it('rejects a missing unidad_id with 400 unidad_id requerido', async () => {
    const flt = await makeFleet('F');
    const r = await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unidad_id requerido');
  });

  it('returns 404 flota no encontrada when the fleet is unknown', async () => {
    const u1 = await makeUnit('U1');
    const r = await call(app, 'POST', '/api/flota/flotas/flt_nope/unidades', env, { unidad_id: u1 });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('flota no encontrada');
  });

  it('returns 404 unidad no encontrada when the unit is unknown', async () => {
    const flt = await makeFleet('F');
    const r = await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: 'uni_nope' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('unidad no encontrada');
  });
});

describe('DELETE /api/flota/flotas/:id/unidades/:unidadId — remove unit', () => {
  it('removes an existing membership row', async () => {
    const u1 = await makeUnit('U1');
    const flt = await makeFleet('F');
    await call(app, 'POST', `/api/flota/flotas/${flt}/unidades`, env, { unidad_id: u1 });

    const r = await call(app, 'DELETE', `/api/flota/flotas/${flt}/unidades/${u1}`, env);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, flota_id: flt, unidad_id: u1 });

    const mem = db.raw
      .prepare('SELECT COUNT(*) n FROM flota_flota_unidades WHERE flota_id=? AND unidad_id=?')
      .get(flt, u1) as { n: number };
    expect(mem.n).toBe(0);
  });

  it('returns 404 no encontrado when the membership does not exist', async () => {
    const flt = await makeFleet('F');
    const r = await call(app, 'DELETE', `/api/flota/flotas/${flt}/unidades/uni_nope`, env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});
