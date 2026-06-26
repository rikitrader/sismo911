import type { Context } from 'hono';
import type { Env } from '../types';
import { requestIp } from './security';

// ---------------------------------------------------------------------------
// API-client credentials for the gated data API + MCP server.
//
// Key  = sk911_<32 hex>  — public identifier, stored plaintext, used to look the
//        client up.
// Secret = 48-byte base64url — high-entropy bearer secret, shown to the client
//        exactly once at registration; we persist only SHA-256(secret).
// ---------------------------------------------------------------------------

export const ALL_SCOPES = [
  'read:earthquakes',
  'read:shelters',
  'read:blog',
  'read:stats',
  'read:missing-persons', // citizen-submitted PII — operator-granted only
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export const DEFAULT_SCOPES = 'read:earthquakes,read:shelters,read:blog,read:stats';

export interface ApiClient {
  id: string;
  name: string;
  email: string;
  org: string;
  purpose: string;
  api_key: string;
  status: 'pending' | 'approved' | 'revoked';
  scopes: string;
  rate_limit: number;
  request_count: number;
  last_used_ms: number | null;
  created_ms: number;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' }[m]!));
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Constant-time string compare (avoids leaking the secret hash via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function genApiKey(): string {
  return 'sk911_' + hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}
export function genSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(48)));
}
export function genClientId(): string {
  return 'cli_' + crypto.randomUUID().slice(0, 8);
}

/** A client may carry the credential as a header pair or a combined Bearer. */
export function extractCredential(c: Context): { key: string; secret: string } | null {
  const hKey = c.req.header('x-api-key');
  const hSecret = c.req.header('x-api-secret');
  if (hKey && hSecret) return { key: hKey.trim(), secret: hSecret.trim() };
  // Authorization: Bearer sk911_xxx:secret   (or  ApiKey sk911_xxx:secret)
  const auth = c.req.header('authorization') || '';
  const m = auth.match(/^(?:Bearer|ApiKey)\s+(sk911_[a-f0-9]+):(.+)$/i);
  if (m) return { key: m[1].trim(), secret: m[2].trim() };
  return null;
}

export type AuthResult =
  | { ok: true; client: ApiClient }
  | { ok: false; status: number; error: string; hint?: string; retry_after?: number };

/**
 * Authenticate + authorize an API request against the api_clients table, then
 * enforce a per-minute, KV-backed rate limit. On success bumps usage counters
 * and records a request-log row (opportunistically pruned). Pure function of the
 * request — callers decide how to render the AuthResult.
 */
export async function authenticateApiClient(
  c: Context<{ Bindings: Env }>,
  opts: { scope?: Scope; endpoint: string }
): Promise<AuthResult> {
  const cred = extractCredential(c);
  if (!cred) {
    return {
      ok: false,
      status: 401,
      error: 'missing_credentials',
      hint: 'Envía X-API-Key + X-API-Secret, o Authorization: Bearer <key>:<secret>',
    };
  }
  const row = await c.env.DB.prepare(
    `SELECT id,name,email,org,purpose,api_key,secret_hash,status,scopes,rate_limit,request_count,last_used_ms,created_ms
     FROM api_clients WHERE api_key = ?`
  )
    .bind(cred.key)
    .first<ApiClient & { secret_hash: string }>()
    .catch(() => null);
  if (!row) return { ok: false, status: 401, error: 'invalid_key' };

  const presented = await sha256Hex(cred.secret);
  if (!timingSafeEqual(presented, row.secret_hash)) {
    return { ok: false, status: 401, error: 'invalid_secret' };
  }
  if (row.status === 'pending') {
    return {
      ok: false,
      status: 403,
      error: 'pending_approval',
      hint: 'Tu solicitud está en revisión. Te avisaremos al aprobarla.',
    };
  }
  if (row.status !== 'approved') {
    return { ok: false, status: 403, error: 'key_revoked' };
  }
  if (opts.scope && !hasScope(row.scopes, opts.scope)) {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      hint: `Tu clave no incluye el permiso "${opts.scope}".`,
    };
  }

  // Per-minute rate limit in KV (best-effort; failure never blocks the request).
  const limit = row.rate_limit || 120;
  const bucket = `apirl:${row.id}:${Math.floor(Date.now() / 60_000)}`;
  let count = 0;
  try {
    count = Number((await c.env.CACHE.get(bucket)) ?? 0) + 1;
    await c.env.CACHE.put(bucket, String(count), { expirationTtl: 120 });
  } catch {
    /* KV hiccup → fail open */
  }
  if (count > limit) {
    return {
      ok: false,
      status: 429,
      error: 'rate_limited',
      hint: `Límite de ${limit} solicitudes/minuto excedido.`,
      retry_after: 60 - (Math.floor(Date.now() / 1000) % 60),
    };
  }

  const now = Date.now();
  // Bump usage + log (best-effort, never block the response).
  const bump = (async () => {
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE api_clients SET request_count = request_count + 1, last_used_ms = ? WHERE id = ?`
        ).bind(now, row.id),
        c.env.DB.prepare(
          `INSERT INTO api_request_log (client_id, endpoint, status, ip, ts_ms) VALUES (?,?,?,?,?)`
        ).bind(row.id, opts.endpoint, 200, requestIp(c), now),
        // Keep only the most recent 500 log rows per client.
        c.env.DB.prepare(
          `DELETE FROM api_request_log WHERE client_id = ? AND id NOT IN
             (SELECT id FROM api_request_log WHERE client_id = ? ORDER BY id DESC LIMIT 500)`
        ).bind(row.id, row.id),
      ]);
    } catch {
      /* ignore — usage accounting is non-critical */
    }
  })();
  // Prefer waitUntil so it runs after the response; accessing executionCtx throws
  // when there is none (e.g. unit tests) — fall back to fire-and-forget.
  try {
    c.executionCtx.waitUntil(bump);
  } catch {
    void bump;
  }

  const { secret_hash: _omit, ...client } = row;
  return { ok: true, client: client as ApiClient };
}

export function hasScope(scopes: string, scope: Scope): boolean {
  return scopes
    .split(',')
    .map((s) => s.trim())
    .includes(scope);
}

/** Normalize an operator-supplied scope list to known scopes (dedup, validate). */
export function sanitizeScopes(input: string | string[] | undefined): string {
  const arr = Array.isArray(input) ? input : (input ?? '').split(',');
  const valid = arr
    .map((s) => s.trim())
    .filter((s): s is Scope => (ALL_SCOPES as readonly string[]).includes(s));
  return [...new Set(valid)].join(',') || DEFAULT_SCOPES;
}

/** Public-safe projection of a client (never leaks the secret hash). */
export function publicClient(row: ApiClient): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    org: row.org,
    purpose: row.purpose,
    api_key: row.api_key,
    status: row.status,
    scopes: row.scopes.split(',').filter(Boolean),
    rate_limit: row.rate_limit,
    request_count: row.request_count,
    last_used_ms: row.last_used_ms,
    created_ms: row.created_ms,
  };
}
