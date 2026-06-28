import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminImpersonation } from '../src/routes/admin-impersonation';

// Real-SQLite harness: apply the actual base + RBAC migrations (incl. 0054 which
// adds sessions.impersonator_id) so the handlers run their real SQL.
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
  app.route('/api/rbac', adminImpersonation);

  const now = Date.now();
  const a = await hashPassword('pw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);    // super_admin
  ins.run('usr_admin2', 'admin2@s.com', 'Admin Two', 'admin', a.hash, a.salt, 'active', now); // another admin
  ins.run('usr_target', 'target@s.com', 'Target User', 'citizen', a.hash, a.salt, 'active', now); // impersonatable
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', a.hash, a.salt, 'active', now); // no perms
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

describe('admin impersonation API', () => {
  it('admin impersonates a target → mints a tagged session + impersonation_log + security_event', async () => {
    const { app, env, db } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_target', ADMIN, { reason: 'support ticket #42' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.target).toEqual({ id: 'usr_target', name: 'Target User' });
    expect(typeof j.expires_ms).toBe('number');

    // A session was minted FOR the target, tagged with the admin id.
    const minted: any = db.raw.prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND impersonator_id = ?`
    ).get('usr_target', 'usr_admin');
    expect(minted).toBeTruthy();
    expect(minted.expires_ms).toBeGreaterThan(Date.now());

    // impersonation_log row written (open, with reason).
    const log: any = db.raw.prepare(
      `SELECT * FROM impersonation_log WHERE admin_id = ? AND target_id = ?`
    ).get('usr_admin', 'usr_target');
    expect(log).toBeTruthy();
    expect(log.reason).toBe('support ticket #42');
    expect(log.ended_ms).toBeNull();

    // security_event recorded.
    const se: any = db.raw.prepare(
      `SELECT * FROM security_events WHERE type = 'impersonate.start' AND target_id = ?`
    ).get('usr_target');
    expect(se).toBeTruthy();
  });

  it('cannot impersonate another admin → 403 cannot_impersonate_admin', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_admin2', ADMIN, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_admin');
  });

  it('cannot impersonate yourself → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_admin', ADMIN, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_self');
  });

  it('citizen lacking users:impersonate → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_target', CIT, {});
    expect(r.status).toBe(403);
  });

  it('unknown target → 404', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_nope', ADMIN, {});
    expect(r.status).toBe(404);
  });

  it('cross-site write rejected with bad_origin (403)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_target',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://evil.example' }, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('bad_origin');
  });

  it('stop ends the active log row and restores the admin session', async () => {
    const { app, env, db } = await setup();
    const now = Date.now();
    // Simulate an in-progress impersonation: a tagged session + open log row.
    db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms,impersonator_id) VALUES (?,?,?,?,?)`)
      .run('tok_imp', 'usr_target', now + 1_000_000, now, 'usr_admin');
    db.raw.prepare(`INSERT INTO impersonation_log (id,admin_id,target_id,reason,started_ms,expires_ms,ended_ms) VALUES (?,?,?,?,?,?,NULL)`)
      .run('imp_x', 'usr_admin', 'usr_target', null, now, now + 1_800_000);

    const r = await req(app, env, 'POST', '/api/rbac/impersonate/stop',
      { Authorization: 'Bearer tok_imp', 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_admin_token=tok_admin' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.relogin).toBe(false); // admin's own session still valid → restored

    // Log row closed; impersonation session deleted.
    const log: any = db.raw.prepare(`SELECT ended_ms FROM impersonation_log WHERE id = 'imp_x'`).get();
    expect(log.ended_ms).toBeGreaterThan(0);
    const gone = db.raw.prepare(`SELECT 1 FROM sessions WHERE token = 'tok_imp'`).get();
    expect(gone).toBeUndefined();
  });

  it('stop on a non-impersonation session is a no-op', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/stop',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://sismo911.com' });
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual({ ok: true, impersonating: false });
  });

  it('GET /impersonation/active lists open, unexpired impersonations (security:read)', async () => {
    const { app, env, db } = await setup();
    const now = Date.now();
    db.raw.prepare(`INSERT INTO impersonation_log (id,admin_id,target_id,reason,started_ms,expires_ms,ended_ms) VALUES (?,?,?,?,?,?,?)`)
      .run('imp_open', 'usr_admin', 'usr_target', null, now, now + 1_800_000, null);   // active
    db.raw.prepare(`INSERT INTO impersonation_log (id,admin_id,target_id,reason,started_ms,expires_ms,ended_ms) VALUES (?,?,?,?,?,?,?)`)
      .run('imp_done', 'usr_admin', 'usr_cit', null, now - 1000, now + 1000, now);      // ended
    const r = await req(app, env, 'GET', '/api/rbac/impersonation/active', { Authorization: 'Bearer tok_admin' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.active.map((x: any) => x.id)).toEqual(['imp_open']);

    // citizen blocked
    const denied = await req(app, env, 'GET', '/api/rbac/impersonation/active', { Authorization: 'Bearer tok_cit' });
    expect(denied.status).toBe(403);
  });

  it('GET /impersonation/log returns history (security:read)', async () => {
    const { app, env, db } = await setup();
    const now = Date.now();
    db.raw.prepare(`INSERT INTO impersonation_log (id,admin_id,target_id,reason,started_ms,expires_ms,ended_ms) VALUES (?,?,?,?,?,?,?)`)
      .run('imp_h', 'usr_admin', 'usr_target', 'audit me', now, now + 1000, now);
    const r = await req(app, env, 'GET', '/api/rbac/impersonation/log?limit=10', { Authorization: 'Bearer tok_admin' });
    expect(r.status).toBe(200);
    expect((await r.json()).log.length).toBe(1);
  });
});
