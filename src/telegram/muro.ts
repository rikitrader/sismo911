// SISMO911 — Telegram bot ↔ Muro de Emergencia bridge.
// ---------------------------------------------------------------------------
// Connects the bot to the public wall at /muro (chat_messages, channel
// 'terremotos'). Two directions:
//   • WRITE: /muro <texto> posts to the wall as the Telegram sender, reusing
//     the wall's own hygiene (sanitizeHtml + 600-char cap). The web CAPTCHA/
//     honeypot are anti-bot measures for the anonymous web form; the Telegram
//     path is instead gated upstream by group authorization + rate limiting.
//   • READ: name searches surface recent wall posts mentioning that name, and
//     /muro with no text returns the latest wall posts.
// Wall content is fully public — nothing here touches the case registries, so
// no redaction tier applies.

import type { Env } from '../types';
import { uid } from '../lib/db';
import { sanitizeHtml } from '../lib/sanitize';

export const MURO_CHANNEL = 'terremotos';
export const MURO_MAX_LEN = 600; // same cap the web wall enforces
const MENTIONS_MAX = 3;
const LATEST_MAX = 5;

/** A public wall post as surfaced in a Telegram reply. */
export interface MuroPost {
  id: string;
  name: string;
  body: string;
  createdMs: number;
}

export type MuroPostResult =
  | { kind: 'muro_ok'; id: string; name: string }
  | { kind: 'muro_too_long'; max: number }
  | { kind: 'muro_empty' }
  | { kind: 'muro_error' };

/** Display name for a Telegram sender, mirroring the wall's 'Anónimo' default. */
export function muroDisplayName(from?: { first_name?: string; username?: string } | null): string {
  const n = (from?.first_name || from?.username || '').trim();
  return (n || 'Anónimo').slice(0, 60);
}

/**
 * Post a text message to the public wall on behalf of a Telegram user.
 * Same row shape the web form writes (role 'citizen', no photo, no user_id).
 */
export async function postToMuro(env: Env, input: { name: string; text: string }): Promise<MuroPostResult> {
  const text = (input.text ?? '').trim();
  if (!text) return { kind: 'muro_empty' };
  if (text.length > MURO_MAX_LEN) return { kind: 'muro_too_long', max: MURO_MAX_LEN };
  const safeBody = sanitizeHtml(text);
  const name = (input.name || 'Anónimo').slice(0, 60);
  const id = uid('msg');
  try {
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, channel, name, body, role, image_key, user_id, flagged, created_ms)
       VALUES (?,?,?,?,?,NULL,NULL,0,?)`
    ).bind(id, MURO_CHANNEL, name, safeBody, 'citizen', Date.now()).run();
    return { kind: 'muro_ok', id, name };
  } catch {
    return { kind: 'muro_error' };
  }
}

/**
 * Recent wall posts mentioning a name (case-insensitive substring), newest
 * first. Only ever reads the public wall channel — never a case registry.
 */
export async function searchMuroMentions(env: Env, name: string, limit = MENTIONS_MAX): Promise<MuroPost[]> {
  const q = (name ?? '').trim();
  if (q.length < 3) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, body, created_ms FROM chat_messages
       WHERE channel = ? AND flagged = 0 AND body LIKE ? COLLATE NOCASE
       ORDER BY created_ms DESC LIMIT ?`
    ).bind(MURO_CHANNEL, `%${q}%`, limit).all();
    return rowsToPosts(results);
  } catch {
    return [];
  }
}

/** Latest wall posts (for a bare /muro), newest first. */
export async function latestMuroPosts(env: Env, limit = LATEST_MAX): Promise<MuroPost[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, body, created_ms FROM chat_messages
       WHERE channel = ? AND flagged = 0
       ORDER BY created_ms DESC LIMIT ?`
    ).bind(MURO_CHANNEL, limit).all();
    return rowsToPosts(results);
  } catch {
    return [];
  }
}

function rowsToPosts(results: unknown): MuroPost[] {
  return ((results as any[]) ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? 'Anónimo'),
    body: String(r.body ?? ''),
    createdMs: Number(r.created_ms ?? 0),
  }));
}
