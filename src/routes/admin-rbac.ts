/**
 * Admin RBAC API — fine-grained user / role / permission administration.
 *
 * Mounted at /api/rbac (NOT /api/admin — that prefix is globally gated by
 * `ops:console`, which would collapse every fine-grained permission into the
 * coarse operator gate). /api/rbac is "open" to the global gate (route-policy)
 * so each route here enforces its OWN permission via requirePermission(); a
 * sub-app guard additionally rejects cross-site state-changing requests.
 *
 * Every mutation is double-logged: audit() (human-readable trail) +
 * security_events (security-relevant change feed). Any change to a user's roles
 * or permissions calls bumpEpoch() to invalidate that user's KV permission cache.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { hashPassword } from '../lib/auth';
import { requirePermission, requireAnyPermission, currentUser } from '../rbac/middleware';
import { getEffectivePermissions, bumpEpoch } from '../rbac/engine';
import { assertGrantable } from '../rbac/grant-guard';
import { redactRow, loadFieldPolicies } from '../rbac/field-policy';
import { isAllowedOrigin, requestIp } from '../lib/security';
import { randomToken, sha256hex, sendEmail, resetEmail } from '../lib/email';

export const adminRbac = new Hono<{ Bindings: Env }>();

const ORG = 'org_sismo911';
const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// --- Sub-app CSRF guard: state-changing calls must be same-site. The global
// gate (index.ts) does this for gated prefixes; /api/rbac is "open" to it, so we
// repeat the same-site check here (a missing Origin/Referer on an unsafe method
// is treated as NOT same-site — defense-in-depth vs CSRF). ---
adminRbac.use('*', async (c, next) => {
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

/**
 * Keep the legacy users.role fast-path consistent with the user's RBAC roles
 * (audit follow-up: removing a user's super_admin role must also drop the legacy
 * 'admin' fast-path, else the console shows them de-privileged while they retain
 * god-mode). RBAC is the source of truth: admin > operator > citizen.
 */
