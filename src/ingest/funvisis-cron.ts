import type { Env } from '../types';
import { fetchFunvisis } from '../lib/funvisis';
import { upsertEvents, recordIngest } from '../lib/db';
import { refreshEventsCache } from './usgs-cron';

/**
 * Scheduled ingestion of the live FUNVISIS national feed (Venezuela's own
 * seismological service). Upserts into the same `events` table as USGS
 * (source='funvisis'), so the map layers and history queries surface both
 * sources with no extra plumbing.
 *
 * After persisting, it REBUILDS the shared /api/events KV snapshot from D1 so
 * FUNVISIS rows show on the main quakes feed too — the hourly USGS sync writes a
 * USGS-only snapshot, which would otherwise hide FUNVISIS until the next read
 * cold-starts. This job is sequenced right AFTER `usgs` in the :00 cron group,
 * so each tick ends with an all-sources snapshot. Cost is tiny (1 fetch + 1 D1
 * batch + 1 D1 read + 1 KV put) — safe on the subrequest budget.
 */
export async function ingestFunvisis(env: Env): Promise<{ count: number; cached: number }> {
  const now = Date.now();
  try {
    const { events, raw } = await fetchFunvisis(env, now);
    const written = await upsertEvents(env, events, raw);
    const cached = await refreshEventsCache(env);
    await recordIngest(env, 'funvisis', true, written);
    return { count: written, cached };
  } catch (err: any) {
    await recordIngest(env, 'funvisis', false, 0, String(err?.message ?? err));
    throw err;
  }
}
