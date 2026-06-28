/**
 * Admin Org API — organization → department → team hierarchy.
 *
 * Mounted at /api/rbac (alongside admin-rbac). Same contract as admin-rbac:
 * /api/rbac is "open" to the global ops gate, so each route enforces its OWN
 * fine-grained permission via requirePermission(), and a sub-app CSRF guard
 * rejects cross-site state-changing requests. Every mutation is double-logged
 * (audit() + security_events).
 *
 * Hierarchy integrity is enforced server-side: a department's parent must live
 * in the same org, a team's org must exist, and a department can't be deleted
 * while it still has child departments or assigned users.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { requirePermission, currentUser } from '../rbac/middleware';
import { isAllowedOrigin, requestIp } from '../lib/security';

export const adminOrg = new Hono<{ Bindings: Env }>();

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// --- Sub-app CSRF guard (same-site only on unsafe methods). ---
adminOrg.use('*', async (c, next) => {
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

// ===========================================================================
// ORGANIZATIONS (roots — no delete)
// ===========================================================================

adminOrg.get('/orgs', requirePermission('organizations:read'), async (c) => {
  const orgs = ((await c.env.DB.prepare(
    `SELECT id, slug, name, logo_r2, branding_json, status, created_ms, updated_ms
     FROM organizations ORDER BY created_ms`
  ).all()).results ?? []);
  return c.json({ orgs });
});

adminOrg.post('/orgs', requirePermission('organizations:manage'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const slug = (b?.slug || '').trim().toLowerCase();
  const name = (b?.name || '').trim();
  if (!slug || !name) return c.json({ error: 'slug_and_name_required' }, 400);
  if (await c.env.DB.prepare('SELECT 1 FROM organizations WHERE slug = ?').bind(slug).first())
    return c.json({ error: 'slug_taken' }, 409);
  const id = uid('org');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO organizations (id, slug, name, status, created_ms) VALUES (?,?,?,?,?)`
  ).bind(id, slug, name, b?.status ?? 'active', now).run();
  await audit(c, 'orgs.create', { id, slug });
  await logSecurity(c, 'org.create', id, { slug });
  return c.json({ id }, 201);
});

adminOrg.patch('/orgs/:id', requirePermission('organizations:manage'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  if (!(await c.env.DB.prepare('SELECT 1 FROM organizations WHERE id = ?').bind(id).first()))
    return c.json({ error: 'not_found' }, 404);
  const sets: string[] = []; const binds: any[] = [];
  for (const k of ['name', 'branding_json', 'status', 'logo_r2']) if (k in b) { sets.push(`${k} = ?`); binds.push(b[k] ?? null); }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  binds.push(id);
  await c.env.DB.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(c, 'orgs.update', { id, fields: sets.map((s) => s.split(' ')[0]) });
  await logSecurity(c, 'org.update', id, {});
  return c.json({ ok: true });
});

// ===========================================================================
// DEPARTMENTS (nestable via parent_id)
// ===========================================================================

adminOrg.get('/departments', requirePermission('departments:read'), async (c) => {
  const orgId = (c.req.query('org_id') || 'org_sismo911').trim();
  const rows = ((await c.env.DB.prepare(
    `SELECT id, org_id, name, parent_id, created_ms FROM departments WHERE org_id = ? ORDER BY created_ms`
  ).bind(orgId).all()).results ?? []) as any[];
  // Build a parent→children tree for the roots; flat list also returned.
  const byId = new Map<string, any>(rows.map((d) => [d.id, { ...d, children: [] }]));
  const tree: any[] = [];
  for (const d of byId.values()) {
    if (d.parent_id && byId.has(d.parent_id)) byId.get(d.parent_id).children.push(d);
    else tree.push(d);
  }
  return c.json({ departments: rows, tree });
});

adminOrg.post('/departments', requirePermission('departments:manage'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const orgId = (b?.org_id || 'org_sismo911').trim();
  const name = (b?.name || '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (!(await c.env.DB.prepare('SELECT 1 FROM organizations WHERE id = ?').bind(orgId).first()))
    return c.json({ error: 'org_not_found' }, 400);
  // A parent must exist AND belong to the same org (no cross-org parenting).
  if (b?.parent_id) {
    const p: any = await c.env.DB.prepare('SELECT org_id FROM departments WHERE id = ?').bind(b.parent_id).first();
    if (!p) return c.json({ error: 'parent_not_found' }, 400);
    if (p.org_id !== orgId) return c.json({ error: 'parent_cross_org' }, 400);
  }
  const id = uid('dept');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO departments (id, org_id, name, parent_id, created_ms) VALUES (?,?,?,?,?)`
  ).bind(id, orgId, name, b?.parent_id ?? null, now).run();
  await audit(c, 'departments.create', { id, orgId, parent_id: b?.parent_id ?? null });
  await logSecurity(c, 'department.create', id, { orgId });
  return c.json({ id }, 201);
});

adminOrg.patch('/departments/:id', requirePermission('departments:manage'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const dept: any = await c.env.DB.prepare('SELECT id, org_id FROM departments WHERE id = ?').bind(id).first();
  if (!dept) return c.json({ error: 'not_found' }, 404);
  const sets: string[] = []; const binds: any[] = [];
  if (b?.name != null) { sets.push('name = ?'); binds.push(b.name); }
  if ('parent_id' in b) {
    if (b.parent_id) {
      if (b.parent_id === id) return c.json({ error: 'parent_self' }, 400);
      const p: any = await c.env.DB.prepare('SELECT org_id FROM departments WHERE id = ?').bind(b.parent_id).first();
      if (!p) return c.json({ error: 'parent_not_found' }, 400);
      if (p.org_id !== dept.org_id) return c.json({ error: 'parent_cross_org' }, 400);
    }
    sets.push('parent_id = ?'); binds.push(b.parent_id ?? null);
  }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE departments SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(c, 'departments.update', { id });
  await logSecurity(c, 'department.update', id, {});
  return c.json({ ok: true });
});

adminOrg.delete('/departments/:id', requirePermission('departments:manage'), async (c) => {
  const id = c.req.param('id');
  if (!(await c.env.DB.prepare('SELECT 1 FROM departments WHERE id = ?').bind(id).first()))
    return c.json({ error: 'not_found' }, 404);
  const kids: any = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM departments WHERE parent_id = ?').bind(id).first();
  if (Number(kids?.n ?? 0) > 0) return c.json({ error: 'has_children' }, 409);
  const assigned: any = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE department_id = ?').bind(id).first();
  if (Number(assigned?.n ?? 0) > 0) return c.json({ error: 'has_users' }, 409);
  await c.env.DB.prepare('DELETE FROM departments WHERE id = ?').bind(id).run();
  await audit(c, 'departments.delete', { id });
  await logSecurity(c, 'department.delete', id, {});
  return c.json({ ok: true });
});

// ===========================================================================
// TEAMS + membership
// ===========================================================================

adminOrg.get('/teams', requirePermission('teams:read'), async (c) => {
  const orgId = (c.req.query('org_id') || 'org_sismo911').trim();
  const teams = ((await c.env.DB.prepare(
    `SELECT id, org_id, name, color, priority, leader_id, created_ms FROM teams WHERE org_id = ? ORDER BY priority DESC, created_ms`
  ).bind(orgId).all()).results ?? []);
  return c.json({ teams });
});

adminOrg.post('/teams', requirePermission('teams:manage'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const orgId = (b?.org_id || 'org_sismo911').trim();
  const name = (b?.name || '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (!(await c.env.DB.prepare('SELECT 1 FROM organizations WHERE id = ?').bind(orgId).first()))
    return c.json({ error: 'org_not_found' }, 400);
  const id = uid('team');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO teams (id, org_id, name, color, priority, leader_id, created_ms) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, orgId, name, b?.color ?? null, Number(b?.priority) || 0, b?.leader_id ?? null, now).run();
  await audit(c, 'teams.create', { id, orgId });
  await logSecurity(c, 'team.create', id, { orgId });
  return c.json({ id }, 201);
});

adminOrg.patch('/teams/:id', requirePermission('teams:manage'), async (c) => {
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  if (!(await c.env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first()))
    return c.json({ error: 'not_found' }, 404);
  const sets: string[] = []; const binds: any[] = [];
  for (const k of ['name', 'color', 'leader_id']) if (k in b) { sets.push(`${k} = ?`); binds.push(b[k] ?? null); }
  if ('priority' in b) { sets.push('priority = ?'); binds.push(Number(b.priority) || 0); }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(c, 'teams.update', { id });
  await logSecurity(c, 'team.update', id, {});
  return c.json({ ok: true });
});

adminOrg.delete('/teams/:id', requirePermission('teams:manage'), async (c) => {
  const id = c.req.param('id');
  if (!(await c.env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first()))
    return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare('DELETE FROM team_members WHERE team_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(id).run();
  await audit(c, 'teams.delete', { id });
  await logSecurity(c, 'team.delete', id, {});
  return c.json({ ok: true });
});

adminOrg.get('/teams/:id/members', requirePermission('teams:read'), async (c) => {
  const id = c.req.param('id');
  const members = ((await c.env.DB.prepare(
    `SELECT tm.team_id, tm.user_id, tm.role_in_team, tm.added_ms, u.name, u.email
     FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.added_ms`
  ).bind(id).all()).results ?? []);
  return c.json({ members });
});

adminOrg.post('/teams/:id/members', requirePermission('teams:manage'), async (c) => {
  const teamId = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const userId = (b?.user_id || '').trim();
  if (!userId) return c.json({ error: 'user_id_required' }, 400);
  if (!(await c.env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(teamId).first()))
    return c.json({ error: 'team_not_found' }, 404);
  if (!(await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(userId).first()))
    return c.json({ error: 'user_not_found' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO team_members (team_id, user_id, role_in_team, added_ms) VALUES (?,?,?,?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET role_in_team = excluded.role_in_team`
  ).bind(teamId, userId, b?.role_in_team ?? 'member', Date.now()).run();
  await audit(c, 'teams.member_add', { teamId, userId, role_in_team: b?.role_in_team ?? 'member' });
  await logSecurity(c, 'team.member_add', teamId, { userId });
  return c.json({ ok: true });
});

adminOrg.delete('/teams/:id/members/:userId', requirePermission('teams:manage'), async (c) => {
  const teamId = c.req.param('id');
  const userId = c.req.param('userId');
  await c.env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId).run();
  await audit(c, 'teams.member_remove', { teamId, userId });
  await logSecurity(c, 'team.member_remove', teamId, { userId });
  return c.json({ ok: true });
});
