// Scoped per-unit bearer tokens for field GPS ingest. Format:
//   fbu_<prefix>_<secret>   (prefix is indexed/non-secret; full token is hashed)
// Only the hash is stored; plaintext is returned once at issue time.

import type { Env } from '../types';
import { sha256Hex } from './apikey';
import { uid } from './db';

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface IssuedToken { id: string; token: string; prefix: string; }

/** Create + persist a token for a unit; returns the plaintext ONCE. */
export async function issueUnitToken(env: Env, unidadId: string, label: string | null): Promise<IssuedToken> {
  const id = uid('tok');
  const prefix = hex(4);                 // 8 hex chars
  const secret = hex(16);                // 32 hex chars
  const token = `fbu_${prefix}_${secret}`;
  const token_hash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO flota_unit_tokens (id, unidad_id, token_prefix, token_hash, label, created_ms) VALUES (?,?,?,?,?,?)`
  ).bind(id, unidadId, prefix, token_hash, label, Date.now()).run();
  return { id, token, prefix };
}

/** Verify a presented token. Returns the unidad_id it authorizes, or null.
 *  Updates last_used_ms on success. Constant-time hash compare. */
export async function verifyUnitToken(env: Env, token: string | undefined | null): Promise<string | null> {
  if (!token || !token.startsWith('fbu_')) return null;
  const parts = token.split('_');
  if (parts.length !== 3) return null;
  const prefix = parts[1];
  const row = await env.DB.prepare(
    `SELECT id, unidad_id, token_hash, revoked_ms FROM flota_unit_tokens WHERE token_prefix = ? LIMIT 1`
  ).bind(prefix).first() as { id: string; unidad_id: string; token_hash: string; revoked_ms: number | null } | null;
  if (!row || row.revoked_ms) return null;
  const presented = await sha256Hex(token);
  // Constant-time compare.
  if (presented.length !== row.token_hash.length) return null;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ row.token_hash.charCodeAt(i);
  if (diff !== 0) return null;
  await env.DB.prepare(`UPDATE flota_unit_tokens SET last_used_ms = ? WHERE id = ?`).bind(Date.now(), row.id).run();
  return row.unidad_id;
}

/** Extract a unit token from a request (Authorization: Bearer fbu_... or X-Unit-Token). */
export function unitTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get('authorization') || '';
  const [scheme, t] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'bearer' && t?.startsWith('fbu_')) return t;
  const h = req.headers.get('x-unit-token');
  return h?.startsWith('fbu_') ? h : null;
}
