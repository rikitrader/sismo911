/**
 * Admin impersonation API (Phase 2 Wave 2 — Admin Tools). Mounted at /api/rbac.
 *
 * SECURITY-SENSITIVE. Every start/stop is double-logged: impersonation_log
 * (dedicated trail) + security_events (security feed). An admin impersonates a
 * target by minting a 30-min session FOR THE TARGET tagged with the admin's id;
 * the admin's own token is stashed so /stop restores it. Admins/super_admins can
 * NEVER be impersonated (no lateral/upward escalation). CSRF same-site guard on
 * unsafe methods (this prefix is "open" to the global gate — see admin-rbac.ts).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { getSessionToken, setSessionCookie } from '../lib/auth';
import { requirePermission, requireLogin, currentUser } from '../rbac/middleware';
import { isAllowedOrigin, requestIp } from '../lib/security';
import {
  mintImpersonationSession, setImpersonationCookies, getStashedAdminToken,
  clearImpersonationCookies, isPrivilegedTarget, IMPERSONATION_TTL_MS,
} from '../lib/impersonation';

export const adminImpersonation = new Hono<{ Bindings: Env }>();

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// CSRF: unsafe methods must be same-site (missing Origin/Referer ⇒ NOT same-site).
adminImpersonation.use('*', async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const originHdr = c.req.header('origin') || c.req.header('referer')?.split('/').slice(0, 3).join('/');
    const sameSite = originHdr ? isAllowedOrigin(c.env, originHdr) : false;
    if (!sameSite) return c.json({ error: 'bad_origin' }, 403);
  }
  return next();
});

/** Append to the security-events feed. Best-effort: never throws. */
async function logSecurity(c: Context<{ Bindings: Env }>, type: string, targetId: string | null, detail?: unknown) {
  try {
    await c.env.DB.prepare(
      `INSERT INTO security_events (id, type, actor_id, target_id, ip, detail_json, created_ms) VALUES (?,?,?,?,?,?,?)`
    ).bind(
      uid('se'), type, currentUser(c)?.id ?? null, targetId,
      requestIp(c), detail == null ? null : JSON.stringify(detail).slice(0, 2000), Date.now()
    ).run();
  } catch { /* security logging never breaks the request */ }
}

// ===========================================================================
// STOP — POST /impersonate/stop   (requireLogin)
// Registered BEFORE /impersonate/:userId so the static path wins the match.
// ===========================================================================
adminImpersonation.post('/impersonate/stop', requireLogin, async (c) => {
  const token = getSessionToken(c);
  const session: any = token
    ? await c.env.DB.prepare('SELECT user_id, impersonator_id FROM sessions WHERE token = ?').bind(token).first()
    : null;

  if (!session?.impersonator_id) {
    // Not an impersonation session — nothing to stop.
    return c.json({ ok: true, impersonating: false });
  }

  const adminId: string = session.impersonator_id;
  const targetId: string = session.user_id;
  const now = Date.now();

  // Close the active log row + drop the impersonation session.
  await c.env.DB.prepare(
    `UPDATE impersonation_log SET ended_ms = ?
     WHERE admin_id = ? AND target_id = ? AND ended_ms IS NULL`
  ).bind(now, adminId, targetId).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();

  // Restore the admin's own session if we stashed it; else send them to /login.
  const adminToken = getStashedAdminToken(c);
  let relogin = true;
  if (adminToken) {
    const stillValid: any = await c.env.DB.prepare(
      'SELECT 1 FROM sessions WHERE token = ? AND revoked_ms IS NULL AND expires_ms >= ?'
    ).bind(adminToken, now).first();
    if (stillValid) { setSessionCookie(c, adminToken); relogin = false; }
  }
  clearImpersonationCookies(c);

  await audit(c, 'impersonate.stop', { admin_id: adminId, target_id: targetId, relogin });
  await logSecurity(c, 'impersonate.stop', targetId, { admin_id: adminId });
  return c.json({ ok: true, relogin });
});

// ===========================================================================
// START — POST /impersonate/:userId  {reason?}   (users:impersonate)
// ===========================================================================
adminImpersonation.post('/impersonate/:userId', requirePermission('users:impersonate'), async (c) => {
  const admin = currentUser(c)!;
  const targetId = c.req.param('userId');
  const body: any = await c.req.json().catch(() => ({}));
  const reason: string | null = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null;

  if (targetId === admin.id) return c.json({ error: 'cannot_impersonate_self' }, 403);

  const target: any = await c.env.DB.prepare(
    'SELECT id, name, email, role FROM users WHERE id = ?'
  ).bind(targetId).first();
  if (!target) return c.json({ error: 'not_found' }, 404);

  // Never impersonate an admin/super_admin, an escalation-capable account, or a
  // target strictly MORE privileged than the impersonator (fail-closed subset rule).
  const denial = await isPrivilegedTarget(c.env, target, admin);
  if (denial) {
    await logSecurity(c, 'impersonate.denied', targetId, { reason: denial });
    return c.json({ error: denial }, 403);
  }

  // Stash the admin's OWN token so /stop can restore their session.
  const adminToken = getSessionToken(c);
  const now = Date.now();
  const { token, expires } = await mintImpersonationSession(c.env, targetId, admin.id, c.req.header('user-agent') || undefined);

  await c.env.DB.prepare(
    `INSERT INTO impersonation_log (id, admin_id, target_id, reason, started_ms, expires_ms, ended_ms)
     VALUES (?,?,?,?,?,?,NULL)`
  ).bind(uid('imp'), admin.id, targetId, reason, now, now + IMPERSONATION_TTL_MS).run();

  // Switch the caller's session cookie to the impersonation token + banner.
  setSessionCookie(c, token);
  if (adminToken) {
    setImpersonationCookies(c, adminToken, {
      admin: { id: admin.id, name: admin.name },
      target: { id: target.id, name: target.name },
      expires,
    });
  }

  await audit(c, 'impersonate.start', { admin_id: admin.id, target_id: targetId, reason });
  await logSecurity(c, 'impersonate.start', targetId, { admin_id: admin.id, reason });
  return c.json({ ok: true, target: { id: target.id, name: target.name }, expires_ms: expires });
});

// ===========================================================================
// ACTIVE — GET /impersonation/active   (security:read)
// ===========================================================================
adminImpersonation.get('/impersonation/active', requirePermission('security:read'), async (c) => {
  const active = ((await c.env.DB.prepare(
    `SELECT id, admin_id, target_id, reason, started_ms, expires_ms
     FROM impersonation_log WHERE ended_ms IS NULL AND expires_ms > ? ORDER BY started_ms DESC LIMIT 200`
  ).bind(Date.now()).all()).results ?? []);
  return c.json({ active });
});

// ===========================================================================
// LOG — GET /impersonation/log?limit=   (security:read)
// ===========================================================================
adminImpersonation.get('/impersonation/log', requirePermission('security:read'), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const log = ((await c.env.DB.prepare(
    `SELECT id, admin_id, target_id, reason, started_ms, expires_ms, ended_ms
     FROM impersonation_log ORDER BY started_ms DESC LIMIT ?`
  ).bind(limit).all()).results ?? []);
  return c.json({ log });
});
