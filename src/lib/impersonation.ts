/**
 * Impersonation cookie + session helpers (Phase 2 Wave 2 — Admin Tools).
 *
 * Model: an admin impersonates a target by minting a SHORT-LIVED session FOR THE
 * TARGET user, tagged with `sessions.impersonator_id = <admin id>`. The admin's
 * own session token is stashed in an httpOnly cookie so "stop" restores it. A
 * readable banner cookie tells the SPA to show the impersonation warning.
 *
 * SECURITY: never used to impersonate an admin/super_admin (see isPrivilegedTarget).
 */
import type { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../types';
import { createSession, type User } from './auth';
import { getEffectivePermissions } from '../rbac/engine';

/** Readable (NOT httpOnly) — SPA reads it to render the warning banner. */
export const BANNER_COOKIE = 'sismo_impersonating';
/** httpOnly stash of the admin's own token so /stop restores their session. */
export const ADMIN_TOKEN_COOKIE = 'sismo_admin_token';
/** Impersonation sessions auto-expire after this; an expired session simply
 *  stops authenticating (getUserFromRequest rejects expired sessions). */
export const IMPERSONATION_TTL_MS = 30 * 60_000; // 30 minutes

export interface ImpersonationBanner {
  admin: { id: string; name: string };
  target: { id: string; name: string };
  expires: number;
}

/** Mint a short-lived session FOR the target, tagged with the impersonator. */
export async function mintImpersonationSession(
  env: Env,
  targetId: string,
  adminId: string,
  ua?: string,
): Promise<{ token: string; expires: number }> {
  const { token, expires } = await createSession(env, targetId, ua, IMPERSONATION_TTL_MS);
  // createSession() doesn't take impersonator_id; tag the row right after.
  await env.DB.prepare('UPDATE sessions SET impersonator_id = ? WHERE token = ?').bind(adminId, token).run();
  return { token, expires };
}

/** Set the admin-token stash + the readable banner cookie. */
export function setImpersonationCookies(c: Context, adminToken: string, banner: ImpersonationBanner): void {
  setCookie(c, ADMIN_TOKEN_COOKIE, adminToken, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: IMPERSONATION_TTL_MS / 1000,
  });
  setCookie(c, BANNER_COOKIE, JSON.stringify(banner), {
    httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: IMPERSONATION_TTL_MS / 1000,
  });
}

/** Read the stashed admin token (set when impersonation started). */
export function getStashedAdminToken(c: Context): string | undefined {
  return getCookie(c, ADMIN_TOKEN_COOKIE);
}

/** Clear both impersonation cookies (on stop). */
export function clearImpersonationCookies(c: Context): void {
  deleteCookie(c, BANNER_COOKIE, { path: '/' });
  deleteCookie(c, ADMIN_TOKEN_COOKIE, { path: '/' });
}

/**
 * True if `user` is admin/super_admin-class and so must NEVER be impersonated.
 * Refuses on: legacy users.role='admin' (→ super_admin), OR holding the
 * 'users:impersonate' capability (which super_admin/admins hold via god-mode) —
 * this blocks lateral/upward escalation by hijacking another privileged session.
 */
export async function isPrivilegedTarget(env: Env, user: User | null): Promise<boolean> {
  if (!user) return true; // unknown ⇒ treat as privileged (fail closed)
  if (user.role === 'admin') return true; // legacy admin maps to super_admin
  const perms = await getEffectivePermissions(env, user.id);
  return perms.has('users:impersonate');
}
