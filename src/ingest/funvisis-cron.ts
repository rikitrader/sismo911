import type { Env } from '../types';
import { fetchFunvisis } from '../lib/funvisis';
import { upsertEvents, recordIngest, type IngestLogRow } from '../lib/db';
import { refreshEventsCache } from './usgs-cron';
import { dedupeCrossSource } from '../lib/dedupe-seismic';

// FUNVISIS's server intermittently 403s Cloudflare egress IPs (transient — the
// next tick usually succeeds). A single missed hourly tick is NOT an incident:
// only alert (throw → SYS-02 email) when the feed has produced no data for this
// long. Below that, a failed attempt records to ingest_log and returns quietly.
const ALERT_AFTER_MS = 3 * 60 * 60 * 1000;   // matches classifyIngestHealth STALE_AFTER_MS

// Catch-up freshness window: the :00 seat is the primary run; the catch-up
// seats on the other triggers (:05/:15/:30/:45) only re-attempt when the last
// success is older than this (i.e. the primary run failed or was skipped).
const FRESH_MS = 55 * 60 * 1000;

async function readFunvisisLog(env: Env): Promise<IngestLogRow | null> {
  return env.DB.prepare(`SELECT * FROM ingest_log WHERE source='funvisis'`)
    .first<IngestLogRow>().catch(() => null);
}

/**
 * Scheduled ingestion of the live FUNVISIS national feed (Venezuela's own
 * seismological service). Upserts into the same `events` table as USGS
 * (source='funvisis'), so the map layers and history queries surface both
 * sources with no extra plumbing.
 *
 * Pipeline (runs right AFTER `usgs` in the :00 cron group):
 *   fetch → upsert → cross-source dedup → rebuild the shared snapshot.
 * The dedup marks USGS/FUNVISIS rows that are the same physical quake
 * (`dup_of`) BEFORE the cache is rebuilt, so the /api/events snapshot the USGS
 * job wrote USGS-only is replaced with the de-duplicated all-sources set — and
 * FUNVISIS-only quakes (the ones USGS misses) still show. Cost is tiny (1 fetch
 * + a few D1 statements + 1 KV put) — safe on the subrequest budget.
 */
export async function ingestFunvisis(env: Env): Promise<
  { count: number; deduped: number; divergences: number; borderline: number; cached: number }
  | { softFail: string; lastOkAgeMin: number | null }
> {
  const now = Date.now();
  try {
    const { events, raw } = await fetchFunvisis(env, now);
    const written = await upsertEvents(env, events, raw);
    const dd = await dedupeCrossSource(env);
    const cached = await refreshEventsCache(env);
    await recordIngest(env, 'funvisis', true, written);
    // Self-monitoring sanity check (replaces the old local launchd job): persist
    // the latest dedup health to KV so /api/status can show whether the tuned
    // tolerances still cover the data. `borderline` = pairs a WIDE pass catches
    // that production tolerances miss — the "is the tuning still right?" signal.
    await env.CACHE.put('dedupe:sanity', JSON.stringify({
      checked_ms: now,
      scanned: dd.scanned,
      prod_pairs: dd.pairs,
      wide_pairs: dd.pairs + dd.borderline.length,
      borderline: dd.borderline.map((p) => ({
        keep: `${p.keepSource}:${p.keepId}`, drop: `${p.dropSource}:${p.dropId}`,
        dtMs: p.dtMs, distKm: p.distKm, dMag: p.dMag,
      })),
    }), { expirationTtl: 8 * 86_400 });
    // Surface magnitude disagreements between agencies on the same quake — a
    // data-quality signal worth seeing in the logs (and /api/status counts them).
    if (dd.divergences.length) {
      console.warn(`[funvisis] cross-source magnitude divergence on ${dd.divergences.length} pair(s):`,
        JSON.stringify(dd.divergences.map((d) => ({ keep: d.keepId, drop: d.dropId, dMag: d.dMag }))));
    }
    // Drift alarm: production tolerances are missing pairs a wider window catches.
    if (dd.borderline.length) {
      console.warn(`[funvisis] dedup SANITY: ${dd.borderline.length} borderline pair(s) beyond prod tolerances — review src/lib/dedupe-seismic.ts DEFAULTS:`,
        JSON.stringify(dd.borderline.map((p) => ({ keep: p.keepId, drop: p.dropId, dtMs: p.dtMs, distKm: p.distKm }))));
    }
    return { count: written, deduped: dd.marked, divergences: dd.divergences.length, borderline: dd.borderline.length, cached };
  } catch (err: any) {
    // recordIngest preserves last_ok_ms on failure, so the row read below still
    // reflects the last real success.
    await recordIngest(env, 'funvisis', false, 0, String(err?.message ?? err));
    const row = await readFunvisisLog(env);
    const okAge = row?.last_ok_ms ? now - row.last_ok_ms : null;
    if (okAge !== null && okAge < ALERT_AFTER_MS) {
      // Transient failure with fresh data on hand: log it, skip the SYS-02
      // email. The catch-up seats on the other triggers retry within minutes.
      console.warn(`[funvisis] transient failure (${String(err?.message ?? err)}); last success ${Math.round(okAge / 60000)}min ago — no alert`);
      return { softFail: String(err?.message ?? err), lastOkAgeMin: Math.round(okAge / 60000) };
    }
    throw err;
  }
}

/**
 * Catch-up seat for the OTHER cron triggers (:05/:15/:30/:45). The account is
 * capped at 5 cron triggers, so instead of a dedicated retry schedule the
 * funvisis ingest rides every existing trigger and self-skips while fresh:
 * steady-state cost is ONE D1 read per tick. Only when the :00 primary run
 * failed (FUNVISIS 403 on CF egress) does a catch-up actually re-fetch — so a
 * blocked hour self-heals at the next 5/15/30/45-minute mark instead of
 * leaving a data gap until the next hour.
 */
export async function catchupFunvisis(env: Env): Promise<unknown> {
  const row = await readFunvisisLog(env);
  const okAge = row?.last_ok_ms ? Date.now() - row.last_ok_ms : null;
  if (okAge !== null && okAge < FRESH_MS) {
    return { skipped: 'fresh', lastOkAgeMin: Math.round(okAge / 60000) };
  }
  return ingestFunvisis(env);
}
