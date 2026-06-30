import type { Env } from '../types';
import { uid } from './db';
import { patientToRow, type RawPatient } from './hospital-registry';

// Shared hospital-registry write path — used by the ingest route AND the pull cron.

/** Idempotent bulk upsert by dedupe_key. Returns counts. */
export async function upsertHospitalRows(env: Env, rawRows: RawPatient[], sourceUpdated: string): Promise<{ received: number; written: number; skipped: number }> {
  const now = Date.now();
  const src = String(sourceUpdated || '').slice(0, 80);
  let written = 0, skipped = 0;
  const stmts: any[] = [];
  for (const raw of rawRows) {
    const r = patientToRow(raw);
    if (!r || !r.dedupe_key) { skipped++; continue; }
    stmts.push(env.DB.prepare(
      `INSERT INTO hospital_patients
         (id,dedupe_key,hospital,full_name,name_variants,norm_name,edad,cedula,telefono,direccion,
          estado,conflict,observaciones,source,source_updated,match_confidence,created_ms,updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'none', ?, ?)
       ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
         hospital=excluded.hospital, full_name=excluded.full_name, name_variants=excluded.name_variants,
         norm_name=excluded.norm_name, edad=excluded.edad, cedula=excluded.cedula, telefono=excluded.telefono,
         direccion=excluded.direccion, estado=excluded.estado, conflict=excluded.conflict,
         observaciones=excluded.observaciones, source_updated=excluded.source_updated, updated_ms=excluded.updated_ms`
    ).bind(uid('hp'), r.dedupe_key, r.hospital, r.full_name, r.name_variants, r.norm_name, r.edad, r.cedula,
           r.telefono, r.direccion, r.estado, r.conflict, r.observaciones, 'registro-maestro', src, now, now));
  }
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
    written += Math.min(50, stmts.length - i);
  }
  return { received: rawRows.length, written, skipped };
}

/**
 * Map raw xlsx rows (cell-text matrix) → RawPatient[]. Finds the header row
 * dynamically (the one whose cells include HOSPITAL + OBSERVACIONES) and reads the
 * data rows after it by column position, so a layout shift doesn't silently break.
 */
export function mapSheetRows(rows: string[][]): { source_updated: string; patients: RawPatient[] } {
  // "Actualizado: <stamp>" usually sits in one of the first banner rows.
  let sourceUpdated = '';
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const cell = String(rows[i]?.[0] || '');
    const m = /Actualizado:\s*([0-9A-Za-z .:]+)/.exec(cell);
    if (m) { sourceUpdated = m[1].trim().slice(0, 80); break; }
  }
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const joined = (rows[i] || []).join('|').toUpperCase();
    if (joined.includes('HOSPITAL') && joined.includes('OBSERVACIONES')) { h = i; break; }
  }
  if (h < 0) return { source_updated: sourceUpdated, patients: [] };
  const head = (rows[h] || []).map((c) => String(c || '').toUpperCase());
  const col = (...names: string[]) => head.findIndex((c) => names.some((n) => c.includes(n)));
  const iH = col('HOSPITAL'), iN = col('APELLIDOS', 'NOMBRES', 'NOMBRE'), iE = col('EDAD'),
        iC = col('CÉDULA', 'CEDULA', 'ID'), iT = col('TELÉFONO', 'TELEFONO'),
        iD = col('DIRECCIÓN', 'DIRECCION'), iO = col('OBSERVAC');
  const at = (row: string[], i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  const patients: RawPatient[] = [];
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const nombre = at(row, iN);
    if (!nombre) continue;
    patients.push({
      hospital: at(row, iH), nombre, edad: at(row, iE), cedula: at(row, iC),
      telefono: at(row, iT), direccion: at(row, iD), observaciones: at(row, iO),
    });
  }
  return { source_updated: sourceUpdated, patients };
}
