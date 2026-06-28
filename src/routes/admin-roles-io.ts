/**
 * Admin role tooling (Phase 2 Wave 2 — Admin Tools). Mounted at /api/rbac.
 *
 *  - POST /roles/:id/diff              preview a role change before saving (no mutation)
 *  - GET  /roles/export                dump all roles as portable JSON
 *  - POST /roles/import                upsert custom roles (NEVER overwrites is_system)
 *  - GET  /users/:id/effective-permissions   troubleshooting inspector (perm → source)
 *
 * Each route enforces its OWN permission. Imports double-log (audit +
 * security_events) and bumpEpoch every affected user. CSRF same-site guard on
 * unsafe methods (this prefix is "open" to the global gate — see admin-rbac.ts).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { requirePermission, currentUser } from '../rbac/middleware';
import { getEffectivePermissions, bumpEpoch } from '../rbac/engine';
import { isAllowedOrigin, requestIp } from '../lib/security';

export const adminRolesIo = new Hono<{ Bindings: Env }>();

const ORG = 'org_sismo911';
const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const rowsOf = async <T = any>(c: Context<{ Bindings: Env }>, sql: string, ...binds: any[]): Promise<T[]> =>
  ((await (binds.length ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql)).all()).results ?? []) as T[];
const parseInherits = (j: string | null): string[] => { try { return JSON.parse(j || '[]'); } catch { return []; } };
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// CSRF: unsafe methods must be same-site.
adminRolesIo.use('*', async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const originHdr = c.req.header('origin') || c.req.header('referer')?.split('/').slice(0, 3).join('/');
    const sameSite = originHdr ? isAllowedOrigin(c.env, originHdr) : false;
    if (!sameSite) return c.json({ error: 'bad_origin' }, 403);
  }
  return next();
});

async function logSecurity(c: Context<{ Bindings: Env }>, type: string, targetId: string | null, detail?: unknown) {
  try {
    await c.env.DB.prepare(
      `INSERT INTO security_events (id, type, actor_id, target_id, ip, detail_json, created_ms) VALUES (?,?,?,?,?,?,?)`
    ).bind(
      uid('se'), type, currentUser(c)?.id ?? null, targetId,
      requestIp(c), detail == null ? null : JSON.stringify(detail).slice(0, 2000), Date.now()
    ).run();
  } catch { /* never break the request */ }
}

// ===========================================================================
// A2 — PERMISSION DIFF VIEWER (preview, no mutation)
// POST /roles/:id/diff {perms:[key], inherits:[key]}   (roles:read)
// ===========================================================================
adminRolesIo.post('/roles/:id/diff', requirePermission('roles:read'), async (c) => {
  const id = c.req.param('id');
  const role: any = await c.env.DB.prepare(
    'SELECT id, inherits_json FROM rbac_roles WHERE id = ?'
  ).bind(id).first();
  if (!role) return c.json({ error: 'not_found' }, 404);

  const b: any = await c.req.json().catch(() => ({}));
  const proposedPerms = new Set(strArr(b?.perms));
  const proposedInherits = new Set(strArr(b?.inherits));

  const curPermRows = await rowsOf(c, `SELECT perm_key FROM role_permissions WHERE role_id = ? AND effect = 'allow'`, id);
  const currentPerms = new Set<string>(curPermRows.map((r: any) => r.perm_key));
  const currentInherits = new Set<string>(parseInherits(role.inherits_json));

  const diff = (proposed: Set<string>, current: Set<string>) => ({
    added: [...proposed].filter((x) => !current.has(x)),
    removed: [...current].filter((x) => !proposed.has(x)),
  });
  const p = diff(proposedPerms, currentPerms);
  const i = diff(proposedInherits, currentInherits);
  return c.json({ added: p.added, removed: p.removed, inheritsAdded: i.added, inheritsRemoved: i.removed });
});

// ===========================================================================
// A3 — ROLE EXPORT
// GET /roles/export   (roles:read)
// ===========================================================================
adminRolesIo.get('/roles/export', requirePermission('roles:read'), async (c) => {
  const roles = await rowsOf(c, `SELECT id, key, name, description, inherits_json, is_system FROM rbac_roles ORDER BY is_system DESC, key`);
  const rp = await rowsOf(c, `SELECT role_id, perm_key FROM role_permissions WHERE effect = 'allow'`);
  const permsByRole = new Map<string, string[]>();
  for (const r of rp as any[]) { const a = permsByRole.get(r.role_id) ?? []; a.push(r.perm_key); permsByRole.set(r.role_id, a); }
  const out = {
    version: 1,
    roles: (roles as any[]).map((r) => ({
      key: r.key, name: r.name, description: r.description,
      inherits: parseInherits(r.inherits_json), perms: permsByRole.get(r.id) ?? [],
      is_system: r.is_system,
    })),
  };
  await audit(c, 'roles.export', { count: out.roles.length });
  return c.json(out, 200, { 'content-disposition': 'attachment; filename="rbac-roles.json"' });
});

