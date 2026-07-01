// Search-index maintenance for the unified case search.
//
// Populates the structured, accent-folded search columns added in migration
// 0086 (name_norm / geo_estado / geo_municipio, plus hospital age_num) for rows
// that don't have them yet. Runs from:
//   • the hourly cron  → self-healing across EVERY write path (bulk importers,
//     citizen reports, operator edits) without touching each INSERT site;
//   • POST /api/persons/reindex-search (operator) → drives the initial mass
//     backfill right after a deploy;
//   • directly on the two primary citizen-facing creates (instant structuring).
//
// Marker semantics (so a row is processed exactly once, never re-looped even
// when its location can't be parsed):
//   persons / personas → keyed on `name_norm IS NULL`. Processing always writes
//     name_norm (normalizeText(name), possibly '' — still NOT NULL), so the row
//     drops out of the queue whether or not an estado was found.
//   hospital_patients  → keyed on `geo_estado IS NULL` (norm_name already exists
//     from ingest, so it can't be the marker). Processing writes geo_estado to
//     the parsed slug or '' (empty sentinel = processed-but-unparsed).

import { normalizeName } from './search-normalize';
import { parseLocation, parseAge } from './ve-geo';

export interface SearchField { name_norm: string; geo_estado: string | null; geo_municipio: string | null }

/** Compute the structured search fields for a person/persona row. */
export function computeSearchFields(name: string | null | undefined, ...locations: Array<string | null | undefined>): SearchField {
  const geo = parseLocation(...locations);
  return { name_norm: normalizeName(name), geo_estado: geo.estado, geo_municipio: geo.municipio };
}

interface BackfillResult { persons: number; personas: number; hospital: number; total: number }

/**
 * Backfill one batch of un-indexed rows across all three registries.
 * @param batch max rows per table per call (keeps the Worker under its
 *              subrequest/time budget — batched UPDATEs count as one call).
 */
export async function backfillSearchFields(env: any, batch = 400): Promise<BackfillResult> {
  const out: BackfillResult = { persons: 0, personas: 0, hospital: 0, total: 0 };

  // ── persons ──
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, full_name, last_seen FROM persons WHERE name_norm IS NULL LIMIT ?`
    ).bind(batch).all();
    if (results?.length) {
      const stmts = results.map((r: any) => {
        const f = computeSearchFields(r.full_name, r.last_seen);
        return env.DB.prepare(`UPDATE persons SET name_norm=?, geo_estado=?, geo_municipio=? WHERE id=?`)
          .bind(f.name_norm, f.geo_estado, f.geo_municipio, r.id);
      });
      await env.DB.batch(stmts);
      out.persons = results.length;
    }
  } catch (e: any) { console.error('[search-index] persons backfill failed:', e?.message ?? e); }

  // ── personas (Familia) ──
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, nombre, ubicacion FROM personas WHERE name_norm IS NULL LIMIT ?`
    ).bind(batch).all();
    if (results?.length) {
      const stmts = results.map((r: any) => {
        const f = computeSearchFields(r.nombre, r.ubicacion);
        return env.DB.prepare(`UPDATE personas SET name_norm=?, geo_estado=?, geo_municipio=? WHERE id=?`)
          .bind(f.name_norm, f.geo_estado, f.geo_municipio, r.id);
      });
      await env.DB.batch(stmts);
      out.personas = results.length;
    }
  } catch (e: any) { console.error('[search-index] personas backfill failed:', e?.message ?? e); }

  // ── hospital_patients ──
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, edad, direccion, hospital FROM hospital_patients WHERE geo_estado IS NULL LIMIT ?`
    ).bind(batch).all();
    if (results?.length) {
      const stmts = results.map((r: any) => {
        const geo = parseLocation(r.direccion, r.hospital);
        const age = parseAge(r.edad);
        return env.DB.prepare(`UPDATE hospital_patients SET geo_estado=?, geo_municipio=?, age_num=? WHERE id=?`)
          .bind(geo.estado ?? '', geo.municipio ?? '', age, r.id);
      });
      await env.DB.batch(stmts);
      out.hospital = results.length;
    }
  } catch (e: any) { console.error('[search-index] hospital backfill failed:', e?.message ?? e); }

  out.total = out.persons + out.personas + out.hospital;
  return out;
}

/** How many rows still await indexing (for progress / done detection). */
export async function reindexRemaining(env: any): Promise<number> {
  let n = 0;
  for (const sql of [
    `SELECT COUNT(*) AS c FROM persons WHERE name_norm IS NULL`,
    `SELECT COUNT(*) AS c FROM personas WHERE name_norm IS NULL`,
    `SELECT COUNT(*) AS c FROM hospital_patients WHERE geo_estado IS NULL`,
  ]) {
    try { const r: any = await env.DB.prepare(sql).first(); n += Number(r?.c) || 0; } catch { /* table may be absent in some envs */ }
  }
  return n;
}
