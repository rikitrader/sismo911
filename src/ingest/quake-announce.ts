import type { Env } from '../types';
import { uid } from '../lib/db';

// Monitor → movement bridge. When a significant NEW quake (M>=THRESHOLD) lands
// in the events table, post an official message to the community channel so the
// monitor and the movement feed each other. De-duped via KV.
const THRESHOLD = 5.5;
const WINDOW_MS = 90 * 60 * 1000; // only consider the last 90 minutes
const KV_KEY = 'mov:announced_quakes';

export async function announceQuakes(env: Env): Promise<number> {
  const since = Date.now() - WINDOW_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, mag, place, place_es, depth_km, time_ms FROM events
     WHERE mag >= ? AND time_ms >= ? ORDER BY time_ms DESC LIMIT 20`
  ).bind(THRESHOLD, since).all<any>();
  if (!results?.length) return 0;

  const seen: string[] = (await env.CACHE.get(KV_KEY, 'json')) ?? [];
  const seenSet = new Set(seen);
  let posted = 0;

  for (const e of results) {
    if (seenSet.has(e.id)) continue;
    const place = e.place_es || e.place || 'Venezuela';
    const depth = e.depth_km != null ? ` · prof ${Math.round(e.depth_km)} km` : '';
    const body = `⚠️ Sismo M${e.mag} — ${place}${depth}. Si lo sentiste, mantén la calma, aléjate de estructuras dañadas y prepárate para réplicas. Guía: sismo911.com/guia`;
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, channel, name, body, role, flagged, created_ms)
       VALUES (?,?,?,?,?,0,?)`
    ).bind(uid('msg'), 'general', 'SISMO911 Monitor', body, 'official', Date.now()).run();
    seenSet.add(e.id);
    posted++;
  }

  if (posted) {
    // keep the last 200 ids
    const next = Array.from(seenSet).slice(-200);
    await env.CACHE.put(KV_KEY, JSON.stringify(next));
  }
  return posted;
}
