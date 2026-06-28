import { describe, it, expect, beforeEach } from 'vitest';
import { flotaUnidades } from '../src/routes/flota-unidades';
import { flotaMisiones } from '../src/routes/flota-misiones';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Integration tests for the MISIONES dispatch route — the full mission
// lifecycle exercised against a real in-memory SQLite via the D1 adapter.
// Routes are mounted on a bare Hono app (the global auth gate is verified
// elsewhere), so writes here need no auth/cookies.

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/flota/unidades', flotaUnidades],
  ['/api/flota/misiones', flotaMisiones],
]);

beforeEach(() => {
  db = makeDb(['migrations/0037_flota.sql', 'migrations/0038_flota_unit_tokens.sql']);
  env = makeEnv(db);
});

async function makeUnit(estado_op = 'disponible') {
  const r = await call(app, 'POST', '/api/flota/unidades', env, { nombre: 'U1', tipo: 'ambulancia', estado_op });
  return r.json.id as string;
}
async function makeMission(body: Record<string, unknown> = { tipo: 'rescate', descripcion: 'X' }) {
  const r = await call(app, 'POST', '/api/flota/misiones', env, body);
  return r.json.id as string;
}

// ── Create ──────────────────────────────────────────────────────────────────
describe('POST / create', () => {
  it('creates a mission with codigo MIS-*, estado creada, and an initial actividad row', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, { tipo: 'rescate', descripcion: 'Colapso edificio' });
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.estado).toBe('creada');
    expect(typeof r.json.id).toBe('string');
    expect(r.json.codigo).toMatch(/^MIS-[0-9A-F]{8}$/);

    const row = db.raw.prepare('SELECT * FROM flota_misiones WHERE id=?').get(r.json.id) as any;
    expect(row.estado).toBe('creada');
    expect(row.tipo).toBe('rescate');
    expect(row.prioridad).toBe(3); // default
    expect(row.despachada_ms).toBeNull();

    const act = db.raw.prepare('SELECT * FROM flota_mision_actividad WHERE mision_id=?').all(r.json.id) as any[];
    expect(act.length).toBe(1);
    expect(act[0].estado).toBe('creada');
  });

  it('defaults tipo to rescate when omitted', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, { descripcion: 'sin tipo' });
    expect(r.status).toBe(201);
    const row = db.raw.prepare('SELECT tipo FROM flota_misiones WHERE id=?').get(r.json.id) as any;
    expect(row.tipo).toBe('rescate');
  });

  it('inserts provided waypoints (filtered to those with lat+lon, seq 1..n)', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, {
      tipo: 'evacuacion',
      descripcion: 'ruta',
      waypoints: [
        { lat: 10, lon: -66, direccion: 'A' },
        { lat: 11, lon: -67, direccion: 'B' },
        { lat: null, lon: -67, direccion: 'descartado' }, // dropped (no lat)
      ],
    });
    expect(r.status).toBe(201);
    const wp = db.raw.prepare('SELECT * FROM flota_mision_waypoints WHERE mision_id=? ORDER BY seq').all(r.json.id) as any[];
    expect(wp.length).toBe(2);
    expect(wp[0].seq).toBe(1);
    expect(wp[1].seq).toBe(2);
    expect(wp[0].estado).toBe('pendiente');
    expect(wp[0].direccion).toBe('A');
  });

  it('honors a valid prioridad', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, { tipo: 'medico', descripcion: 'x', prioridad: 1 });
    const row = db.raw.prepare('SELECT prioridad FROM flota_misiones WHERE id=?').get(r.json.id) as any;
    expect(row.prioridad).toBe(1);
  });

  it('400 when descripcion is missing', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, { tipo: 'rescate' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('descripcion requerida');
  });

  it('400 when tipo is invalid', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, { tipo: 'no_existe', descripcion: 'x' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('tipo inválido');
  });

  it('400 when origen coordinates are present but out of range', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones', env, { descripcion: 'x', origen_lat: 999, origen_lon: 0 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('bad_origen_lat_lon');
  });
});

