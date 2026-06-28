import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminRolesIo } from '../src/routes/admin-roles-io';

const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0009_password_resets.sql',
  'migrations/0046_rbac_workforce.sql',
  'migrations/0047_rbac_seed.sql',
  'migrations/0052_rbac_finegrained.sql',
  'migrations/0054_impersonation.sql',
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminRolesIo);

  const now = Date.now();
  const a = await hashPassword('pw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);
  ins.run('usr_target', 'target@s.com', 'Target', 'citizen', a.hash, a.salt, 'active', now);
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', a.hash, a.salt, 'active', now);
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now);
  return { db, env, app, now };
}

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };
const ADMIN = { Authorization: 'Bearer tok_admin', ...J };
const CIT = { Authorization: 'Bearer tok_cit', ...J };

function req(app: Hono, env: any, method: string, path: string, headers?: any, body?: unknown) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env);
}

describe('A2 — permission diff viewer', () => {
  it('returns correct added/removed for perms and inherits (no mutation)', async () => {
    const { app, env, db, now } = await setup();
    db.raw.prepare(`INSERT INTO rbac_roles (id,org_id,key,name,inherits_json,is_system,created_ms) VALUES (?,?,?,?,?,0,?)`)
      .run('role_diff', 'org_sismo911', 'diffme', 'Diff Me', '["citizen"]', now);
    db.raw.prepare(`INSERT INTO role_permissions (role_id,perm_key,effect) VALUES (?,?,?)`).run('role_diff', 'a', 'allow');
    db.raw.prepare(`INSERT INTO role_permissions (role_id,perm_key,effect) VALUES (?,?,?)`).run('role_diff', 'b', 'allow');

    const r = await req(app, env, 'POST', '/api/rbac/roles/role_diff/diff', ADMIN, { perms: ['b', 'c'], inherits: ['operator'] });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.added).toEqual(['c']);
    expect(j.removed).toEqual(['a']);
    expect(j.inheritsAdded).toEqual(['operator']);
    expect(j.inheritsRemoved).toEqual(['citizen']);

    // no mutation
    const stillTwo: any = db.raw.prepare(`SELECT COUNT(*) n FROM role_permissions WHERE role_id='role_diff'`).get();
    expect(stillTwo.n).toBe(2);
  });

  it('unknown role → 404; citizen → 403', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'POST', '/api/rbac/roles/nope/diff', ADMIN, { perms: [] })).status).toBe(404);
    expect((await req(app, env, 'POST', '/api/rbac/roles/x/diff', CIT, { perms: [] })).status).toBe(403);
  });
});

describe('A3 — role export / import', () => {
  it('export returns version 1 with all roles; citizen → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/roles/export', ADMIN);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.version).toBe(1);
    expect(j.roles.some((x: any) => x.key === 'super_admin' && x.is_system)).toBe(true);

    expect((await req(app, env, 'GET', '/api/rbac/roles/export', CIT)).status).toBe(403);
  });

  it('import round-trips a custom role and SKIPS system roles', async () => {
    const { app, env, db, now } = await setup();
    // a pre-existing custom role to be updated by the round-trip
    db.raw.prepare(`INSERT INTO rbac_roles (id,org_id,key,name,inherits_json,is_system,created_ms) VALUES (?,?,?,?,?,0,?)`)
      .run('role_rt', 'org_sismo911', 'rt_role', 'RT Role', '[]', now);
    db.raw.prepare(`INSERT INTO role_permissions (role_id,perm_key,effect) VALUES (?,?,?)`).run('role_rt', 'users:read', 'allow');

    const exported = await (await req(app, env, 'GET', '/api/rbac/roles/export', ADMIN)).json();

    // add a brand-new role to the payload, then import it all back
    exported.roles.push({ key: 'imported_role', name: 'Imported', description: null, inherits: [], perms: ['roles:read'], is_system: 0 });
    const r = await req(app, env, 'POST', '/api/rbac/roles/import', ADMIN, exported);
    expect(r.status).toBe(200);
    const j = await r.json();

    expect(j.created).toContain('imported_role');
    expect(j.updated).toContain('rt_role');           // existing custom role updated
    expect(j.skipped).toContain('super_admin');        // system roles never overwritten
    expect(j.skipped).toContain('citizen');

    // system role untouched
    const sa: any = db.raw.prepare(`SELECT name FROM rbac_roles WHERE key='super_admin'`).get();
    expect(sa.name).toBe('Super Administrator');
    // new role created as non-system with its perm
    const ir: any = db.raw.prepare(`SELECT id,is_system FROM rbac_roles WHERE key='imported_role'`).get();
    expect(ir.is_system).toBe(0);
    const irPerm: any = db.raw.prepare(`SELECT perm_key FROM role_permissions WHERE role_id=?`).get(ir.id);
    expect(irPerm.perm_key).toBe('roles:read');
  });

  it('import with empty payload → 400; citizen → 403', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'POST', '/api/rbac/roles/import', ADMIN, { version: 1, roles: [] })).status).toBe(400);
    expect((await req(app, env, 'POST', '/api/rbac/roles/import', CIT, { version: 1, roles: [{ key: 'x', name: 'X' }] })).status).toBe(403);
  });
});

