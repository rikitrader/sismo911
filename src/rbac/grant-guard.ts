/**
 * Privilege-monotonicity guard (security audit C1/C2/H2/H3/H8 fix).
 *
 * THE INVARIANT: an actor may only grant roles/permissions that are a SUBSET of
 * their own effective permissions, and may only grant `super_admin` / `owner`
 * (or any role that inherits them) if they are themselves a super_admin. This is
 * enforced identically on EVERY grant path (user create, role assign, permission
 * grant, role create/update, invitation, temp-role, role import) via this one
 * helper — so no single endpoint can become the escalation hole.
 *
 * Without this, a holder of an ordinary delegated capability (`users:create`,
 * `users:invite`, `roles:assign`, …) could mint or assign a `super_admin` and
 * escalate to god-mode.
 */
import type { Env } from '../types';
import { getEffectivePermissions } from './engine';

const GOD_ROLES = new Set(['super_admin', 'owner']);

type Actor = { id: string; role?: string } | null | undefined;

/** A legacy `admin` user IS super_admin (the engine's god-mode short-circuit). */
function isSuperActor(actor: Actor): boolean {
  return actor?.role === 'admin';
}

const rows = async <T = any>(env: Env, sql: string, ...b: any[]): Promise<T[]> => {
  const st = b.length ? env.DB.prepare(sql).bind(...b) : env.DB.prepare(sql);
  return ((await st.all<T>())?.results ?? []) as T[];
};

/** Transitively expand a set of role keys through `inherits_json`. */
async function expandRoleKeys(env: Env, keys: string[]): Promise<{ expanded: Set<string>; touchesGod: boolean }> {
  const all = await rows<any>(env, 'SELECT id, key, inherits_json FROM rbac_roles');
  const byKey = new Map<string, any>(all.map((r) => [r.key, r]));
  const expanded = new Set<string>();
  const stack = [...keys];
  while (stack.length) {
    const k = stack.pop()!;
    if (expanded.has(k)) continue;
    expanded.add(k);
    const r = byKey.get(k);
    if (r) { try { for (const p of JSON.parse(r.inherits_json || '[]')) stack.push(p); } catch { /* ignore */ } }
  }
  const touchesGod = [...expanded].some((k) => GOD_ROLES.has(k));
  return { expanded, touchesGod };
}

/** Effective permission keys conferred by a set of role keys (allow ∪, − deny). */
export async function permsForRoleKeys(env: Env, keys: string[]): Promise<{ perms: Set<string>; touchesGod: boolean }> {
  const { expanded, touchesGod } = await expandRoleKeys(env, keys);
  if (touchesGod) {
    // god-mode roles confer EVERYTHING — represent as the full catalog so the
    // subset check fails for any non-super actor.
    const allPerms = await rows<any>(env, 'SELECT key FROM rbac_permissions');
    return { perms: new Set(allPerms.map((p) => p.key)), touchesGod: true };
  }
  const allRoles = await rows<any>(env, 'SELECT id, key FROM rbac_roles');
  const idByKey = new Map<string, string>(allRoles.map((r) => [r.key, r.id]));
  const ids = new Set([...expanded].map((k) => idByKey.get(k)).filter(Boolean) as string[]);
  const rp = await rows<any>(env, 'SELECT role_id, perm_key, effect FROM role_permissions');
  const allow = new Set<string>(); const deny = new Set<string>();
  for (const r of rp) if (ids.has(r.role_id)) (r.effect === 'deny' ? deny : allow).add(r.perm_key);
  for (const d of deny) allow.delete(d);
  return { perms: allow, touchesGod: false };
}

export interface GrantViolation { status: number; body: { error: string; need?: string[] } }

/**
 * Assert the actor may grant the given roleKeys + permKeys. Returns null if OK,
 * or a {status, body} to return to the caller. super_admin actors pass freely.
 */
export async function assertGrantable(
  env: Env,
  actor: Actor,
  grant: { roleKeys?: string[]; permKeys?: string[] },
): Promise<GrantViolation | null> {
  if (!actor) return { status: 401, body: { error: 'unauthorized' } };
  if (isSuperActor(actor)) return null; // god-mode may grant anything

  const actorPerms = await getEffectivePermissions(env, actor.id);
  const roleKeys = (grant.roleKeys ?? []).filter(Boolean);
  const permKeys = (grant.permKeys ?? []).filter(Boolean);

  // Direct permission grants must be within the actor's own set.
  const missingPerms = permKeys.filter((p) => !actorPerms.has(p));
  if (missingPerms.length) return { status: 403, body: { error: 'grant_exceeds_privilege', need: missingPerms } };

  if (roleKeys.length) {
    const { perms: conferred, touchesGod } = await permsForRoleKeys(env, roleKeys);
    // Only a super_admin may grant/inherit super_admin or owner.
    if (touchesGod) return { status: 403, body: { error: 'cannot_grant_superadmin' } };
    // The role's whole conferred set must be ⊆ the actor's own effective perms.
    const exceeds = [...conferred].filter((p) => !actorPerms.has(p));
    if (exceeds.length) return { status: 403, body: { error: 'grant_exceeds_privilege', need: exceeds.slice(0, 20) } };
  }
  return null;
}
