import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminSessions } from '../src/routes/admin-sessions';
import { generateTotp } from '../src/lib/totp';

// Real-SQLite harness: apply the actual base + RBAC + MFA migrations so the
// route handlers run their real SQL (engine resolution, seeded catalog/roles,
// revoked_ms filtering, etc.).
const MIGRATIONS = [
  'migrations/0004_auth.sql',           // users + sessions
  'migrations/0002_ops.sql',            // audit
  'migrations/0046_rbac_workforce.sql', // rbac tables + ALTER users/sessions (mfa_*, status, revoked_ms)
  'migrations/0047_rbac_seed.sql',      // permission catalog + system roles
  'migrations/0052_rbac_finegrained.sql', // fine-grained perms + user_roles.expires_ms
  'migrations/0050_mfa_sessions.sql',   // mfa_backup_codes, session device cols, trusted_devices
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT'); // getUserFromRequest selects it
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0'); // getUserFromRequest selects it
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminSessions);

  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now); // legacy admin → super_admin
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'active', now);   // no perms
  const sess = db.raw.prepare(
    `INSERT INTO sessions (token,user_id,expires_ms,created_ms,user_agent,ip) VALUES (?,?,?,?,?,?)`
  );
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now, 'Mozilla/5.0 (Macintosh) Chrome/120', '1.1.1.1');
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now, 'Mozilla/5.0 (iPhone; iOS) Safari/16', '2.2.2.2');
  sess.run('tok_cit2', 'usr_cit', now + 86_400_000, now, 'Mozilla/5.0 (Windows) Firefox/121', '3.3.3.3');
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

describe('admin-sessions — MFA enrollment', () => {
  it('enroll → verify enables MFA + returns 10 backup codes', async () => {
    const { app, env, db } = await setup();
    const er = await req(app, env, 'POST', '/api/rbac/mfa/enroll', CIT, {});
    expect(er.status).toBe(200);
    const { secret, otpauth_uri } = await er.json();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(otpauth_uri).toContain('otpauth://totp/');

    const code = await generateTotp(secret);
    const vr = await req(app, env, 'POST', '/api/rbac/mfa/verify', CIT, { code });
    expect(vr.status).toBe(200);
    const vj = await vr.json();
    expect(vj.ok).toBe(true);
    expect(vj.backup_codes).toHaveLength(10);

    const row: any = db.raw.prepare('SELECT mfa_enabled, mfa_enrolled_ms FROM users WHERE id = ?').get('usr_cit');
    expect(row.mfa_enabled).toBe(1);
    expect(row.mfa_enrolled_ms).toBeGreaterThan(0);
  });

  it('verify with a bad code → 400 bad_code (MFA stays off)', async () => {
    const { app, env, db } = await setup();
    await req(app, env, 'POST', '/api/rbac/mfa/enroll', CIT, {});
    const vr = await req(app, env, 'POST', '/api/rbac/mfa/verify', CIT, { code: '000000' });
    expect(vr.status).toBe(400);
    expect((await vr.json()).error).toBe('bad_code');
    const row: any = db.raw.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get('usr_cit');
    expect(row.mfa_enabled).toBe(0);
  });

  it('disable turns MFA back off with a valid TOTP', async () => {
    const { app, env, db } = await setup();
    const { secret } = await (await req(app, env, 'POST', '/api/rbac/mfa/enroll', CIT, {})).json();
    await req(app, env, 'POST', '/api/rbac/mfa/verify', CIT, { code: await generateTotp(secret) });
    const dr = await req(app, env, 'POST', '/api/rbac/mfa/disable', CIT, { code: await generateTotp(secret) });
    expect(dr.status).toBe(200);
    const row: any = db.raw.prepare('SELECT mfa_enabled, mfa_secret FROM users WHERE id = ?').get('usr_cit');
    expect(row.mfa_enabled).toBe(0);
    expect(row.mfa_secret).toBeNull();
  });
});

