import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminFlags } from '../src/routes/admin-flags';
import { resolveFlag, effectiveFlagsForUser } from '../src/lib/feature-flags';

const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0046_rbac_workforce.sql',
  'migrations/0047_rbac_seed.sql',
  'migrations/0051_org_flags.sql',
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminFlags);

  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'active', now);
  // Give the citizen the 'operator' role so role-scoped overrides apply to them.
  db.raw.exec(
    `INSERT INTO user_roles (user_id, role_id, granted_ms)
     SELECT 'usr_cit', id, ${now} FROM rbac_roles WHERE key = 'operator'`
  );
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now);
  return { db, env, app };
}

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };
const ADMIN = { Authorization: 'Bearer tok_admin', ...J };

function req(app: Hono, env: any, method: string, path: string, headers?: any, body?: unknown) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env);
}

const MOD = 'telemedicina';

describe('admin Feature-Flags API', () => {
  it('permission gating: citizen 403, admin 200', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'GET', '/api/rbac/feature-flags', { Authorization: 'Bearer tok_cit' })).status).toBe(403);
    expect((await req(app, env, 'GET', '/api/rbac/feature-flags', ADMIN)).status).toBe(200);
  });

  it('cross-site PUT rejected with bad_origin (403)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'PUT', '/api/rbac/feature-flags',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://evil.example' },
      { module_key: MOD, scope_type: 'org', scope_id: 'org_sismo911', enabled: false });
    expect(r.status).toBe(403);
  });

  it('default enabled when no policy row anywhere', async () => {
    const { env } = await setup();
    expect(await resolveFlag(env, MOD, { orgId: 'org_sismo911', roleKeys: ['operator'], userId: 'usr_cit' })).toBe(true);
  });

  it('precedence org<role<user: org=off, role=on → ON; then user=off → OFF', async () => {
    const { app, env } = await setup();
    const scope = { orgId: 'org_sismo911', roleKeys: ['operator'], userId: 'usr_cit' };

    // org=off
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'org', scope_id: 'org_sismo911', enabled: false });
    expect(await resolveFlag(env, MOD, scope)).toBe(false);

    // role=on beats org=off
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'role', scope_id: 'operator', enabled: true });
    expect(await resolveFlag(env, MOD, scope)).toBe(true);

    // user=off beats role=on
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'user', scope_id: 'usr_cit', enabled: false });
    expect(await resolveFlag(env, MOD, scope)).toBe(false);
  });

  it('GET /feature-flags/effective resolves via roles + reflects precedence', async () => {
    const { app, env } = await setup();
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'org', scope_id: 'org_sismo911', enabled: false });
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'role', scope_id: 'operator', enabled: true });
    const r = await req(app, env, 'GET', '/api/rbac/feature-flags/effective?user_id=usr_cit', ADMIN);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.flags[MOD].enabled).toBe(true);
    expect(j.flags[MOD].source).toBe('role');
  });

  it('DELETE override falls back to lower precedence', async () => {
    const { app, env } = await setup();
    const scope = { orgId: 'org_sismo911', roleKeys: ['operator'], userId: 'usr_cit' };
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'org', scope_id: 'org_sismo911', enabled: false });
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'user', scope_id: 'usr_cit', enabled: true });
    expect(await resolveFlag(env, MOD, scope)).toBe(true);
    // remove the user override → falls back to org=off
    await req(app, env, 'DELETE', `/api/rbac/feature-flags/${MOD}/user/usr_cit`, ADMIN);
    expect(await resolveFlag(env, MOD, scope)).toBe(false);
  });

  it('effectiveFlagsForUser derives role keys from user_roles', async () => {
    const { app, env } = await setup();
    await req(app, env, 'PUT', '/api/rbac/feature-flags', ADMIN, { module_key: MOD, scope_type: 'role', scope_id: 'operator', enabled: false });
    const flags = await effectiveFlagsForUser(env, { id: 'usr_cit', org_id: 'org_sismo911' });
    expect(flags[MOD].enabled).toBe(false);
    expect(flags[MOD].source).toBe('role');
  });
});
