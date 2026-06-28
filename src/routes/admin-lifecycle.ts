/**
 * Admin USER-LIFECYCLE API (Phase 2 Wave 2). Mounted at /api/rbac by the
 * orchestrator (alongside admin-rbac). Covers:
 *   • Invitations (U1/U3) — create/list/revoke/resend, with email/SMS delivery
 *     and a copyable link/token for magic-link & QR channels.
 *   • Accept (PUBLIC, token-authenticated) — how a new hire joins; rate-limited,
 *     never permission-gated.
 *   • Approval workflow (U2) — list/approve/reject accounts that landed pending.
 *   • Temporary roles (U4) — grant/list/revoke user_roles with an expires_ms; the
 *     RBAC engine already drops an expired assignment.
 *
 * Every gated mutation enforces its OWN permission (the /api/rbac prefix is
 * "open" to the global gate) and is double-logged: audit() + security_events.
 * Any role/permission change bumps the user's KV permission-cache epoch.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { requirePermission, currentUser } from '../rbac/middleware';
import { bumpEpoch } from '../rbac/engine';
import { isAllowedOrigin, requestIp, rateLimit } from '../lib/security';
import { sendEmail, randomToken, sha256hex, type EmailMsg } from '../lib/email';
import { sendText } from '../lib/sms';
import {
  createInvitation, findInvitationByToken, verifyInvitation, acceptInvitation,
  acceptLink, type InviteChannel,
} from '../lib/invite';

export const adminLifecycle = new Hono<{ Bindings: Env }>();

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// --- Sub-app CSRF guard: unsafe methods must be same-site (mirrors admin-rbac).
// A missing Origin/Referer on an unsafe method is treated as NOT same-site. The
// PUBLIC accept POST is still same-site (the new hire posts from sismo911.com).
adminLifecycle.use('*', async (c, next) => {
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
      `INSERT INTO security_events (id, type, actor_id, target_id, ip, detail_json, created_ms) VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      uid('se'), type, currentUser(c)?.id ?? null, targetId,
      requestIp(c), detail == null ? null : JSON.stringify(detail).slice(0, 2000), Date.now(),
    ).run();
  } catch { /* security logging never breaks the request */ }
}