describe('admin-sessions — sessions', () => {
  it('self GET /sessions lists own sessions, flags the current one, masks tokens', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/sessions', { Authorization: 'Bearer tok_cit' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.sessions.length).toBe(2); // tok_cit + tok_cit2
    const cur = j.sessions.find((s: any) => s.current);
    expect(cur).toBeTruthy();
    expect(cur.token).toContain('ok_cit'); // masked: last 6 of "tok_cit"
    expect(j.sessions.every((s: any) => !s.token.startsWith('tok_'))).toBe(true);
  });

  it('unauthenticated GET /sessions → 401', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'GET', '/api/rbac/sessions')).status).toBe(401);
  });

  it('admin revoking a session makes that token stop authenticating', async () => {
    const { app, env } = await setup();
    // tok_cit2 works before revocation
    expect((await req(app, env, 'GET', '/api/rbac/sessions', { Authorization: 'Bearer tok_cit2' })).status).toBe(200);
    const rr = await req(app, env, 'DELETE', '/api/rbac/users/usr_cit/sessions/tok_cit2', ADMIN);
    expect(rr.status).toBe(200);
    expect((await rr.json()).revoked).toBe(1);
    // getUserFromRequest now rejects the revoked session → 401
    expect((await req(app, env, 'GET', '/api/rbac/sessions', { Authorization: 'Bearer tok_cit2' })).status).toBe(401);
  });

  it('self-revoke works for the caller', async () => {
    const { app, env } = await setup();
    const rr = await req(app, env, 'DELETE', '/api/rbac/sessions/tok_cit2', CIT);
    expect(rr.status).toBe(200);
    expect((await req(app, env, 'GET', '/api/rbac/sessions', { Authorization: 'Bearer tok_cit2' })).status).toBe(401);
  });

  it('revoke-all kills every session of a user', async () => {
    const { app, env } = await setup();
    const rr = await req(app, env, 'POST', '/api/rbac/users/usr_cit/sessions/revoke-all', ADMIN, {});
    expect(rr.status).toBe(200);
    expect((await rr.json()).revoked).toBe(2);
    expect((await req(app, env, 'GET', '/api/rbac/sessions', { Authorization: 'Bearer tok_cit' })).status).toBe(401);
  });

  it('sessions:revoke is required — citizen → 403, admin → 200', async () => {
    const { app, env } = await setup();
    const denied = await req(app, env, 'DELETE', '/api/rbac/users/usr_admin/sessions/tok_admin', CIT);
    expect(denied.status).toBe(403);
    const ok = await req(app, env, 'DELETE', '/api/rbac/users/usr_cit/sessions/tok_cit', ADMIN);
    expect(ok.status).toBe(200);
  });

  it('sessions:read is required for another user — citizen → 403, admin → 200', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'GET', '/api/rbac/users/usr_cit/sessions', { Authorization: 'Bearer tok_cit' })).status).toBe(403);
    expect((await req(app, env, 'GET', '/api/rbac/users/usr_cit/sessions', { Authorization: 'Bearer tok_admin' })).status).toBe(200);
  });
});

describe('admin-sessions — emergency lock (U5)', () => {
  it('lock sets status=locked, kills sessions, and bumps perm epoch', async () => {
    const { app, env, db } = await setup();
    const before: any = db.raw.prepare('SELECT perm_epoch FROM users WHERE id = ?').get('usr_cit');
    const lr = await req(app, env, 'POST', '/api/rbac/users/usr_cit/lock', ADMIN, { reason: 'suspicious activity' });
    expect(lr.status).toBe(200);
    const row: any = db.raw.prepare('SELECT status, perm_epoch FROM users WHERE id = ?').get('usr_cit');
    expect(row.status).toBe('locked');
    expect(row.perm_epoch).toBe(before.perm_epoch + 1);
    // locked user can no longer authenticate (all sessions revoked)
    expect((await req(app, env, 'GET', '/api/rbac/sessions', { Authorization: 'Bearer tok_cit' })).status).toBe(401);
  });

  it('unlock restores status=active', async () => {
    const { app, env, db } = await setup();
    await req(app, env, 'POST', '/api/rbac/users/usr_cit/lock', ADMIN, {});
    const ur = await req(app, env, 'POST', '/api/rbac/users/usr_cit/unlock', ADMIN, {});
    expect(ur.status).toBe(200);
    const row: any = db.raw.prepare('SELECT status FROM users WHERE id = ?').get('usr_cit');
    expect(row.status).toBe('active');
  });

  it('lock requires users:suspend — citizen → 403', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'POST', '/api/rbac/users/usr_admin/lock', CIT, {})).status).toBe(403);
  });
});

describe('admin-sessions — CSRF', () => {
  it('cross-site unsafe request is rejected with bad_origin (403)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/users/usr_cit/lock',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://evil.example' }, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('bad_origin');
  });
});
