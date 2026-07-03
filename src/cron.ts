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
import { sendEmail } from './lib/email';
import { operationalAlert } from './lib/email-catalog';
import { ingestUsgs } from './ingest/usgs-cron';
import { ingestFunvisis } from './ingest/funvisis-cron';
import { bootstrapHistory } from './ingest/usgs-history';
import { ingestKobo } from './ingest/kobo-cron';
import { announceQuakes } from './ingest/quake-announce';
import { broadcastSismos } from './telegram-sismos/broadcast';
import { readTelegramConfig } from './telegram/env';
import { syncBotCommands } from './telegram/botcommands';
import { ingestSosDamage } from './ingest/sos-damage';
import { ingestFamilia, mirrorFamiliaPhotos } from './ingest/familia-cron';
import { cleanPersonas, cleanNameFloods, purgeRejectedPersonas } from './lib/clean';
import { dedupePersonas, dedupeRavReports } from './lib/dedupe';
import { backfillSearchFields, reindexRemaining } from './lib/search-index';
import { ingestSocialMonitor } from './ingest/social-monitor';
import { syncMonitorSheet, syncSosSheet, syncHospitalSheet } from './lib/sheets-sync';
import { syncCasesSheetToD1 } from './sync/sheet-source';
import { ingestBlog } from './ingest/blog-cron';
import { ingestRav, ingestRavStats, ingestRavVerified, ingestRavReports, ingestRavSafe } from './ingest/rav-cron';
import { analyzeRavPhotos, backfillPhashes } from './ingest/rav-photos';
import { sweepCaseScores } from './lib/case-score-sync';
import { backfillHospitalMatches } from './ingest/hospital-match';
import { drainHospitalRegistryMatch } from './ingest/hospital-registry-match';
import { ingestHospitalRegistry } from './ingest/hospital-registry-sync';
import { ingestCivisAtendidos } from './ingest/civis-atendidos';
import { ingestCivisDesaparecidos } from './ingest/civis-desaparecidos';
import { ingestTvBuildings } from './ingest/tv-buildings-cron';
import { ingestPacientesRvz } from './ingest/pacientes-rvz-cron';
import { ingestCivisExtras } from './ingest/civis-extras';
import { ingestCivisEdificaciones } from './ingest/civis-edificaciones';
import { logAgentActivity, missingStats, missingPhrase } from './lib/agent-activity';
import { sendTelemedReminders } from './ingest/telemed-reminders';
import { ingestCasualties } from './ingest/casualty-cron';
import { sweepBulkJobs } from './bulk/import-job';
import { runCaseAlerts } from './ingest/case-alerts';
import { runBuildingCasesLink } from './lib/building-cases';

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

export interface CronJob { name: string; run: (env: Env) => Promise<unknown>; }