describe('A4 — effective-permissions inspector', () => {
  async function withUserGrants() {
    const ctx = await setup();
    const { db, now } = ctx;
    // custom role granting users:read + roles:read
    db.raw.prepare(`INSERT INTO rbac_roles (id,org_id,key,name,inherits_json,is_system,created_ms) VALUES (?,?,?,?,?,0,?)`)
      .run('role_reader', 'org_sismo911', 'reader_x', 'Reader X', '[]', now);
    db.raw.prepare(`INSERT INTO role_permissions (role_id,perm_key,effect) VALUES (?,?,?)`).run('role_reader', 'users:read', 'allow');
    db.raw.prepare(`INSERT INTO role_permissions (role_id,perm_key,effect) VALUES (?,?,?)`).run('role_reader', 'roles:read', 'allow');
    db.raw.prepare(`INSERT INTO user_roles (user_id,role_id,granted_ms) VALUES (?,?,?)`).run('usr_target', 'role_reader', now);
    // direct deny of roles:read (deny wins) + direct allow of permissions:read
    db.raw.prepare(`INSERT INTO user_permissions (user_id,perm_key,effect,granted_ms) VALUES (?,?,?,?)`).run('usr_target', 'roles:read', 'deny', now);
    db.raw.prepare(`INSERT INTO user_permissions (user_id,perm_key,effect,granted_ms) VALUES (?,?,?,?)`).run('usr_target', 'permissions:read', 'allow', now);
    return ctx;
  }

  it('resolves the effective set and explains the source of each permission', async () => {
    const { app, env } = await withUserGrants();
    const r = await req(app, env, 'GET', '/api/rbac/users/usr_target/effective-permissions', ADMIN);
    expect(r.status).toBe(200);
    const j = await r.json();

    // effective: users:read kept, permissions:read added, roles:read denied-out
    expect(j.effective).toContain('users:read');
    expect(j.effective).toContain('permissions:read');
    expect(j.effective).not.toContain('roles:read');

    // bySource explanation
    const reader = j.bySource.roles.find((x: any) => x.role === 'reader_x');
    expect(reader).toBeTruthy();
    expect(reader.perms).toContain('users:read');
    expect(reader.perms).toContain('roles:read');         // role grants it (pre-deny)
    expect(j.bySource.direct).toEqual(expect.arrayContaining([
      { perm: 'roles:read', effect: 'deny' },
      { perm: 'permissions:read', effect: 'allow' },
    ]));
    expect(j.bySource.denied).toContain('roles:read');
  });

  it('unknown user → 404; citizen → 403', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'GET', '/api/rbac/users/nope/effective-permissions', ADMIN)).status).toBe(404);
    expect((await req(app, env, 'GET', '/api/rbac/users/usr_target/effective-permissions', CIT)).status).toBe(403);
  });
});
