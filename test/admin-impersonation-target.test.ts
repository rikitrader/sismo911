import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock, RBAC_MIGRATIONS } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminImpersonation } from '../src/routes/admin-impersonation';

// Audit L4/L5: impersonation must fail-closed against lateral/upward escalation —
// an actor with `users:impersonate` may NOT impersonate a target who holds powerful
// permissions the actor lacks. Target's effective perms must be a SUBSET of the
// impersonator's, plus an escalation-capable denylist as defense-in-depth.

async function setup() {
  const db: D1Mock = makeDb(RBAC_MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT'); // getUserFromRequest selects it
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0'); // getUserFromRequest selects it
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0'); // getUserFromRequest selects it
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminImpersonation);

  const now = Date.now();
  const pw = await hashPassword('pw');
  const insU = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`
  );
  // Impersonator: holds users:impersonate + cases:read, but NOT roles:assign / billing:manage.
  insU.run('usr_imp', 'imp@s.com', 'Impersonator', 'citizen', pw.hash, pw.salt, 'active', now);
  // Legacy admin → super_admin (god-mode).
  insU.run('usr_admin', 'admin@s.com', 'Admin', 'admin', pw.hash, pw.salt, 'active', now);
  // More-privileged targets the impersonator must NOT be able to hijack.
  insU.run('usr_tgt_assign', 'tgta@s.com', 'TgtAssign', 'citizen', pw.hash, pw.salt, 'active', now);   // roles:assign (denylist)
  insU.run('usr_tgt_billing', 'tgtb@s.com', 'TgtBilling', 'citizen', pw.hash, pw.salt, 'active', now);  // billing:manage (subset rule)
  // Strictly-less-privileged target (only cases:read — a subset of impersonator).
  insU.run('usr_less', 'less@s.com', 'Less', 'citizen', pw.hash, pw.salt, 'active', now);

  const grant = db.raw.prepare(
    `INSERT INTO user_permissions (user_id, perm_key, effect, granted_by, granted_ms) VALUES (?,?,?,?,?)`
  );
  grant.run('usr_imp', 'users:impersonate', 'allow', 'usr_admin', now);
  grant.run('usr_imp', 'cases:read', 'allow', 'usr_admin', now);
  grant.run('usr_tgt_assign', 'roles:assign', 'allow', 'usr_admin', now);
  grant.run('usr_tgt_billing', 'billing:manage', 'allow', 'usr_admin', now);
  grant.run('usr_less', 'cases:read', 'allow', 'usr_admin', now);

  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  sess.run('tok_imp', 'usr_imp', now + 86_400_000, now);
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now);

  return { db, env, app };
}

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };

function post(app: Hono, env: any, path: string, token: string, body?: unknown) {
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...J },
    body: JSON.stringify(body ?? {}),
  };
  return app.request(path, init, env);
}

describe('impersonation target guard — escalation fail-closed (audit L4/L5)', () => {
  it('refuses a target holding roles:assign (escalation denylist) → 403 cannot_impersonate_more_privileged', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/impersonate/usr_tgt_assign', 'tok_imp', { reason: 'x' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_more_privileged');
  });

  it('refuses a target holding billing:manage the actor lacks (subset rule) → 403 cannot_impersonate_more_privileged', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/impersonate/usr_tgt_billing', 'tok_imp', { reason: 'x' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_more_privileged');
  });

  it('allows a strictly-less-privileged target (only cases:read, a subset) → 200', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/impersonate/usr_less', 'tok_imp', { reason: 'ok' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.target.id).toBe('usr_less');
  });

  it('super_admin (legacy admin) may still impersonate any non-admin target → 200', async () => {
    const { app, env } = await setup();
    // Even a target holding escalation-capable perms: god-mode short-circuits.
    const r = await post(app, env, '/api/rbac/impersonate/usr_tgt_assign', 'tok_admin', { reason: 'godmode' });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it('still refuses impersonating a legacy admin/super_admin → 403 cannot_impersonate_admin', async () => {
    const { app, env } = await setup();
    const r = await post(app, env, '/api/rbac/impersonate/usr_admin', 'tok_imp', { reason: 'x' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_admin');
  });
});
