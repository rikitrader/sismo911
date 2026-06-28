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
  stillMissing?: number;
  summary: string;           // agent-narrated one-liner shown in the tracking feed
  ok?: boolean;
}

// Count the still-unresolved missing across BOTH registries: native `persons`
// (status='missing') and the Familia/RAV `personas` (estado not in the resolved
// set). This is the "continuamos buscando" number the operators track.
export async function countStillMissing(env: Env): Promise<number> {
  const [a, b] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM personas
       WHERE moderation='approved' AND estado NOT IN ('localizado','aparecido','hospitalizado','fallecido')`,
    ).first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM persons WHERE review='approved' AND status='missing'`,
    ).first<{ n: number }>().catch(() => ({ n: 0 })),
  ]);
  return Number(a?.n ?? 0) + Number(b?.n ?? 0);
}

// Append an agent-activity row. Best-effort: a tracking write must never break the
// ingest that produced it.
export async function logAgentActivity(env: Env, a: AgentActivity): Promise<void> {
  try {
    const now = Date.now();
    const id = `aa_${a.source}_${now}_${(crypto.randomUUID?.() || String(now)).slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO agent_activity
         (id, source, action, fetched, created, updated, matched, still_missing, summary, ok, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, a.source, a.action ?? 'poll',
      a.fetched ?? 0, a.created ?? 0, a.updated ?? 0, a.matched ?? 0, a.stillMissing ?? 0,
      a.summary.slice(0, 500), a.ok === false ? 0 : 1, now,
    ).run();
  } catch (e: any) {
    console.error('[agent-activity] log failed:', e?.message ?? e);
  }
}