async function reconcileLegacyRole(c: Context<{ Bindings: Env }>, userId: string) {
  const keys = (((await c.env.DB.prepare(
    'SELECT r.key FROM user_roles ur JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id = ?'
  ).bind(userId).all()).results ?? []) as any[]).map((r) => r.key);
  const legacy = keys.includes('super_admin') ? 'admin' : keys.includes('operator') ? 'operator' : 'citizen';
  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(legacy, userId).run();
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ===========================================================================
// USERS
// ===========================================================================

adminRbac.get('/users', requirePermission('users:read'), async (c) => {
  const q = (c.req.query('q') || '').trim();
  const status = (c.req.query('status') || '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500);
  const where: string[] = []; const binds: any[] = [];
  if (q) { where.push('(email LIKE ? OR name LIKE ? OR username LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('status = ?'); binds.push(status); }
  const sql = `SELECT id,email,name,preferred_name,username,job_title,department_id,employment_type,status,last_login_ms
               FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_ms DESC LIMIT ?`;
  binds.push(limit);
  const users = ((await c.env.DB.prepare(sql).bind(...binds).all()).results ?? []) as any[];

  // Attach each user's role keys in one pass.
  const rolesByUser = new Map<string, string[]>();
  if (users.length) {
    const ph = users.map(() => '?').join(',');
    const rows = ((await c.env.DB.prepare(
      `SELECT ur.user_id, r.key FROM user_roles ur JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id IN (${ph})`
    ).bind(...users.map((u) => u.id)).all()).results ?? []) as any[];
    for (const r of rows) { const a = rolesByUser.get(r.user_id) ?? []; a.push(r.key); rolesByUser.set(r.user_id, a); }
  }
  return c.json({ users: users.map((u) => ({ ...u, roles: rolesByUser.get(u.id) ?? [] })) });
});

// Export must be registered before /users/:id would never match it (distinct
// path), but keep it grouped with users.
adminRbac.get('/users.csv', requirePermission('users:export'), async (c) => {
  const rows = ((await c.env.DB.prepare(
    `SELECT id,email,name,job_title,employment_type,status,last_login_ms FROM users ORDER BY created_ms DESC LIMIT 5000`
  ).all()).results ?? []) as any[];
  const header = 'id,email,name,job_title,employment_type,status,last_login_ms';
  const body = [header, ...rows.map((r) =>
    [r.id, r.email, r.name, r.job_title, r.employment_type, r.status, r.last_login_ms].map(csvCell).join(','))].join('\n');
  await audit(c, 'users.export', { count: rows.length });
  return c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="users.csv"',
  });
});

adminRbac.get('/users/:id', requirePermission('users:read'), async (c) => {
  const id = c.req.param('id');
  const user: any = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!user) return c.json({ error: 'not_found' }, 404);
  // SECURITY (audit H6): never leak ANY credential material — including the
  // later-added mfa_backup_codes (hashed MFA recovery codes) — in a profile payload.
  delete user.pw_hash; delete user.pw_salt; delete user.mfa_secret; delete user.mfa_backup_codes;
  // SECURITY (audit M1): enforce field-level policies (emergency_contact, notes,
  // last_ip, …) against the CALLER's permissions before returning the row.
  let safeUser: any = user;
  const callerId = currentUser(c)?.id;
  if (callerId) {
    const [policies, perms] = await Promise.all([
      loadFieldPolicies(c.env, 'users'),
      getEffectivePermissions(c.env, callerId),
    ]);
    safeUser = redactRow(user, policies, perms);
  }
  const roles = ((await c.env.DB.prepare(
    'SELECT r.id, r.key, r.name FROM user_roles ur JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id = ?'
  ).bind(id).all()).results ?? []);
  const directPermissions = ((await c.env.DB.prepare(
    'SELECT perm_key, effect FROM user_permissions WHERE user_id = ?'
  ).bind(id).all()).results ?? []);
  const effectivePermissions = [...await getEffectivePermissions(c.env, id)];
  return c.json({ user: safeUser, roles, directPermissions, effectivePermissions });
});

adminRbac.post('/users', requirePermission('users:create'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const email = (b?.email || '').trim().toLowerCase();
  if (!emailOk(email)) return c.json({ error: 'email_invalid' }, 400);
  if (!b?.name) return c.json({ error: 'name_required' }, 400);
  if (await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    return c.json({ error: 'email_taken' }, 409);

  const roleKeys: string[] = Array.isArray(b.roleKeys) ? b.roleKeys.filter((k: any) => typeof k === 'string') : [];
  // SECURITY (audit C1/H2): a `users:create` holder must not be able to mint a
  // role above their own privilege — enforce the grant ceiling on the seeded roles.
  const grantViolation = await assertGrantable(c.env, currentUser(c), { roleKeys });
  if (grantViolation) return c.json(grantViolation.body, grantViolation.status as any);

  // Sensible legacy users.role so the coarse fast-path gate stays coherent.
  let legacyRole = 'citizen';
  if (roleKeys.includes('super_admin')) legacyRole = 'admin';
  else if (roleKeys.includes('operator')) legacyRole = 'operator';

  const id = uid('usr');
  const now = Date.now();
  const { hash, salt } = await hashPassword(randomToken(16)); // random temp password — never returned
  // SECURITY (audit H2): status is NOT caller-controllable — new users always
  // start 'pending' and must be activated/approved, so create can't mint an
  // immediately-active privileged account.
  await c.env.DB.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,employment_type,job_title,department_id,status,org_id,created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, email, b.name, legacyRole, hash, salt,
    b.employment_type ?? 'employee', b.job_title ?? null, b.department_id ?? null, 'pending', ORG, now
  ).run();

  for (const key of roleKeys) {
    const r: any = await c.env.DB.prepare('SELECT id FROM rbac_roles WHERE key = ?').bind(key).first();
    if (r) await c.env.DB.prepare(
      'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_ms) VALUES (?,?,?,?)'
    ).bind(id, r.id, currentUser(c)?.id ?? null, now).run();
  }
  await bumpEpoch(c.env, id);
  await audit(c, 'users.create', { id, email, roleKeys });
  await logSecurity(c, 'user.create', id, { email, roleKeys });
  return c.json({ id }, 201);
});

const PROFILE_FIELDS = ['name', 'preferred_name', 'job_title', 'department_id', 'manager_id', 'office',
  'location', 'employment_type', 'timezone', 'language', 'notes', 'phone'];

adminRbac.patch('/users/:id', requirePermission('users:update'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const sets: string[] = []; const binds: any[] = [];
  for (const k of PROFILE_FIELDS) if (k in b) { sets.push(`${k} = ?`); binds.push(b[k] ?? null); }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(c, 'users.update', { id, fields: sets.map((s) => s.split(' ')[0]) });
  return c.json({ ok: true });
});

adminRbac.post('/users/:id/suspend', requirePermission('users:suspend'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run(); // revoke active sessions
  await audit(c, 'users.suspend', { id, reason: b?.reason ?? null });
  await logSecurity(c, 'user.suspend', id, { reason: b?.reason ?? null });
  return c.json({ ok: true });
});

adminRbac.post('/users/:id/activate', requirePermission('users:suspend'), async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(id).run();
  await audit(c, 'users.activate', { id });
  await logSecurity(c, 'user.activate', id, {});
  return c.json({ ok: true });
});

