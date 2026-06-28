import type { Env } from '../types';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { verifyAccessJwt } from './access';

export const COOKIE = 'sismo_session';
const SESSION_TTL_MS = 30 * 86_400_000; // 30 days (citizens — absolute)
// Privileged (operator/admin) sessions use a SLIDING idle window: each request
// extends the session by IDLE_TTL_MS; after this long with no activity it expires
// server-side. Implemented on the existing expires_ms so there is no schema change.
export const IDLE_TTL_MS = 30 * 60_000; // 30 minutes idle
export const isPrivilegedRole = (role: string | null | undefined) =>
  role === 'operator' || role === 'admin';
// SECURITY: bump to 600k once hash format carries iter count.
// OWASP recommends ≥600,000 PBKDF2-SHA256 iterations, but the stored hash format
// is only { hash, salt } — it does NOT persist the iteration count. derive() is
// shared by hashPassword AND verifyPassword, so raising this would make every
// EXISTING (100k) hash fail to verify. Left unchanged until the stored format
// carries a per-hash iter count (then new hashes can use 600k while old ones
// still verify at their recorded count).
const PBKDF2_ITERS = 100_000;

export type Role = 'citizen' | 'operator' | 'admin';
export interface User {
  id: string; email: string; name: string; role: Role;
  rank: string | null; unit: string | null; phone: string | null;
  wallet_address?: string | null;
  must_change_pw?: number;
}

// ---- crypto helpers ----
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    key, 256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  return { hash: b64(hash), salt: b64(salt) };
}

export async function verifyPassword(password: string, hashB64: string, saltB64: string): Promise<boolean> {
  const got = await derive(password, unb64(saltB64));
  const want = unb64(hashB64);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// ---- sessions ----
export async function createSession(env: Env, userId: string, ua?: string, ttlMs: number = SESSION_TTL_MS): Promise<{ token: string; expires: number }> {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' }[m]!));
  const now = Date.now();
  const expires = now + ttlMs;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_ms, created_ms, user_agent) VALUES (?,?,?,?,?)`
  ).bind(token, userId, expires, now, ua ?? null).run();
  return { token, expires };
}

export async function getUserFromRequest(env: Env, c: Context): Promise<User | null> {
  const token = getSessionToken(c);
  if (token) {
    const row: any = await env.DB.prepare(
      `SELECT u.id,u.email,u.name,u.role,u.rank,u.unit,u.phone,u.wallet_address,u.must_change_pw,s.expires_ms
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.revoked_ms IS NULL`
    ).bind(token).first();
    if (row && row.expires_ms >= Date.now()) {
      // Privileged sessions: slide the idle window on activity, and cap any
      // over-long session (e.g. created before idle timeout existed) down to it.
      // Throttled to ~once/minute so it's one write per active minute, not per request.
      if (isPrivilegedRole(row.role)) {
        const now = Date.now();
        const newExpires = now + IDLE_TTL_MS;
        if (Math.abs(newExpires - row.expires_ms) > 60_000) {
          await env.DB.prepare(`UPDATE sessions SET expires_ms = ? WHERE token = ?`).bind(newExpires, token).run();
        }
      }
      return { id: row.id, email: row.email, name: row.name, role: row.role, rank: row.rank, unit: row.unit, phone: row.phone, wallet_address: row.wallet_address, must_change_pw: row.must_change_pw ?? 0 };
    }
  }

  const accessJwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!accessJwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const identity = await verifyAccessJwt(accessJwt, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  if (!identity?.email) return null;
  const row: any = await env.DB.prepare(
    `SELECT id,email,name,role,rank,unit,phone,wallet_address FROM users WHERE email = ?`
  ).bind(identity.email.trim().toLowerCase()).first();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, rank: row.rank, unit: row.unit, phone: row.phone, wallet_address: row.wallet_address };
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000 });
}

export function getSessionToken(c: Context): string | undefined {
  const cookieToken = getCookie(c, COOKIE);
  if (cookieToken) return cookieToken;
  const auth = c.req.header('authorization') || '';
  const [scheme, token] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token;
}

export async function clearSession(env: Env, c: Context) {
  const token = getSessionToken(c);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  deleteCookie(c, COOKIE, { path: '/' });
}
