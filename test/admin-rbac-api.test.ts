import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminRbac } from '../src/routes/admin-rbac';

// Real-SQLite harness: apply the actual base + RBAC migrations so the route
// handlers run their real SQL (engine resolution, seeded catalog/roles, etc.).
const MIGRATIONS = [
  'migrations/0004_auth.sql',          // users + sessions
  'migrations/0002_ops.sql',           // audit
  'migrations/0009_password_resets.sql',
  'migrations/0046_rbac_workforce.sql', // rbac tables + ALTER users/sessions
  'migrations/0047_rbac_seed.sql',      // permission catalog + system roles
  'migrations/0052_rbac_finegrained.sql', // fine-grained perms + user_roles.expires_ms
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT'); // getUserFromRequest selects it
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0'); // getUserFromRequest selects it
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0'); // getUserFromRequest selects it
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminRbac);

  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);     // legacy admin → super_admin
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'active', now);       // no perms
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now);
  return { db, env, app };
}

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };
const ADMIN = { Authorization: 'Bearer tok_admin', ...J };
const CIT = { Authorization: 'Bearer tok_cit', ...J };

function req(app: Hono, env: any, method: string, path: string, headers?: any, body?: unknown) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env);
}

describe('admin RBAC API — authorization gating', () => {
  it('unauthenticated GET /users → 401', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/users');
    expect(r.status).toBe(401);
  });

  it('admin reads GET /users → 200 with roles attached', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_admin' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.users)).toBe(true);
    expect(j.users.length).toBe(2);
    expect(j.users[0]).toHaveProperty('roles');
  });

  it('citizen GET /users → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_cit' });
    expect(r.status).toBe(403);
  });

  it('admin POST /roles → 200 + {id}; citizen → 403', async () => {
    const { app, env } = await setup();
    const ok = await req(app, env, 'POST', '/api/rbac/roles', ADMIN, { key: 'field_lead', name: 'Field Lead', perms: ['incidents:read'] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toMatch(/^role_/);

    const denied = await req(app, env, 'POST', '/api/rbac/roles', CIT, { key: 'x', name: 'X' });
    expect(denied.status).toBe(403);
  });

  it('admin POST /users/:id/roles → 200; citizen → 403', async () => {
    const { app, env } = await setup();
    const ok = await req(app, env, 'POST', '/api/rbac/users/usr_cit/roles', ADMIN, { roleKey: 'operator' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);

    const denied = await req(app, env, 'POST', '/api/rbac/users/usr_admin/roles', CIT, { roleKey: 'operator' });
    expect(denied.status).toBe(403);
  });

  it('cross-site write is rejected with bad_origin (403)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/roles',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://evil.example' },
      { key: 'z', name: 'Z' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('bad_origin');
  });

  it('granting a role takes effect through the engine (epoch bumped)', async () => {
    const { app, env } = await setup();
    // citizen lacks users:read
    expect((await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_cit' })).status).toBe(403);
    // grant a role that has users:read (operations_director)
    await req(app, env, 'POST', '/api/rbac/users/usr_cit/roles', ADMIN, { roleKey: 'operations_director' });
    const after = await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_cit' });
    expect(after.status).toBe(200);
  });

  it('GET /permissions returns a category map', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/permissions', { Authorization: 'Bearer tok_admin' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.categories).toBeTruthy();
    expect(j.categories.Administration.some((p: any) => p.key === 'users:read')).toBe(true);
  });

  it('GET /users.csv exports CSV for an admin', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/users.csv', { Authorization: 'Bearer tok_admin' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const text = await r.text();
    expect(text.split('\n')[0]).toBe('id,email,name,job_title,employment_type,status,last_login_ms');
  });
});
