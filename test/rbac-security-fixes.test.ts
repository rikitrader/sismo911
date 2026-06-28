import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, RBAC_MIGRATIONS, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminRbac } from '../src/routes/admin-rbac';
import { adminLifecycle } from '../src/routes/admin-lifecycle';
import { evaluateGate } from '../src/rbac/route-policy';
import { assertGrantable } from '../src/rbac/grant-guard';

// Regression guards for the 2026-06-27 adversarial RBAC audit. Each confirmed
// finding gets an assertion so a future edit that reopens the hole fails CI.

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };

async function setup() {
  const db: D1Mock = makeDb(RBAC_MIGRATIONS);
  // getUserFromRequest selects these columns (added by donations/x402 migrations
  // outside the RBAC set); add them so authenticated sessions resolve.
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminLifecycle); // lifecycle first (mirrors index.ts)
  app.route('/api/rbac', adminRbac);

  const now = Date.now();
  const pw = await hashPassword('pw');
  const ins = db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`);
  // super_admin (legacy admin), an HR delegate (has users:* + users:invite, NOT super), a support user (users:read only), a suspended user.
  ins.run('u_super', 'super@s.com', 'Super', 'admin', pw.hash, pw.salt, 'active', now);
  ins.run('u_hr', 'hr@s.com', 'HR', 'citizen', pw.hash, pw.salt, 'active', now);
  ins.run('u_support', 'support@s.com', 'Sup', 'citizen', pw.hash, pw.salt, 'active', now);
  ins.run('u_susp', 'susp@s.com', 'Susp', 'citizen', pw.hash, pw.salt, 'suspended', now);
  const ur = db.raw.prepare(`INSERT INTO user_roles (user_id, role_id, granted_ms) VALUES (?,?,?)`);
  ur.run('u_hr', 'role_hr', now);
  ur.run('u_support', 'role_support', now);
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  for (const [t, u] of [['t_super', 'u_super'], ['t_hr', 'u_hr'], ['t_support', 'u_support'], ['t_susp', 'u_susp']])
    sess.run(t, u, now + 86_400_000, now);
  return { db, env, app };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, ...J });
const post = (app: Hono, env: any, path: string, t: string, body: any) =>
  app.request(path, { method: 'POST', headers: auth(t), body: JSON.stringify(body) }, env);

describe('audit C1/H2 — grant ceiling on user create', () => {
  it('an HR delegate CANNOT create a super_admin', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/users', 't_hr', { email: 'evil@x.com', name: 'E', roleKeys: ['super_admin'] });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_grant_superadmin');
  });
  it('a super_admin CAN create a super_admin', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/users', 't_super', { email: 'ok@x.com', name: 'A', roleKeys: ['super_admin'] });
    expect(r.status).toBe(201);
  });
  it('newly-created users are forced status=pending (no caller-controlled active)', async () => {
    const { app, env, db } = await setup();
    await post(app, env, '/api/rbac/users', 't_super', { email: 'p@x.com', name: 'P', status: 'active' });
    const u: any = db.raw.prepare(`SELECT status FROM users WHERE email = ?`).get('p@x.com');
    expect(u.status).toBe('pending');
  });
});

describe('audit C2 — grant ceiling on invitations', () => {
  it('an HR delegate CANNOT invite a super_admin', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/invitations', 't_hr', { email: 'evil@x.com', roleKey: 'super_admin', channel: 'magic' });
    expect(r.status).toBe(403);
  });
});

describe('audit H3/H8 — no self-elevation via role/permission grants', () => {
  it('assertGrantable blocks a non-super actor from granting super_admin', async () => {
    const { env } = await setup();
    const v = await assertGrantable(env, { id: 'u_hr', role: 'citizen' }, { roleKeys: ['super_admin'] });
    expect(v?.body.error).toBe('cannot_grant_superadmin');
  });
  it('assertGrantable blocks granting a permission the actor lacks', async () => {
    const { env } = await setup();
    const v = await assertGrantable(env, { id: 'u_support', role: 'citizen' }, { permKeys: ['system:manage'] });
    expect(v?.status).toBe(403);
  });
  it('assertGrantable allows a super_admin anything', async () => {
    const { env } = await setup();
    expect(await assertGrantable(env, { id: 'u_super', role: 'admin' }, { roleKeys: ['super_admin'] })).toBeNull();
  });
});

describe('audit H4 — account status enforced (lock/suspend is real)', () => {
  it('a suspended account\'s session is rejected on a gated endpoint (401)', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/users', { headers: auth('t_susp') }, env);
    expect(r.status).toBe(401);
  });
  it('locking a user immediately kills their access', async () => {
    const { app, env, db } = await setup();
    db.raw.prepare(`UPDATE users SET status='locked' WHERE id='u_support'`).run();
    const r = await app.request('/api/rbac/users/u_super', { headers: auth('t_support') }, env);
    expect(r.status).toBe(401);
  });
});

describe('audit H6 — no MFA backup codes leak in the user profile', () => {
  it('GET /users/:id never returns mfa_backup_codes / mfa_secret / pw_hash', async () => {
    const { app, env, db } = await setup();
    db.raw.prepare(`UPDATE users SET mfa_backup_codes='["h1","h2"]', mfa_secret='SECRET' WHERE id='u_hr'`).run();
    const r = await app.request('/api/rbac/users/u_hr', { headers: auth('t_super') }, env);
    expect(r.status).toBe(200);
    const { user } = await r.json();
    expect(user.mfa_backup_codes).toBeUndefined();
    expect(user.mfa_secret).toBeUndefined();
    expect(user.pw_hash).toBeUndefined();
    expect(user.pw_salt).toBeUndefined();
  });
});

describe('audit M1 — field-level redaction is enforced on reads', () => {
  it('a users:read-only caller does NOT see emergency_contact (requires users:update)', async () => {
    const { app, env, db } = await setup();
    db.raw.prepare(`UPDATE users SET emergency_contact='ICE 555' WHERE id='u_super'`).run();
    const r = await app.request('/api/rbac/users/u_super', { headers: auth('t_support') }, env);
    expect(r.status).toBe(200);
    const { user } = await r.json();
    expect(user.emergency_contact).toBeUndefined();
  });
  it('a privileged caller (users:update) DOES see emergency_contact', async () => {
    const { app, env, db } = await setup();
    db.raw.prepare(`UPDATE users SET emergency_contact='ICE 555' WHERE id='u_super'`).run();
    const r = await app.request('/api/rbac/users/u_super', { headers: auth('t_super') }, env);
    const { user } = await r.json();
    expect(user.emergency_contact).toBe('ICE 555');
  });
});

describe('audit H1 — FLOTA writes require the write capability', () => {
  it('flota GET → flota:read, but unsafe methods → flota:dispatch', () => {
    expect(evaluateGate('/api/flota/unidades', 'GET')).toMatchObject({ perm: 'flota:read' });
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(evaluateGate('/api/flota/misiones/x/despachar', m)).toMatchObject({ perm: 'flota:dispatch' });
    }
  });
});

describe('audit L6 — four-eyes on approval', () => {
  it('an approver cannot approve their own account', async () => {
    const { app, env } = await setup();
    // u_super is active + holds users:update; approving THEMSELVES → 403 (four-eyes).
    const r = await post(app, env, '/api/rbac/users/u_super/approve', 't_super', {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_self_approve');
  });
});
