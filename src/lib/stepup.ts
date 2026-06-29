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
