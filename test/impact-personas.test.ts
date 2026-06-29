import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { impact } from '../src/routes/impact';

// "Personas ayudadas" must ALWAYS be derived from real records — never a hardcoded
// demo/constant. These tests assert: 0 when no verified data, exact counts when
// real rows exist, and that EXCLUDED statuses (cancelled/open/fallecido/
// sin-contacto/planning estimates) never inflate it.
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
const addPersona = (db: D1Mock, id: string, estado: string) =>
  db.raw.prepare(`INSERT INTO personas (id, estado) VALUES (?,?)`).run(id, estado);

describe('GET /api/impact/personas-ayudadas — real, auditable, never fake', () => {
  it('returns total 0 (→ UI shows "—") when there is NO verified data', async () => {
    const { app, env } = setup();
    const j = await get(app, env);
    expect(j.ok).toBe(true);
    expect(j.total).toBe(0);
    expect(j.breakdown).toEqual({ medical_consults: 0, persons_located_safe: 0 });
  });

  it('counts ONLY completed consultations + located/found/hospitalized persons', async () => {
    const { db, app, env } = setup();
    // verified help:
    addConsult(db, 'c1', 'completed');
    addConsult(db, 'c2', 'completed');
    addPersona(db, 'p1', 'aparecido');
    addPersona(db, 'p2', 'localizado');
    addPersona(db, 'p3', 'hospitalizado');
    // NOT help (must be excluded):
    addConsult(db, 'c3', 'open');
    addConsult(db, 'c4', 'cancelled');
    addConsult(db, 'c5', 'scheduled');
    addPersona(db, 'p4', 'sin-contacto');
    addPersona(db, 'p5', 'fallecido');
    const j = await get(app, env);
    expect(j.breakdown).toEqual({ medical_consults: 2, persons_located_safe: 3 });
    expect(j.total).toBe(5);
  });

  it('the value tracks real rows (data-derived, not a constant)', async () => {
    const { db, app, env } = setup();
    expect((await get(app, env)).total).toBe(0);
    addPersona(db, 'p1', 'aparecido');
    expect((await get(app, env)).total).toBe(1);
    addConsult(db, 'c1', 'completed');
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
