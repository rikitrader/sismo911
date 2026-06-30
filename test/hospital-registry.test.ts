import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normName, cleanCedula, splitNameVariants, parseStatus, dedupeKey, patientToRow,
} from '../src/lib/hospital-registry';
import { parseXlsxRows } from '../src/lib/xlsx-lite';

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

  it('dedupeKey prefers cédula, else hospital|norm-name', () => {
    expect(dedupeKey('18134813', 'Hosp', 'perez ana')).toBe('c:18134813');
    expect(dedupeKey('', 'Hospital Vargas', 'perez ana')).toBe('n:hospital vargas|perez ana');
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
    // end-to-end: a parsed data row → clean record
    const r = patientToRow({ hospital: rows[4][1], nombre: rows[4][2], edad: rows[4][3], cedula: rows[4][4], observaciones: rows[4][7] })!;
    expect(r.estado).toBe('hospitalizado');
    expect(normName(r.full_name)).toBe('perez ana');
  });
});
