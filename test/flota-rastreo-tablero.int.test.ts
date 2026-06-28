import { describe, it, expect, beforeEach } from 'vitest';
import { flotaRastreo } from '../src/routes/flota-rastreo';
import { flotaTablero } from '../src/routes/flota-tablero';
import { flotaUnidades } from '../src/routes/flota-unidades';
import { flotaMisiones } from '../src/routes/flota-misiones';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Integration tests for the FLOTA read surfaces:
//   • RASTREO  (/api/flota/rastreo) — GPS position ingest + map/track reads
//   • TABLERO  (/api/flota/tablero) — dashboard aggregates + command map
// Routes are mounted on a bare Hono app (the global auth gate is bypassed, so no
// cookies/tokens needed). The test env has no FLOTA_TRACKING binding, so the
// live-publish branch in /posicion is skipped, and no `rate_buckets` table exists
// so rateLimit() fails open — both as the routes intend.

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/flota/rastreo', flotaRastreo],
  ['/api/flota/tablero', flotaTablero],
  ['/api/flota/unidades', flotaUnidades],
  ['/api/flota/misiones', flotaMisiones],
]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
});

async function makeUnit(opts: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/api/flota/unidades', env, {
    nombre: 'U', tipo: 'ambulancia', estado_op: 'disponible', ...opts,
  });
  return r.json.id as string;
}

