/**
 * Scoped feature-flag resolution (org < role < user precedence).
 *
 * Phase-0 `src/rbac/engine.ts#isModuleEnabled` answers the ORG-only question.
 * This module is the scoped SUPERSET used by the admin flags API: it layers the
 * org-only base table under a higher-precedence `feature_flag_overrides` table
 * so a module can be toggled for a single org, a role, or one user.
 *
 * Layers, lowest → highest (highest matching wins):
 *   1. base  feature_flags(org_id, module_key)            — Phase-0 opt-out base
 *   2. override scope_type='org'  scope_id=orgId
 *   3. override scope_type='role' scope_id ∈ user's roleKeys
 *   4. override scope_type='user' scope_id=userId
 *
 * Default ENABLED when no row exists at any layer (modules are opt-out).
 */
import type { Env } from '../types';

const ORG = 'org_sismo911';

export type FlagScope = { orgId?: string; roleKeys?: string[]; userId?: string };
export type FlagSource = 'default' | 'org-base' | 'org' | 'role' | 'user';

/**
 * Resolve a single module flag for a scope, returning both the boolean and the
 * winning layer. Cheap: at most 4 small indexed queries.
 */
export async function resolveFlagWithSource(
  env: Env,
  moduleKey: string,
  scope: FlagScope,
): Promise<{ enabled: boolean; source: FlagSource }> {
  const orgId = scope.orgId || ORG;
  const roleKeys = scope.roleKeys ?? [];
  const userId = scope.userId;

  let enabled = true;
  let source: FlagSource = 'default';

  // 1. base org table (Phase-0)
  const base = await env.DB
    .prepare('SELECT enabled FROM feature_flags WHERE org_id = ? AND module_key = ?')
    .bind(orgId, moduleKey).first<any>().catch(() => null);
  if (base) { enabled = Number(base.enabled) === 1; source = 'org-base'; }

  // 2. override: org scope
  const orgOv = await env.DB
    .prepare(`SELECT enabled FROM feature_flag_overrides WHERE module_key = ? AND scope_type = 'org' AND scope_id = ?`)
    .bind(moduleKey, orgId).first<any>().catch(() => null);
  if (orgOv) { enabled = Number(orgOv.enabled) === 1; source = 'org'; }

  // 3. override: role scope (any of the user's roles; most-recent wins on conflict)
  if (roleKeys.length) {
    const ph = roleKeys.map(() => '?').join(',');
    const roleOv = await env.DB
      .prepare(`SELECT enabled FROM feature_flag_overrides
                WHERE module_key = ? AND scope_type = 'role' AND scope_id IN (${ph})
                ORDER BY updated_ms DESC LIMIT 1`)
      .bind(moduleKey, ...roleKeys).first<any>().catch(() => null);
    if (roleOv) { enabled = Number(roleOv.enabled) === 1; source = 'role'; }
  }

  // 4. override: user scope (highest precedence)
  if (userId) {
    const userOv = await env.DB
      .prepare(`SELECT enabled FROM feature_flag_overrides WHERE module_key = ? AND scope_type = 'user' AND scope_id = ?`)
      .bind(moduleKey, userId).first<any>().catch(() => null);
    if (userOv) { enabled = Number(userOv.enabled) === 1; source = 'user'; }
  }

  return { enabled, source };
}

/** Boolean-only convenience wrapper around resolveFlagWithSource. */
export async function resolveFlag(env: Env, moduleKey: string, scope: FlagScope): Promise<boolean> {
  return (await resolveFlagWithSource(env, moduleKey, scope)).enabled;
}

/** The role keys assigned to a user (assigned rows, else legacy users.role). */
export async function roleKeysForUser(env: Env, userId: string): Promise<string[]> {
  const rows = ((await env.DB.prepare(
    `SELECT r.key FROM user_roles ur JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id = ?`
  ).bind(userId).all<any>().catch(() => ({ results: [] }))).results ?? []) as any[];
  const keys = rows.map((r) => r.key);
  if (keys.length === 0) {
    const u = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first<any>().catch(() => null);
    const map: Record<string, string> = { admin: 'super_admin', operator: 'operator', citizen: 'citizen' };
    if (u?.role && map[u.role]) keys.push(map[u.role]);
  }
  return keys;
}

/** Distinct module keys that have any policy row (base or override). */
async function knownModules(env: Env): Promise<string[]> {
  const rows = ((await env.DB.prepare(
    `SELECT module_key FROM feature_flags
     UNION SELECT module_key FROM feature_flag_overrides`
  ).all<any>().catch(() => ({ results: [] }))).results ?? []) as any[];
  return [...new Set(rows.map((r) => r.module_key))];
}

/**
 * Resolved flag map for a user across every module that has any policy row:
 *   { [module]: { enabled, source } }
 * Modules with no policy row anywhere are simply absent (they default ENABLED).
 */
export async function effectiveFlagsForUser(
  env: Env,
  user: { id: string; org_id?: string | null },
): Promise<Record<string, { enabled: boolean; source: FlagSource }>> {
  const orgId = user.org_id || ORG;
  const roleKeys = await roleKeysForUser(env, user.id);
  const modules = await knownModules(env);
  const out: Record<string, { enabled: boolean; source: FlagSource }> = {};
  for (const m of modules) {
    out[m] = await resolveFlagWithSource(env, m, { orgId, roleKeys, userId: user.id });
  }
  return out;
}