// Convergence helper: re-run a bounded-batch cleanup until it reports nothing
// left (`remaining === 0`) or a pass cap is hit, so a backlog actually DRAINS
// instead of trickling one batch per hour. Safe on the subrequest budget now
// that R2 deletes are bulk (1 subrequest per ≤1000 keys). Returns a summary.
// maxPasses is the burst ceiling, NOT the steady-state cost: every pass that
// finds nothing left early-breaks (remaining===0), so a quiet tick does ~1 pass.
// It only engages when a RAV-ingest burst leaves a big backlog — at 400 rows/pass
// the old 6-pass cap (2,400/tick) couldn't outrun the firehose, so same-photo /
// exact-resubmission duplicates stayed visible on /personas for hours. 16 passes
// (6,400 rows/tick) drains a typical burst in one tick. Safe on the subrequest
// budget: each pass is ~1 SELECT + ≤5 chunked D1 DELETEs + 1 BULK R2 delete.
async function drain(
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

// Cron expression → ordered job list. Stagger across the hour so no single
// invocation carries enough work to approach the subrequest ceiling.
export const CRON_GROUPS: Record<string, CronJob[]> = {
  // :00 — seismic core (time-sensitive, light) + the frugal case-score sweep.
  '0 * * * *': [
    { name: 'usgs', run: ingestUsgs },
    // FUNVISIS (Venezuela's own seismic service) right after USGS: it upserts
    // into the same `events` table AND rebuilds the all-sources /api/events
    // snapshot the USGS job just wrote USGS-only, so both feeds render together.
    { name: 'funvisis', run: ingestFunvisis },
    { name: 'kobo', run: ingestKobo },
    { name: 'quake-announce', run: announceQuakes },
    { name: 'sos-damage', run: ingestSosDamage },
    { name: 'case-score-sweep', run: (env) => sweepCaseScores(env) },
    // Pull + re-ingest the hospital patient registry every 6h (idempotent; bounded
    // subrequests). No-op when HOSPITAL_FEED_URL is unset.
    { name: 'hospital-registry-sync', run: (env) => (new Date().getUTCHours() % 6 === 0 ? ingestHospitalRegistry(env) : Promise.resolve({ skipped: true })) },
    { name: 'sos-sheet', run: syncSosSheet },
    { name: 'telemed-reminders', run: sendTelemedReminders },
  ],
  // :15 — Familia registry ingest + cleanup (D1-heavy, but chunked/batched).
  '15 * * * *': [
    { name: 'familia-ingest', run: ingestFamilia },
    { name: 'personas-clean', run: (env) => cleanPersonas(env, { apply: true }) },
    { name: 'personas-name-floods', run: (env) => cleanNameFloods(env, { apply: true }) },
    // Structured-search backfill (name_norm / geo_estado / geo_municipio) — a
    // standalone maintenance rule that DRAINS to convergence exactly like the
    // personas-dedupe-* rules below. Manual + citizen writes set these fields
    // inline, but the BULK importers (familia/RAV/CIVIS sync) insert WITHOUT them,
    // so those rows accumulate NULL name_norm and fall out of name search + dedupe
    // (a prior cron rebalance dropped this job, leaving ~124k rows unindexed).
    // Covers personas + persons + hospital.
    { name: 'search-index-backfill', run: (env) => drain(async () => { const p = await backfillSearchFields(env, 400); return { remaining: await reindexRemaining(env), deletedRows: p.total }; }) },
    // Each cleanup DRAINS to convergence (up to N bounded passes) so backlogs
    // clear over a single tick, not one 400-row batch per hour.
    { name: 'personas-dedupe-exact', run: (env) => drain(() => dedupePersonas(env, { mode: 'exact', apply: true, limit: 400 })) },
    { name: 'personas-dedupe-photo', run: (env) => drain(() => dedupePersonas(env, { mode: 'photo', apply: true, limit: 400 })) },
    // Same upstream id re-imported under different namespaced `id`s (the RAV/familia
    // sync upserts on `id`, so it never catches this). Groups by (origen, ext_id) —
    // the root cause of the bulk personas duplication. Convergent drain.
    { name: 'personas-dedupe-extid', run: (env) => drain(() => dedupePersonas(env, { mode: 'extid', apply: true, limit: 400 })) },
    // PHYSICALLY drain the soft-rejected backlog (spam/junk flagged just above).
    { name: 'personas-purge-rejected', run: (env) => drain(() => purgeRejectedPersonas(env, { apply: true, limit: 400 })) },
    // Cross-match desaparecidos ↔ hospital intakes → persisted matches + pending
    // docket notes (status untouched). Drains the registry, then re-scans for new intakes.
    { name: 'hospital-match', run: (env) => drainHospitalMatch(env) },
    // Cross-reference the hospital_patients REGISTRY ↔ cases: link + tracer note
    // (cédula-confirmed → auto status). Cursor-drained, converges over ticks.
    { name: 'hospital-registry-match', run: (env) => drainHospitalRegistryMatch(env) },
    // CIVIS satellite damage + live stats — HOURLY. /api/edificaciones →
    // sat_edificaciones (Copernicus EMS verified + Microsoft AI4G, ~975 rows)
    // + /api/estadisticas + /api/panorama → civis_stats_snapshots. Feeds
    // /panorama and the Satélite section on /edificios. Light: ~3 fetches +
    // ~11 D1 batches. Seated here (:05 is at the 10-job group cap). Lifts the
    // PR #607 deferral of /api/edificaciones as its own evidence class.
    { name: 'civis-edificaciones', run: ingestCivisEdificaciones },
  ],
  // :30 — photo mirroring (external fetch + R2 puts, the heaviest) plus the
  // sheet sync and fuzzyphone dedupe. Keep RAV off this trigger: together these
  // jobs can exceed the Free-plan subrequest cap before RAV gets its turn.
  '30 * * * *': [
    // Buildings ↔ cases auto-linker. Runs FIRST in the group: it needs only
    // ~5-10 subrequests (2 registry reads + chunked INSERT OR IGNORE batches)
    // but a few seconds of CPU for the name-token match — at the TAIL of this
    // group (as part of tv-buildings) the invocation died before it could run.
    { name: 'tv-building-cases', run: runBuildingCasesLink },
    { name: 'familia-photo-mirror', run: mirrorFamiliaPhotos },
    { name: 'monitor-sheet', run: syncMonitorSheet },
    // Mirror the hospital_patients registry (Cruz Roja + CIVIS) into the Sheet's
    // "Hospital" tab. No-op without HOSPITAL_SHEET_ID/MONITOR_SHEET_ID + Google creds.
    { name: 'hospital-sheet', run: syncHospitalSheet },
    // Sheet-as-source-of-truth: pull the curated "Casos CRM" sheet into D1 (one
    // bounded 4k-row pass per tick, drains via KV cursor; dedup runs on wrap).
    // No-op until CASES_SHEET_ID + GOOGLE_* creds are set.
    { name: 'cases-sheet-sync', run: syncCasesSheetToD1 },
    // Email subscribers when a case they follow changes (status / new verified
    // lead / data). Scans only cases with active subs; the AI summary + email
    // send fire ONLY on a real change, so a quiet tick is ~cheap D1 reads. Rides
    // :30 (4 jobs, ample subrequest budget) rather than the full :00 group.
    { name: 'case-alerts', run: (env) => runCaseAlerts(env) },
    // Safe fuzzy dedup: same normalized name + age + phone (near-zero false merges).
    { name: 'personas-dedupe-fuzzyphone', run: (env) => drain(() => dedupePersonas(env, { mode: 'fuzzyphone', apply: true, limit: 400 })) },
    // 2nd phash-backfill slot (batch 400). Adding the backfill to 3 hourly groups
    // (:05/:30/:45) is how we go faster WITHOUT a 6th cron (account caps at 5).
    // :30 has budget: familia-photo-mirror is only ~50 fetches (~100 subrequests).
    { name: 'personas-phash-backfill-30', run: (env) => backfillPhashes(env, 400) },
    // Bulk roster importer backstop: start any 'pending' job whose ingest tick
    // died before waitUntil ran it, and flag long-stuck 'processing' jobs as
    // error. Cheap D1-only when idle (a couple of indexed reads).
    { name: 'bulk-import-sweep', run: (env) => sweepBulkJobs(env) },
    // Hourly mirror of terremotovenezuela.com's damaged-buildings map (real
    // citizen field reports WITH photo galleries) into tv_buildings. Light:
    // 1 external fetch of ~795 rows + chunked D1 upserts; idempotent (upsert on id).
    { name: 'tv-buildings', run: ingestTvBuildings },
  ],
  // :45 — social/web monitor + AI blog (external-fetch heavy) — now isolated, so
  // it always has a full subrequest budget. This is the job that used to fail.
  // RAV photo analysis (vision + content-hash) + the image-content dedupe ride here.
  '45 * * * *': [
    // CIVIS atendidos (civisvenezuela.com) — HOURLY. Pulls the newest hospital feed
    // + a rotating slice of centros (KV cursor) into hospital_patients as name-deduped
    // profiles. Runs FIRST here so its bounded (~28) subrequests land before the
    // heavier social/blog jobs draw down the invocation budget.
    { name: 'civis-atendidos', run: ingestCivisAtendidos },
    // CIVIS desaparecidos (civisvenezuela.com) — HOURLY. Pages the missing-persons
    // registry (limit=100+offset KV cursor) into `personas` as new/updated rows;
    // photos auto-mirror to R2 via familia-photo-mirror + dedupe crons. Also
    // refreshes the Sheet "Desaparecidos" tab. Bounded (~10 subreq/tick).
    { name: 'civis-desaparecidos', run: ingestCivisDesaparecidos },
    { name: 'social-monitor', run: ingestSocialMonitor },
    { name: 'blog', run: ingestBlog },
    // Trailing casualty (fallecidos/heridos/desaparecidos) poller. Self-throttles
    // to every 3h (UTC hour % 3) INSIDE the job — the account is capped at 5 cron
    // triggers (all used), so we ride :45 instead of adding a 6th schedule. Light
    // (≤3 external fetches, only on the 3h tick); every figure passes gateCasualty.
    { name: 'casualties', run: ingestCasualties },
    { name: 'rav-photos', run: (env) => analyzeRavPhotos(env) },
    // Cheap (AI-free) content-hash backfill for R2-mirrored photos, run RIGHT
    // BEFORE the phash dedupe so this tick's freshly hashed rows are deduped in
    // the same invocation. analyzeRavPhotos only hashes 24/tick (welded to the
    // slow vision call); this drains the ~17k mirrored backlog in days, not
    // months — without it the phash mode below has almost nothing to group on.
    { name: 'personas-phash-backfill', run: (env) => backfillPhashes(env, 150) },
    { name: 'personas-dedupe-phash', run: (env) => drain(() => dedupePersonas(env, { mode: 'phash', apply: true, limit: 400 })) },
    // Perceptual-hash dedupe (collapses re-encoded same-image dups the byte-hash
    // misses). photo_dhash is populated by the local scripts/dhash-photos-local.mjs
    // (Workers can't decode JPEG); this cron only does the SQL GROUP/delete, which
    // is safe-guarded to small clusters (2..6) so shared placeholders never merge.
    { name: 'personas-dedupe-dhash', run: (env) => drain(() => dedupePersonas(env, { mode: 'dhash', apply: true, limit: 400 })) },
    // Register/refresh the Telegram command menu (BotFather setMyCommands).
    // KV-guarded by COMMANDS_VERSION: a single KV read in steady state, ~5
    // Telegram fetches only on the first tick after a version bump. No-op until
    // the case-status bot is configured.
    { name: 'botcommands-sync', run: async (env) => { const cfg = readTelegramConfig(env); return cfg ? syncBotCommands(env, cfg) : { skipped: true }; } },
  ],
  // :05 — one-time historical-archive bootstrap. Self-disabling via a KV flag
  // (`history:bootstrapped`): on a fresh/empty D1 it runs the full USGS backfill
  // once; once populated it's a single KV read. RAV rides this existing trigger
  // to stay away from the :30 cleanup/mirror group without adding a sixth
  // account-level cron schedule.
  '5 * * * *': [
    { name: 'history-bootstrap', run: bootstrapHistory },
    { name: 'rav-ingest', run: (env) => ingestRav(env) },
    // reportesvenezuela.com /pacientes.json (CC0): hospital intakes (ingresados)
    // upserted as rav_reports kind='hospital'. The :15 hospital-match cron then
    // cross-matches our desaparecidos against these by name → leads + docket
    // notes. Light (1 fetch; skips the bulk upsert when the snapshot is unchanged).
    { name: 'pacientes-rvz', run: ingestPacientesRvz },
    { name: 'rav-stats', run: ingestRavStats },
    { name: 'rav-verified', run: ingestRavVerified },
    // RAV extra datasets: citizen reports (pets/volunteers/trapped/aid/damage) +
    // "estoy a salvo" check-ins. Both bounded + UPSERT-keyed (no dupes); one job.
    { name: 'rav-reports-safe', run: async (env) => ({ reports: await ingestRavReports(env), safe: await ingestRavSafe(env) }) },
    // Collapse rav_reports re-imported under different `id`s (559 dup ext_id groups
    // / ~2,526 redundant rows found in the audit). Runs right after the rav ingest
    // so each tick's fresh dupes are caught in the same invocation. Convergent.
    { name: 'rav-reports-dedupe-extid', run: (env) => drain(() => dedupeRavReports(env, { apply: true, limit: 400 })) },
    // 3rd phash-backfill slot (batch 400). :05's rav ingest is bounded (Supabase
    // REST pages), so there's budget. Together :05+:30+:45 hash ~950/hr → the
    // one-time ~58k backlog drains in ~2.6 days (vs ~16 at the :45-only 150/tick).
    { name: 'personas-phash-backfill-05', run: (env) => backfillPhashes(env, 400) },
    // Push new significant quakes to the live-seismic Telegram bot's subscribers.
    // Runs 5 min after the :00 USGS/FUNVISIS ingest so alerts are fresh. No-op
    // until the bot is configured; KV-deduped, independent of quake-announce.
    { name: 'sismos-bot-broadcast', run: broadcastSismos },
    // CIVIS auxiliary feeds — HOURLY. /api/reportes/publicos → sos_damage (citizen
    // damage reports w/ photos+geo) + /api/puntos → civis_puntos (aid/collection
    // points). Both idempotent UPSERTs, ~3 fetches total. Rides :05 (external-pull group).
    { name: 'civis-extras', run: ingestCivisExtras },
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
      // SYS-02: job-failure alert to the ops distribution (only if configured).
      // Best-effort + isolated — a mail failure must never abort the cron loop,
      // and this is the rare (catch) path so it adds no steady-state subrequests.
      if (env.OPS_ALERT_EMAIL) {
        try {
          await sendEmail(env, env.OPS_ALERT_EMAIL, operationalAlert({
            subject: `[SISMO911-SYS] Trabajo fallido — ${job.name}`,
            eyebrow: 'Sistema · Trabajos',
            heading: 'Trabajo programado fallido.',
            roleTag: 'SISTEMA',
            paras: ['Un trabajo programado (cron) falló. Revisa los registros del Worker.'],
            details: [
              { label: 'Trabajo', value: job.name },
              { label: 'Grupo', value: cron ?? 'all' },
              { label: 'Error', value: String(e?.message ?? e).slice(0, 200) },
            ],
          }));
        } catch { /* ignore — alerting must never break the cron loop */ }
      }
    }
  }
}
