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

/** Denial reason returned by {@link isPrivilegedTarget}; null ⇒ impersonation allowed. */
export type ImpersonationDenial = 'cannot_impersonate_admin' | 'cannot_impersonate_more_privileged';

/**
 * Escalation-capable permissions a target must NEVER hold to be impersonated —
 * defense-in-depth denylist enforced regardless of the subset check below. Holding
 * any of these would let an impersonator gain role/permission/user-management or
 * re-impersonation power they may not legitimately wield through the hijacked session.
 */
const ESCALATION_PERMS = [
  'roles:create', 'roles:update', 'roles:delete', 'roles:assign',
  'permissions:grant', 'users:create', 'users:impersonate',
] as const;

/**
 * Decide whether `impersonator` may impersonate `target`. Returns a denial code
 * (→ 403) or null when allowed. Fail-closed against lateral/upward escalation:
 *
 *  1. Unknown/admin/super_admin target ⇒ `cannot_impersonate_admin`.
 *  2. A super_admin impersonator (legacy users.role='admin') is god-mode and may
 *     impersonate anyone non-admin (short-circuit allow).
 *  3. Target holding ANY escalation-capable permission (ESCALATION_PERMS,
 *     incl. 'users:impersonate') ⇒ `cannot_impersonate_more_privileged`.
 *  4. SUBSET RULE: the target's effective permissions must be a subset of the
 *     impersonator's own effective permissions — you cannot impersonate someone
 *     STRICTLY MORE PRIVILEGED than you ⇒ `cannot_impersonate_more_privileged`.
 */
export async function isPrivilegedTarget(
  env: Env,
  target: User | null,
  impersonator?: User | null,
): Promise<ImpersonationDenial | null> {
  if (!target) return 'cannot_impersonate_admin'; // unknown ⇒ fail closed
  if (target.role === 'admin') return 'cannot_impersonate_admin'; // legacy admin maps to super_admin

  // god-mode: a super_admin impersonator (legacy role 'admin') may impersonate anyone non-admin.
  if (impersonator && impersonator.role === 'admin') return null;

  const targetPerms = await getEffectivePermissions(env, target.id);

  // Defense-in-depth denylist: never impersonate a holder of escalation-capable perms.
  for (const p of ESCALATION_PERMS) if (targetPerms.has(p)) return 'cannot_impersonate_more_privileged';

  // Subset rule: refuse if the target holds any permission the impersonator lacks.
  if (impersonator) {
    const actorPerms = await getEffectivePermissions(env, impersonator.id);
    for (const p of targetPerms) if (!actorPerms.has(p)) return 'cannot_impersonate_more_privileged';
  }

  return null;
}
