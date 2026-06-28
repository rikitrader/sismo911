/**
 * Admin Feature-Flags API — scoped module toggles (org < role < user).
 *
 * Mounted at /api/rbac (alongside admin-rbac/admin-org). The Phase-0 base table
 * `feature_flags(org_id, module_key)` is the org-only opt-out layer; this API
 * manages the higher-precedence `feature_flag_overrides` table and resolves a
 * user's effective map via src/lib/feature-flags.ts.
 *
 * Per the route contract each route enforces its OWN permission and the sub-app
 * CSRF guard rejects cross-site writes; every mutation is double-logged.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { requirePermission, currentUser } from '../rbac/middleware';
import { isAllowedOrigin, requestIp } from '../lib/security';
import { effectiveFlagsForUser } from '../lib/feature-flags';

export const adminFlags = new Hono<{ Bindings: Env }>();

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const SCOPES = new Set(['org', 'role', 'user']);

adminFlags.use('*', async (c, next) => {
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
// FEATURE FLAGS
// ===========================================================================

/** Base (org) flags + every override, grouped by module. */
adminFlags.get('/feature-flags', requirePermission('feature_flags:read'), async (c) => {
  const base = ((await c.env.DB.prepare(
    `SELECT org_id, module_key, enabled, updated_by, updated_ms FROM feature_flags ORDER BY module_key`
  ).all()).results ?? []) as any[];
  const overrides = ((await c.env.DB.prepare(
    `SELECT id, module_key, scope_type, scope_id, enabled, updated_by, updated_ms
     FROM feature_flag_overrides ORDER BY module_key, scope_type`
  ).all()).results ?? []) as any[];

  const modules: Record<string, { base: any[]; overrides: any[] }> = {};
  for (const b of base) (modules[b.module_key] ??= { base: [], overrides: [] }).base.push(b);
  for (const o of overrides) (modules[o.module_key] ??= { base: [], overrides: [] }).overrides.push(o);
  return c.json({ modules });
});

/** Upsert a scoped override (org|role|user). */
adminFlags.put('/feature-flags', requirePermission('feature_flags:manage'), async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const module_key = (b?.module_key || '').trim();
  const scope_type = (b?.scope_type || '').trim();
  const scope_id = (b?.scope_id || '').trim();
  if (!module_key || !scope_id || !SCOPES.has(scope_type))
    return c.json({ error: 'module_scope_required' }, 400);
  if (typeof b?.enabled !== 'boolean' && b?.enabled !== 0 && b?.enabled !== 1)
    return c.json({ error: 'enabled_required' }, 400);
  const enabled = b.enabled === true || b.enabled === 1 ? 1 : 0;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO feature_flag_overrides (id, module_key, scope_type, scope_id, enabled, updated_by, updated_ms)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(module_key, scope_type, scope_id)
       DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_ms = excluded.updated_ms`
  ).bind(uid('ffo'), module_key, scope_type, scope_id, enabled, currentUser(c)?.id ?? null, now).run();
  await audit(c, 'feature_flags.set', { module_key, scope_type, scope_id, enabled });
  await logSecurity(c, 'flag.change', scope_id, { module_key, scope_type, enabled });
  return c.json({ ok: true });
});

/** Remove an override (falls back to lower precedence). */
adminFlags.delete('/feature-flags/:moduleKey/:scopeType/:scopeId', requirePermission('feature_flags:manage'), async (c) => {
  const module_key = c.req.param('moduleKey');
  const scope_type = c.req.param('scopeType');
  const scope_id = c.req.param('scopeId');
  await c.env.DB.prepare(
    `DELETE FROM feature_flag_overrides WHERE module_key = ? AND scope_type = ? AND scope_id = ?`
  ).bind(module_key, scope_type, scope_id).run();
  await audit(c, 'feature_flags.unset', { module_key, scope_type, scope_id });
  await logSecurity(c, 'flag.change', scope_id, { module_key, scope_type, removed: true });
  return c.json({ ok: true });
});

/** Resolved flag map for a user (org < role < user precedence). */
adminFlags.get('/feature-flags/effective', requirePermission('feature_flags:read'), async (c) => {
  const userId = (c.req.query('user_id') || '').trim();
  if (!userId) return c.json({ error: 'user_id_required' }, 400);
  const u: any = await c.env.DB.prepare('SELECT id, org_id FROM users WHERE id = ?').bind(userId).first();
  if (!u) return c.json({ error: 'user_not_found' }, 404);
  const flags = await effectiveFlagsForUser(c.env, u);
  return c.json({ user_id: userId, flags });
});
