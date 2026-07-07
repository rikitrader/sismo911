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
import { ingestFunvisis, catchupFunvisis } from './ingest/funvisis-cron';
import { bootstrapHistory } from './ingest/usgs-history';
import { ingestKobo } from './ingest/kobo-cron';
import { announceQuakes } from './ingest/quake-announce';
import { broadcastSismos } from './telegram-sismos/broadcast';
import { readTelegramConfig } from './telegram/env';
import { syncBotCommands } from './telegram/botcommands';
import { ingestSosDamage } from './ingest/sos-damage';
import { dedupePersonas } from './lib/dedupe';
import { ingestSocialMonitor } from './ingest/social-monitor';
import { syncSosSheet } from './lib/sheets-sync';
import { ingestBlog } from './ingest/blog-cron';
import { runRavPipeline } from './ingest/rav-pipeline';
import { runPersonasPipeline } from './ingest/personas-pipeline';
import { runBuildingsCasesPipeline } from './ingest/buildings-cases-pipeline';
import { drain } from './ingest/pipeline';
import { analyzeRavPhotos, backfillPhashes } from './ingest/rav-photos';
import { sweepCaseScores } from './lib/case-score-sync';
import { ingestHospitalRegistry } from './ingest/hospital-registry-sync';
import { sendTelemedReminders } from './ingest/telemed-reminders';
import { ingestCasualties } from './ingest/casualty-cron';
import { runCivisPipeline } from './ingest/civis-pipeline';

export interface CronJob { name: string; run: (env: Env) => Promise<unknown>; }

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
  // :15 — personas-hourly-pipeline: the full personas ingest/clean/dedupe +
  // hospital-match run as ONE named pipeline seat (src/ingest/personas-pipeline.ts),
  // with the ordering explicit inside the pipeline: familia-ingest →
  // civis-edificaciones → clean → name-floods → search-index-backfill →
  // dedupe (extid → exact → photo) → purge-rejected → hospital-match →
  // hospital-registry-match. A KV lock (flock-style, auto-expiring) guarantees
  // two hourly runs can never overlap. Same consolidation pattern as
  // rav-pipeline (:05) and civis-pipeline (:45).
  '15 * * * *': [
    // FUNVISIS catch-up: 1 D1 read when the :00 run succeeded; re-fetches only
    // when the primary run failed (intermittent 403 on CF egress). First seat —
    // seismic data is the most time-sensitive thing on this trigger.
    { name: 'funvisis-catchup-15', run: catchupFunvisis },
    { name: 'personas-hourly-pipeline', run: (env) => runPersonasPipeline(env) },
  ],
  // :30 — buildings-cases-hourly-pipeline: buildings/cases sync, sheet mirrors,
  // photo mirror, hash/dedupe, stalled-import sweep and case alerts run as ONE
  // named pipeline seat (src/ingest/buildings-cases-pipeline.ts), ordered by
  // dependency inside the pipeline: tv-buildings → cases-sheet-sync →
  // tv-building-cases → monitor/hospital sheet mirrors → familia-photo-mirror →
  // phash-backfill → dedupe (fuzzyphone → scored engine) → bulk-import-sweep →
  // case-alerts LAST (freshest state). KV lock prevents overlapping hourly runs.
  '30 * * * *': [
    // FUNVISIS catch-up (see :15 note) — self-skips in 1 D1 read while fresh.
    { name: 'funvisis-catchup-30', run: catchupFunvisis },
    { name: 'buildings-cases-hourly-pipeline', run: (env) => runBuildingsCasesPipeline(env) },
  ],
  // :45 — social/web monitor + AI blog (external-fetch heavy) — now isolated, so
  // it always has a full subrequest budget. This is the job that used to fail.
  // RAV photo analysis (vision + content-hash) + the image-content dedupe ride here.
  '45 * * * *': [
    // FUNVISIS catch-up (see :15 note) — self-skips in 1 D1 read while fresh.
    { name: 'funvisis-catchup-45', run: catchupFunvisis },
    // CIVIS consolidated pipeline (civisvenezuela.com) — ONE seat for what were
    // FOUR jobs against the same upstream (atendidos, desaparecidos, extras,
    // edificaciones), run SEQUENTIALLY and finished with the scored-dedupe pass:
    // fetch → gate-filter/map (inside each source, unchanged) → dedupe. Runs
    // FIRST so its bounded (~50) subrequests land before social/blog draw down
    // the budget. One failing source never blocks the rest.
    { name: 'civis-pipeline', run: (env) => runCivisPipeline(env) },
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
    // FUNVISIS catch-up (see :15 note) — the fastest retry after a failed :00
    // run (5 min), so a 403-blocked hour usually self-heals before :10.
    { name: 'funvisis-catchup-05', run: catchupFunvisis },
    { name: 'history-bootstrap', run: bootstrapHistory },
    // RAV consolidated pipeline — ONE seat for what were SIX same-upstream jobs
    // (rav-ingest, pacientes-rvz, rav-stats, rav-verified, rav-reports+safe,
    // rav-reports-dedupe-extid), run SEQUENTIALLY and finished with the scored
    // dedupe pass: fetch → gate-filter/map (inside each source, unchanged) →
    // dedupe. Same invocation budget as before (all six already shared :05);
    // one failing source never blocks the rest. Twin of civis-pipeline (:45).
    { name: 'rav-pipeline', run: (env) => runRavPipeline(env) },
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
    const started = Date.now();
    try {
      const r = await job.run(env);
      // Always log (even void results) so every job gets a duration line.
      console.log(`[cron:${cron ?? 'all'}] ${job.name} (${Date.now() - started}ms):`, r === undefined ? 'ok' : typeof r === 'object' ? JSON.stringify(r) : r);
    } catch (e: any) {
      const elapsed = Date.now() - started;
      console.error(`[cron:${cron ?? 'all'}] ${job.name} failed (${elapsed}ms):`, e?.message ?? e);
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
              { label: 'Duración', value: `${elapsed}ms` },
              { label: 'Error', value: String(e?.message ?? e).slice(0, 200) },
            ],
          }));
        } catch { /* ignore — alerting must never break the cron loop */ }
      }
    }
  }
}
