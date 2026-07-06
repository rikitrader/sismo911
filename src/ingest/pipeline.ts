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
