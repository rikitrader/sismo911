// SISMO911 — consolidated CIVIS ingest pipeline (one cron seat, one upstream).
// ---------------------------------------------------------------------------
// civisvenezuela.com was hit by FOUR separate cron jobs spread across the hour
// (atendidos :45, desaparecidos :45, extras :05, edificaciones :15) — four
// invocations against the same third-party site, four seats consumed, and no
// shared ordering between fetch → filter/map → dedupe.
//
// This pipeline replaces all four seats with ONE job that runs the sources
// SEQUENTIALLY (courteous to the upstream: one client, one pass, built-in
// spacing) and finishes with the scored-dedupe stage, so every CIVIS tick ends
// with: fetched → gate-filtered/mapped (inside each source, unchanged) →
// deduped. One source failing never blocks the others; each stage's outcome is
// reported and the whole run is bounded by the sources' own page caps
// (~5 pages each — comfortably inside one invocation's subrequest budget).

import type { Env } from '../types';
import { runIngestPipeline, type PipelineStage, type PipelineSummary } from './pipeline';
import { ingestCivisAtendidos } from './civis-atendidos';
import { ingestCivisDesaparecidos } from './civis-desaparecidos';
import { ingestCivisExtras } from './civis-extras';
import { runHourlyDedupe } from '../db/dedupe-cron';

/** Default stage order: person-registry sources first, then satellite/stats,
 *  then the dedupe pass that collapses whatever the tick just ingested.
 *  NOTE: civis-edificaciones moved to the :15 personas-hourly-pipeline so
 *  building data is fresh before that tick's matching — do not re-add it here
 *  (jobs must stay disjoint across groups; test/cron.test.ts guards this). */
export type { PipelineStage, PipelineSummary } from './pipeline';

export const CIVIS_STAGES: PipelineStage[] = [
  { name: 'civis-desaparecidos', run: ingestCivisDesaparecidos },
  { name: 'civis-atendidos', run: ingestCivisAtendidos },
  { name: 'civis-extras', run: ingestCivisExtras },
  { name: 'dedupe-pass', run: (env) => runHourlyDedupe(env) },
];

/** Run the stages sequentially; a failing stage is recorded, never fatal. */
export async function runCivisPipeline(env: Env, stages: PipelineStage[] = CIVIS_STAGES): Promise<PipelineSummary> {
  return runIngestPipeline(env, stages);
}
