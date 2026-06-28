import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminOrg } from '../src/routes/admin-org';

// Real-SQLite harness: apply the actual base + RBAC migrations so the org/dept/
// team routes run their real SQL against the seeded org + permission catalog.
const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0046_rbac_workforce.sql',
  'migrations/0047_rbac_seed.sql',
  'migrations/0052_rbac_finegrained.sql', // fine-grained perms + user_roles.expires_ms
  'migrations/0051_org_flags.sql',
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminOrg);

  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'active', now);
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

describe('admin Org API — orgs / departments / teams', () => {
  it('citizen GET /orgs → 403; admin → 200 with seeded org', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'GET', '/api/rbac/orgs', { Authorization: 'Bearer tok_cit' })).status).toBe(403);
    const r = await req(app, env, 'GET', '/api/rbac/orgs', { Authorization: 'Bearer tok_admin' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.orgs.some((o: any) => o.id === 'org_sismo911')).toBe(true);
  });

  it('cross-site write is rejected with bad_origin (403)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/orgs',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://evil.example' },
      { slug: 'z', name: 'Z' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('bad_origin');
  });

  it('admin POST /orgs → 201; citizen → 403', async () => {
    const { app, env } = await setup();
    const ok = await req(app, env, 'POST', '/api/rbac/orgs', ADMIN, { slug: 'alpha', name: 'Alpha Org' });
    expect(ok.status).toBe(201);
    expect((await ok.json()).id).toMatch(/^org_/);
    const denied = await req(app, env, 'POST', '/api/rbac/orgs', CIT, { slug: 'beta', name: 'Beta' });
    expect(denied.status).toBe(403);
  });

  it('department: parent must be in the same org → 400', async () => {
    const { app, env } = await setup();
    // Second org + a department under it.
    const o2 = await (await req(app, env, 'POST', '/api/rbac/orgs', ADMIN, { slug: 'two', name: 'Two' })).json();
    const d2 = await (await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { org_id: o2.id, name: 'Dept2' })).json();
    expect(d2.id).toMatch(/^dept_/);
    // Try to create a dept in org_sismo911 whose parent is in the other org.
    const bad = await req(app, env, 'POST', '/api/rbac/departments', ADMIN,
      { org_id: 'org_sismo911', name: 'Child', parent_id: d2.id });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('parent_cross_org');
  });

  it('department tree nests children under parents', async () => {
    const { app, env } = await setup();
    const root = await (await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { name: 'Ops' })).json();
    const child = await (await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { name: 'Field', parent_id: root.id })).json();
    const r = await req(app, env, 'GET', '/api/rbac/departments?org_id=org_sismo911', ADMIN);
    const j = await r.json();
    const rootNode = j.tree.find((d: any) => d.id === root.id);
    expect(rootNode.children.some((ch: any) => ch.id === child.id)).toBe(true);
  });

  it('DELETE department refuses while it has children → 409', async () => {
    const { app, env } = await setup();
    const root = await (await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { name: 'R' })).json();
    await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { name: 'C', parent_id: root.id });
    const del = await req(app, env, 'DELETE', `/api/rbac/departments/${root.id}`, ADMIN);
    expect(del.status).toBe(409);
    expect((await del.json()).error).toBe('has_children');
  });

  it('team create + member add/remove + list', async () => {
    const { app, env } = await setup();
    const t = await (await req(app, env, 'POST', '/api/rbac/teams', ADMIN, { name: 'Rescue', priority: 5 })).json();
    expect(t.id).toMatch(/^team_/);

    const add = await req(app, env, 'POST', `/api/rbac/teams/${t.id}/members`, ADMIN, { user_id: 'usr_cit', role_in_team: 'member' });
    expect(add.status).toBe(200);

    const list = await (await req(app, env, 'GET', `/api/rbac/teams/${t.id}/members`, ADMIN)).json();
    expect(list.members.length).toBe(1);
    expect(list.members[0].user_id).toBe('usr_cit');

    const rm = await req(app, env, 'DELETE', `/api/rbac/teams/${t.id}/members/usr_cit`, ADMIN);
    expect(rm.status).toBe(200);
    const after = await (await req(app, env, 'GET', `/api/rbac/teams/${t.id}/members`, ADMIN)).json();
    expect(after.members.length).toBe(0);
  });

  it('team in a nonexistent org → 400', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/teams', ADMIN, { org_id: 'org_nope', name: 'X' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('org_not_found');
  });
});
