// SISMO911 — Case score persistence + autonomous re-scoring.
// ---------------------------------------------------------------------------
// The scoreCase() engine (case-score.ts) is the source of truth and is computed
// live on every read. This module PERSISTS the derived priority back into the
// store so operator filters (?priority=) and stored sorts stay in sync, and runs
// the AUTONOMOUS auto-update:
//
//   • on-write   — recomputeCaseScore(env, id) is called the moment a case is
//                  marked found / gets a new docket entry / changes status, so a
//                  resolved case drops to 'baja' instantly.
//   • on-cron    — sweepCaseScores(env) re-scores active cases hourly so the
//                  time-based rules (72 h window, cold case) re-evaluate even
//                  when nobody touches the case.
//
// Persistence targets the EXISTING priority columns (no migration):
//   native cases  → persons.priority
//   familia cases → case_meta.priority (upserted; id = 'fam-<personas.id>')

import type { Env } from '../types';
import { scoreCase, type CaseSignals, type Priority } from './case-score';

const FAM = 'fam-';
const isFam = (id: string) => id.startsWith(FAM);
const famKey = (id: string) => id.slice(FAM.length);
const estadoToStatus = (e: string): CaseSignals['status'] =>
  e === 'localizado' ? 'found_safe' : e === 'fallecido' ? 'found_deceased' : 'missing';

// Reference quake (mag + PAGER alert) every case is anchored to. Cached per call.
async function quakeRef(env: Env): Promise<{ mag: number | null; alert: string | null }> {
  const row: any =
    (await env.DB.prepare(`SELECT mag, alert FROM events WHERE id = 'us6000t7zp'`).first().catch(() => null)) ||
    (await env.DB.prepare(`SELECT mag, alert FROM events ORDER BY mag DESC LIMIT 1`).first().catch(() => null));
  return { mag: row?.mag ?? null, alert: row?.alert ?? null };
}

async function docketStats(env: Env, id: string): Promise<{ count: number; lastMs: number | null }> {
  const row: any = await env.DB
    .prepare(`SELECT COUNT(*) AS c, MAX(created_ms) AS last FROM person_events WHERE person_id = ?`)
    .bind(id).first().catch(() => null);
  return { count: Number(row?.c ?? 0), lastMs: row?.last ?? null };
}

// Persist a derived priority, but only when it actually changed (avoids write churn).
async function persistPriority(env: Env, id: string, next: Priority): Promise<boolean> {
  if (isFam(id)) {
    const cur: any = await env.DB.prepare(`SELECT priority FROM case_meta WHERE person_id = ?`).bind(id).first().catch(() => null);
    if (cur?.priority === next) return false;
    await env.DB.prepare(
      `INSERT INTO case_meta (person_id, priority, updated_ms) VALUES (?,?,?)
       ON CONFLICT(person_id) DO UPDATE SET priority = excluded.priority, updated_ms = excluded.updated_ms`
    ).bind(id, next, Date.now()).run();
    return true;
  }
  const cur: any = await env.DB.prepare(`SELECT priority FROM persons WHERE id = ?`).bind(id).first().catch(() => null);
  if (!cur || cur.priority === next) return false;
  await env.DB.prepare(`UPDATE persons SET priority = ? WHERE id = ?`).bind(next, id).run();
  return true;
}

/** Recompute + persist the priority for ONE case. Returns the fresh score, or null if the case is gone. */
export async function recomputeCaseScore(env: Env, id: string, now = Date.now()) {
  const quake = await quakeRef(env);
  let sig: CaseSignals | null = null;
  let incidentType: string | null = null;

  if (isFam(id)) {
    const row: any = await env.DB.prepare(`SELECT edad, estado, created_at FROM personas WHERE id = ?`).bind(famKey(id)).first().catch(() => null);
    if (!row) return null;
    const meta: any = await env.DB.prepare(`SELECT incident_type FROM case_meta WHERE person_id = ?`).bind(id).first().catch(() => null);
    incidentType = meta?.incident_type ?? null;
    const d = await docketStats(env, id);
    sig = {
      status: estadoToStatus(row.estado), age: row.edad ?? null, incidentType,
      createdMs: row.created_at ?? null, lastActivityMs: d.lastMs, docketCount: d.count,
      eventMag: quake.mag, eventAlert: quake.alert, now,
    };
  } else {
    const row: any = await env.DB.prepare(`SELECT age, status, incident_type, created_ms FROM persons WHERE id = ?`).bind(id).first().catch(() => null);
    if (!row) return null;
    const d = await docketStats(env, id);
    sig = {
      status: row.status, age: row.age ?? null, incidentType: row.incident_type ?? null,
      createdMs: row.created_ms ?? null, lastActivityMs: d.lastMs, docketCount: d.count,
      eventMag: quake.mag, eventAlert: quake.alert, now,
    };
  }

  const sc = scoreCase(sig);
  await persistPriority(env, id, sc.priority).catch(() => {});
  return sc;
}