/** Branded invite email (links to the accept page / QR link). */
function inviteEmail(link: string): EmailMsg {
  const subject = 'Te invitaron a SISMO911';
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <tr><td style="background:#13284f;padding:20px 28px"><span style="color:#fff;font-size:21px;font-weight:800">SISMO911</span>
   <div style="color:#cdd6ea;font-size:11px;letter-spacing:.12em;text-transform:uppercase">Comando Sísmico Nacional</div></td></tr>
  <tr><td style="padding:28px">
   <h1 style="margin:0 0 12px;font-size:20px;color:#13284f">Te invitaron a unirte</h1>
   <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151">Recibiste una invitación para crear tu cuenta en SISMO911. Activa tu cuenta con el botón:</p>
   <p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#13284f;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:8px">Activar mi cuenta</a></p>
   <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151">El enlace expira en 7 días. Si el botón no funciona, copia y pega:<br><span style="color:#13284f;word-break:break-all">${link}</span></p>
  </td></tr>
 </table></td></tr></table></body></html>`;
  const text = `Te invitaron a SISMO911. Activa tu cuenta (el enlace expira en 7 días):\n${link}`;
  return { subject, html, text };
}

// Deliver the invite over its channel. email→sendEmail, sms→sendText; magic/qr/csv
// are link-only (the admin copies the returned link / renders the QR client-side).
async function deliverInvite(env: Env, channel: InviteChannel, email: string, phone: string | null, link: string): Promise<boolean> {
  if (channel === 'email') return sendEmail(env, email, inviteEmail(link));
  if (channel === 'sms') return phone ? sendText(env, phone, `SISMO911: activa tu cuenta (expira en 7 días): ${link}`, 'sms') : false;
  return false; // magic | qr | csv → link returned to the admin
}

// ===========================================================================
// INVITATIONS (U1, U3)
// ===========================================================================

adminLifecycle.post('/invitations', requirePermission('users:invite'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const email = String(b?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'email_invalid' }, 400);
  const channel: InviteChannel = ['email', 'sms', 'magic', 'qr', 'csv'].includes(b?.channel) ? b.channel : 'email';
  const phone = b?.phone ? String(b.phone).trim() : null;
  if (channel === 'sms' && !phone) return c.json({ error: 'phone_required' }, 400);

  const { id, token, link } = await createInvitation(c.env, {
    email, roleKey: b?.roleKey ?? null, deptId: b?.deptId ?? null, channel, phone,
    invitedBy: currentUser(c)?.id ?? null,
  });
  const sent = await deliverInvite(c.env, channel, email, phone, link);
  await audit(c, 'invitations.create', { id, email, channel, roleKey: b?.roleKey ?? null });
  await logSecurity(c, 'invite.create', id, { email, channel, sent });
  // Raw token/link returned ONCE so the admin can copy it or render the QR.
  return c.json({ id, link, token, sent }, 201);
});

adminLifecycle.get('/invitations', requirePermission('users:invite'), async (c) => {
  const status = (c.req.query('status') || '').trim();
  const where: string[] = []; const binds: any[] = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  const sql = `SELECT id, email, role_id, dept_id, channel, status, invited_by, phone, expires_ms, created_ms, accepted_ms, approved_by
               FROM invitations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_ms DESC LIMIT 500`;
  const invitations = ((await c.env.DB.prepare(sql).bind(...binds).all()).results ?? []);
  return c.json({ invitations });
});

adminLifecycle.post('/invitations/:id/revoke', requirePermission('users:invite'), async (c) => {
  const id = c.req.param('id');
  const inv: any = await c.env.DB.prepare('SELECT id, status FROM invitations WHERE id = ?').bind(id).first();
  if (!inv) return c.json({ error: 'not_found' }, 404);
  if (inv.status === 'accepted') return c.json({ error: 'already_accepted' }, 409);
  await c.env.DB.prepare(`UPDATE invitations SET status = 'revoked' WHERE id = ?`).bind(id).run();
  await audit(c, 'invitations.revoke', { id });
  await logSecurity(c, 'invite.revoke', id, {});
  return c.json({ ok: true });
});

adminLifecycle.post('/invitations/:id/resend', requirePermission('users:invite'), async (c) => {
  const id = c.req.param('id');
  const inv: any = await c.env.DB.prepare('SELECT * FROM invitations WHERE id = ?').bind(id).first();
  if (!inv) return c.json({ error: 'not_found' }, 404);
  if (inv.status === 'accepted') return c.json({ error: 'already_accepted' }, 409);
  // Regenerate the token (new hash, fresh 7-day expiry, re-open if revoked/expired).
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE invitations SET token_hash = ?, status = 'pending', expires_ms = ?, accepted_ms = NULL WHERE id = ?`,
  ).bind(await sha256hex(token), now + 7 * 86_400_000, id).run();
  const link = acceptLink(c.env, token);
  const sent = await deliverInvite(c.env, inv.channel as InviteChannel, inv.email, inv.phone ?? null, link);
  await audit(c, 'invitations.resend', { id });
  await logSecurity(c, 'invite.resend', id, { sent });
  return c.json({ ok: true, id, link, token, sent });
});

// ===========================================================================
// ACCEPT (PUBLIC — token-authenticated, NOT permission-gated)
// ===========================================================================

adminLifecycle.get('/invitations/accept', async (c) => {
  const token = (c.req.query('token') || '').trim();
  const inv = await verifyInvitation(c.env, token);
  if (!inv) return c.json({ valid: false });
  let roleName: string | null = null;
  if (inv.role_id) {
    const r: any = await c.env.DB.prepare('SELECT name FROM rbac_roles WHERE id = ?').bind(inv.role_id).first();
    roleName = r?.name ?? null;
  }
  return c.json({ valid: true, email: inv.email, roleName });
});

adminLifecycle.post('/invitations/accept', async (c) => {
  const limited = await rateLimit(c.env, c, 'invite_accept', 10, 60);
  if (limited) return limited;
  const b: any = await c.req.json().catch(() => ({}));
  const token = String(b?.token || '').trim();
  const res = await acceptInvitation(c.env, token, { name: b?.name, password: b?.password });
  if (!res.ok) {
    await logSecurity(c, 'invite.accept_fail', null, { error: res.error });
    return c.json({ error: res.error }, (res.code ?? 400) as any);
  }
  await audit(c, 'invitations.accept', { userId: res.userId, pending: res.pending });
  await logSecurity(c, 'invite.accept', res.userId ?? null, { pending: res.pending });
  return c.json({ ok: true, userId: res.userId, pending: !!res.pending }, 201);
});

// ===========================================================================
// APPROVAL WORKFLOW (U2)
// ===========================================================================

