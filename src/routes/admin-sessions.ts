/**
 * Sessions + MFA + emergency-lock API.
 *
 * Mounted (by the orchestrator, in index.ts) at /api/rbac — alongside the
 * fine-grained RBAC admin sub-app. Every route is guarded: a user manages their
 * OWN MFA + sessions (requireLogin), while reading/revoking OTHER users' sessions
 * and locking accounts require explicit permissions (sessions:read / sessions:revoke
 * / users:suspend). Unsafe methods additionally require a same-site Origin (CSRF).
 *
 * Mutations are double-logged: audit() (human trail) + security_events (security
 * change feed). Locking a user revokes all their sessions and bumps their perm
 * epoch so the KV permission cache is invalidated immediately.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { getSessionToken } from '../lib/auth';
import { requireLogin, requirePermission, currentUser } from '../rbac/middleware';
import { bumpEpoch } from '../rbac/engine';
import { isAllowedOrigin, requestIp } from '../lib/security';
import {
  generateSecret,
  totpUri,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  matchBackupCode,
} from '../lib/totp';

export const adminSessions = new Hono<{ Bindings: Env }>();

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// --- Sub-app CSRF guard: state-changing calls must be same-site. /api/rbac is
// "open" to the global gate, so we repeat the same-site check here (a missing
// Origin/Referer on an unsafe method is treated as NOT same-site). ---
adminSessions.use('*', async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const originHdr = c.req.header('origin') || c.req.header('referer')?.split('/').slice(0, 3).join('/');
    const sameSite = originHdr ? isAllowedOrigin(c.env, originHdr) : false;
    if (!sameSite) return c.json({ error: 'bad_origin' }, 403);
  }
  return next();
});

/** Insert a row into the security-events feed. Best-effort: never throws. */
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

/** Mask a session token to its last 6 chars (never expose the full bearer token). */
const maskToken = (t: string) => (t && t.length > 6 ? `…${t.slice(-6)}` : t);

/** Best-effort human-friendly device label from a User-Agent string. */
function deviceLabel(ua: string | null | undefined): string {
  const s = String(ua ?? '');
  if (!s) return 'Dispositivo desconocido';
  const os =
    /Windows/i.test(s) ? 'Windows' :
    /iPhone|iPad|iOS/i.test(s) ? 'iOS' :
    /Mac OS X|Macintosh/i.test(s) ? 'macOS' :
    /Android/i.test(s) ? 'Android' :
    /Linux/i.test(s) ? 'Linux' : '';
  const br =
    /Edg\//i.test(s) ? 'Edge' :
    /OPR\/|Opera/i.test(s) ? 'Opera' :
    /Chrome\//i.test(s) ? 'Chrome' :
    /Firefox\//i.test(s) ? 'Firefox' :
    /Safari\//i.test(s) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || 'Dispositivo';
}

function mapSession(row: any, currentToken: string | undefined) {
  return {
    token: maskToken(row.token),
    device_label: row.device_label || deviceLabel(row.user_agent),
    ip: row.ip ?? null,
    created_ms: row.created_ms ?? null,
    last_seen_ms: row.last_seen_ms ?? null,
    current: !!currentToken && row.token === currentToken,
  };
}

// ===========================================================================
// MFA — a user manages their OWN multi-factor auth
// ===========================================================================

// POST /mfa/enroll — generate a secret (stored but NOT yet enabled) + otpauth URI.
adminSessions.post('/mfa/enroll', requireLogin, async (c) => {
  const me = currentUser(c)!;
  const secret = generateSecret();
  await c.env.DB.prepare(`UPDATE users SET mfa_secret = ? WHERE id = ?`).bind(secret, me.id).run();
  return c.json({ secret, otpauth_uri: totpUri(secret, me.email, 'SISMO911') });
});

