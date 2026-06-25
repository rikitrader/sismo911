import type { Env } from '../types';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';

export const COOKIE = 'sismo_session';
const SESSION_TTL_MS = 30 * 86_400_000; // 30 days
const PBKDF2_ITERS = 100_000;

export type Role = 'citizen' | 'operator' | 'admin';
export interface User {
  id: string; email: string; name: string; role: Role;
  rank: string | null; unit: string | null; phone: string | null;
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
export async function createSession(env: Env, userId: string, ua?: string): Promise<{ token: string; expires: number }> {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' }[m]!));
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_ms, created_ms, user_agent) VALUES (?,?,?,?,?)`
  ).bind(token, userId, expires, now, ua ?? null).run();
  return { token, expires };
}

export async function getUserFromRequest(env: Env, c: Context): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const row: any = await env.DB.prepare(
    `SELECT u.id,u.email,u.name,u.role,u.rank,u.unit,u.phone,s.expires_ms
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(token).first();
  if (!row || row.expires_ms < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, rank: row.rank, unit: row.unit, phone: row.phone };
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000 });
}

export async function clearSession(env: Env, c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  deleteCookie(c, COOKIE, { path: '/' });
}
