import type { Env } from '../types';

// Agent activity tracking — the CRM "tracking part". Every automated poller logs
// one row per cycle so operators can SEE the system is continuously working the
// missing-person backlog (and how many are still unresolved). Per-case updates
// live in person_events; this is the global heartbeat/audit feed (agent_activity).

export interface AgentActivity {
  source: string;            // poller id, e.g. 'pacientes-rvz'
  action?: string;           // 'poll' | 'match' | 'ingest'
  fetched?: number;
  created?: number;
  updated?: number;
  matched?: number;
  stillMissing?: number;     // raw unresolved total
  stillUnique?: number;      // de-duplicated unique estimate
  summary: string;           // agent-narrated one-liner shown in the tracking feed
  ok?: boolean;
}

// Count the still-unresolved missing across BOTH registries: native `persons`
// (status='missing') and the Familia/RAV `personas` (estado not in the resolved
// set). This is the "continuamos buscando" number the operators track.

// Unresolved-case predicates, shared so total + unique use the SAME definition.
const PERSONAS_UNRESOLVED = `moderation='approved' AND estado NOT IN ('localizado','aparecido','hospitalizado','fallecido')`;
const PERSONS_UNRESOLVED = `review='approved' AND status='missing'`;

export interface MissingStats {
  total: number;    // raw unresolved rows across both registries (inflated by cross-source dups)
  unique: number;   // de-duplicated estimate: distinct normalized name across both registries
}

// `total` is the raw unresolved row count across the native `persons`
// (status='missing') and the Familia/RAV `personas` registries. `unique` collapses
// obvious duplicates by a normalized-name key (the registries carry heavy
// cross-source duplication — see the dedupe crons). NOTE: SQLite lower() does NOT
// fold accents, so `unique` is a conservative UNDER-dedupe ESTIMATE, never exact.
export async function missingStats(env: Env): Promise<MissingStats> {
  const key = (col: string) =>
    `lower(replace(replace(replace(replace(trim(${col}),'  ',' '),'.',''),',',''),'-',' '))`;
  const [t, u] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM personas WHERE ${PERSONAS_UNRESOLVED}) +
         (SELECT COUNT(*) FROM persons  WHERE ${PERSONS_UNRESOLVED}) AS n`,
    ).first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT k) AS n FROM (
         SELECT ${key('nombre')} AS k FROM personas
           WHERE ${PERSONAS_UNRESOLVED} AND trim(coalesce(nombre,'')) <> ''
         UNION
         SELECT ${key('full_name')} AS k FROM persons
           WHERE ${PERSONS_UNRESOLVED} AND trim(coalesce(full_name,'')) <> ''
       )`,
    ).first<{ n: number }>().catch(() => ({ n: 0 })),
  ]);
  return { total: Number(t?.n ?? 0), unique: Number(u?.n ?? 0) };
}

// Back-compat single-number helper (raw total).
export async function countStillMissing(env: Env): Promise<number> {
  return (await missingStats(env)).total;
}

// "{total} casos (~{unique} únicas) aún sin localizar" fragment for summaries.
export function missingPhrase(m: MissingStats): string {
  return `${m.total.toLocaleString('es')} casos (~${m.unique.toLocaleString('es')} personas únicas estimadas) aún sin localizar`;
}

// Append an agent-activity row. Best-effort: a tracking write must never break the
// ingest that produced it.
export async function logAgentActivity(env: Env, a: AgentActivity): Promise<void> {
  try {
    const now = Date.now();
    const id = `aa_${a.source}_${now}_${(crypto.randomUUID?.() || String(now)).slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO agent_activity
         (id, source, action, fetched, created, updated, matched, still_missing, still_unique, summary, ok, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, a.source, a.action ?? 'poll',
      a.fetched ?? 0, a.created ?? 0, a.updated ?? 0, a.matched ?? 0, a.stillMissing ?? 0, a.stillUnique ?? 0,
      a.summary.slice(0, 500), a.ok === false ? 0 : 1, now,
    ).run();
  } catch (e: any) {
    console.error('[agent-activity] log failed:', e?.message ?? e);
  }
}
