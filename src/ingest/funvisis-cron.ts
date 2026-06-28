import type { Env } from '../types';
import { fetchFunvisis } from '../lib/funvisis';
import { upsertEvents, recordIngest } from '../lib/db';
import { refreshEventsCache } from './usgs-cron';
import { dedupeCrossSource } from '../lib/dedupe-seismic';

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
export async function ingestFunvisis(env: Env): Promise<{ count: number; deduped: number; divergences: number; borderline: number; cached: number }> {
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
    await recordIngest(env, 'funvisis', false, 0, String(err?.message ?? err));
    throw err;
  }
}