// ── Detail ──────────────────────────────────────────────────────────────────
describe('GET /:id detail', () => {
  it('returns mission + ordered waypoints + newest-first actividad, with meta parsed', async () => {
    const id = await makeMission({
      tipo: 'rescate',
      descripcion: 'x',
      meta: { foo: 'bar', n: 7 },
      waypoints: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }],
    });
    // dispatch + advance to generate multiple actividad rows
    const unit = await makeUnit();
    await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit });
    await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'en_ruta' });

    const r = await call(app, 'GET', `/api/flota/misiones/${id}`, env);
    expect(r.status).toBe(200);
    expect(r.json.mision.id).toBe(id);
    expect(r.json.mision.meta).toEqual({ foo: 'bar', n: 7 }); // parsed from JSON string

    expect(r.json.waypoints.map((w: any) => w.seq)).toEqual([1, 2]);

    // ordered newest-first by created_ms (DESC) — verify non-increasing order
    // and that all three lifecycle entries are present (ms ties make the exact
    // head ambiguous, so assert the ordering invariant + the set).
    const times = r.json.actividad.map((a: any) => a.created_ms);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    expect(r.json.actividad.map((a: any) => a.estado).sort()).toEqual(['creada', 'despachada', 'en_ruta']);
  });

  it('404 for an unknown id', async () => {
    const r = await call(app, 'GET', '/api/flota/misiones/nope', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

// ── List + filters ───────────────────────────────────────────────────────────
describe('GET / list with filters', () => {
  beforeEach(async () => {
    await makeMission({ tipo: 'rescate', descripcion: 'a', prioridad: 1, evento_id: 'evt1' });
    await makeMission({ tipo: 'medico', descripcion: 'b', prioridad: 2, evento_id: 'evt2' });
    await makeMission({ tipo: 'rescate', descripcion: 'c', prioridad: 2, evento_id: 'evt2' });
  });

  it('lists all without filters', async () => {
    const r = await call(app, 'GET', '/api/flota/misiones', env);
    expect(r.status).toBe(200);
    expect(r.json.results.length).toBe(3);
  });

  it('filters by tipo', async () => {
    const r = await call(app, 'GET', '/api/flota/misiones?tipo=rescate', env);
    expect(r.json.results.length).toBe(2);
    expect(r.json.results.every((m: any) => m.tipo === 'rescate')).toBe(true);
  });

  it('filters by estado', async () => {
    const r = await call(app, 'GET', '/api/flota/misiones?estado=creada', env);
    expect(r.json.results.length).toBe(3);
    const r2 = await call(app, 'GET', '/api/flota/misiones?estado=completada', env);
    expect(r2.json.results.length).toBe(0);
  });

  it('filters by evento_id', async () => {
    const r = await call(app, 'GET', '/api/flota/misiones?evento_id=evt2', env);
    expect(r.json.results.length).toBe(2);
  });

  it('filters by prioridad', async () => {
    const r = await call(app, 'GET', '/api/flota/misiones?prioridad=2', env);
    expect(r.json.results.length).toBe(2);
    expect(r.json.results.every((m: any) => m.prioridad === 2)).toBe(true);
  });
});

// ── Patch ────────────────────────────────────────────────────────────────────
describe('PATCH /:id', () => {
  it('updates editable fields and bumps updated_ms', async () => {
    const id = await makeMission();
    db.raw.prepare('UPDATE flota_misiones SET updated_ms=1000 WHERE id=?').run(id);

    const r = await call(app, 'PATCH', `/api/flota/misiones/${id}`, env, { prioridad: 5, descripcion: 'nueva' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const row = db.raw.prepare('SELECT prioridad, descripcion, updated_ms FROM flota_misiones WHERE id=?').get(id) as any;
    expect(row.prioridad).toBe(5);
    expect(row.descripcion).toBe('nueva');
    expect(row.updated_ms).toBeGreaterThan(1000);
  });

  it('400 on invalid prioridad', async () => {
    const id = await makeMission();
    const r = await call(app, 'PATCH', `/api/flota/misiones/${id}`, env, { prioridad: 9 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('prioridad inválida');
  });

  it('400 when nothing to update', async () => {
    const id = await makeMission();
    const r = await call(app, 'PATCH', `/api/flota/misiones/${id}`, env, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nada que actualizar');
  });

  it('404 for unknown id', async () => {
    const r = await call(app, 'PATCH', '/api/flota/misiones/nope', env, { prioridad: 2 });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

// ── Despachar ────────────────────────────────────────────────────────────────
describe('POST /:id/despachar', () => {
  it('dispatches a creada mission: estado despachada, despachada_ms set, unit en_mision, actividad logged', async () => {
    const unit = await makeUnit();
    const id = await makeMission();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit, personal_id: 'p1' });
    expect(r.status).toBe(200);
    expect(r.json.estado).toBe('despachada');
    expect(r.json.unidad_id).toBe(unit);

    const row = db.raw.prepare('SELECT estado, unidad_id, personal_id, despachada_ms FROM flota_misiones WHERE id=?').get(id) as any;
    expect(row.estado).toBe('despachada');
    expect(row.unidad_id).toBe(unit);
    expect(row.personal_id).toBe('p1');
    expect(row.despachada_ms).toBeTypeOf('number');

    const u = db.raw.prepare('SELECT estado_op FROM flota_unidades WHERE id=?').get(unit) as any;
    expect(u.estado_op).toBe('en_mision');

    const act = db.raw.prepare("SELECT COUNT(*) n FROM flota_mision_actividad WHERE mision_id=? AND estado='despachada'").get(id) as any;
    expect(act.n).toBe(1);
  });

  it('400 when unidad_id is missing', async () => {
    const id = await makeMission();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unidad_id requerido');
  });

  it('404 when mission does not exist', async () => {
    const unit = await makeUnit();
    const r = await call(app, 'POST', '/api/flota/misiones/nope/despachar', env, { unidad_id: unit });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });

  it('409 transicion_invalida when mission is not in creada state', async () => {
    const unit = await makeUnit();
    const id = await makeMission();
    await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit });
    // already despachada → cannot dispatch again
    const unit2 = await makeUnit();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit2 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('transicion_invalida');
  });

  it('404 unidad_no_encontrada when the unit does not exist', async () => {
    const id = await makeMission();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: 'ghost' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('unidad_no_encontrada');
  });

  it('409 unidad_no_disponible when the unit is not disponible', async () => {
    const unit = await makeUnit('mantenimiento');
    const id = await makeMission();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('unidad_no_disponible');
    expect(r.json.estado_op).toBe('mantenimiento');
  });
});

// ── Estado transitions ───────────────────────────────────────────────────────
describe('POST /:id/estado', () => {
  async function dispatched() {
    const unit = await makeUnit();
    const id = await makeMission();
    await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit });
    return { unit, id };
  }

  it('advances one valid step at a time and logs actividad each time', async () => {
    const { id } = await dispatched();
    for (const estado of ['en_ruta', 'en_sitio', 'completada']) {
      const r = await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado });
      expect(r.status).toBe(200);
      expect(r.json.mision.estado).toBe(estado);
    }
    const row = db.raw.prepare('SELECT estado, completada_ms FROM flota_misiones WHERE id=?').get(id) as any;
    expect(row.estado).toBe('completada');
    expect(row.completada_ms).toBeTypeOf('number');

    // creada + despachada + en_ruta + en_sitio + completada = 5 actividad rows
    const act = db.raw.prepare('SELECT COUNT(*) n FROM flota_mision_actividad WHERE mision_id=?').get(id) as any;
    expect(act.n).toBe(5);
  });

  it('409 transicion_invalida when skipping a step', async () => {
    const { id } = await dispatched();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'en_sitio' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('transicion_invalida');
  });

  it('409 transicion_invalida when going backwards', async () => {
    const { id } = await dispatched();
    await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'en_ruta' });
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'cancelada' });
    expect(r.status).toBe(200); // cancel allowed from non-terminal
    // now terminal; any further transition fails
    const r2 = await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'en_sitio' });
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe('transicion_invalida');
  });

  it('400 estado inválido when setting despachada via /estado', async () => {
    const { id } = await dispatched();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'despachada' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado inválido');
  });

  it('400 estado inválido for an unknown estado', async () => {
    const { id } = await dispatched();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'volando' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado inválido');
  });

  it('404 for an unknown mission', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones/nope/estado', env, { estado: 'en_ruta' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });

  it('frees the assigned unit back to disponible on completada', async () => {
    const { unit, id } = await dispatched();
    await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'en_ruta' });
    await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'en_sitio' });
    await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'completada' });
    const u = db.raw.prepare('SELECT estado_op FROM flota_unidades WHERE id=?').get(unit) as any;
    expect(u.estado_op).toBe('disponible');
  });

  it('frees the assigned unit back to disponible on cancelada', async () => {
    const { unit, id } = await dispatched();
    await call(app, 'POST', `/api/flota/misiones/${id}/estado`, env, { estado: 'cancelada' });
    const u = db.raw.prepare('SELECT estado_op FROM flota_unidades WHERE id=?').get(unit) as any;
    expect(u.estado_op).toBe('disponible');
  });
});

