import type { Env } from '../types';
import { fetchUsgs } from '../lib/usgs';
import { upsertEvents, recordIngest } from '../lib/db';

const CACHE_KEY = 'usgs:latest';
// Track the hourly cron sync (+5 min margin) so the parsed/trimmed snapshot
// stays warm for the full hour between syncs. The expensive JSON.parse of the
// global USGS feed then happens ONCE per hour (in the cron), and every public
// read serves this cached snapshot instead of re-deriving it.
const CACHE_TTL = 3900; // seconds (65 min)

/**
 * Scheduled ingestion: pull the live USGS feed for Venezuela, cache the
 * normalized payload in KV (hot path for the API), and upsert into D1
 * (durable history + joins with persons/reports).
 */
export async function ingestUsgs(env: Env): Promise<{ count: number }> {
  const now = Date.now();
  try {
    const { events, raw } = await fetchUsgs(env, now);
    await env.CACHE.put(
      CACHE_KEY,
      JSON.stringify({ updated_ms: now, count: events.length, events }),
      { expirationTtl: CACHE_TTL }
    );
    const written = await upsertEvents(env, events, raw);
    await recordIngest(env, 'usgs', true, written);
    return { count: written };
  } catch (err: any) {
    await recordIngest(env, 'usgs', false, 0, String(err?.message ?? err));
    throw err;
  }
}

export async function getCachedEvents(env: Env): Promise<any | null> {
  const hit = await env.CACHE.get(CACHE_KEY, 'json');
  return hit;
}
