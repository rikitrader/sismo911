import type { Context } from 'hono';
import type { Env } from '../types';

// Step-up (re-confirmation) for sensitive actions. When a user enables
// sec_require_login, sensitive mutating endpoints require a RECENT password
// confirmation. The confirmation is a short-lived flag in KV keyed by user id;
// it is NOT a bearer token the client holds — the server checks the flag.
const TTL_SECONDS = 300; // 5 minutes
const key = (userId: string) => `stepup:${userId}`;

// Record that the user just re-confirmed their identity (after a password check).
export async function markStepUpConfirmed(env: Env, userId: string): Promise<void> {
  await env.CACHE.put(key(userId), String(Date.now()), { expirationTtl: TTL_SECONDS });
}

// True if the user confirmed within the TTL window.
export async function hasRecentStepUp(env: Env, userId: string): Promise<boolean> {
  const v = await env.CACHE.get(key(userId));
  return v != null;
}

// Parse a user's settings_json and report whether step-up is required for them.
export function stepUpEnabled(settingsJson: unknown): boolean {
  if (typeof settingsJson !== 'string' || !settingsJson) return false;
  try { const s = JSON.parse(settingsJson); return !!(s && typeof s === 'object' && s.sec_require_login === true); }
  catch { return false; }
}

// Reusable gate for any sensitive mutating endpoint. Returns a 403 step_up_required
// Response when `userId` has enabled sec_require_login and has NOT re-confirmed
// recently; otherwise null (the caller proceeds). The client catches the 403,
// prompts for the password via POST /api/profile/confirm, then retries.
// `userId` is the ACTING user — for admin mutations pass the admin's id.
export async function enforceStepUp(
  c: Context<{ Bindings: Env }>,
  userId: string,
): Promise<Response | null> {
  if (!userId) return null;
  let settingsJson: unknown;
  try {
    const row: any = await c.env.DB.prepare(`SELECT settings_json FROM users WHERE id = ?`).bind(userId).first();
    settingsJson = row?.settings_json;
  } catch {
    // Cannot read the setting → do not block. Step-up is a defense-in-depth layer
    // (the action still requires auth + permissions); failing open keeps legit
    // actions working on any DB hiccup rather than hard-failing the request.
    return null;
  }
  if (stepUpEnabled(settingsJson) && !(await hasRecentStepUp(c.env, userId))) {
    return c.json({ error: 'step_up_required' }, 403);
  }
  return null;
}
