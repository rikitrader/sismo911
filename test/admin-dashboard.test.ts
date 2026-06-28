import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminRbac } from '../src/routes/admin-rbac';

const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0009_password_resets.sql',
  'migrations/0046_rbac_workforce.sql',
  'migrations/0047_rbac_seed.sql',
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0'); // getUserFromRequest selects it
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminRbac);
  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'suspended', now);
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms,revoked_ms) VALUES (?,?,?,?,?)`);
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now, null);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now, null);
  // a couple of login-history + invitation rows for the aggregates
  db.raw.prepare(`INSERT INTO login_history (id,user_id,email,ip,ua,ok,reason,created_ms) VALUES (?,?,?,?,?,?,?,?)`)
    .run('lh_1', 'usr_admin', 'admin@s.com', '1.2.3.4', 'ua', 1, null, now);
  db.raw.prepare(`INSERT INTO login_history (id,user_id,email,ip,ua,ok,reason,created_ms) VALUES (?,?,?,?,?,?,?,?)`)
    .run('lh_2', null, 'bad@s.com', '5.6.7.8', 'ua', 0, 'invalid_credentials', now);
  db.raw.prepare(`INSERT INTO invitations (id,org_id,email,token_hash,channel,status,expires_ms,created_ms) VALUES (?,?,?,?,?,?,?,?)`)
    .run('inv_1', 'org_sismo911', 'new@s.com', 'hash', 'email', 'pending', now + 1000, now);
  return { db, env, app };
}

describe('admin RBAC dashboard', () => {
  it('admin GET /dashboard → 200 with the documented shape', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/dashboard', { headers: { Authorization: 'Bearer tok_admin' } }, env);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.users).toMatchObject({
      total: 2, active: 1, suspended: 1, pending: 0, locked: 0,
    });
    expect(typeof j.users.online).toBe('number');
    expect(Array.isArray(j.recentLogins)).toBe(true);
    expect(Array.isArray(j.permChanges)).toBe(true);
    expect(j.failedLogins24h).toBe(1);
    expect(j.recentInvitations).toBe(1);
  });

  it('citizen GET /dashboard → 403', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/dashboard', { headers: { Authorization: 'Bearer tok_cit' } }, env);
    expect(r.status).toBe(403);
  });

  it('unauthenticated GET /dashboard → 401', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/dashboard', {}, env);
    expect(r.status).toBe(401);
  });
});
