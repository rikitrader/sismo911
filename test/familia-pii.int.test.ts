import { describe, it, expect, beforeEach } from 'vitest';
import { familia } from '../src/routes/familia';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Regression for the open-route-audit finding: GET /api/familia/person/:id leaked
// the reporter's contact phone (PII) to anonymous callers in the personas branch.
// It must be redacted for non-operators (matching mapPerson + the per_ branch).

let db: D1Mock;
let env: TestEnv;
const app = mount([['/api/familia', familia]]);

beforeEach(() => {
  db = makeDb();
  env = makeEnv(db);
  db.raw.exec(
    `CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, nombre TEXT, edad INTEGER,
       ubicacion TEXT, fecha TEXT, descripcion TEXT, contacto TEXT, estado TEXT, foto TEXT,
       foto_r2 TEXT, localizado_por TEXT, updated_at INTEGER, moderation TEXT)`,
  );
  db.raw.prepare(
    `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, estado, moderation)
     VALUES ('p1','Juan Pérez',30,'Caracas','visto por última vez...','0414-1234567','desaparecido','approved')`,
  ).run();
});

describe('familia PII — reporter contact is operator-only', () => {
  it('an anonymous detail read returns the person but REDACTS the reporter phone', async () => {
    const r = await call(app, 'GET', '/api/familia/person/p1', env);
    expect(r.status).toBe(200);
    expect(r.json.full_name).toBe('Juan Pérez'); // public fields still present
    expect(r.json.reporter).toBeNull();           // PII NOT leaked to anonymous callers
    // belt-and-suspenders: the raw phone must not appear anywhere in the payload
    expect(JSON.stringify(r.json)).not.toContain('0414-1234567');
  });
});
