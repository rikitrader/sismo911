// Scoped per-unit bearer tokens for live GPS ingest (live-GPS schema, migration
// 0045). Format: fbu_<48 hex>. Only sha256(token) is stored; the plaintext is
// returned ONCE at issue time and never logged. Lookup is by token_hash.
//
// Tokens are scoped to one unit, revocable (revoked_at), and expiring
// (expires_at, unix-ms; NULL = no expiry). verifyUnitToken() validates the token
// itself; "unit active" is checked by the caller (the WS connect handler).

import type { Env } from '../types';
import { sha256Hex } from './apikey';
import { uid } from './db';

const hex = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface IssuedToken { id: string; token: string; expiresAt: number | null; }
export interface VerifiedToken { unitId: string; tokenId: string; }

export interface IssueOpts { label?: string | null; expiresInHours?: number | null; createdBy?: string | null; }

/** Create + persist a scoped token for a unit; returns the plaintext ONCE. */
export async function issueUnitToken(env: Env, unitId: string, opts: IssueOpts = {}): Promise<IssuedToken> {
  const id = uid('tok');
  const token = `fbu_${hex(24)}`; // 48 hex chars of entropy
  const token_hash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt =
    opts.expiresInHours != null && opts.expiresInHours > 0
      ? now + Math.floor(opts.expiresInHours * 3600_000)
      : null;
  await env.DB.prepare(
    `INSERT INTO flota_unit_tokens (id, unit_id, token_hash, label, expires_at, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, unitId, token_hash, opts.label ?? null, expiresAt, opts.createdBy ?? null, now).run();
  return { id, token, expiresAt };
}

/** Verify a presented token: hash match, not revoked, not expired.
 *  Returns { unitId, tokenId } or null. Does NOT check that the unit is active
 *  (the WS connect handler does that against flota_units). */
export async function verifyUnitToken(env: Env, token: string | undefined | null): Promise<VerifiedToken | null> {
  if (!token || !token.startsWith('fbu_')) return null;
  const presented = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id, unit_id, token_hash, revoked_at, expires_at FROM flota_unit_tokens WHERE token_hash = ? LIMIT 1`
  ).bind(presented).first() as
    | { id: string; unit_id: string; token_hash: string; revoked_at: number | null; expires_at: number | null }
    | null;
  if (!row) return null;
  // Constant-time confirm (defense-in-depth; the WHERE already matched the hash).
  if (!timingSafeEqual(presented, row.token_hash)) return null;
  if (row.revoked_at) return null;
  if (row.expires_at != null && row.expires_at <= Date.now()) return null;
  return { unitId: row.unit_id, tokenId: row.id };
}

/** Revoke a token by its id. Returns true if a live token was revoked. */
export async function revokeUnitToken(env: Env, tokenId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE flota_unit_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
  ).bind(Date.now(), tokenId).run();
  return !!r.meta.changes;
}

/** Revoke ALL live tokens for a unit. Returns the number revoked. */
export async function revokeUnitTokensFor(env: Env, unitId: string): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE flota_unit_tokens SET revoked_at = ? WHERE unit_id = ? AND revoked_at IS NULL`
  ).bind(Date.now(), unitId).run();
  return r.meta.changes ?? 0;
}

/** Extract a unit token from a request (Authorization: Bearer, X-Unit-Token, or ?token=). */
export function unitTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get('authorization') || '';
  const [scheme, t] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'bearer' && t?.startsWith('fbu_')) return t;
  const h = req.headers.get('x-unit-token');
  if (h?.startsWith('fbu_')) return h;
  const q = new URL(req.url).searchParams.get('token');
  return q?.startsWith('fbu_') ? q : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
