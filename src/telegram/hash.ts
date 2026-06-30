// SISMO911 — Telegram bot: hashing helpers for audit logs.
// ---------------------------------------------------------------------------
// Reuses the project's single SHA-256 implementation (src/lib/apikey.ts) so we
// never ship a second crypto path. We log only HASHED identifiers — a raw
// Telegram user id, cédula, name, or phone must never reach the audit table.

import { sha256Hex } from '../lib/apikey';

export { sha256Hex };

/**
 * Pseudonymize an identifier for logs: SHA-256 over a stable, per-deployment
 * salt + the value, truncated to 16 hex chars (64 bits — enough to correlate a
 * user's actions across log lines, not enough to be a useful PII leak). The
 * salt is the bot's webhook secret, which never appears in logs, so the hash is
 * not reversible by anyone reading the audit table.
 */
export async function hashId(salt: string, value: string | number): Promise<string> {
  const h = await sha256Hex(`${salt}:${String(value)}`);
  return h.slice(0, 16);
}
