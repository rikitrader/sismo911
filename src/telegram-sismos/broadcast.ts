// SISMO911 — Live-seismic Telegram bot: push broadcaster.
// ---------------------------------------------------------------------------
// Called from the seismic cron group right after USGS/FUNVISIS ingest. Finds
// NEW significant quakes (M ≥ THRESHOLD in the last window) that haven't been
// pushed yet (KV-deduped, mirroring quake-announce.ts), formats an alert, and
// fans it out to every /suscribir-ed chat. No-op when the bot isn't configured.

import type { Env } from '../types';
import { formatQuakeAlert } from './format';

const THRESHOLD = 4.5; // M≥4.5 is "felt / worth an alert" for VE
const WINDOW_MS = 3 * 60 * 60 * 1000; // consider quakes from the last 3h
const KV_KEY = 'sismosbot:announced'; // separate from mov:announced_quakes
const TG_API = 'https://api.telegram.org';

/** Send one message to a chat; best-effort, never throws. */
async function send(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface BroadcastReport {
  quakes: number;
  subscribers: number;
  sent: number;
  skipped?: string;
}

export async function broadcastSismos(env: Env): Promise<BroadcastReport> {
  const token = (env as any).SISMOS_BOT_TOKEN as string | undefined;
  if (!token) return { quakes: 0, subscribers: 0, sent: 0, skipped: 'not-configured' };

  const since = Date.now() - WINDOW_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, mag, place, place_es, depth_km, mmi, alert, tsunami, time_ms, url
       FROM events
      WHERE mag >= ? AND time_ms >= ? AND dup_of IS NULL
      ORDER BY time_ms ASC LIMIT 20`,
  ).bind(THRESHOLD, since).all<any>();
  const quakes = results ?? [];
  if (!quakes.length) return { quakes: 0, subscribers: 0, sent: 0 };

  const seen: string[] = (await env.CACHE.get(KV_KEY, 'json')) ?? [];
  const seenSet = new Set(seen);
  const fresh = quakes.filter((e) => !seenSet.has(e.id));
  if (!fresh.length) return { quakes: 0, subscribers: 0, sent: 0 };

  const subsRes = await env.DB.prepare(`SELECT chat_id FROM sismos_bot_subs`).all<any>();
  const subs = (subsRes.results ?? []).map((r) => String(r.chat_id));

  const baseUrl = (env as any).PUBLIC_BASE_URL || 'https://sismo911.com';
  let sent = 0;
  for (const e of fresh) {
    const text = formatQuakeAlert(e, baseUrl);
    for (const chatId of subs) {
      if (await send(token, chatId, text)) sent++;
      await new Promise((r) => setTimeout(r, 40)); // gentle global pacing
    }
    seenSet.add(e.id);
  }

  // Keep the last 300 announced ids (mirrors quake-announce's bounded cache).
  await env.CACHE.put(KV_KEY, JSON.stringify(Array.from(seenSet).slice(-300)));
  return { quakes: fresh.length, subscribers: subs.length, sent };
}