adminLifecycle.get('/approvals', requirePermission('users:update'), async (c) => {
  const approvals = ((await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.status, u.created_ms,
            ar.requested_role_id, r.key AS requested_role_key, r.name AS requested_role_name
       FROM users u
       LEFT JOIN approval_requests ar ON ar.user_id = u.id AND ar.status = 'pending'
       LEFT JOIN rbac_roles r ON r.id = ar.requested_role_id
      WHERE u.status = 'pending'
      ORDER BY u.created_ms DESC LIMIT 500`,
  ).all()).results ?? []);
  return c.json({ approvals });
});

adminLifecycle.post('/users/:id/approve', requirePermission('users:update'), async (c) => {
  const id = c.req.param('id');
  const u: any = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!u) return c.json({ error: 'not_found' }, 404);
  const approver = currentUser(c)?.id ?? null;
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(id).run();
  await c.env.DB.prepare(
    `UPDATE approval_requests SET status = 'approved', decided_by = ?, decided_ms = ? WHERE user_id = ? AND status = 'pending'`,
  ).bind(approver, now, id).run();
  await c.env.DB.prepare(
    `UPDATE invitations SET approved_by = ? WHERE email = (SELECT email FROM users WHERE id = ?)`,
  ).bind(approver, id).run().catch(() => {});
  await bumpEpoch(c.env, id);
  await audit(c, 'users.approve', { id });
  await logSecurity(c, 'user.approve', id, {});
  return c.json({ ok: true });
});

adminLifecycle.post('/users/:id/reject', requirePermission('users:update'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const u: any = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!u) return c.json({ error: 'not_found' }, 404);
  const approver = currentUser(c)?.id ?? null;
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE users SET status = 'inactive' WHERE id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run().catch(() => {});
  await c.env.DB.prepare(
    `UPDATE approval_requests SET status = 'rejected', decided_by = ?, decided_ms = ? WHERE user_id = ? AND status = 'pending'`,
  ).bind(approver, now, id).run();
  await audit(c, 'users.reject', { id, reason: b?.reason ?? null });
  await logSecurity(c, 'user.reject', id, { reason: b?.reason ?? null });
  return c.json({ ok: true });
});

// ===========================================================================
// TEMPORARY ROLES (U4) — user_roles rows with a non-null expires_ms.
// ===========================================================================

async function resolveRoleId(c: Context<{ Bindings: Env }>, b: any): Promise<string | null> {
  if (b?.roleId) {
    const r: any = await c.env.DB.prepare('SELECT id FROM rbac_roles WHERE id = ?').bind(b.roleId).first();
    return r?.id ?? null;
  }
  if (b?.roleKey) {
    const r: any = await c.env.DB.prepare('SELECT id FROM rbac_roles WHERE key = ?').bind(b.roleKey).first();
    return r?.id ?? null;
  }
  return null;
}

adminLifecycle.post('/users/:id/temp-roles', requirePermission('roles:assign'), async (c) => {
  const userId = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const expiresMs = Number(b?.expires_ms);
  if (!Number.isFinite(expiresMs)) return c.json({ error: 'expires_ms_required' }, 400);
  const roleId = await resolveRoleId(c, b);
  if (!roleId) return c.json({ error: 'role_not_found' }, b?.roleId || b?.roleKey ? 404 : 400);
  // Upsert so re-granting (or converting a permanent grant to temp) updates expiry.
  await c.env.DB.prepare(
    `INSERT INTO user_roles (user_id, role_id, granted_by, granted_ms, expires_ms) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, role_id) DO UPDATE SET expires_ms = excluded.expires_ms, granted_by = excluded.granted_by, granted_ms = excluded.granted_ms`,
  ).bind(userId, roleId, currentUser(c)?.id ?? null, Date.now(), expiresMs).run();
  await bumpEpoch(c.env, userId);
  await audit(c, 'roles.temp_grant', { userId, roleId, expiresMs });
  await logSecurity(c, 'role.temp_grant', userId, { roleId, expiresMs });
  return c.json({ ok: true });
});

adminLifecycle.get('/users/:id/temp-roles', requirePermission('roles:read'), async (c) => {
  const userId = c.req.param('id');
  const now = Date.now();
  const rows = ((await c.env.DB.prepare(
    `SELECT ur.role_id, r.key, r.name, ur.granted_by, ur.granted_ms, ur.expires_ms
       FROM user_roles ur LEFT JOIN rbac_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.expires_ms IS NOT NULL
      ORDER BY ur.expires_ms DESC`,
  ).bind(userId).all()).results ?? []) as any[];
  const assignments = rows.map((r) => ({ ...r, expired: Number(r.expires_ms) <= now }));
  return c.json({ assignments });
});

adminLifecycle.delete('/users/:id/temp-roles/:roleId', requirePermission('roles:assign'), async (c) => {
  const userId = c.req.param('id');
  const roleId = c.req.param('roleId');
  // Only remove TEMPORARY assignments (expires_ms set) so a permanent grant isn't
  // dropped through the temp-role surface.
  await c.env.DB.prepare(
    'DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND expires_ms IS NOT NULL',
  ).bind(userId, roleId).run();
  await bumpEpoch(c.env, userId);
  await audit(c, 'roles.temp_revoke', { userId, roleId });
  await logSecurity(c, 'role.temp_revoke', userId, { roleId });
  return c.json({ ok: true });
});
