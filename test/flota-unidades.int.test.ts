import { describe, it, expect, beforeEach } from 'vitest';
import { flotaUnidades } from '../src/routes/flota-unidades';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Integration tests for the UNIDADES (response-units) CRUD route, run against a
// real in-memory SQLite via the D1 adapter. Mounted on a bare Hono app so the
// global auth gate is bypassed (it's a separate concern verified elsewhere).
// Token sub-routes (/:id/token*) are covered in flota-unit-token.test.ts; here
// we only smoke-test the basic issue path.

let db: D1Mock;
let env: TestEnv;
const app = mount([['/api/flota/unidades', flotaUnidades]]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function createUnit(body: Record<string, unknown> = {}) {
  return call(app, 'POST', '/api/flota/unidades', env, {
    nombre: 'Unidad 1',
    tipo: 'ambulancia',
    ...body,
  });
}

describe('POST /api/flota/unidades — create', () => {
  it('creates a unit and returns the row with 201', async () => {
    const r = await createUnit({ tipo: 'rescate', estado_op: 'disponible', placa: 'ABC-123', capacidad: 4 });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^uni_/);
    expect(r.json.nombre).toBe('Unidad 1');
    expect(r.json.tipo).toBe('rescate');
    expect(r.json.estado_op).toBe('disponible');
    expect(r.json.placa).toBe('ABC-123');
    expect(r.json.capacidad).toBe(4);
    expect(r.json.created_ms).toBeGreaterThan(0);
    expect(r.json.updated_ms).toBe(r.json.created_ms);

    // The row really landed in SQLite.
    const row = db.raw.prepare('SELECT * FROM flota_unidades WHERE id = ?').get(r.json.id) as any;
    expect(row).toBeTruthy();
    expect(row.nombre).toBe('Unidad 1');
  });

  it('defaults tipo to "rescate" and estado_op to "disponible" when omitted', async () => {
    const r = await call(app, 'POST', '/api/flota/unidades', env, { nombre: 'Solo Nombre' });
    expect(r.status).toBe(201);
    expect(r.json.tipo).toBe('rescate');
    expect(r.json.estado_op).toBe('disponible');
  });

  it('returns 400 when nombre is missing', async () => {
    const r = await call(app, 'POST', '/api/flota/unidades', env, { tipo: 'ambulancia' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre requerido');
  });

  it('returns 400 when nombre is blank/whitespace', async () => {
    const r = await call(app, 'POST', '/api/flota/unidades', env, { nombre: '   ' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre requerido');
  });

  it('returns 400 for an invalid tipo', async () => {
    const r = await createUnit({ tipo: 'nave_espacial' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('tipo inválido');
  });

  it('returns 400 for an invalid estado_op', async () => {
    const r = await createUnit({ tipo: 'ambulancia', estado_op: 'volando' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado_op inválido');
  });
});

describe('GET /api/flota/unidades — list', () => {
  it('returns an empty list when there are no units', async () => {
    const r = await call(app, 'GET', '/api/flota/unidades', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([]);
  });

  it('lists all units', async () => {
    await createUnit({ nombre: 'A', tipo: 'ambulancia' });
    await createUnit({ nombre: 'B', tipo: 'rescate' });
    const r = await call(app, 'GET', '/api/flota/unidades', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(2);
  });

  it('filters by ?estado_op=', async () => {
    await createUnit({ nombre: 'Disp', estado_op: 'disponible' });
    await createUnit({ nombre: 'Mant', estado_op: 'mantenimiento' });
    const r = await call(app, 'GET', '/api/flota/unidades?estado_op=mantenimiento', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].nombre).toBe('Mant');
    expect(r.json.results[0].estado_op).toBe('mantenimiento');
  });

  it('filters by ?tipo=', async () => {
    await createUnit({ nombre: 'Amb', tipo: 'ambulancia' });
    await createUnit({ nombre: 'Dron', tipo: 'dron' });
    const r = await call(app, 'GET', '/api/flota/unidades?tipo=dron', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].nombre).toBe('Dron');
    expect(r.json.results[0].tipo).toBe('dron');
  });

  it('ignores an unrecognised filter value (returns everything)', async () => {
    await createUnit({ nombre: 'A' });
    await createUnit({ nombre: 'B' });
    const r = await call(app, 'GET', '/api/flota/unidades?tipo=nope', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(2);
  });
});

describe('GET /api/flota/unidades/:id — one', () => {
  it('returns the unit by id', async () => {
    const id = (await createUnit()).json.id;
    const r = await call(app, 'GET', `/api/flota/unidades/${id}`, env);
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(id);
    expect(r.json.nombre).toBe('Unidad 1');
  });

  it('returns 404 for an unknown id', async () => {
    const r = await call(app, 'GET', '/api/flota/unidades/uni_does_not_exist', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('PATCH /api/flota/unidades/:id — update', () => {
  it('updates fields and bumps updated_ms', async () => {
    const created = (await createUnit()).json;
    // Force a later timestamp so the bump is observable.
    db.raw.prepare('UPDATE flota_unidades SET updated_ms = ? WHERE id = ?').run(1, created.id);

    const r = await call(app, 'PATCH', `/api/flota/unidades/${created.id}`, env, {
      nombre: 'Renombrada',
      estado_op: 'en_mision',
      placa: 'XYZ-999',
    });
    expect(r.status).toBe(200);
    expect(r.json.nombre).toBe('Renombrada');
    expect(r.json.estado_op).toBe('en_mision');
    expect(r.json.placa).toBe('XYZ-999');
    expect(r.json.updated_ms).toBeGreaterThan(1);
    expect(r.json.created_ms).toBe(created.created_ms);
  });

  it('returns 400 when there is nothing to update', async () => {
    const id = (await createUnit()).json.id;
    const r = await call(app, 'PATCH', `/api/flota/unidades/${id}`, env, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nada que actualizar');
  });

  it('returns 400 for an invalid tipo', async () => {
    const id = (await createUnit()).json.id;
    const r = await call(app, 'PATCH', `/api/flota/unidades/${id}`, env, { tipo: 'submarino' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('tipo inválido');
  });

  it('returns 400 for an invalid estado_op', async () => {
    const id = (await createUnit()).json.id;
    const r = await call(app, 'PATCH', `/api/flota/unidades/${id}`, env, { estado_op: 'orbita' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado_op inválido');
  });

  it('returns 400 when nombre is set to blank', async () => {
    const id = (await createUnit()).json.id;
    const r = await call(app, 'PATCH', `/api/flota/unidades/${id}`, env, { nombre: '   ' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nombre inválido');
  });

  it('returns 404 for an unknown id', async () => {
    const r = await call(app, 'PATCH', '/api/flota/unidades/uni_missing', env, { nombre: 'X' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

describe('DELETE /api/flota/unidades/:id', () => {
  it('deletes a unit and returns ok', async () => {
    const id = (await createUnit()).json.id;
    const r = await call(app, 'DELETE', `/api/flota/unidades/${id}`, env);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, id });
    const row = db.raw.prepare('SELECT id FROM flota_unidades WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('returns 404 for an unknown id', async () => {
    const r = await call(app, 'DELETE', '/api/flota/unidades/uni_missing', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

// NB: field-unit GPS tokens moved to the new live-GPS system (flota_units +
// /api/admin/flota) — covered by test/flota-live-gps.int.test.ts.
