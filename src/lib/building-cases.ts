import type { Env } from '../types';
import { linkLiveCases, type LinkedCase, type MissingReport } from './building-score';

// ===== Buildings ↔ Cases linkage (building_cases, migration 0091) =====
//
// Every reported building (tv_buildings) is ATTACHED to the missing-person cases
// whose last-seen location names it. Links persist in `building_cases` so the
// /edificios listing can show them without recomputing the name match, and so
// operators can attach cases manually (source='manual') when the auto linker
// can't (the TV site flags has_missing_persons without names).
//
// case_id is the federated /casos id: persons.id native, 'fam-<personas.id>'
// for Familia rows — both open the full case profile at /casos#caso=<id>.

// Approved, still-missing reports from both registries WITH their case ids
// (one D1 batch). Fail-soft: [] on any DB error so callers degrade gracefully.
export async function fetchCaseReports(env: Env): Promise<MissingReport[]> {
  try {
    const [a, b] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id, full_name AS name, last_seen AS loc FROM persons
         WHERE review='approved' AND status='missing' AND COALESCE(last_seen,'')<>'' LIMIT 8000`),
      env.DB.prepare(
        `SELECT ('fam-'||id) AS id, nombre AS name, ubicacion AS loc FROM personas
         WHERE moderation='approved' AND COALESCE(ubicacion,'')<>''
           AND estado NOT IN ('localizado','aparecido','hospitalizado','fallecido') LIMIT 8000`),
    ]);
    const rows = [...(a.results ?? []), ...(b.results ?? [])] as { id: string; name: string; loc: string }[];
    return rows.filter((r) => r.name && r.loc)
      .map((r) => ({ id: String(r.id), name: r.name, loc: r.loc.toLowerCase() }));
  } catch { return []; }
}

// Persisted links for ONE building, manual first.
export async function persistedCases(env: Env, buildingId: string): Promise<(LinkedCase & { source: string })[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT case_id AS id, case_name AS name, source FROM building_cases
       WHERE building_id = ? ORDER BY source DESC, created_at ASC`,
    ).bind(buildingId).all();
    return ((r.results ?? []) as any[]).map((x) => ({ id: x.id, name: x.name || x.id, source: x.source }));
  } catch { return []; }
}

// Persisted links for ALL buildings, grouped — one query for the /reported listing.
export async function persistedCasesByBuilding(env: Env): Promise<Record<string, (LinkedCase & { source: string })[]>> {
  const out: Record<string, (LinkedCase & { source: string })[]> = {};
  try {
    const r = await env.DB.prepare(
      `SELECT building_id, case_id AS id, case_name AS name, source FROM building_cases
       ORDER BY source DESC, created_at ASC`,
    ).all();
    for (const x of (r.results ?? []) as any[]) {
      (out[x.building_id] ||= []).push({ id: x.id, name: x.name || x.id, source: x.source });
    }
  } catch { /* table may not exist yet — fail-soft */ }
  return out;
}

export interface CaseSyncResult { buildings: number; reports: number; linked: number; written: number }

// Hourly auto-linker (rides the tv-buildings cron). Name-token matches every
// tv_building against the live case registries and UPSERTs the attachments.
// INSERT OR IGNORE only: an attachment persists even after the person is found
// (the expediente is still tied to the building). Manual links are never touched.
export async function syncBuildingCases(env: Env): Promise<CaseSyncResult> {
  const reports = await fetchCaseReports(env);
  let buildings: { id: string; name: string }[] = [];
  try {
    const r = await env.DB.prepare(`SELECT id, name FROM tv_buildings WHERE COALESCE(name,'')<>''`).all();
    buildings = (r.results ?? []) as any[];
  } catch { buildings = []; }
  const rows: { b: string; c: string; n: string }[] = [];
  for (const b of buildings) {
    for (const m of linkLiveCases(b.name, reports)) {
      if (m.id) rows.push({ b: b.id, c: m.id, n: m.name });
    }
  }
  let written = 0;
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK).map((r) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO building_cases (building_id, case_id, case_name, source) VALUES (?,?,?,'auto')`,
      ).bind(r.b, r.c, r.n));
    try { await env.DB.batch(batch); written += batch.length; } catch { /* keep going */ }
  }
  return { buildings: buildings.length, reports: reports.length, linked: rows.length, written };
}
