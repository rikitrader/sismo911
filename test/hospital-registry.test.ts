import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normName, cleanCedula, splitNameVariants, parseStatus, dedupeKey, patientToRow,
} from '../src/lib/hospital-registry';
import { parseXlsxRows } from '../src/lib/xlsx-lite';
import { hospital } from '../src/routes/hospital';
import { makeDb, makeEnv, mount } from './helpers/d1';

describe('hospital-registry parsers', () => {
  it('parseStatus reads the REAL status from messy observaciones (no fabrication)', () => {
    expect(parseStatus('Internado | UPT | Ingreso 24/6')).toEqual({ estado: 'hospitalizado', conflict: false });
    expect(parseStatus('Alta médica')).toEqual({ estado: 'alta', conflict: false });
    expect(parseStatus('FALLECIDO | ⚠ ESTADO EN CONFLICTO')).toEqual({ estado: 'fallecido', conflict: true });
    expect(parseStatus('')).toEqual({ estado: 'desconocido', conflict: false });
    // deceased beats an also-present "internado"
    expect(parseStatus('Internado | Fallecida').estado).toBe('fallecido');
  });

  it('splitNameVariants splits "/"-separated spellings and dedups', () => {
    expect(splitNameVariants('PÉREZ ANA / PEREZ ANA / GOMEZ')).toEqual(['PÉREZ ANA', 'GOMEZ']);
  });

  it('cleanCedula keeps only plausible 5–9 digit ids', () => {
    expect(cleanCedula('18.134.813')).toBe('18134813');
    expect(cleanCedula('S/C')).toBe('');
    expect(cleanCedula('123')).toBe('');
  });

  it('dedupeKey prefers cédula, else the normalized name (hospital ignored)', () => {
    expect(dedupeKey('18134813', 'Hosp', 'perez ana')).toBe('c:18134813');
    expect(dedupeKey('', 'Hospital Vargas', 'perez ana')).toBe('n:perez ana');
    // The same person under a hospital-name variant must collapse to ONE key.
    expect(dedupeKey('', 'Hospital Ana Francisca Pérez de León', 'abarca neiulan'))
      .toBe(dedupeKey('', 'Hospital Ana Francisca Pérez de León 2', 'abarca neiulan'));
  });

  it('patientToRow builds a clean row + parses estado', () => {
    const r = patientToRow({ hospital: 'Hospital Vargas', nombre: 'PÉREZ ANA / PEREZ ANA M', edad: '36', cedula: '18134813', observaciones: 'Internado | UPT' })!;
    expect(r.full_name).toBe('PÉREZ ANA');
    expect(r.norm_name).toBe('perez ana');
    expect(r.estado).toBe('hospitalizado');
    expect(r.cedula).toBe('18134813');
    expect(r.dedupe_key).toBe('c:18134813');
    expect(JSON.parse(r.name_variants)).toEqual(['PÉREZ ANA', 'PEREZ ANA M']);
    expect(patientToRow({ nombre: '' })).toBeNull();
  });
});

describe('xlsx-lite reader (same Web-Streams code path as the Worker cron)', () => {
  it('reads the .xlsx fixture into rows incl. accents + "/" names', async () => {
    const buf = readFileSync(new URL('./fixtures/hospital-sample.xlsx', import.meta.url));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const rows = await parseXlsxRows(ab);
    // header is on row index 3 (0-based) in this layout
    expect(rows[3]).toEqual(['N°', 'HOSPITAL', 'APELLIDOS Y NOMBRES', 'EDAD', 'CÉDULA / ID', 'TELÉFONO', 'DIRECCIÓN', 'OBSERVACIONES']);
    expect(rows[4][2]).toBe('PÉREZ ANA / PEREZ ANA M');
    expect(rows[4][4]).toBe('18134813');
    expect(rows[6][7]).toContain('FALLECIDO');
    // gappy row 6 (empty cédula/tel/dir) — obs must NOT be swallowed by the self-closing-cell bug
    expect(rows[5][2]).toBe('GÓMEZ LUIS');
    expect(rows[5][7]).toBe('Alta médica');
    // end-to-end: a parsed data row → clean record
    const r = patientToRow({ hospital: rows[4][1], nombre: rows[4][2], edad: rows[4][3], cedula: rows[4][4], observaciones: rows[4][7] })!;
    expect(r.estado).toBe('hospitalizado');
    expect(normName(r.full_name)).toBe('perez ana');
  });
});

