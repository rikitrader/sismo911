import { describe, it, expect } from 'vitest';
import { getEffectivePermissions, hasPermission, bumpEpoch, isModuleEnabled } from '../src/rbac/engine';

// ── In-memory D1 stub backed by simple tables (matches repo test style) ──────
function makeEnv(seed: {
  users: any[];
  rbac_roles: any[];
  role_permissions: any[];
  user_roles: any[];
  user_permissions?: any[];
  rbac_permissions?: any[];
  feature_flags?: any[];
}) {
  const t = {
    users: seed.users,
    rbac_roles: seed.rbac_roles,
    role_permissions: seed.role_permissions,
    user_roles: seed.user_roles,
    user_permissions: seed.user_permissions ?? [],
    rbac_permissions: seed.rbac_permissions ?? [],
    feature_flags: seed.feature_flags ?? [],
  };
  const exec = (sql: string, args: any[], kind: 'first' | 'all' | 'run') => {
    if (kind === 'run') {
      const m = sql.match(/UPDATE users SET perm_epoch = COALESCE\(perm_epoch,1\) \+ 1 WHERE id = \?/);
      if (m) { const u = t.users.find((x) => x.id === args[0]); if (u) u.perm_epoch = (u.perm_epoch ?? 1) + 1; return { success: true, meta: { changes: 1 } }; }
      return { success: true, meta: { changes: 0 } };
    }
    if (/FROM users WHERE id = \?/.test(sql)) return t.users.find((u) => u.id === args[0]) ?? null;
    if (/FROM user_roles WHERE user_id = \?/.test(sql)) return { results: t.user_roles.filter((r) => r.user_id === args[0]) };
    if (/FROM rbac_roles/.test(sql)) return { results: t.rbac_roles };
    if (/FROM role_permissions/.test(sql)) return { results: t.role_permissions };
    if (/FROM user_permissions WHERE user_id = \?/.test(sql)) return { results: t.user_permissions.filter((r) => r.user_id === args[0]) };
    if (/SELECT key FROM rbac_permissions/.test(sql)) return { results: t.rbac_permissions };
    if (/FROM feature_flags WHERE org_id = \? AND module_key = \?/.test(sql)) return t.feature_flags.find((f) => f.org_id === args[0] && f.module_key === args[1]) ?? null;
    return kind === 'all' ? { results: [] } : null;
  };
  const stmt = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async () => exec(sql, args, 'first'),
    all: async () => exec(sql, args, 'all'),
    run: async () => exec(sql, args, 'run'),
  });
  const kvMap = new Map<string, string>();
  return {
    DB: { prepare: (sql: string) => stmt(sql) },
    CACHE: { get: async (k: string) => kvMap.get(k) ?? null, put: async (k: string, v: string) => { kvMap.set(k, v); } },
    _kv: kvMap,
  } as any;
}

// roles: super_admin (god), reader (incidents:read), operator (inherits reader + cases:read)
const ROLES = [
  { id: 'role_super_admin', key: 'super_admin', inherits_json: '[]' },
  { id: 'role_reader', key: 'reader', inherits_json: '[]' },
  { id: 'role_operator', key: 'operator', inherits_json: '["reader"]' },
];
const ROLE_PERMS = [
  { role_id: 'role_reader', perm_key: 'incidents:read', effect: 'allow' },
  { role_id: 'role_operator', perm_key: 'cases:read', effect: 'allow' },
  { role_id: 'role_operator', perm_key: 'incidents:gps', effect: 'allow' },
];
const ALL_PERMS = [{ key: 'incidents:read' }, { key: 'cases:read' }, { key: 'incidents:gps' }, { key: 'users:delete' }, { key: 'system:manage' }];

