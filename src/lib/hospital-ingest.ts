import type { Env } from '../types';
import { uid } from './db';
import { patientToRow, type RawPatient } from './hospital-registry';

// Shared hospital-registry write path — used by the ingest route AND the pull cron.
export const HOSPITAL_COLLAPSE_LAST_KEY = 'hospital-registry:collapse-last';
const COLLAPSE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
         direccion=excluded.direccion,
         -- Status is STICKY UPWARD: with the name-only dedupe key, a person listed
         -- both with "Internado" and with a blank cell collides on ONE row. A blank
         -- (desconocido) re-ingest must NEVER clobber a known status, or hospitalizados
         -- silently vanish. Priority: fallecido > alta > hospitalizado > desconocido.
         estado=CASE
           WHEN excluded.estado='fallecido'      OR hospital_patients.estado='fallecido'      THEN 'fallecido'
           WHEN excluded.estado='alta'           OR hospital_patients.estado='alta'           THEN 'alta'
           WHEN excluded.estado='hospitalizado'  OR hospital_patients.estado='hospitalizado'  THEN 'hospitalizado'
           ELSE excluded.estado END,
         conflict=CASE WHEN excluded.conflict=1 OR hospital_patients.conflict=1 THEN 1 ELSE 0 END,
         -- Keep the evidence that justifies the status: a blank re-ingest of the same
         -- person (name-key collision) must NOT erase the observación that the status
         -- was derived from. Prefer the non-blank / longer text.
         observaciones=CASE
           WHEN excluded.observaciones IS NULL OR TRIM(excluded.observaciones)='' THEN hospital_patients.observaciones
           WHEN LENGTH(excluded.observaciones) >= LENGTH(COALESCE(hospital_patients.observaciones,'')) THEN excluded.observaciones
           ELSE hospital_patients.observaciones END,
         source_updated=excluded.source_updated, updated_ms=excluded.updated_ms`
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
 * Collapse duplicate hospital_patients rows created before the dedupe-key fix
 * (and any that future syncs re-create for the same person listed both with and
 * without a cédula). REVERSIBLE: losing rows are archived into
 * `hospital_patients_dupes` (with `merged_into` = winner id) BEFORE deletion.
 *
 * Safety: rows are grouped by `norm_name`. A group is collapsed ONLY when it
 * contains 0-or-1 distinct cédulas — i.e. it is unambiguously ONE person. Groups
 * where two+ distinct cédulas share a normalized name (different real people with
 * the same name) are left completely untouched. Within a collapsed group the
 * winner is chosen cédula-first, then richest contact info, then oldest — and it
 * inherits the best status in the group (a hospitalizado loser is never lost to a
 * desconocido winner). Set-based SQL (a handful of statements, no per-row fan-out)
 * so it stays well inside the Worker subrequest budget.
 */
export async function collapseHospitalDupes(env: Env, opts: { force?: boolean } = {}): Promise<{ collapsed: number; reason?: string }> {
  const now = Date.now();
  if (!opts.force) {
    const last = Number(await env.CACHE.get(HOSPITAL_COLLAPSE_LAST_KEY) || 0);
    if (last > 0 && now - last < COLLAPSE_COOLDOWN_MS)
      return { collapsed: 0, reason: 'collapse_cooldown' };
  }
  try {
    // Self-healing: tolerate an un-migrated DB (mirrors migration 0084).
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS hospital_patients_dupes (
         id TEXT PRIMARY KEY, dedupe_key TEXT, hospital TEXT, full_name TEXT, name_variants TEXT,
         norm_name TEXT, edad TEXT, cedula TEXT, telefono TEXT, direccion TEXT, estado TEXT,
         conflict INTEGER, observaciones TEXT, source TEXT, source_updated TEXT,
         matched_person_id TEXT, matched_persona_id TEXT, match_kind TEXT, match_confidence REAL,
         matched_ms INTEGER, created_ms INTEGER, updated_ms INTEGER, merged_into TEXT, archived_ms INTEGER)`
    ).run();

    // Estado-independent winner ranking, reused by archive + delete so they pick
    // the SAME losers. n_ced<=1 ⇒ unambiguous single identity.
    const grpRanked =
      `WITH grp AS (
         SELECT norm_name, COUNT(DISTINCT NULLIF(cedula,'')) AS n_ced
         FROM hospital_patients GROUP BY norm_name
       ),
       ranked AS (
         SELECT h.id,
           FIRST_VALUE(h.id) OVER w AS winner_id,
           ROW_NUMBER()      OVER w AS rn
         FROM hospital_patients h JOIN grp g ON g.norm_name = h.norm_name
         WHERE g.n_ced <= 1
         WINDOW w AS (PARTITION BY h.norm_name
           ORDER BY (h.cedula<>'') DESC, (h.telefono<>'') DESC, (h.direccion<>'') DESC,
                    h.created_ms ASC, h.id ASC)
       )`;

    // 1. Promote the best status in each unambiguous group onto every row in it
    //    (the winner survives carrying it; losers are about to be archived). Done
    //    first BECAUSE the ranking above is intentionally status-independent.
    await env.DB.prepare(
      `WITH grp AS (
         SELECT norm_name, COUNT(DISTINCT NULLIF(cedula,'')) AS n_ced
         FROM hospital_patients GROUP BY norm_name
       ),
       best AS (
         -- Same priority as the upsert: fallecido > alta > hospitalizado > desconocido.
         SELECT norm_name, MIN(CASE estado WHEN 'fallecido' THEN 0 WHEN 'alta' THEN 1
                                           WHEN 'hospitalizado' THEN 2 ELSE 3 END) AS bp
         FROM hospital_patients GROUP BY norm_name
       )
       UPDATE hospital_patients
         SET estado = CASE (SELECT bp FROM best b WHERE b.norm_name = hospital_patients.norm_name)
                        WHEN 0 THEN 'fallecido' WHEN 1 THEN 'alta'
                        WHEN 2 THEN 'hospitalizado' ELSE 'desconocido' END,
             updated_ms = ?
       WHERE norm_name IN (SELECT norm_name FROM grp WHERE n_ced <= 1)`
    ).bind(now).run();

    // 2. Archive losers (reversible) — copy each onto its winner's id.
    await env.DB.prepare(
      `${grpRanked}
       INSERT OR IGNORE INTO hospital_patients_dupes
         (id,dedupe_key,hospital,full_name,name_variants,norm_name,edad,cedula,telefono,direccion,
          estado,conflict,observaciones,source,source_updated,matched_person_id,matched_persona_id,
          match_kind,match_confidence,matched_ms,created_ms,updated_ms,merged_into,archived_ms)
       SELECT h.id,h.dedupe_key,h.hospital,h.full_name,h.name_variants,h.norm_name,h.edad,h.cedula,
              h.telefono,h.direccion,h.estado,h.conflict,h.observaciones,h.source,h.source_updated,
              h.matched_person_id,h.matched_persona_id,h.match_kind,h.match_confidence,h.matched_ms,
              h.created_ms,h.updated_ms, r.winner_id, ?
       FROM hospital_patients h JOIN ranked r ON r.id = h.id
       WHERE r.rn > 1`
    ).bind(now).run();

    // 3. Delete losers from the live table.
    const del: any = await env.DB.prepare(
      `${grpRanked} DELETE FROM hospital_patients WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`
    ).run();
    const collapsed = Number(del?.meta?.changes ?? del?.changes ?? 0);
    await env.CACHE.put(HOSPITAL_COLLAPSE_LAST_KEY, String(now));
    return { collapsed };
  } catch (e: any) {
    return { collapsed: 0, reason: String(e?.message || e).slice(0, 120) };
  }
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
  // Accent-strip the header so 'CÉDULA' matches 'CEDULA'. Use precise tokens —
  // NEVER 'ID' (it is a substring of "apellIDos" and would steal the cédula column).
  const deacc = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const head = (rows[h] || []).map((c) => deacc(String(c || '')));
  const col = (...names: string[]) => head.findIndex((c) => names.some((n) => c.includes(n)));
  const iH = col('HOSPITAL'), iN = col('APELLIDOS', 'NOMBRE'), iE = col('EDAD'),
        iC = col('CEDULA', 'C.I'), iT = col('TELEFONO'),
        iD = col('DIRECCION'), iO = col('OBSERVAC');
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