// ===========================================================================
// A3 — ROLE IMPORT (upsert custom roles; SKIP system roles)
// POST /roles/import {version, roles:[...]}   (roles:create)
// ===========================================================================
adminRolesIo.post('/roles/import', requirePermission('roles:create'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const incoming: any[] = Array.isArray(b?.roles) ? b.roles : [];
  if (!incoming.length) return c.json({ error: 'no_roles' }, 400);

  const created: string[] = []; const updated: string[] = []; const skipped: string[] = [];
  const affectedRoleIds = new Set<string>();
  const now = Date.now();

  for (const r of incoming) {
    const key = typeof r?.key === 'string' ? r.key.trim() : '';
    if (!key || typeof r?.name !== 'string') continue;
    const perms = strArr(r?.perms);
    const inherits = strArr(r?.inherits);

    const existing: any = await c.env.DB.prepare(
      `SELECT id, is_system FROM rbac_roles WHERE key = ? AND IFNULL(org_id,'') IN (?, '')`
    ).bind(key, ORG).first();

    if (existing) {
      if (existing.is_system) { skipped.push(key); continue; } // NEVER overwrite a system role
      await c.env.DB.prepare(
        `UPDATE rbac_roles SET name = ?, description = ?, inherits_json = ?, updated_ms = ? WHERE id = ?`
      ).bind(r.name, r.description ?? null, JSON.stringify(inherits), now, existing.id).run();
      await c.env.DB.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(existing.id).run();
      for (const p of perms) await c.env.DB.prepare(
        `INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES (?,?, 'allow')`
      ).bind(existing.id, p).run();
      affectedRoleIds.add(existing.id);
      updated.push(key);
    } else {
      const id = uid('role');
      await c.env.DB.prepare(
        `INSERT INTO rbac_roles (id, org_id, key, name, description, inherits_json, is_system, created_ms)
         VALUES (?,?,?,?,?,?,0,?)`
      ).bind(id, ORG, key, r.name, r.description ?? null, JSON.stringify(inherits), now).run();
      for (const p of perms) await c.env.DB.prepare(
        `INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES (?,?, 'allow')`
      ).bind(id, p).run();
      affectedRoleIds.add(id);
      created.push(key);
    }
  }

  // Invalidate the permission cache for everyone holding an affected role.
  if (affectedRoleIds.size) {
    const ph = [...affectedRoleIds].map(() => '?').join(',');
    const holders = await rowsOf(c, `SELECT DISTINCT user_id FROM user_roles WHERE role_id IN (${ph})`, ...affectedRoleIds);
    for (const h of holders as any[]) await bumpEpoch(c.env, h.user_id);
  }

  await audit(c, 'roles.import', { created, updated, skipped });
  await logSecurity(c, 'roles.import', null, { created, updated, skipped });
  return c.json({ created, updated, skipped });
});

// ===========================================================================
// A4 — EFFECTIVE-PERMISSIONS INSPECTOR (troubleshooting)
// GET /users/:id/effective-permissions   (permissions:read)
// ===========================================================================
adminRolesIo.get('/users/:id/effective-permissions', requirePermission('permissions:read'), async (c) => {
  const userId = c.req.param('id');
  const user: any = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!user) return c.json({ error: 'not_found' }, 404);

  const effective = [...await getEffectivePermissions(c.env, userId)];

  // Build the explanation: which role / direct grant produced each permission.
  const now = Date.now();
  const assigned = await rowsOf(c,
    `SELECT r.id, r.key FROM user_roles ur JOIN rbac_roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND (ur.expires_ms IS NULL OR ur.expires_ms > ?)`,
    userId, now);
  const allRoles = await rowsOf(c, `SELECT id, key, inherits_json FROM rbac_roles`);
  const byId = new Map<string, any>((allRoles as any[]).map((r) => [r.id, r]));
  const byKey = new Map<string, any>((allRoles as any[]).map((r) => [r.key, r]));
  const rolePerms = await rowsOf(c, `SELECT role_id, perm_key, effect FROM role_permissions`);
  const permsForRole = new Map<string, { allow: string[]; deny: string[] }>();
  for (const rp of rolePerms as any[]) {
    const e = permsForRole.get(rp.role_id) ?? { allow: [], deny: [] };
    (rp.effect === 'deny' ? e.deny : e.allow).push(rp.perm_key);
    permsForRole.set(rp.role_id, e);
  }

  /** Transitively expand a role key into the set of role ids in its chain. */
  const expandRole = (startKey: string): string[] => {
    const seen = new Set<string>(); const ids: string[] = []; const stack = [startKey];
    while (stack.length) {
      const k = stack.pop()!; if (seen.has(k)) continue; seen.add(k);
      const r = byKey.get(k); if (!r) continue;
      ids.push(r.id);
      for (const p of parseInherits(r.inherits_json)) stack.push(p);
    }
    return ids;
  };

  const denied = new Set<string>();
  const roles = (assigned as any[]).map((role) => {
    const chainIds = expandRole(role.key);
    const allow = new Set<string>();
    for (const rid of chainIds) {
      const e = permsForRole.get(rid);
      if (e) { for (const p of e.allow) allow.add(p); for (const p of e.deny) denied.add(p); }
    }
    return { role: role.key, perms: [...allow] };
  });

  const directRows = await rowsOf(c, `SELECT perm_key, effect FROM user_permissions WHERE user_id = ?`, userId);
  const direct = (directRows as any[]).map((d) => ({ perm: d.perm_key, effect: d.effect }));
  for (const d of directRows as any[]) if (d.effect === 'deny') denied.add(d.perm_key);

  return c.json({ effective, bySource: { roles, direct, denied: [...denied] } });
});