// POST /mfa/verify {code} — confirm enrollment: enable MFA + issue 10 backup codes (shown ONCE).
adminSessions.post('/mfa/verify', requireLogin, async (c) => {
  const me = currentUser(c)!;
  const b = await c.req.json().catch(() => ({}));
  const code = typeof b?.code === 'string' ? b.code : '';
  const row: any = await c.env.DB.prepare(`SELECT mfa_secret FROM users WHERE id = ?`).bind(me.id).first();
  if (!row?.mfa_secret || !(await verifyTotp(row.mfa_secret, code))) {
    return c.json({ error: 'bad_code' }, 400);
  }
  const codes = generateBackupCodes(10);
  const hashes = await Promise.all(codes.map(hashBackupCode));
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE users SET mfa_enabled = 1, mfa_enrolled_ms = ?, mfa_backup_codes = ? WHERE id = ?`
  ).bind(now, JSON.stringify(hashes), me.id).run();
  await audit(c, 'mfa.enabled', { user_id: me.id });
  await logSecurity(c, 'mfa.enabled', me.id);
  return c.json({ ok: true, backup_codes: codes });
});

// POST /mfa/disable {code} — verify (TOTP or backup) then turn MFA off + clear secrets.
adminSessions.post('/mfa/disable', requireLogin, async (c) => {
  const me = currentUser(c)!;
  const b = await c.req.json().catch(() => ({}));
  const code = typeof b?.code === 'string' ? b.code : '';
  const row: any = await c.env.DB.prepare(
    `SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = ?`
  ).bind(me.id).first();
  if (!row?.mfa_enabled) return c.json({ error: 'mfa_not_enabled' }, 400);
  const okTotp = row.mfa_secret ? await verifyTotp(row.mfa_secret, code) : false;
  let backups: string[] = [];
  try { backups = JSON.parse(row.mfa_backup_codes || '[]'); } catch { backups = []; }
  const ok = okTotp || (await matchBackupCode(code, backups)) >= 0;
  if (!ok) return c.json({ error: 'bad_code' }, 400);
  await c.env.DB.prepare(
    `UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, mfa_enrolled_ms = NULL WHERE id = ?`
  ).bind(me.id).run();
  await audit(c, 'mfa.disabled', { user_id: me.id });
  await logSecurity(c, 'mfa.disabled', me.id);
  return c.json({ ok: true });
});

// ===========================================================================
// SESSIONS
// ===========================================================================

const ACTIVE_SESSIONS_SQL =
  `SELECT token, ip, created_ms, last_seen_ms, user_agent, device_label
     FROM sessions
    WHERE user_id = ? AND expires_ms >= ? AND revoked_ms IS NULL
    ORDER BY created_ms DESC`;

// GET /sessions — the caller's own active sessions.
adminSessions.get('/sessions', requireLogin, async (c) => {
  const me = currentUser(c)!;
  const cur = getSessionToken(c);
  const { results } = await c.env.DB.prepare(ACTIVE_SESSIONS_SQL).bind(me.id, Date.now()).all();
  return c.json({ sessions: (results ?? []).map((r) => mapSession(r, cur)) });
});

// GET /users/:id/sessions — another user's active sessions (sessions:read).
adminSessions.get('/users/:id/sessions', requirePermission('sessions:read'), async (c) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(ACTIVE_SESSIONS_SQL).bind(id, Date.now()).all();
  return c.json({ sessions: (results ?? []).map((r) => mapSession(r, undefined)) });
});

// DELETE /sessions/:token — revoke one of the caller's OWN sessions.
adminSessions.delete('/sessions/:token', requireLogin, async (c) => {
  const me = currentUser(c)!;
  const token = c.req.param('token');
  const r = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_ms = ? WHERE user_id = ? AND token = ? AND revoked_ms IS NULL`
  ).bind(Date.now(), me.id, token).run();
  await audit(c, 'session.revoke_self', { user_id: me.id });
  return c.json({ ok: true, revoked: r.meta?.changes ?? 0 });
});

// DELETE /users/:id/sessions/:token — revoke any user's session (sessions:revoke).
adminSessions.delete('/users/:id/sessions/:token', requirePermission('sessions:revoke'), async (c) => {
  const id = c.req.param('id');
  const token = c.req.param('token');
  const r = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_ms = ? WHERE user_id = ? AND token = ? AND revoked_ms IS NULL`
  ).bind(Date.now(), id, token).run();
  await audit(c, 'session.revoke', { target: id });
  await logSecurity(c, 'session.revoke', id, { token: maskToken(token) });
  return c.json({ ok: true, revoked: r.meta?.changes ?? 0 });
});

// POST /users/:id/sessions/revoke-all — revoke ALL of a user's sessions (sessions:revoke).
adminSessions.post('/users/:id/sessions/revoke-all', requirePermission('sessions:revoke'), async (c) => {
  const id = c.req.param('id');
  const r = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_ms = ? WHERE user_id = ? AND revoked_ms IS NULL`
  ).bind(Date.now(), id).run();
  await audit(c, 'session.revoke_all', { target: id });
  await logSecurity(c, 'session.revoke', id, { all: true, revoked: r.meta?.changes ?? 0 });
  return c.json({ ok: true, revoked: r.meta?.changes ?? 0 });
});

// ===========================================================================
// EMERGENCY LOCK (U5)
// ===========================================================================

// POST /users/:id/lock {reason?} — lock the account, kill all sessions, invalidate perms.
adminSessions.post('/users/:id/lock', requirePermission('users:suspend'), async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const reason = typeof b?.reason === 'string' ? b.reason.slice(0, 500) : null;
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE users SET status = 'locked' WHERE id = ?`).bind(id).run();
  await c.env.DB.prepare(
    `UPDATE sessions SET revoked_ms = ? WHERE user_id = ? AND revoked_ms IS NULL`
  ).bind(now, id).run();
  await bumpEpoch(c.env, id);
  await audit(c, 'user.lock', { target: id, reason });
  await logSecurity(c, 'user.lock', id, { reason });
  return c.json({ ok: true });
});

// POST /users/:id/unlock — restore the account to active.
adminSessions.post('/users/:id/unlock', requirePermission('users:suspend'), async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(id).run();
  await bumpEpoch(c.env, id);
  await audit(c, 'user.unlock', { target: id });
  await logSecurity(c, 'user.unlock', id);
  return c.json({ ok: true });
});
