// SISMO911 — consolidated hourly PERSONAS pipeline (one :15 cron seat).
// ---------------------------------------------------------------------------
// What used to be TEN independent jobs on the '15 * * * *' trigger is now ONE
// named pipeline with the ordering made explicit and dependency-driven:
//
//   ingest (familia, civis-edificaciones) → clean/normalize → enrich/index →
//   dedupe (cheapest/most deterministic first) → purge → hospital matching.
//
// Rationale for the order:
//   - search-index-backfill runs BEFORE the dedupes: bulk importers insert rows
//     without name_norm/geo fields, and the dedupe modes group on those fields.
//   - dedupe order extid → exact → photo: extid (same origen+ext_id) is the
//     documented root cause of bulk duplication and the cheapest most
//     deterministic mode, so it removes rows before the pricier scans run.
//   - purge runs after all dedupes/rejections flagged this tick's junk.
//   - hospital matching runs LAST, against fully cleaned/deduped personas.
//
// Overlap lock: a KV sentinel (env.CACHE) makes two hourly runs mutually
// exclusive — the Workers equivalent of `flock -n /tmp/….lock`. If a previous
// run is still in flight the tick SKIPS (and says so in the cron log) instead
// of racing it. The lock auto-expires (TTL) so a crashed invocation can never
// wedge the pipeline for more than one tick.
//
// Same shape as civis-pipeline (:45) / rav-pipeline (:05): runIngestPipeline
// runs stages SEQUENTIALLY, one failing stage never blocks the rest, and every
// stage's duration (ms) + outcome lands in the logged summary.

import type { Env } from '../types';
import { runLockedPipeline, drain, type PipelineStage, type PipelineSummary } from './pipeline';
import { ingestFamilia } from './familia-cron';
import { ingestCivisEdificaciones } from './civis-edificaciones';
import { cleanPersonas, cleanNameFloods, purgeRejectedPersonas } from '../lib/clean';
import { dedupePersonas } from '../lib/dedupe';
import { backfillSearchFields, reindexRemaining } from '../lib/search-index';
import { backfillHospitalMatches } from './hospital-match';
import { drainHospitalRegistryMatch } from './hospital-registry-match';
import { logAgentActivity, missingStats, missingPhrase } from '../lib/agent-activity';

// Drain the hospital cross-match a bounded number of pages per tick (whole
// registry completes over a few ticks; thereafter it re-scans for new intakes).
async function drainHospitalMatch(env: Env): Promise<{ passes: number; matched: number; phase: string }> {
  let passes = 0, matched = 0, phase = 'personas';
  for (; passes < 10; passes++) {
    const r = await backfillHospitalMatches(env, { pages: 3 });
    matched += r.matched; phase = r.phase;
    if (r.done) { passes++; break; }
  }
  // CRM tracking — one entry per sweep, only when NEW hospital↔desaparecido leads
  // were found (status untouched; each is a pending docket note for verification).
  if (matched > 0) {
    const m = await missingStats(env);
    await logAgentActivity(env, {
      source: 'hospital-match', action: 'match', matched, stillMissing: m.total, stillUnique: m.unique,
      summary: `🏥 Cruce hospitalario — ${matched} nueva(s) coincidencia(s) desaparecido↔ingreso (nota pendiente de verificación). ${missingPhrase(m)}.`,
    });
  }
  return { passes, matched, phase };
}

/** Ordered stages — ingest → clean → index → dedupe → purge → match. */
export const PERSONAS_STAGES: PipelineStage[] = [
  // 1-2 · Ingest. familia is the primary missing-persons registry; the CIVIS
  // edificaciones pull rides here (moved from the :45 CIVIS pipeline) so
  // building data is fresh before this tick's hospital/case matching.
  { name: 'familia-ingest', run: ingestFamilia },
  { name: 'civis-edificaciones', run: ingestCivisEdificaciones },
  // 3-4 · Clean/normalize what the ingest just wrote.
  { name: 'personas-clean', run: (env) => cleanPersonas(env, { apply: true }) },
  { name: 'personas-name-floods', run: (env) => cleanNameFloods(env, { apply: true }) },
  // 5 · Enrich/index: populate name_norm / geo_* / age_num for any row a bulk
  // write path left un-indexed — the dedupes below group on these fields.
  { name: 'search-index-backfill', run: (env) => drain(async () => { const p = await backfillSearchFields(env, 400); return { remaining: await reindexRemaining(env), deletedRows: p.total }; }) },
  // 6-8 · Dedupe, cheapest/most deterministic first. Each DRAINS to convergence.
  { name: 'personas-dedupe-extid', run: (env) => drain(() => dedupePersonas(env, { mode: 'extid', apply: true, limit: 400 })) },
  { name: 'personas-dedupe-exact', run: (env) => drain(() => dedupePersonas(env, { mode: 'exact', apply: true, limit: 400 })) },
  { name: 'personas-dedupe-photo', run: (env) => drain(() => dedupePersonas(env, { mode: 'photo', apply: true, limit: 400 })) },
  // 9 · PHYSICALLY drain the soft-rejected backlog (spam/junk flagged above).
  { name: 'personas-purge-rejected', run: (env) => drain(() => purgeRejectedPersonas(env, { apply: true, limit: 400 })) },
  // 10-11 · Cross-matching, now against clean deduped data.
  { name: 'hospital-match', run: (env) => drainHospitalMatch(env) },
  { name: 'hospital-registry-match', run: (env) => drainHospitalRegistryMatch(env) },
];

/** One :15 seat: flock-style KV lock around the sequential stage run. */
export async function runPersonasPipeline(env: Env, stages: PipelineStage[] = PERSONAS_STAGES): Promise<PipelineSummary | { skipped: 'locked'; since: string }> {
  return runLockedPipeline(env, 'personas-hourly-pipeline', stages);
}
