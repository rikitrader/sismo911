import type { Env } from '../types';
import { fetchUsgs } from '../lib/usgs';
import { upsertEvents, recordIngest, listEvents } from '../lib/db';
import { logAgentActivity } from '../lib/agent-activity';

// Shared hot-path snapshot for GET /api/events. Named `usgs:latest` for
// historical reasons, but it is source-AGNOSTIC: any ingest source (USGS,
// FUNVISIS, …) can refresh it from D1 so the public feed reflects every source.
export const CACHE_KEY = 'usgs:latest';
// Track the hourly cron sync (+5 min margin) so the parsed/trimmed snapshot
// stays warm for the full hour between syncs. The expensive JSON.parse of the
// global USGS feed then happens ONCE per hour (in the cron), and every public
// read serves this cached snapshot instead of re-deriving it.
export const CACHE_TTL = 3900; // seconds (65 min)

/**
 * Rebuild the shared events snapshot from D1 (ALL sources, newest first) and
 * write it to KV. Call after an ingest whose rows must surface on the public
 * /api/events feed even when the USGS-only snapshot is already warm (e.g.
 * FUNVISIS, which the hourly USGS sync would otherwise overwrite/omit).
 */
export async function refreshEventsCache(env: Env): Promise<number> {
  const events = await listEvents(env, 300);
  await env.CACHE.put(
    CACHE_KEY,
    JSON.stringify({ updated_ms: Date.now(), count: events.length, events }),
    { expirationTtl: CACHE_TTL }
  );
  return events.length;
}

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
    // CRM tracking — only when there's a NEW quake, to avoid hourly empty noise.
    if (written > 0) {
      await logAgentActivity(env, {
        source: 'usgs', action: 'poll', fetched: events.length, created: written,
        summary: `🌎 USGS — ${written} sismo(s) nuevo(s) registrados.`,
      });
    }
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
