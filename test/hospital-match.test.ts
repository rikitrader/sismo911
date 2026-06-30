import { describe, it, expect } from 'vitest';
import { makeDb, makeEnv } from './helpers/d1';
import { drainHospitalRegistryMatch } from '../src/ingest/hospital-registry-match';
import { mapSheetRows } from '../src/lib/hospital-ingest';
import { upsertHospitalRows } from '../src/lib/hospital-ingest';

function env() {
  const db = makeDb(['migrations/0083_hospital_patients.sql']);
  db.raw.exec(`
    CREATE TABLE personas (id TEXT PRIMARY KEY, nombre TEXT, estado TEXT DEFAULT 'sin-contacto', moderation TEXT DEFAULT 'approved', updated_at INTEGER);
    CREATE TABLE persons (id TEXT PRIMARY KEY, full_name TEXT, status TEXT DEFAULT 'missing', review TEXT DEFAULT 'approved', updated_ms INTEGER);
    CREATE TABLE person_events (id TEXT PRIMARY KEY, person_id TEXT, kind TEXT, status_from TEXT, status_to TEXT, detail TEXT, source TEXT, review TEXT, created_ms INTEGER);
    CREATE TABLE case_identity (id TEXT PRIMARY KEY, person_id TEXT, cedula TEXT, result TEXT);
    CREATE TABLE agent_activity (id TEXT PRIMARY KEY, source TEXT, action TEXT, fetched INT, created INT, updated INT, matched INT, still_missing INT, still_unique INT, summary TEXT, ok INT, created_ms INT);
  `);
  const e: any = makeEnv(db);
  return { db, e };
}

describe('mapSheetRows', () => {
  it('finds the header dynamically and maps data rows', () => {
    const rows = [
      ['REGISTRO MAESTRO'], ['Actualizado: 30JUN26 00:40h'], ['aviso'],
      ['N°', 'HOSPITAL', 'APELLIDOS Y NOMBRES', 'EDAD', 'CÉDULA / ID', 'TELÉFONO', 'DIRECCIÓN', 'OBSERVACIONES'],
      ['1', 'H Vargas', 'PEREZ JUAN', '40', '111', '', '', 'Internado'],
      ['2', '', '', '', '', '', '', ''],   // blank name → skipped
    ];
    const { source_updated, patients } = mapSheetRows(rows);
    expect(source_updated).toBe('30JUN26 00:40h');
    expect(patients).toHaveLength(1);
    expect(patients[0].nombre).toBe('PEREZ JUAN');
    expect(patients[0].observaciones).toBe('Internado');
  });

  it('maps cédula to the CÉDULA column — not "apellIDos" (real header)', () => {
    const rows = [
      ['REGISTRO MAESTRO'], ['Actualizado: 30JUN26 00:40h'], ['aviso'],
      ['N°', 'HOSPITAL', 'APELLIDOS Y NOMBRES', 'EDAD', 'CÉDULA / ID', 'TELÉFONO', 'DIRECCIÓN', 'OBSERVACIONES'],
      ['1', 'H Domingo Luciani', 'ABELLO MATILDE / ABELLO WILMARI', '36', '18134813', '0412', 'Petare', 'Fallecida | CONFLICTO'],
    ];
    const { patients } = mapSheetRows(rows);
    expect(patients).toHaveLength(1);
    expect(patients[0].nombre).toBe('ABELLO MATILDE / ABELLO WILMARI');
    expect(patients[0].cedula).toBe('18134813');   // NOT the name
    expect(patients[0].telefono).toBe('0412');
    expect(patients[0].direccion).toBe('Petare');
    expect(patients[0].observaciones).toContain('Fallecida');
  });
});

describe('hospital-registry match cron (hybrid: name→pending, cédula→auto-status)', () => {
  it('name-only match links + adds a PENDING tracer, status UNCHANGED', async () => {
    const { db, e } = env();
    await upsertHospitalRows(e, [{ hospital: 'H Vargas', nombre: 'JUAN PEREZ', cedula: '', observaciones: 'Internado' }], 't');
    db.raw.prepare(`INSERT INTO personas (id,nombre,estado) VALUES ('p1','JUAN PEREZ','sin-contacto')`).run();
    const r = await drainHospitalRegistryMatch(e, { pages: 2 });
    expect(r.matched).toBe(1);
    const hp: any = db.raw.prepare(`SELECT matched_persona_id, match_confidence FROM hospital_patients`).get();
    expect(hp.matched_persona_id).toBe('p1'); expect(hp.match_confidence).toBe('low');
    const ev: any = db.raw.prepare(`SELECT kind, review FROM person_events WHERE person_id='fam-p1'`).get();
    expect(ev.kind).toBe('hospital'); expect(ev.review).toBe('pending');
    const per: any = db.raw.prepare(`SELECT estado FROM personas WHERE id='p1'`).get();
    expect(per.estado).toBe('sin-contacto');     // NOT auto-flipped on a name-only match
  });

  it('cédula-confirmed match auto-flips status + writes a status_change tracer', async () => {
    const { db, e } = env();
    await upsertHospitalRows(e, [{ hospital: 'H Luciani', nombre: 'MARIA LOPEZ', cedula: '22222222', observaciones: 'Internado' }], 't');
    db.raw.prepare(`INSERT INTO personas (id,nombre,estado) VALUES ('p2','MARIA LOPEZ','sin-contacto')`).run();
    db.raw.prepare(`INSERT INTO case_identity (id,person_id,cedula,result) VALUES ('i1','fam-p2','22222222','match')`).run();
    await drainHospitalRegistryMatch(e, { pages: 2 });
    const per: any = db.raw.prepare(`SELECT estado FROM personas WHERE id='p2'`).get();
    expect(per.estado).toBe('hospitalizado');     // auto-flipped (cédula confirmed)
    const ev: any = db.raw.prepare(`SELECT kind, status_to, review FROM person_events WHERE person_id='fam-p2'`).get();
    expect(ev.kind).toBe('status_change'); expect(ev.status_to).toBe('hospitalizado'); expect(ev.review).toBe('approved');
    const hp: any = db.raw.prepare(`SELECT match_confidence, match_kind FROM hospital_patients`).get();
    expect(hp.match_confidence).toBe('high'); expect(hp.match_kind).toBe('cedula');
  });
});
