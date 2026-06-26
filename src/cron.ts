// SISMO911 — scheduled-job groups.
// ---------------------------------------------------------------------------
// Cloudflare Workers cap subrequests PER invocation (~1000 on paid). The former
// single hourly cron ran ALL ingest/sync jobs in ONE invocation, so the heavy
// ones (familia pipeline, photo mirror, blog) exhausted the budget and the jobs
// near the end (social monitor) failed with "Too many subrequests".
//
// Fix: split the work across SEPARATE cron triggers. Each trigger is its own
// invocation with a fresh subrequest budget. The groups are staggered across the
// hour so every job still runs hourly, just never all in one invocation.
//
// Keep `wrangler.toml [triggers].crons` in sync with the keys of CRON_GROUPS —
// `test/cron.test.ts` asserts they match.

import type { Env } from './types';
import { ingestUsgs } from './ingest/usgs-cron';
import { ingestKobo } from './ingest/kobo-cron';
import { announceQuakes } from './ingest/quake-announce';
import { ingestSosDamage } from './ingest/sos-damage';
import { ingestFamilia, mirrorFamiliaPhotos } from './ingest/familia-cron';
import { cleanPersonas, cleanNameFloods, purgeRejectedPersonas } from './lib/clean';
import { dedupePersonas } from './lib/dedupe';
import { ingestSocialMonitor } from './ingest/social-monitor';
import { syncMonitorSheet, syncSosSheet } from './lib/sheets-sync';
import { ingestBlog } from './ingest/blog-cron';
import { sweepCaseScores } from './lib/case-score-sync';

export interface CronJob { name: string; run: (env: Env) => Promise<unknown>; }

// Convergence helper: re-run a bounded-batch cleanup until it reports nothing
// left (`remaining === 0`) or a pass cap is hit, so a backlog actually DRAINS
// instead of trickling one batch per hour. Safe on the subrequest budget now
// that R2 deletes are bulk (1 subrequest per ≤1000 keys). Returns a summary.
async function drain(
  run: () => Promise<{ remaining?: number; deletedRows?: number; deletedPhotos?: number }>,
  maxPasses = 6,
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

// Cron expression → ordered job list. Stagger across the hour so no single
// invocation carries enough work to approach the subrequest ceiling.
export const CRON_GROUPS: Record<string, CronJob[]> = {
  // :00 — seismic core (time-sensitive, light) + the frugal case-score sweep.
  '0 * * * *': [
    { name: 'usgs', run: ingestUsgs },
    { name: 'kobo', run: ingestKobo },
    { name: 'quake-announce', run: announceQuakes },
    { name: 'sos-damage', run: ingestSosDamage },
    { name: 'case-score-sweep', run: (env) => sweepCaseScores(env) },
    { name: 'sos-sheet', run: syncSosSheet },
  ],
  // :15 — Familia registry ingest + cleanup (D1-heavy, but chunked/batched).
  '15 * * * *': [
    { name: 'familia-ingest', run: ingestFamilia },
    { name: 'personas-clean', run: (env) => cleanPersonas(env, { apply: true }) },
    { name: 'personas-name-floods', run: (env) => cleanNameFloods(env, { apply: true }) },
    // Each cleanup DRAINS to convergence (up to N bounded passes) so backlogs
    // clear over a single tick, not one 400-row batch per hour.
    { name: 'personas-dedupe-exact', run: (env) => drain(() => dedupePersonas(env, { mode: 'exact', apply: true, limit: 400 })) },
    { name: 'personas-dedupe-photo', run: (env) => drain(() => dedupePersonas(env, { mode: 'photo', apply: true, limit: 400 })) },
    // PHYSICALLY drain the soft-rejected backlog (spam/junk flagged just above).
    { name: 'personas-purge-rejected', run: (env) => drain(() => purgeRejectedPersonas(env, { apply: true, limit: 400 })) },
  ],
  // :30 — photo mirroring (external fetch + R2 puts, the heaviest) on its own budget.
  '30 * * * *': [
    { name: 'familia-photo-mirror', run: mirrorFamiliaPhotos },
    { name: 'monitor-sheet', run: syncMonitorSheet },
    // Safe fuzzy dedup: same normalized name + age + phone (near-zero false merges).
    { name: 'personas-dedupe-fuzzyphone', run: (env) => drain(() => dedupePersonas(env, { mode: 'fuzzyphone', apply: true, limit: 400 })) },
  ],
  // :45 — social/web monitor + AI blog (external-fetch heavy) — now isolated, so
  // it always has a full subrequest budget. This is the job that used to fail.
  '45 * * * *': [
    { name: 'social-monitor', run: ingestSocialMonitor },
    { name: 'blog', run: ingestBlog },
  ],
};

// Jobs to run for a fired cron. Unknown/empty cron (e.g. local `wrangler dev`
// or a manual trigger) → run EVERY job once, in group order (full-cycle fallback).
export function jobsForCron(cron: string | undefined): CronJob[] {
  if (cron && CRON_GROUPS[cron]) return CRON_GROUPS[cron];
  return Object.values(CRON_GROUPS).flat();
}

// Run a job group sequentially; one job's failure never aborts the rest.
export async function runCronGroup(cron: string | undefined, env: Env): Promise<void> {
  for (const job of jobsForCron(cron)) {
    try {
      const r = await job.run(env);
      if (r !== undefined) console.log(`[cron:${cron ?? 'all'}] ${job.name}:`, typeof r === 'object' ? JSON.stringify(r) : r);
    } catch (e: any) {
      console.error(`[cron:${cron ?? 'all'}] ${job.name} failed:`, e?.message ?? e);
    }
  }
}
