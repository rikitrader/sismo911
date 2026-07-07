// SISMO911 — consolidated hourly BUILDINGS/CASES pipeline (one :30 cron seat).
// ---------------------------------------------------------------------------
// What used to be ELEVEN independent jobs on the '30 * * * *' trigger is now
// ONE named pipeline with the ordering made explicit and dependency-driven:
//
//   ingest (tv-buildings, cases-sheet-sync) → link (tv-building-cases) →
//   sheet mirrors → photo mirror → hash backfill → dedupe → import sweep →
//   case-alerts LAST (so alerts see the freshest case/building/sheet state).
//
// Rationale for the order:
//   - tv-buildings and cases-sheet-sync run BEFORE tv-building-cases so the
//     linker sees this tick's fresh buildings AND freshly synced CRM cases.
//     (tv-building-cases historically died at the TAIL of the old :30 group —
//     2026-07-02 — so it must stay near the front; only these two light,
//     bounded ingests precede it.)
//   - mirrors (monitor/hospital sheets, familia photos) run mid-pipeline: they
//     export state and have no downstream consumer inside this tick.
//   - phash-backfill runs BEFORE the dedupes so freshly hashed rows are
//     deduped in the same invocation.
//   - dedupe-engine-hourly (scored engine v2: auto-merge + review queue) stays
//     in this pipeline (it was in the old :30 group) and runs after the cheap
//     fuzzyphone pass.
//   - case-alerts runs LAST, over fully synced/linked/deduped data. It already
//     alerts only on real not-yet-alerted changes (change-detection inside the
//     job), satisfying the no-duplicate-notifications requirement.
//
// Overlap lock: runLockedPipeline (KV sentinel, auto-expiring) — the Workers
// equivalent of `flock -n /tmp/buildings-cases-hourly-pipeline.lock …`. Same
// shape as personas-hourly-pipeline (:15) / civis-pipeline (:45) /
// rav-pipeline (:05): stages run SEQUENTIALLY, one failing stage never blocks
// the rest, and every stage's duration (ms) + outcome lands in the summary.

import type { Env } from '../types';
import { runLockedPipeline, drain, type PipelineStage, type PipelineSummary } from './pipeline';
import { ingestTvBuildings } from './tv-buildings-cron';
import { syncCasesSheetToD1 } from '../sync/sheet-source';
import { runBuildingCasesLink } from '../lib/building-cases';
import { syncMonitorSheet, syncHospitalSheet } from '../lib/sheets-sync';
import { mirrorFamiliaPhotos } from './familia-cron';
import { backfillPhashes } from './rav-photos';
import { dedupePersonas } from '../lib/dedupe';
import { runHourlyDedupe } from '../db/dedupe-cron';
import { sweepBulkJobs } from '../bulk/import-job';
import { runCaseAlerts } from './case-alerts';

/** Ordered stages — ingest → link → mirrors → hash/dedupe → sweep → alerts. */
export const BUILDINGS_CASES_STAGES: PipelineStage[] = [
  // 1-2 · Ingest fresh state: terremotovenezuela damaged-buildings mirror,
  // then the curated 'Casos CRM' sheet → D1 (bounded, KV-cursor drained).
  { name: 'tv-buildings', run: ingestTvBuildings },
  { name: 'cases-sheet-sync', run: syncCasesSheetToD1 },
  // 3 · Auto-link buildings ↔ cases over BOTH fresh datasets.
  { name: 'tv-building-cases', run: runBuildingCasesLink },
  // 4-6 · Mirrors (exports; nothing downstream consumes them this tick).
  { name: 'monitor-sheet', run: syncMonitorSheet },
  { name: 'hospital-sheet', run: syncHospitalSheet },
  { name: 'familia-photo-mirror', run: mirrorFamiliaPhotos },
  // 7-9 · Hash backfill BEFORE dedupe (fresh hashes dedupe in the same tick),
  // then the cheap fuzzyphone pass, then the scored dedupe engine.
  { name: 'personas-phash-backfill-30', run: (env) => backfillPhashes(env, 400) },
  { name: 'personas-dedupe-fuzzyphone', run: (env) => drain(() => dedupePersonas(env, { mode: 'fuzzyphone', apply: true, limit: 400 })) },
  { name: 'dedupe-engine-hourly', run: (env) => runHourlyDedupe(env) },
  // 10 · Restart stalled bulk roster imports / flag long-stuck jobs.
  { name: 'bulk-import-sweep', run: (env) => sweepBulkJobs(env) },
  // 11 · LAST: subscriber alerts over the freshest case/building/sheet state.
  { name: 'case-alerts', run: (env) => runCaseAlerts(env) },
];

/** One :30 seat: flock-style KV lock around the sequential stage run. */
export async function runBuildingsCasesPipeline(env: Env, stages: PipelineStage[] = BUILDINGS_CASES_STAGES): Promise<PipelineSummary | { skipped: 'locked'; since: string }> {
  return runLockedPipeline(env, 'buildings-cases-hourly-pipeline', stages);
}
