import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { impact } from '../src/routes/impact';

// "Personas ayudadas" must ALWAYS be derived from records SISMO911 itself produced
// — never a hardcoded constant and never the IMPORTED personas registry (whose
// estado/localizado_nota were backfilled by an external import, not by SISMO911).
const MIGRATIONS = ['migrations/0012_personas_registry.sql', 'migrations/0028_telemedicine.sql'];

function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/impact', impact);
  return { db, env, app };
}
const get = async (app: Hono, env: any) =>
  (await (await app.request('/api/impact/personas-ayudadas', {}, env)).json()) as any;

const addConsult = (db: D1Mock, id: string, status: string) =>
  db.raw.prepare(`INSERT INTO telemed_requests (id, patient_name, status) VALUES (?,?,?)`).run(id, 'Paciente', status);
const addPersona = (db: D1Mock, id: string, estado: string, nota: string | null = null) =>
  db.raw.prepare(`INSERT INTO personas (id, estado, localizado_nota) VALUES (?,?,?)`).run(id, estado, nota);

describe('GET /api/impact/personas-ayudadas — real, auditable, never fake', () => {
  it('returns total 0 (→ UI shows "—") when there is NO verified data', async () => {
    const { app, env } = setup();
    const j = await get(app, env);
    expect(j.ok).toBe(true);
    expect(j.total).toBe(0);
    expect(j.breakdown).toEqual({ medical_consults: 0, persons_located_safe: 0 });
  });

  it('counts ONLY completed telemedicine consultations', async () => {
    const { db, app, env } = setup();
    addConsult(db, 'c1', 'completed');
    addConsult(db, 'c2', 'completed');
    addConsult(db, 'c3', 'open');       // excluded
    addConsult(db, 'c4', 'cancelled');  // excluded
    addConsult(db, 'c5', 'scheduled');  // excluded
    const j = await get(app, env);
    expect(j.breakdown.medical_consults).toBe(2);
    expect(j.total).toBe(2);
  });

  it('the IMPORTED personas registry can NEVER inflate the metric (anti-fabrication)', async () => {
    const { db, app, env } = setup();
    // a large imported registry with every "positive" status + backfilled notes
    for (let i = 0; i < 100; i++) {
      addPersona(db, 'imp' + i, ['aparecido', 'localizado', 'hospitalizado'][i % 3], 'nota importada');
    }
    expect((await get(app, env)).total).toBe(0); // NONE of it counts → UI "—"
    expect((await get(app, env)).breakdown.persons_located_safe).toBe(0);
    // only a real SISMO911 outcome moves the needle:
    addConsult(db, 'c1', 'completed');
    expect((await get(app, env)).total).toBe(1);
  });

  it('the value tracks real platform rows (data-derived, not a constant)', async () => {
    const { db, app, env } = setup();
    expect((await get(app, env)).total).toBe(0);
    addConsult(db, 'c1', 'completed');
    expect((await get(app, env)).total).toBe(1);
    addConsult(db, 'c2', 'completed');
    expect((await get(app, env)).total).toBe(2);
  });

  it('is public (no auth required) and exposes its definition for auditability', async () => {
    const { app, env } = setup();
    const r = await app.request('/api/impact/personas-ayudadas', {}, env);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(typeof j.definition).toBe('string');
    expect(j.definition.length).toBeGreaterThan(40);
    expect(j.as_of).toBeGreaterThan(0);
  });
});