describe('hospital ingest route (catches the upsert / ON CONFLICT partial-index bug)', () => {
  const setup = () => {
    const db = makeDb(['migrations/0083_hospital_patients.sql']);
    const env: any = makeEnv(db); env.RAV_INGEST_TOKEN = 'tok';
    const app = mount([['/api/persons', hospital]]);
    return { db, env, app };
  };
  const post = (app: any, env: any, body: unknown, tok = 'tok') =>
    app.request('/api/persons/hospital/ingest',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }, env);

  it('rejects without the bearer token', async () => {
    const { app, env } = setup();
    const r = await post(app, env, { rows: [] }, 'wrong');
    expect(r.status).toBe(401);
  });

  it('upserts idempotently (re-ingest is an UPDATE, not a 500 or a duplicate)', async () => {
    const { db, env, app } = setup();
    const rows = [
      { hospital: 'Hosp Vargas', nombre: 'PEREZ ANA', edad: '30', cedula: '12345678', observaciones: 'Internado' },
      { hospital: 'Domingo Luciani', nombre: 'GOMEZ LUIS', cedula: '', observaciones: 'Alta' },
    ];
    const r1 = await post(app, env, { rows, source_updated: '30JUN26' });
    expect(r1.status).toBe(200);
    const j1 = await r1.json(); expect(j1.ok).toBe(true);
    // re-ingest the SAME rows (estado changed) → must UPDATE in place (ON CONFLICT)
    const r2 = await post(app, env, { rows: [{ ...rows[0], observaciones: 'Fallecida' }] });
    expect(r2.status).toBe(200);
    const cnt: any = db.raw.prepare(`SELECT COUNT(*) AS n FROM hospital_patients`).get();
    expect(cnt.n).toBe(2);                       // not 3 — upserted, not duplicated
    const ana: any = db.raw.prepare(`SELECT estado FROM hospital_patients WHERE cedula='12345678'`).get();
    expect(ana.estado).toBe('fallecido');         // refreshed
  });

  it('a blank (desconocido) re-ingest never downgrades a known status (sticky upward)', async () => {
    const { db, env, app } = setup();
    // Same person (no cédula → name key) listed once as Internado, once blank.
    await post(app, env, { rows: [{ hospital: 'H', nombre: 'PEDRO HOSPI', observaciones: 'Internado UCI' }] });
    let row: any = db.raw.prepare(`SELECT estado FROM hospital_patients WHERE norm_name='pedro hospi'`).get();
    expect(row.estado).toBe('hospitalizado');
    // Re-ingest the SAME name with a blank cell — must NOT clobber to desconocido.
    await post(app, env, { rows: [{ hospital: 'H', nombre: 'PEDRO HOSPI', observaciones: '' }] });
    row = db.raw.prepare(`SELECT estado FROM hospital_patients WHERE norm_name='pedro hospi'`).get();
    expect(row.estado).toBe('hospitalizado');                 // sticky — not downgraded
    // But a real progression (alta) DOES win over hospitalizado.
    await post(app, env, { rows: [{ hospital: 'H', nombre: 'PEDRO HOSPI', observaciones: 'Alta médica' }] });
    row = db.raw.prepare(`SELECT estado FROM hospital_patients WHERE norm_name='pedro hospi'`).get();
    expect(row.estado).toBe('alta');
  });

  it('search + stats reflect parsed estado', async () => {
    const { env, app } = setup();
    await post(app, env, { rows: [
      { hospital: 'H', nombre: 'MARIA LOPEZ', cedula: '11111111', observaciones: 'Internado UCI' },
      { hospital: 'H', nombre: 'JUAN ALTA', cedula: '22222222', observaciones: 'Alta' },
    ] });
    const s = await (await app.request('/api/persons/hospital/stats', {}, env)).json();
    expect(s.hospitalizado).toBe(1); expect(s.alta).toBe(1); expect(s.total).toBe(2);
    const found = await (await app.request('/api/persons/hospital/search?q=maria', {}, env)).json();
    expect(found.results[0].full_name).toBe('MARIA LOPEZ');
    expect(found.results[0].estado).toBe('hospitalizado');
  });
});
