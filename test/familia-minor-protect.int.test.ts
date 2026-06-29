import { describe, it, expect, beforeEach } from 'vitest';
import { familia } from '../src/routes/familia';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Minor-protection gate, exercised through the REAL /api/familia handlers + SQL
// for an anonymous (public) caller. A still-missing minor stays findable but with
// a locality-only last-seen; a RESOLVED minor and an operator-protected case are
// suppressed (404 / dropped from the list); adults are unaffected.

let db: D1Mock;
let env: TestEnv;
const app = mount([['/api/familia', familia]]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
  db.raw.exec(
    `CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, nombre TEXT, edad INTEGER,
       ubicacion TEXT, fecha TEXT, descripcion TEXT, contacto TEXT, estado TEXT, foto TEXT,
       foto_r2 TEXT, localizado_por TEXT, created_at INTEGER, updated_at INTEGER, moderation TEXT,
       protected INTEGER NOT NULL DEFAULT 0)`,
  );
  const ins = (id: string, nombre: string, edad: number, estado: string, prot = 0) =>
    db.raw.prepare(
      `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, estado, moderation, protected, created_at, updated_at)
       VALUES (?,?,?,'Av. Sucre, Catia, Caracas','Cabello negro, vive en Av. Sucre #5','0414-1234567',?, 'approved', ?, 1000, 1000)`,
    ).run(id, nombre, edad, estado, prot);
  ins('kid-missing', 'Niña Desaparecida', 10, 'desaparecido');
  ins('kid-found', 'Niño Localizado', 10, 'localizado');
  ins('kid-protected', 'Menor Protegido', 12, 'desaparecido', 1);
  ins('adult-missing', 'Adulto Desaparecido', 40, 'desaparecido');
  ins('adult-found', 'Adulto Localizado', 40, 'localizado');
});

describe('minor-protect — public detail (/api/familia/person/:id)', () => {
  it('still-missing minor: 200, last-seen coarsened + description house-number scrubbed', async () => {
    const r = await call(app, 'GET', '/api/familia/person/kid-missing', env);
    expect(r.status).toBe(200);
    expect(r.json.last_seen).toBe('Caracas');          // street/sector dropped
    expect(r.json.description).toContain('Cabello negro'); // prose kept
    expect(r.json.description).not.toContain('#5');     // house number redacted
  });
  it('resolved minor: suppressed (404) for the public', async () => {
    const r = await call(app, 'GET', '/api/familia/person/kid-found', env);
    expect(r.status).toBe(404);
  });
  it('operator-protected case: suppressed (404) for the public', async () => {
    const r = await call(app, 'GET', '/api/familia/person/kid-protected', env);
    expect(r.status).toBe(404);
  });
  it('adult is unaffected: full last-seen, resolved adult still visible', async () => {
    const missing = await call(app, 'GET', '/api/familia/person/adult-missing', env);
    expect(missing.status).toBe(200);
    expect(missing.json.last_seen).toBe('Av. Sucre, Catia, Caracas');
    const found = await call(app, 'GET', '/api/familia/person/adult-found', env);
    expect(found.status).toBe(200);
  });
});

describe('minor-protect — public list (/api/familia/persons)', () => {
  it('drops resolved minors and protected cases; keeps missing minor (coarsened) + adults', async () => {
    const r = await call(app, 'GET', '/api/familia/persons', env);
    expect(r.status).toBe(200);
    const ids = r.json.persons.map((p: any) => p.id);
    expect(ids).toContain('kid-missing');
    expect(ids).toContain('adult-missing');
    expect(ids).toContain('adult-found');
    expect(ids).not.toContain('kid-found');      // resolved minor suppressed
    expect(ids).not.toContain('kid-protected');  // operator-protected suppressed
    const kid = r.json.persons.find((p: any) => p.id === 'kid-missing');
    expect(kid.last_seen).toBe('Caracas');
  });
});