adminRbac.post('/users/:id/reset-password', requirePermission('users:reset_password'), async (c) => {
  const id = c.req.param('id');
  const u: any = await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(id).first();
  if (!u) return c.json({ error: 'not_found' }, 404);
  const raw = randomToken();
  const now = Date.now();
  // Same table/flow as POST /api/auth/forgot-password (1h single-use token).
  await c.env.DB.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_ms, used_ms, created_ms) VALUES (?,?,?,?,?,?)`
  ).bind(uid('rst'), u.id, await sha256hex(raw), now + 60 * 60 * 1000, null, now).run();
  const base = c.env.PUBLIC_BASE_URL || 'https://sismo911.com';
  const sent = await sendEmail(c.env, u.email, resetEmail(u.name, `${base}/restablecer?token=${raw}`)); // token never echoed
  await audit(c, 'users.reset_password', { id });
  await logSecurity(c, 'user.reset_password', id, { sent });
  return c.json({ ok: true, sent });
});

// ===========================================================================
// INVITATIONS
// ===========================================================================

adminRbac.get('/invitations', requirePermission('users:invite'), async (c) => {
  const invitations = ((await c.env.DB.prepare(
    `SELECT id, email, role_id, dept_id, channel, status, invited_by, expires_ms, created_ms, accepted_ms
     FROM invitations ORDER BY created_ms DESC LIMIT 500`
  ).all()).results ?? []);
  return c.json({ invitations });
});

adminRbac.post('/invitations', requirePermission('users:invite'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const email = (b?.email || '').trim().toLowerCase();
  if (!emailOk(email)) return c.json({ error: 'email_invalid' }, 400);
  let roleId: string | null = null;
  if (b?.roleKey) {
    const r: any = await c.env.DB.prepare('SELECT id FROM rbac_roles WHERE key = ?').bind(b.roleKey).first();
    roleId = r?.id ?? null;
  }
  const token = randomToken();
  const id = uid('inv');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO invitations (id, org_id, email, role_id, dept_id, token_hash, channel, status, invited_by, expires_ms, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, ORG, email, roleId, null, await sha256hex(token), b?.channel ?? 'email', 'pending',
    currentUser(c)?.id ?? null, now + 7 * 86_400_000, now).run();
  await audit(c, 'invitations.create', { id, email, roleKey: b?.roleKey ?? null });
  await logSecurity(c, 'invitation.create', id, { email });
  return c.json({ id, token }); // raw token returned so the admin can build the invite link
});

// ===========================================================================
// ROLES
// ===========================================================================

adminRbac.get('/roles', requirePermission('roles:read'), async (c) => {
  const roles = ((await c.env.DB.prepare(
    `SELECT r.id, r.key, r.name, r.description, r.inherits_json, r.is_system,
            r.department_id, d.name AS department_name
       FROM rbac_roles r LEFT JOIN departments d ON d.id = r.department_id
      ORDER BY r.is_system DESC, r.key`
  ).all()).results ?? []) as any[];
  const rp = ((await c.env.DB.prepare(
    `SELECT role_id, perm_key FROM role_permissions WHERE effect = 'allow'`
  ).all()).results ?? []) as any[];
  const permsByRole = new Map<string, string[]>();
  for (const r of rp) { const a = permsByRole.get(r.role_id) ?? []; a.push(r.perm_key); permsByRole.set(r.role_id, a); }
  return c.json({
    roles: roles.map((r) => ({
      id: r.id, key: r.key, name: r.name, description: r.description,
      inherits: (() => { try { return JSON.parse(r.inherits_json || '[]'); } catch { return []; } })(),
      is_system: r.is_system, department_id: r.department_id ?? null, department: r.department_name ?? null,
      perms: permsByRole.get(r.id) ?? [],
    })),
  });
});

adminRbac.post('/roles', requirePermission('roles:create'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const key = (b?.key || '').trim();
  if (!key || !b?.name) return c.json({ error: 'key_and_name_required' }, 400);
  if (await c.env.DB.prepare(`SELECT 1 FROM rbac_roles WHERE key = ? AND IFNULL(org_id,'') = ?`).bind(key, ORG).first())
    return c.json({ error: 'role_exists' }, 409);
  // SECURITY (audit H3): can't create a role granting perms/inherits beyond your own.
  {
    const v = await assertGrantable(c.env, currentUser(c), {
      roleKeys: Array.isArray(b.inherits) ? b.inherits : [],
      permKeys: Array.isArray(b.perms) ? b.perms : [],
    });
    if (v) return c.json(v.body, v.status as any);
  }
  const id = uid('role');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO rbac_roles (id, org_id, key, name, description, inherits_json, is_system, created_ms) VALUES (?,?,?,?,?,?,0,?)`
  ).bind(id, ORG, key, b.name, b.description ?? null, JSON.stringify(Array.isArray(b.inherits) ? b.inherits : []), now).run();
  if (Array.isArray(b.perms)) {
    for (const p of b.perms) await c.env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES (?,?, 'allow')`
    ).bind(id, p).run();
  }
  await audit(c, 'roles.create', { id, key });
  await logSecurity(c, 'role.create', id, { key });
  return c.json({ id });
});

adminRbac.patch('/roles/:id', requirePermission('roles:update'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const role: any = await c.env.DB.prepare('SELECT id, is_system FROM rbac_roles WHERE id = ?').bind(id).first();
  if (!role) return c.json({ error: 'not_found' }, 404);
  if (role.is_system && 'key' in b) return c.json({ error: 'system_role_key_immutable' }, 409);
  // SECURITY (audit H3): a role update can't raise the role's perms/inherits
  // above the actor's own privilege (e.g. inherits:["super_admin"] self-escalation).
  {
    const v = await assertGrantable(c.env, currentUser(c), {
      roleKeys: b.inherits !== undefined && Array.isArray(b.inherits) ? b.inherits : [],
      permKeys: Array.isArray(b.perms) ? b.perms : [],
    });
    if (v) return c.json(v.body, v.status as any);
  }

  const sets: string[] = []; const binds: any[] = [];
  if (b.name != null) { sets.push('name = ?'); binds.push(b.name); }
  if (b.description !== undefined) { sets.push('description = ?'); binds.push(b.description); }
  if (b.inherits !== undefined) { sets.push('inherits_json = ?'); binds.push(JSON.stringify(Array.isArray(b.inherits) ? b.inherits : [])); }
  if (b.department_id !== undefined) {
    // Reassign (or clear with null) the owning department; validate it exists in this org.
    if (b.department_id !== null) {
      const d: any = await c.env.DB.prepare('SELECT id FROM departments WHERE id = ? AND org_id = ?').bind(b.department_id, ORG).first();
      if (!d) return c.json({ error: 'department_not_found' }, 400);
    }
    sets.push('department_id = ?'); binds.push(b.department_id);
  }
  sets.push('updated_ms = ?'); binds.push(Date.now());
  binds.push(id);
  await c.env.DB.prepare(`UPDATE rbac_roles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  if (Array.isArray(b.perms)) {
    await c.env.DB.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(id).run();
    for (const p of b.perms) await c.env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES (?,?, 'allow')`
    ).bind(id, p).run();
  }
  // Anyone holding this role has a stale permission cache → bump them all.
  const holders = ((await c.env.DB.prepare('SELECT user_id FROM user_roles WHERE role_id = ?').bind(id).all()).results ?? []) as any[];
  for (const h of holders) await bumpEpoch(c.env, h.user_id);
  await audit(c, 'roles.update', { id });
  await logSecurity(c, 'role.update', id, { perms: Array.isArray(b.perms) ? b.perms.length : undefined });
  return c.json({ ok: true });
});

adminRbac.delete('/roles/:id', requirePermission('roles:delete'), async (c) => {
  const id = c.req.param('id');
  const role: any = await c.env.DB.prepare('SELECT id, is_system FROM rbac_roles WHERE id = ?').bind(id).first();
  if (!role) return c.json({ error: 'not_found' }, 404);
  if (role.is_system) return c.json({ error: 'system_role_undeletable' }, 409);
  const holders = ((await c.env.DB.prepare('SELECT user_id FROM user_roles WHERE role_id = ?').bind(id).all()).results ?? []) as any[];
  await c.env.DB.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM user_roles WHERE role_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM rbac_roles WHERE id = ?').bind(id).run();
  for (const h of holders) await bumpEpoch(c.env, h.user_id);
  await audit(c, 'roles.delete', { id });
  await logSecurity(c, 'role.delete', id, {});
  return c.json({ ok: true });
});

adminRbac.post('/users/:id/roles', requirePermission('roles:assign'), async (c) => {
  const userId = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  let roleId: string | null = b?.roleId ?? null;
  if (!roleId && b?.roleKey) {
    const r: any = await c.env.DB.prepare('SELECT id FROM rbac_roles WHERE key = ?').bind(b.roleKey).first();
    roleId = r?.id ?? null;
  }
  if (!roleId) return c.json({ error: 'role_required' }, 400);
  const roleRow: any = await c.env.DB.prepare('SELECT key FROM rbac_roles WHERE id = ?').bind(roleId).first();
  if (!roleRow) return c.json({ error: 'role_not_found' }, 404);
  // SECURITY (audit H3/H8): can't assign a role conferring privileges above your own.
  const v = await assertGrantable(c.env, currentUser(c), { roleKeys: [roleRow.key] });
  if (v) return c.json(v.body, v.status as any);
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_ms) VALUES (?,?,?,?)'
  ).bind(userId, roleId, currentUser(c)?.id ?? null, Date.now()).run();
  await reconcileLegacyRole(c, userId);
  await bumpEpoch(c.env, userId);
  await audit(c, 'roles.assign', { userId, roleId });
  await logSecurity(c, 'role.assign', userId, { roleId });
  return c.json({ ok: true });
});

adminRbac.delete('/users/:id/roles/:roleId', requirePermission('roles:assign'), async (c) => {
  const userId = c.req.param('id');
  const roleId = c.req.param('roleId');
  await c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').bind(userId, roleId).run();
  await reconcileLegacyRole(c, userId);
  await bumpEpoch(c.env, userId);
  await audit(c, 'roles.unassign', { userId, roleId });
  await logSecurity(c, 'role.unassign', userId, { roleId });
  return c.json({ ok: true });
});

// ===========================================================================
// PERMISSIONS
// ===========================================================================

adminRbac.get('/permissions', requirePermission('permissions:read'), async (c) => {
  const perms = ((await c.env.DB.prepare(
    `SELECT key, resource, action, label, category FROM rbac_permissions ORDER BY category, key`
  ).all()).results ?? []) as any[];
  const categories: Record<string, any[]> = {};
  for (const p of perms) {
    const cat = p.category || 'Other';
    (categories[cat] ??= []).push({ key: p.key, resource: p.resource, action: p.action, label: p.label });
  }
  return c.json({ categories });
});

adminRbac.post('/users/:id/permissions', requirePermission('permissions:grant'), async (c) => {
  const userId = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const perm_key = (b?.perm_key || '').trim();
  const effect = b?.effect;
  if (!perm_key || !['allow', 'deny'].includes(effect)) return c.json({ error: 'perm_key_and_effect_required' }, 400);
  if (!(await c.env.DB.prepare('SELECT 1 FROM rbac_permissions WHERE key = ?').bind(perm_key).first()))
    return c.json({ error: 'unknown_permission' }, 400);
  // SECURITY (audit H3): an ALLOW grant can't exceed the actor's own privilege.
  // (A deny is restrictive, so it needs no ceiling.)
  if (effect === 'allow') {
    const v = await assertGrantable(c.env, currentUser(c), { permKeys: [perm_key] });
    if (v) return c.json(v.body, v.status as any);
  }
  await c.env.DB.prepare(
    `INSERT INTO user_permissions (user_id, perm_key, effect, granted_by, granted_ms) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, perm_key) DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, granted_ms = excluded.granted_ms`
  ).bind(userId, perm_key, effect, currentUser(c)?.id ?? null, Date.now()).run();
  await bumpEpoch(c.env, userId);
  await audit(c, 'permissions.grant', { userId, perm_key, effect });
  await logSecurity(c, 'permission.grant', userId, { perm_key, effect });
  return c.json({ ok: true });
});

adminRbac.delete('/users/:id/permissions/:permKey', requirePermission('permissions:grant'), async (c) => {
  const userId = c.req.param('id');
  const permKey = c.req.param('permKey');
  await c.env.DB.prepare('DELETE FROM user_permissions WHERE user_id = ? AND perm_key = ?').bind(userId, permKey).run();
  await bumpEpoch(c.env, userId);
  await audit(c, 'permissions.revoke', { userId, permKey });
  await logSecurity(c, 'permission.revoke', userId, { permKey });
  return c.json({ ok: true });
});

// ===========================================================================
// AUDIT / SECURITY / LOGIN HISTORY
// ===========================================================================

const clampLimit = (c: Context, def = 100) => Math.min(Math.max(Number(c.req.query('limit')) || def, 1), 500);

adminRbac.get('/audit', requirePermission('audit:read'), async (c) => {
  const events = ((await c.env.DB.prepare(
    `SELECT id, actor, action, detail, created_ms FROM audit ORDER BY created_ms DESC LIMIT ?`
  ).bind(clampLimit(c)).all()).results ?? []);
  return c.json({ events });
});

adminRbac.get('/security-events', requirePermission('security:read'), async (c) => {
  const events = ((await c.env.DB.prepare(
    `SELECT id, type, actor_id, target_id, ip, detail_json, created_ms FROM security_events ORDER BY created_ms DESC LIMIT ?`
  ).bind(clampLimit(c)).all()).results ?? []);
  return c.json({ events });
});

// CSP Report-Only violations captured during the observation window before we drop
// script-src 'unsafe-inline'. Deduped by signature with a hit count (see migration 0066).
adminRbac.get('/csp-violations', requirePermission('security:read'), async (c) => {
  const violations = ((await c.env.DB.prepare(
    `SELECT sig, document_uri, violated_directive, effective_directive, blocked_uri, source_file,
            line_no, col_no, script_sample, user_agent, count, first_seen, last_seen
       FROM csp_reports ORDER BY last_seen DESC LIMIT ?`,
  ).bind(clampLimit(c)).all()).results ?? []);
  const totals: any = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS distinct_violations, COALESCE(SUM(count), 0) AS total_hits FROM csp_reports`,
  ).first()) ?? { distinct_violations: 0, total_hits: 0 };
  return c.json({ totals, violations });
});

