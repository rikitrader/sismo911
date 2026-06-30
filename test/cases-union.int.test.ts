import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { persons } from '../src/routes/persons';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

// Regression guard for the hospital registry → /casos union (single source of truth).
// Asserts: the registry federates under the right filters, matched people aren't
// double-counted, desconocido stays out, banner==pager, and hosp- detail resolves.

const ALL_MIGRATIONS = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort().map((f) => 'migrations/' + f);

let db: D1Mock;
let env: TestEnv;
const app = mount([['/api/persons', persons]]);

const now = 1_700_000_000_000;
function seedPerson(id: string, status: string) {
  db.raw.prepare(`INSERT INTO persons (id, full_name, status, review, created_ms, updated_ms) VALUES (?,?,?,?,?,?)`)
    .run(id, 'CASE ' + id, status, 'approved', now, now);
}
function seedHosp(id: string, estado: string, matchedPerson: string | null) {
  db.raw.prepare(
    `INSERT INTO hospital_patients (id, dedupe_key, full_name, norm_name, estado, cedula, observaciones, hospital, matched_person_id, match_confidence, source, conflict, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, 'k:' + id, 'PACIENTE ' + id, 'paciente ' + id, estado, '', 'Internado', 'Hospital Test', matchedPerson, matchedPerson ? 'low' : 'none', 'registro-maestro', 0, now, now);
}

beforeEach(() => {
  db = makeDb(ALL_MIGRATIONS);
  env = makeEnv(db) as TestEnv;
  seedPerson('p1', 'missing');                 // a missing case, cross-linked below
  seedHosp('hp_u_h', 'hospitalizado', null);    // unmatched hospitalizado → hosp- case
  seedHosp('hp_u_a', 'alta', null);             // unmatched alta → found_safe
  seedHosp('hp_u_f', 'fallecido', null);        // unmatched fallecido → found_deceased
  seedHosp('hp_m_h', 'hospitalizado', 'p1');    // matched → shows via p1, NOT as hosp-
  seedHosp('hp_desc', 'desconocido', null);     // unknown status → never federated
});

const ids = async (qs: string) => {
  const { json } = await call(app, 'GET', '/api/persons/cases?' + qs, env);
  return { ids: (json.cases || []).map((c: any) => c.id), total: json.total, summary: json.summary };
};

describe('hospital registry → /casos union', () => {
  it('hospitalizado filter: unmatched hosp- case + the cross-linked real case, no double-count, no desconocido', async () => {
    const { ids: r } = await ids('status=hospitalizado&limit=500');
    expect(r).toContain('hosp-hp_u_h');     // unmatched registry row federated
    expect(r).toContain('p1');              // matched person surfaces via its real expediente
    expect(r).not.toContain('hosp-hp_m_h'); // matched registry row NOT double-counted
    expect(r).not.toContain('hosp-hp_desc');// unknown status never appears
  });

  it('alta → found_safe and fallecido → found_deceased federate', async () => {
    expect((await ids('status=found_safe&limit=500')).ids).toContain('hosp-hp_u_a');
    expect((await ids('status=found_deceased&limit=500')).ids).toContain('hosp-hp_u_f');
  });

  it('default view: desconocido excluded and banner total == pager total', async () => {
    const { ids: r, total, summary } = await ids('limit=500');
    expect(r).not.toContain('hosp-hp_desc');
    expect(summary.total).toBe(total);                 // consistency invariant
    expect(summary.hospitalized).toBe(2);              // both hospitalizado rows counted in the KPI
  });

  it('hosp- detail resolves to the registry row with its hospital comment', async () => {
    const { json } = await call(app, 'GET', '/api/persons/hosp-hp_u_h/docket', env);
    expect(json.person.status).toBe('hospitalizado');
    expect(json.person.notes).toContain('Registro Maestro');
    expect(json.hospital).toBe(true);
  });
});