describe('RBAC permission engine', () => {
  it('super_admin resolves to every permission in the catalog', async () => {
    const env = makeEnv({
      users: [{ id: 'u1', role: 'admin', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [{ user_id: 'u1', role_id: 'role_super_admin' }],
    });
    const set = await getEffectivePermissions(env, 'u1');
    expect(set.has('system:manage')).toBe(true);
    expect(set.has('users:delete')).toBe(true);
    expect(set.size).toBe(ALL_PERMS.length);
  });

  it('grants exactly a role\'s permissions, nothing more', async () => {
    const env = makeEnv({
      users: [{ id: 'u2', role: 'citizen', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [{ user_id: 'u2', role_id: 'role_reader' }],
    });
    expect(await hasPermission(env, 'u2', 'incidents:read')).toBe(true);
    expect(await hasPermission(env, 'u2', 'users:delete')).toBe(false);
  });

  it('resolves role inheritance transitively', async () => {
    const env = makeEnv({
      users: [{ id: 'u3', role: 'citizen', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [{ user_id: 'u3', role_id: 'role_operator' }],
    });
    const set = await getEffectivePermissions(env, 'u3');
    expect(set.has('cases:read')).toBe(true);       // own grant
    expect(set.has('incidents:read')).toBe(true);   // inherited from reader
    expect(set.has('incidents:gps')).toBe(true);
  });

  it('DENY always wins (user deny overrides a role allow)', async () => {
    const env = makeEnv({
      users: [{ id: 'u4', role: 'citizen', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [{ user_id: 'u4', role_id: 'role_operator' }],
      user_permissions: [{ user_id: 'u4', perm_key: 'incidents:read', effect: 'deny' }],
    });
    expect(await hasPermission(env, 'u4', 'incidents:read')).toBe(false);
    expect(await hasPermission(env, 'u4', 'cases:read')).toBe(true);
  });

  it('direct user allow grants extra permissions', async () => {
    const env = makeEnv({
      users: [{ id: 'u5', role: 'citizen', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [{ user_id: 'u5', role_id: 'role_reader' }],
      user_permissions: [{ user_id: 'u5', perm_key: 'system:manage', effect: 'allow' }],
    });
    expect(await hasPermission(env, 'u5', 'system:manage')).toBe(true);
  });

  it('falls back to legacy users.role when no user_roles rows exist', async () => {
    const env = makeEnv({
      users: [{ id: 'u6', role: 'admin', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [], // not yet backfilled
    });
    expect(await hasPermission(env, 'u6', 'system:manage')).toBe(true); // admin → super_admin
  });

  it('caches by epoch and invalidates on bumpEpoch', async () => {
    const env = makeEnv({
      users: [{ id: 'u7', role: 'citizen', perm_epoch: 1 }],
      rbac_roles: ROLES, role_permissions: ROLE_PERMS, rbac_permissions: ALL_PERMS,
      user_roles: [{ user_id: 'u7', role_id: 'role_reader' }],
    });
    await getEffectivePermissions(env, 'u7');
    expect(env._kv.has('perm:u7:1')).toBe(true);
    // mutate roles, but cache should still serve epoch 1 until bumped
    env.DB.prepare; // noop
    await bumpEpoch(env, 'u7');
    const u = (env as any);
    expect((await u.DB.prepare('SELECT perm_epoch, role FROM users WHERE id = ?').bind('u7').first()).perm_epoch).toBe(2);
    await getEffectivePermissions(env, 'u7');
    expect(env._kv.has('perm:u7:2')).toBe(true); // recomputed under new epoch
  });

  it('isModuleEnabled defaults to enabled, respects an explicit disable', async () => {
    const env = makeEnv({
      users: [], rbac_roles: [], role_permissions: [], user_roles: [],
      feature_flags: [{ org_id: 'org_sismo911', module_key: 'telemedicina', enabled: 0 }],
    });
    expect(await isModuleEnabled(env, 'flota')).toBe(true);         // no row ⇒ enabled
    expect(await isModuleEnabled(env, 'telemedicina')).toBe(false); // explicit disable
  });
});
