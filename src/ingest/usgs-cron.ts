import type { Env } from '../types';
import { fetchUsgs } from '../lib/usgs';
import { upsertEvents, recordIngest } from '../lib/db';

const CACHE_KEY = 'usgs:latest';
const CACHE_TTL = 120; // seconds

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
