import { describe, it, expect, beforeEach } from 'vitest';
import { flotaPersonal } from '../src/routes/flota-personal';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Integration tests for the FLOTA personnel CRUD route (flota_personal),
// exercised against a real in-memory SQLite via the D1 adapter. Routes are
// mounted on a bare Hono app (the global auth gate is verified elsewhere).

let db: D1Mock;
let env: TestEnv;
const app = mount([['/api/flota/personal', flotaPersonal]]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function makePerson(overrides: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/api/flota/personal', env, {
    nombre: 'Ana Pérez',
    ...overrides,
  });
  return r;
}

describe('POST /api/flota/personal — create', () => {
  it('creates a person with sane defaults and returns 201', async () => {
    const r = await makePerson();
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.id).toBe('string');
    expect(r.json.nombre).toBe('Ana Pérez');
    expect(r.json.rol).toBe('rescatista'); // default
    expect(r.json.estado).toBe('activo'); // default
    expect(r.json.skills).toEqual([]);
  });

  it('persists skills given as an array as a JSON string column', async () => {
    const r = await makePerson({ skills: ['triage', 'rappel', 'soporte vital'] });
    expect(r.status).toBe(201);
    expect(r.json.skills).toEqual(['triage', 'rappel', 'soporte vital']);

    const row = db.raw
      .prepare('SELECT skills FROM flota_personal WHERE id=?')
      .get(r.json.id) as { skills: string };
    expect(typeof row.skills).toBe('string');
    expect(JSON.parse(row.skills)).toEqual(['triage', 'rappel', 'soporte vital']);
  });

  it('accepts skills as a comma-separated string and normalizes to an array', async () => {
    const r = await makePerson({ skills: 'triage, rappel ,  ' });
    expect(r.status).toBe(201);
    expect(r.json.skills).toEqual(['triage', 'rappel']);
  });

  it('persists optional contact + unit fields', async () => {
    const r = await makePerson({
      rol: 'paramedico',
      estado: 'en_mision',
      telefono: '0414-1234567',
      email: 'ana@example.com',
      unidad_id: 'unit-1',
    });
    expect(r.status).toBe(201);
    const row = db.raw
      .prepare('SELECT rol, estado, telefono, email, unidad_id FROM flota_personal WHERE id=?')
      .get(r.json.id) as Record<string, string>;
    expect(row.rol).toBe('paramedico');
    expect(row.estado).toBe('en_mision');
    expect(row.telefono).toBe('0414-1234567');
    expect(row.email).toBe('ana@example.com');
    expect(row.unidad_id).toBe('unit-1');
  });

  it('rejects a missing nombre with 400', async () => {
    const r = await call(app, 'POST', '/api/flota/personal', env, { rol: 'paramedico' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre requerido');
  });

  it('rejects a blank/whitespace nombre with 400', async () => {
    const r = await call(app, 'POST', '/api/flota/personal', env, { nombre: '   ' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre requerido');
  });

  it('rejects an invalid rol with 400', async () => {
    const r = await makePerson({ rol: 'astronauta' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('rol inválido');
  });

  it('rejects an invalid estado with 400', async () => {
    const r = await makePerson({ estado: 'desaparecido' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado inválido');
  });
});

describe('GET /api/flota/personal — list + filters', () => {
  it('returns all persons ordered by nombre with skills parsed back to arrays', async () => {
    await makePerson({ nombre: 'Zoe', skills: ['a'] });
    await makePerson({ nombre: 'Beto' });
    await makePerson({ nombre: 'Ana' });
    const r = await call(app, 'GET', '/api/flota/personal', env);
    expect(r.status).toBe(200);
    expect(r.json.results.map((p: any) => p.nombre)).toEqual(['Ana', 'Beto', 'Zoe']);
    const zoe = r.json.results.find((p: any) => p.nombre === 'Zoe');
    expect(zoe.skills).toEqual(['a']);
  });

  it('filters by rol', async () => {
    await makePerson({ nombre: 'P1', rol: 'paramedico' });
    await makePerson({ nombre: 'P2', rol: 'conductor' });
    const r = await call(app, 'GET', '/api/flota/personal?rol=paramedico', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].nombre).toBe('P1');
  });

  it('ignores an unknown rol filter (returns all)', async () => {
    await makePerson({ nombre: 'P1', rol: 'paramedico' });
    await makePerson({ nombre: 'P2', rol: 'conductor' });
    const r = await call(app, 'GET', '/api/flota/personal?rol=bogus', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(2);
  });

  it('filters by unidad_id', async () => {
    await makePerson({ nombre: 'P1', unidad_id: 'unit-A' });
    await makePerson({ nombre: 'P2', unidad_id: 'unit-B' });
    const r = await call(app, 'GET', '/api/flota/personal?unidad_id=unit-A', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].nombre).toBe('P1');
  });

  it('filters by estado', async () => {
    await makePerson({ nombre: 'P1', estado: 'inactivo' });
    await makePerson({ nombre: 'P2', estado: 'activo' });
    const r = await call(app, 'GET', '/api/flota/personal?estado=inactivo', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].nombre).toBe('P1');
  });

  it('combines filters with AND', async () => {
    await makePerson({ nombre: 'P1', rol: 'paramedico', estado: 'activo' });
    await makePerson({ nombre: 'P2', rol: 'paramedico', estado: 'inactivo' });
    const r = await call(app, 'GET', '/api/flota/personal?rol=paramedico&estado=inactivo', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].nombre).toBe('P2');
  });
});

describe('GET /api/flota/personal/:id — read one', () => {
  it('returns the person with skills parsed back to a JS array', async () => {
    const created = await makePerson({ skills: ['triage', 'rappel'] });
    const r = await call(app, 'GET', `/api/flota/personal/${created.json.id}`, env);
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(created.json.id);
    expect(r.json.nombre).toBe('Ana Pérez');
    expect(Array.isArray(r.json.skills)).toBe(true);
    expect(r.json.skills).toEqual(['triage', 'rappel']);
  });

  it('returns 404 for an unknown id', async () => {
    const r = await call(app, 'GET', '/api/flota/personal/nope', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('PATCH /api/flota/personal/:id — update', () => {
  it('updates mutable fields and returns ok', async () => {
    const created = await makePerson();
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {
      nombre: 'Ana María',
      rol: 'coordinador',
      estado: 'inactivo',
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const row = db.raw
      .prepare('SELECT nombre, rol, estado FROM flota_personal WHERE id=?')
      .get(created.json.id) as Record<string, string>;
    expect(row.nombre).toBe('Ana María');
    expect(row.rol).toBe('coordinador');
    expect(row.estado).toBe('inactivo');
  });

  it('round-trips an updated skills array through GET', async () => {
    const created = await makePerson({ skills: ['old'] });
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {
      skills: ['rappel', 'buceo'],
    });
    expect(r.status).toBe(200);
    const got = await call(app, 'GET', `/api/flota/personal/${created.json.id}`, env);
    expect(got.json.skills).toEqual(['rappel', 'buceo']);
  });

  it('clears nullable fields when set to null', async () => {
    const created = await makePerson({ telefono: '0414', email: 'a@b.co', unidad_id: 'u1' });
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {
      telefono: null,
      email: null,
      unidad_id: null,
    });
    expect(r.status).toBe(200);
    const row = db.raw
      .prepare('SELECT telefono, email, unidad_id FROM flota_personal WHERE id=?')
      .get(created.json.id) as Record<string, unknown>;
    expect(row.telefono).toBeNull();
    expect(row.email).toBeNull();
    expect(row.unidad_id).toBeNull();
  });

  it('rejects an invalid rol with 400', async () => {
    const created = await makePerson();
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {
      rol: 'astronauta',
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('rol inválido');
  });

  it('rejects an invalid estado with 400', async () => {
    const created = await makePerson();
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {
      estado: 'desaparecido',
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado inválido');
  });

  it('rejects a blank nombre with 400', async () => {
    const created = await makePerson();
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {
      nombre: '   ',
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre inválido');
  });

  it('rejects an empty patch with 400', async () => {
    const created = await makePerson();
    const r = await call(app, 'PATCH', `/api/flota/personal/${created.json.id}`, env, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nada que actualizar');
  });

  it('returns 404 when updating an unknown id', async () => {
    const r = await call(app, 'PATCH', '/api/flota/personal/nope', env, { nombre: 'X' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('DELETE /api/flota/personal/:id — delete', () => {
  it('deletes an existing person and returns ok', async () => {
    const created = await makePerson();
    const r = await call(app, 'DELETE', `/api/flota/personal/${created.json.id}`, env);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const row = db.raw
      .prepare('SELECT COUNT(*) n FROM flota_personal WHERE id=?')
      .get(created.json.id) as { n: number };
    expect(row.n).toBe(0);
  });

  it('returns 404 when deleting an unknown id', async () => {
    const r = await call(app, 'DELETE', '/api/flota/personal/nope', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});
