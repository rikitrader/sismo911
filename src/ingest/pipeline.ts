// SISMO911 — shared sequential ingest-pipeline runner.
// ---------------------------------------------------------------------------
// One cron seat runs a list of same-upstream ingest stages SEQUENTIALLY
// (courteous to the third-party site, no cross-invocation racing) and
// typically ends with a dedupe stage, so every ingest tick finishes:
// fetch → gate-filter/map (inside each source, unchanged) → dedupe.
// A failing stage is recorded and never blocks the rest.
// First used by civis-pipeline (PR #656); rav-pipeline consolidates the same way.

import type { Env } from '../types';

export interface PipelineStage {
  name: string;
  run: (env: Env) => Promise<unknown>;
}

export interface PipelineSummary {
  stages: Array<{ name: string; ok: boolean; ms: number; error?: string; result?: unknown }>;
  ok: number;
  failed: number;
}

// Convergence helper: re-run a bounded-batch cleanup until it reports nothing
// left (`remaining === 0`) or a pass cap is hit, so a backlog actually DRAINS
// instead of trickling one batch per hour. maxPasses is the burst ceiling, NOT
// the steady-state cost: a quiet tick early-breaks after ~1 pass. 16 passes
// (6,400 rows/tick at limit 400) drains a typical RAV-burst backlog in one
// tick. Safe on the subrequest budget: each pass is ~1 SELECT + ≤5 chunked D1
// DELETEs + 1 BULK R2 delete. (Moved here from src/cron.ts so pipeline modules
// and the cron groups share ONE implementation.)
export async function drain(
  run: () => Promise<{ remaining?: number; deletedRows?: number; deletedPhotos?: number }>,
  maxPasses = 16,
): Promise<{ passes: number; deletedRows: number; deletedPhotos: number; remaining: number }> {
  let passes = 0, deletedRows = 0, deletedPhotos = 0, remaining = 0;
  for (; passes < maxPasses; passes++) {
    const r = await run();
    deletedRows += r.deletedRows ?? 0;
    deletedPhotos += r.deletedPhotos ?? 0;
    remaining = r.remaining ?? 0;
    if (!remaining) { passes++; break; }
  }
  return { passes, deletedRows, deletedPhotos, remaining };
}

export async function runIngestPipeline(env: Env, stages: PipelineStage[]): Promise<PipelineSummary> {
  const out: PipelineSummary = { stages: [], ok: 0, failed: 0 };
  for (const stage of stages) {
    const started = Date.now();
    try {
      const result = await stage.run(env);
      out.stages.push({ name: stage.name, ok: true, ms: Date.now() - started, result });
      out.ok++;
    } catch (e) {
      out.stages.push({ name: stage.name, ok: false, ms: Date.now() - started, error: String((e as Error)?.message ?? e).slice(0, 200) });
      out.failed++;
    }
  }
  return out;
}

// Auto-expiry safety net for pipeline locks: 55 min < the hourly cadence, so a
// crashed run (which never reaches the finally-delete) costs at most ONE
// skipped tick, never a permanently wedged pipeline.
const LOCK_TTL_S = 55 * 60;

/** flock-style overlap guard around a sequential stage run: a KV sentinel
 *  (env.CACHE) makes two runs of the same pipeline mutually exclusive — if a
 *  previous run is still in flight the tick SKIPS (and says so in the cron
 *  log) instead of racing it. The Workers equivalent of
 *  `flock -n /tmp/<name>.lock <pipeline>`. */
export async function runLockedPipeline(
  env: Env,
  lockName: string,
  stages: PipelineStage[],
): Promise<PipelineSummary | { skipped: 'locked'; since: string }> {
  const key = `lock:${lockName}`;
  const held = await env.CACHE.get(key);
  if (held) return { skipped: 'locked', since: held };
  await env.CACHE.put(key, new Date().toISOString(), { expirationTtl: LOCK_TTL_S });
  try {
    return await runIngestPipeline(env, stages);
  } finally {
    await env.CACHE.delete(key);
  }
}