adminRbac.get('/login-history', requirePermission('login_history:read'), async (c) => {
  const okParam = c.req.query('ok');
  const where = okParam === '0' || okParam === '1' ? `WHERE ok = ${okParam}` : '';
  const events = ((await c.env.DB.prepare(
    `SELECT id, user_id, email, ip, ua, ok, reason, created_ms FROM login_history ${where} ORDER BY created_ms DESC LIMIT ?`
  ).bind(clampLimit(c)).all()).results ?? []);
  return c.json({ events });
});

// ===========================================================================
// DASHBOARD (goal task t-008 API)
// ===========================================================================

adminRbac.get('/dashboard', requireAnyPermission('security:read', 'audit:read', 'users:read'), async (c) => {
  const now = Date.now();
  const u: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='active'    THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) AS suspended,
            SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status='locked'    THEN 1 ELSE 0 END) AS locked
     FROM users`
  ).first();
  const online: any = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_ms > ? AND revoked_ms IS NULL`
  ).bind(now).first();
  const recentLogins = ((await c.env.DB.prepare(
    `SELECT email, ip, ok, created_ms FROM login_history ORDER BY created_ms DESC LIMIT 10`
  ).all()).results ?? []);
  const permChanges = ((await c.env.DB.prepare(
    `SELECT type, actor_id, created_ms FROM security_events
     WHERE type LIKE 'permission.%' OR type LIKE 'role.%' ORDER BY created_ms DESC LIMIT 10`
  ).all()).results ?? []);
  const failed: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_history WHERE ok = 0 AND created_ms > ?`
  ).bind(now - 86_400_000).first();
  const invites: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM invitations WHERE status = 'pending'`
  ).first();

  return c.json({
    users: {
      total: Number(u?.total ?? 0), active: Number(u?.active ?? 0), suspended: Number(u?.suspended ?? 0),
      pending: Number(u?.pending ?? 0), locked: Number(u?.locked ?? 0), online: Number(online?.n ?? 0),
    },
    recentLogins,
    permChanges,
    failedLogins24h: Number(failed?.n ?? 0),
    recentInvitations: Number(invites?.n ?? 0),
  });
});
