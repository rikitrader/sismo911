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
// localizado_nota present only when SISMO911's operator-confirm flow recorded it.
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

  it('counts completed consults + ONLY platform-located persons (localizado + nota)', async () => {
    const { db, app, env } = setup();
    // verified, platform-facilitated help:
    addConsult(db, 'c1', 'completed');
    addConsult(db, 'c2', 'completed');
    addPersona(db, 'p1', 'localizado', 'Reunida con su familia en La Guaira'); // counts
    addPersona(db, 'p2', 'localizado', 'Localizada en hospital');             // counts
    // NOT SISMO911 outcomes (must be excluded):
    addConsult(db, 'c3', 'open');
    addConsult(db, 'c4', 'cancelled');
    addPersona(db, 'pi1', 'aparecido');               // imported historical status
    addPersona(db, 'pi2', 'hospitalizado');           // imported historical status
    addPersona(db, 'pi3', 'localizado', null);        // localizado WITHOUT a platform note → imported
    addPersona(db, 'pi4', 'localizado', '');          // empty note → not a real platform record
    addPersona(db, 'pi5', 'sin-contacto');
    addPersona(db, 'pi6', 'fallecido');
    const j = await get(app, env);
    expect(j.breakdown).toEqual({ medical_consults: 2, persons_located_safe: 2 });
    expect(j.total).toBe(4);
  });

  it('the imported registry NEVER inflates the metric (anti-fabrication guard)', async () => {
    const { db, app, env } = setup();
    // simulate a large imported registry — none of these are SISMO911 outcomes
    for (let i = 0; i < 50; i++) addPersona(db, 'imp' + i, i % 2 ? 'aparecido' : 'hospitalizado');
    addPersona(db, 'impL', 'localizado', null); // imported localizado, no platform note
    expect((await get(app, env)).total).toBe(0); // stays 0 → UI shows "—"
    // one REAL platform location appears → counts exactly 1
    addPersona(db, 'real1', 'localizado', 'Confirmada por operador');
    expect((await get(app, env)).total).toBe(1);
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