/**
 * Autonomous bounded sweep for the hourly cron. Re-scores ACTIVE cases so the
 * time-based rules re-evaluate, persisting only changed priorities.
 *  - all native missing/unknown cases (citizen reports — a small set), and
 *  - a bounded batch of active familia cases, walked via a KV cursor so the
 *    whole registry is covered over successive ticks without a CPU spike.
 * Returns { native, familia, changed }.
 */
export async function sweepCaseScores(env: Env, opts: { famLimit?: number } = {}) {
  const now = Date.now();
  const famLimit = opts.famLimit ?? 300;
  const quake = await quakeRef(env);
  let changed = 0;

  // --- native active cases ---
  const { results: natRows = [] } = await env.DB.prepare(
    `SELECT id, age, status, incident_type, created_ms, priority FROM persons WHERE status IN ('missing','unknown')`
  ).all<any>().catch(() => ({ results: [] as any[] }));
  for (const r of natRows) {
    const d = await docketStats(env, r.id);
    const sc = scoreCase({
      status: r.status, age: r.age ?? null, incidentType: r.incident_type ?? null,
      createdMs: r.created_ms ?? null, lastActivityMs: d.lastMs, docketCount: d.count,
      eventMag: quake.mag, eventAlert: quake.alert, now,
    });
    if (sc.priority !== r.priority) { await persistPriority(env, r.id, sc.priority).catch(() => {}); changed++; }
  }

  // --- familia active batch (cursor-walked) ---
  const cursorKey = 'casescore:fam:cursor';
  const cursor = (await env.CACHE.get(cursorKey).catch(() => null)) || '';
  const { results: famRows = [] } = await env.DB.prepare(
    `SELECT id, edad, estado, created_at FROM personas
     WHERE estado NOT IN ('localizado','fallecido') AND id > ?
     ORDER BY id ASC LIMIT ?`
  ).bind(cursor, famLimit).all<any>().catch(() => ({ results: [] as any[] }));

  if (famRows.length) {
    // One grouped query for docket counts/last-activity across the batch.
    const ids = famRows.map((r: any) => FAM + r.id);
    const placeholders = ids.map(() => '?').join(',');
    const { results: dRows = [] } = await env.DB.prepare(
      `SELECT person_id, COUNT(*) AS c, MAX(created_ms) AS last FROM person_events
       WHERE person_id IN (${placeholders}) GROUP BY person_id`
    ).bind(...ids).all<any>().catch(() => ({ results: [] as any[] }));
    const dMap: Record<string, { c: number; last: number | null }> = {};
    for (const d of dRows) dMap[d.person_id] = { c: Number(d.c), last: d.last ?? null };

    const metaMap: Record<string, string> = {};
    const { results: mRows = [] } = await env.DB.prepare(
      `SELECT person_id, incident_type FROM case_meta WHERE person_id IN (${placeholders})`
    ).bind(...ids).all<any>().catch(() => ({ results: [] as any[] }));
    for (const m of mRows) if (m.incident_type) metaMap[m.person_id] = m.incident_type;

    for (const r of famRows) {
      const id = FAM + r.id;
      const d = dMap[id] || { c: 0, last: null };
      const sc = scoreCase({
        status: estadoToStatus(r.estado), age: r.edad ?? null, incidentType: metaMap[id] ?? null,
        createdMs: r.created_at ?? null, lastActivityMs: d.last, docketCount: d.c,
        eventMag: quake.mag, eventAlert: quake.alert, now,
      });
      if (await persistPriority(env, id, sc.priority).catch(() => false)) changed++;
    }
    // Advance / wrap the cursor.
    const lastId = famRows[famRows.length - 1].id;
    await env.CACHE.put(cursorKey, famRows.length < famLimit ? '' : String(lastId)).catch(() => {});
  } else {
    await env.CACHE.put(cursorKey, '').catch(() => {}); // reached the end → wrap
  }

  return { native: natRows.length, familia: famRows.length, changed };
}
