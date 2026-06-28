/**
 * RBAC permission engine.
 *
 * Effective permissions for a user =
 *     (allow grants from their roles, with role inheritance resolved transitively)
 *   ∪ (direct user allow grants)
 *   −  (any deny grant — from a role OR the user; DENY ALWAYS WINS)
 *
 * `super_admin` (directly or via inheritance) short-circuits to every permission
 * in the catalog — full, unrestricted access.
 *
 * Resolution is cached in KV under `perm:{userId}:{epoch}`. Any change to a user's
 * roles/permissions calls bumpEpoch(), which increments users.perm_epoch so the
 * old cache key is abandoned (and TTL-expires) — O(1) invalidation, no session
 * scan, cheap on the Workers subrequest budget (hot path ≈ 1 KV read).
 *
 * Back-compat: a user with no rows in user_roles falls back to the legacy
 * users.role column (admin→super_admin, operator→operator, citizen→citizen) so
 * the live site behaves identically before/after the migration.
 */
import type { Env } from '../types';

const PERM_CACHE_TTL = 300; // seconds — safety net; epoch bump is the real invalidator

const LEGACY_ROLE_MAP: Record<string, string> = {
  admin: 'super_admin',
  operator: 'operator',
  citizen: 'citizen',
};

const rows = async <T = any>(env: Env, sql: string, ...binds: any[]): Promise<T[]> => {
  const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  const r = await stmt.all<T>();
  return (r?.results ?? []) as T[];
};

/** Full effective permission-key set for a user (cached). */
export async function getEffectivePermissions(env: Env, userId: string): Promise<Set<string>> {
  const u = await env.DB.prepare('SELECT perm_epoch, role FROM users WHERE id = ?').bind(userId).first<any>();
  if (!u) return new Set();
  const epoch = Number(u.perm_epoch ?? 1);
  const cacheKey = `perm:${userId}:${epoch}`;

  const cached = await env.CACHE.get(cacheKey).catch(() => null);
  if (cached) {
    try { return new Set<string>(JSON.parse(cached)); } catch { /* fall through to recompute */ }
  }

  const set = await resolve(env, userId, u.role);
  await env.CACHE.put(cacheKey, JSON.stringify([...set]), { expirationTtl: PERM_CACHE_TTL }).catch(() => {});
  return set;
}

async function resolve(env: Env, userId: string, legacyRole: string | null): Promise<Set<string>> {
  const assigned = await rows<any>(env, 'SELECT role_id FROM user_roles WHERE user_id = ?', userId);
  const allRoles = await rows<any>(env, 'SELECT id, key, inherits_json FROM rbac_roles');
  const byId = new Map<string, any>(allRoles.map((r) => [r.id, r]));
  const byKey = new Map<string, any>(allRoles.map((r) => [r.key, r]));

  // Starting role keys (assigned, else legacy fallback so nothing breaks).
  const startKeys = new Set<string>();
  for (const a of assigned) { const r = byId.get(a.role_id); if (r) startKeys.add(r.key); }
  if (startKeys.size === 0 && legacyRole && LEGACY_ROLE_MAP[legacyRole]) startKeys.add(LEGACY_ROLE_MAP[legacyRole]);

  // Transitively expand role inheritance.
  const expanded = new Set<string>();
  const stack = [...startKeys];
  while (stack.length) {
    const k = stack.pop()!;
    if (expanded.has(k)) continue;
    expanded.add(k);
    const r = byKey.get(k);
    if (r) { try { for (const p of JSON.parse(r.inherits_json || '[]')) stack.push(p); } catch { /* ignore */ } }
  }

  // god-mode
  if (expanded.has('super_admin')) {
    const all = await rows<any>(env, 'SELECT key FROM rbac_permissions');
    return new Set(all.map((p) => p.key));
  }

  const expandedIds = new Set<string>([...expanded].map((k) => byKey.get(k)?.id).filter(Boolean));
  const rolePerms = await rows<any>(env, 'SELECT role_id, perm_key, effect FROM role_permissions');
  const userPerms = await rows<any>(env, 'SELECT perm_key, effect FROM user_permissions WHERE user_id = ?', userId);

  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const rp of rolePerms) if (expandedIds.has(rp.role_id)) (rp.effect === 'deny' ? deny : allow).add(rp.perm_key);
  for (const up of userPerms) (up.effect === 'deny' ? deny : allow).add(up.perm_key);
  for (const d of deny) allow.delete(d); // deny wins
  return allow;
}

/** True if the user holds `perm` (e.g. 'patients:read'). */
export async function hasPermission(env: Env, userId: string, perm: string): Promise<boolean> {
  return (await getEffectivePermissions(env, userId)).has(perm);
}

/** True if the user holds ALL of `perms`. */
export async function hasAll(env: Env, userId: string, perms: string[]): Promise<boolean> {
  const set = await getEffectivePermissions(env, userId);
  return perms.every((p) => set.has(p));
}

/** True if the user holds ANY of `perms`. */
export async function hasAny(env: Env, userId: string, perms: string[]): Promise<boolean> {
  const set = await getEffectivePermissions(env, userId);
  return perms.some((p) => set.has(p));
}

/** Invalidate a user's cached permission set after any role/permission change. */
export async function bumpEpoch(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET perm_epoch = COALESCE(perm_epoch,1) + 1 WHERE id = ?').bind(userId).run();
}

/** Whether a feature module is enabled for the org (default-enabled if no row). */
export async function isModuleEnabled(env: Env, moduleKey: string, orgId = 'org_sismo911'): Promise<boolean> {
  const r = await env.DB
    .prepare('SELECT enabled FROM feature_flags WHERE org_id = ? AND module_key = ?')
    .bind(orgId, moduleKey).first<any>().catch(() => null);
  if (!r) return true; // no policy row ⇒ enabled (modules are opt-out)
  return Number(r.enabled) === 1;
}
