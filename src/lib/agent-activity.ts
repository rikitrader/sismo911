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

// Build a SQL expression that normalizes a name column to a comparison key:
// Spanish accents folded (á/Á→a, é→e, í→i, ó→o, ú→u, ü→u, ñ→n — SQLite lower()
// only folds ASCII), punctuation dropped (.,;:'"·), hyphens→spaces, repeated
// spaces collapsed, then lower-cased + trimmed. This is CONSERVATIVE: it only
// merges names identical up to accents/case/punctuation/whitespace — never a fuzzy
// or token-order merge, so it cannot fold two DIFFERENT people together. (It still
// won't catch typos or apellido/nombre order swaps — those would need a persisted
// fuzzy key; deliberately out of scope to avoid false merges in a MISSING count.)
export function nameKeySql(col: string): string {
  const folds: Array<[string, string]> = [
    ['á', 'a'], ['Á', 'a'], ['à', 'a'], ['ä', 'a'], ['â', 'a'],
    ['é', 'e'], ['É', 'e'], ['è', 'e'], ['ë', 'e'], ['ê', 'e'],
    ['í', 'i'], ['Í', 'i'], ['ì', 'i'], ['ï', 'i'], ['î', 'i'],
    ['ó', 'o'], ['Ó', 'o'], ['ò', 'o'], ['ö', 'o'], ['ô', 'o'],
    ['ú', 'u'], ['Ú', 'u'], ['ù', 'u'], ['ü', 'u'], ['û', 'u'], ['Ü', 'u'],
    ['ñ', 'n'], ['Ñ', 'n'],
    ['.', ''], [',', ''], [';', ''], [':', ''], ["'", ''], ['"', ''], ['·', ''],
    ['-', ' '], ['_', ' '],
    ['   ', ' '], ['  ', ' '], ['  ', ' '],   // collapse runs of spaces (a few passes)
  ];
  // SQL string literal: wrap in single quotes, escaping any embedded quote by
  // doubling it. CRITICAL for the apostrophe fold ("'") — `'''` is invalid SQL;
  // the correct escaped literal is `''''`.
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  let e = `trim(${col})`;
  for (const [a, b] of folds) e = `replace(${e}, ${lit(a)}, ${lit(b)})`;
  return `lower(${e})`;
}

// `total` is the raw unresolved row count across the native `persons`
// (status='missing') and the Familia/RAV `personas` registries. `unique` collapses
// duplicates by an accent-folded normalized-name key (registries carry heavy
// cross-source duplication — see the dedupe crons). `unique` is still an ESTIMATE
// (no typo/order-swap fuzzy merge — see nameKeySql), but it now folds accents so
// "José" and "Jose" count once.
export async function missingStats(env: Env): Promise<MissingStats> {
  const key = nameKeySql;
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
