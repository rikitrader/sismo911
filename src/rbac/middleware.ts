/**
 * Hono middleware + helpers that enforce RBAC server-side. The frontend never
 * controls access — every gated endpoint resolves the caller's effective
 * permissions here.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest, type User } from '../lib/auth';
import { hasPermission, isModuleEnabled } from './engine';

/** Legacy admin = super_admin: short-circuit to avoid an engine lookup on the
 *  hottest, most-privileged path (and to stay byte-identical to old behavior). */
function isSuperAdmin(user: { role?: string } | null): boolean {
  return user?.role === 'admin';
}

/** Authoritative check used by both the global gate and per-route middleware. */
export async function authorize(env: Env, user: User | null, perm: string): Promise<boolean> {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  return hasPermission(env, user.id, perm);
}

/** Require a specific permission. 401 if unauthenticated, 403 if lacking it. */
export function requirePermission(perm: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = await getUserFromRequest(c.env, c).catch(() => null);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (!(await authorize(c.env, user, perm))) return c.json({ error: 'forbidden', need: perm }, 403);
    c.set('user' as never, user as never);
    return next();
  };
}

/** Require ANY of the listed permissions. */
export function requireAnyPermission(...perms: string[]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = await getUserFromRequest(c.env, c).catch(() => null);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    for (const p of perms) if (await authorize(c.env, user, p)) { c.set('user' as never, user as never); return next(); }
    return c.json({ error: 'forbidden', need: perms }, 403);
  };
}

/** Require only that the caller is authenticated (any role). */
export const requireLogin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user' as never, user as never);
  return next();
};

/**
 * Gate a feature module. A DISABLED module returns 404 — not 403 — so a disabled
 * surface is indistinguishable from a nonexistent one (no information leak), per
 * the security contract.
 */
export function requireModule(moduleKey: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!(await isModuleEnabled(c.env, moduleKey))) return c.notFound();
    return next();
  };
}

/** Fetch the user previously stashed by a require* middleware. */
export function currentUser(c: Context): User | null {
  return (c.get('user' as never) as User) ?? null;
}
