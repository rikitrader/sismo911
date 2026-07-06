// SISMO911 — consolidated RAV ingest pipeline (one cron seat, one upstream family).
// ---------------------------------------------------------------------------
// The RAV/reportesvenezuela sources ran as SIX seats in the :05 group
// (rav-ingest, pacientes-rvz, rav-stats, rav-verified, rav-reports-safe,
// rav-reports-dedupe-extid). Same invocation, same budget — but six seats,
// no shared ordering guarantee, and no scored-dedupe finish. This pipeline
// replaces them with ONE seat: person-registry ingest first, then stats/
// verified/extras, then BOTH dedupe passes (rav_reports ext-id collapse +
// the layered scored dedupe over fresh personas). Twin of civis-pipeline.

import type { Env } from '../types';
import { ingestRav, ingestRavStats, ingestRavVerified, ingestRavReports, ingestRavSafe } from './rav-cron';
import { ingestPacientesRvz } from './pacientes-rvz-cron';
import { dedupeRavReports } from '../lib/dedupe';
import { runHourlyDedupe } from '../db/dedupe-cron';
import { runIngestPipeline, type PipelineStage, type PipelineSummary } from './pipeline';

/** Convergent rav_reports ext-id dedupe (bounded passes, mirrors cron drain). */
async function drainRavReportsDedupe(env: Env): Promise<{ passes: number; remaining: number }> {
  let passes = 0;
  let remaining = 0;
  for (; passes < 16; passes++) {
    const r = (await dedupeRavReports(env, { apply: true, limit: 400 })) as { remaining?: number };
    remaining = r.remaining ?? 0;
    if (!remaining) {
      passes++;
      break;
    }
  }
  return { passes, remaining };
}

export const RAV_STAGES: PipelineStage[] = [
  { name: 'rav-ingest', run: (env) => ingestRav(env) },
  { name: 'pacientes-rvz', run: ingestPacientesRvz },
  { name: 'rav-stats', run: ingestRavStats },
  { name: 'rav-verified', run: ingestRavVerified },
  { name: 'rav-reports', run: (env) => ingestRavReports(env) },
  { name: 'rav-safe', run: (env) => ingestRavSafe(env) },
  { name: 'rav-reports-dedupe-extid', run: drainRavReportsDedupe },
  { name: 'dedupe-pass', run: (env) => runHourlyDedupe(env) },
];

export async function runRavPipeline(env: Env, stages: PipelineStage[] = RAV_STAGES): Promise<PipelineSummary> {
  return runIngestPipeline(env, stages);
}