// Direct seed helpers for tables with no mounted write route, or to control state
// without the side-effects of the dispatch lifecycle (which would mutate units).
function seedMission(estado: string, prioridad: number, i: number) {
  const now = Date.now();
  db.raw
    .prepare(
      `INSERT INTO flota_misiones (id, codigo, tipo, prioridad, estado, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(`mis_${i}`, `MIS-${i}`, 'rescate', prioridad, estado, now, now);
}
function seedPersonal(rol: string, i: number) {
  const now = Date.now();
  db.raw
    .prepare(
      `INSERT INTO flota_personal (id, nombre, rol, estado, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(`per_${i}`, `P${i}`, rol, 'activo', now, now);
}

// ── RASTREO ──────────────────────────────────────────────────────────────────

describe('RASTREO POST /posicion (operator path: body.unidad_id, no token)', () => {
  it('records a flota_posiciones row and denormalizes the latest fix onto the unit', async () => {
    const unit = await makeUnit();
    const r = await call(app, 'POST', '/api/flota/rastreo/posicion', env, {
      unidad_id: unit, lat: 10.5, lon: -66.9, rumbo: 90, velocidad: 12,
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });

    const pos = db.raw
      .prepare('SELECT * FROM flota_posiciones WHERE unidad_id = ?')
      .all(unit) as any[];
    expect(pos.length).toBe(1);
    expect(pos[0].lat).toBe(10.5);
    expect(pos[0].lon).toBe(-66.9);

    const u = db.raw
      .prepare('SELECT lat, lon, rumbo, ult_pos_ms FROM flota_unidades WHERE id = ?')
      .get(unit) as { lat: number; lon: number; rumbo: number; ult_pos_ms: number };
    expect(u.lat).toBe(10.5);
    expect(u.lon).toBe(-66.9);
    expect(u.rumbo).toBe(90);
    expect(u.ult_pos_ms).toBeGreaterThan(0);
  });

  it('400 unidad_id requerido when unidad_id is missing', async () => {
    const r = await call(app, 'POST', '/api/flota/rastreo/posicion', env, { lat: 10, lon: -66 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unidad_id requerido');
  });

  it('400 bad_lat_lon when lat/lon are out of range', async () => {
    const unit = await makeUnit();
    const r = await call(app, 'POST', '/api/flota/rastreo/posicion', env, {
      unidad_id: unit, lat: 200, lon: 0,
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('bad_lat_lon');
  });

  it('400 bad_lat_lon when lat/lon are missing (unidad_id present)', async () => {
    const unit = await makeUnit();
    const r = await call(app, 'POST', '/api/flota/rastreo/posicion', env, { unidad_id: unit });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('bad_lat_lon');
  });
});

describe('RASTREO GET /unidades (units with a known position)', () => {
  it('returns only units that have a position', async () => {
    const tracked = await makeUnit({ nombre: 'Tracked' });
    await makeUnit({ nombre: 'NoFix' }); // never reports a position → excluded
    await call(app, 'POST', '/api/flota/rastreo/posicion', env, { unidad_id: tracked, lat: 8, lon: -65 });

    const r = await call(app, 'GET', '/api/flota/rastreo/unidades', env);
    expect(r.status).toBe(200);
    expect(r.json.results.length).toBe(1);
    expect(r.json.results[0].id).toBe(tracked);
    expect(r.json.results[0].lat).toBe(8);
  });
});

describe('RASTREO GET /unidad/:id/track (recent points, respects ?limit)', () => {
  it('returns recent track points and honors ?limit', async () => {
    const unit = await makeUnit();
    for (const lat of [1, 2, 3]) {
      await call(app, 'POST', '/api/flota/rastreo/posicion', env, { unidad_id: unit, lat, lon: -66 });
    }

    const all = await call(app, 'GET', `/api/flota/rastreo/unidad/${unit}/track`, env);
    expect(all.status).toBe(200);
    expect(all.json.results.length).toBe(3);

    const limited = await call(app, 'GET', `/api/flota/rastreo/unidad/${unit}/track?limit=2`, env);
    expect(limited.status).toBe(200);
    expect(limited.json.results.length).toBe(2);
  });

  it('returns an empty list for a unit with no track', async () => {
    const r = await call(app, 'GET', '/api/flota/rastreo/unidad/uni_nope/track', env);
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([]);
  });
});

// ── TABLERO ──────────────────────────────────────────────────────────────────

describe('TABLERO GET /resumen', () => {
  it('aggregates unit / mission / personnel counts', async () => {
    await makeUnit({ tipo: 'ambulancia', estado_op: 'disponible' });
    await makeUnit({ tipo: 'rescate', estado_op: 'disponible' });
    await makeUnit({ tipo: 'bomberos', estado_op: 'mantenimiento' });

    seedMission('creada', 1, 1);
    seedMission('en_ruta', 2, 2);
    seedMission('completada', 3, 3);
    seedMission('cancelada', 1, 4);

    seedPersonal('paramedico', 1);
    seedPersonal('rescatista', 2);
    seedPersonal('paramedico', 3);

    const r = await call(app, 'GET', '/api/flota/tablero/resumen', env);
    expect(r.status).toBe(200);

    expect(r.json.unidades.total).toBe(3);
    expect(r.json.unidades.por_estado).toEqual({ disponible: 2, mantenimiento: 1 });
    expect(r.json.unidades.por_tipo).toEqual({ ambulancia: 1, rescate: 1, bomberos: 1 });

    expect(r.json.misiones.total).toBe(4);
    expect(r.json.misiones.activas).toBe(2); // 4 − completada(1) − cancelada(1)
    expect(r.json.misiones.por_estado).toEqual({
      creada: 1, en_ruta: 1, completada: 1, cancelada: 1,
    });
    expect(r.json.misiones.por_prioridad).toEqual({ '1': 2, '2': 1, '3': 1 });

    expect(r.json.personal.total).toBe(3);
    expect(r.json.personal.por_rol).toEqual({ paramedico: 2, rescatista: 1 });
  });

  it('returns zeroed aggregates on an empty fleet', async () => {
    const r = await call(app, 'GET', '/api/flota/tablero/resumen', env);
    expect(r.status).toBe(200);
    expect(r.json.unidades.total).toBe(0);
    expect(r.json.unidades.por_estado).toEqual({});
    expect(r.json.misiones.total).toBe(0);
    expect(r.json.misiones.activas).toBe(0);
    expect(r.json.personal.total).toBe(0);
    expect(r.json.tiempo_respuesta_prom_min).toBeNull();
  });
});

describe('TABLERO GET /mapa', () => {
  it('returns geolocated units and only active missions', async () => {
    await makeUnit({ nombre: 'OnMap', lat: 10, lon: -66 });
    await makeUnit({ nombre: 'NoCoords' }); // lat/lon NULL → excluded from map

    seedMission('creada', 1, 1);
    seedMission('en_ruta', 2, 2);
    seedMission('completada', 3, 3); // excluded
    seedMission('cancelada', 1, 4);  // excluded

    const r = await call(app, 'GET', '/api/flota/tablero/mapa', env);
    expect(r.status).toBe(200);

    expect(r.json.unidades.length).toBe(1);
    expect(r.json.unidades[0].nombre).toBe('OnMap');

    expect(r.json.misiones_activas.length).toBe(2);
    const estados = r.json.misiones_activas.map((m: any) => m.estado).sort();
    expect(estados).toEqual(['creada', 'en_ruta']);
  });
});