// ── Waypoints ────────────────────────────────────────────────────────────────
describe('waypoints', () => {
  it('POST /:id/waypoints appends with incrementing seq', async () => {
    const id = await makeMission({ tipo: 'rescate', descripcion: 'x', waypoints: [{ lat: 1, lon: 2 }] });
    const a = await call(app, 'POST', `/api/flota/misiones/${id}/waypoints`, env, { lat: 3, lon: 4, direccion: 'Z' });
    expect(a.status).toBe(201);
    expect(a.json.seq).toBe(2);
    const b = await call(app, 'POST', `/api/flota/misiones/${id}/waypoints`, env, { lat: 5, lon: 6 });
    expect(b.json.seq).toBe(3);

    const wp = db.raw.prepare('SELECT COUNT(*) n FROM flota_mision_waypoints WHERE mision_id=?').get(id) as any;
    expect(wp.n).toBe(3);
  });

  it('POST /:id/waypoints 400 when lat/lon missing', async () => {
    const id = await makeMission();
    const r = await call(app, 'POST', `/api/flota/misiones/${id}/waypoints`, env, { direccion: 'no coords' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('lat y lon requeridos');
  });

  it('POST /:id/waypoints 404 for unknown mission', async () => {
    const r = await call(app, 'POST', '/api/flota/misiones/nope/waypoints', env, { lat: 1, lon: 2 });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });

  it('PATCH /:id/waypoints/:wpId updates estado (valid)', async () => {
    const id = await makeMission({ tipo: 'rescate', descripcion: 'x', waypoints: [{ lat: 1, lon: 2 }] });
    const wpId = (db.raw.prepare('SELECT id FROM flota_mision_waypoints WHERE mision_id=?').get(id) as any).id;
    const r = await call(app, 'PATCH', `/api/flota/misiones/${id}/waypoints/${wpId}`, env, { estado: 'llegada' });
    expect(r.status).toBe(200);
    expect(r.json.estado).toBe('llegada');
    const row = db.raw.prepare('SELECT estado FROM flota_mision_waypoints WHERE id=?').get(wpId) as any;
    expect(row.estado).toBe('llegada');
  });

  it('PATCH /:id/waypoints/:wpId 400 on invalid estado', async () => {
    const id = await makeMission({ tipo: 'rescate', descripcion: 'x', waypoints: [{ lat: 1, lon: 2 }] });
    const wpId = (db.raw.prepare('SELECT id FROM flota_mision_waypoints WHERE mision_id=?').get(id) as any).id;
    const r = await call(app, 'PATCH', `/api/flota/misiones/${id}/waypoints/${wpId}`, env, { estado: 'foo' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('estado inválido');
  });

  it('PATCH /:id/waypoints/:wpId 404 for unknown waypoint', async () => {
    const id = await makeMission();
    const r = await call(app, 'PATCH', `/api/flota/misiones/${id}/waypoints/ghost`, env, { estado: 'llegada' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────
describe('DELETE /:id', () => {
  it('cascades waypoints + actividad and frees the assigned unit', async () => {
    const unit = await makeUnit();
    const id = await makeMission({ tipo: 'rescate', descripcion: 'x', waypoints: [{ lat: 1, lon: 2 }] });
    await call(app, 'POST', `/api/flota/misiones/${id}/despachar`, env, { unidad_id: unit });

    const r = await call(app, 'DELETE', `/api/flota/misiones/${id}`, env);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const m = db.raw.prepare('SELECT COUNT(*) n FROM flota_misiones WHERE id=?').get(id) as any;
    const wp = db.raw.prepare('SELECT COUNT(*) n FROM flota_mision_waypoints WHERE mision_id=?').get(id) as any;
    const act = db.raw.prepare('SELECT COUNT(*) n FROM flota_mision_actividad WHERE mision_id=?').get(id) as any;
    expect(m.n).toBe(0);
    expect(wp.n).toBe(0);
    expect(act.n).toBe(0);

    const u = db.raw.prepare('SELECT estado_op FROM flota_unidades WHERE id=?').get(unit) as any;
    expect(u.estado_op).toBe('disponible');
  });

  it('404 for unknown mission', async () => {
    const r = await call(app, 'DELETE', '/api/flota/misiones/nope', env);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no encontrado');
  });
});
