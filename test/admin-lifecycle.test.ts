import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock, RBAC_MIGRATIONS } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { getEffectivePermissions } from '../src/rbac/engine';
import { adminLifecycle } from '../src/routes/admin-lifecycle';
import { createInvitation } from '../src/lib/invite';

// Real-SQLite harness: base auth/ops tables + the full RBAC stack so the engine
// resolves seeded roles/permissions. 0052 adds user_roles.expires_ms (read by the
// engine for temp-role expiry); 0053 adds the lifecycle columns/table.
const MIGRATIONS = RBAC_MIGRATIONS;

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');                    // getUserFromRequest selects it
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminLifecycle);

  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now); // legacy admin → super_admin
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'active', now);   // no perms
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

// roleId for a seeded role key (engine resolves perms through user_roles → role).
function roleId(db: D1Mock, key: string): string {
  return (db.raw.prepare('SELECT id FROM rbac_roles WHERE key = ?').get(key) as any).id;
}

describe('admin-lifecycle — invitations', () => {
  it('admin creates an invitation; citizen is forbidden', async () => {
    const { app, env } = await setup();
    const ok = await req(app, env, 'POST', '/api/rbac/invitations', ADMIN, { email: 'new@hire.com', roleKey: 'operator', channel: 'email' });
    expect(ok.status).toBe(201);
    const j = await ok.json();
    expect(j.id).toMatch(/^inv_/);
    expect(j.token).toBeTruthy();
    expect(j.link).toContain('/invite/accept?token=');

    const denied = await req(app, env, 'POST', '/api/rbac/invitations', CIT, { email: 'x@y.com' });
    expect(denied.status).toBe(403);
  });

  it('rejects an invalid email and an SMS channel with no phone', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'POST', '/api/rbac/invitations', ADMIN, { email: 'nope' })).status).toBe(400);
    expect((await req(app, env, 'POST', '/api/rbac/invitations', ADMIN, { email: 'a@b.com', channel: 'sms' })).status).toBe(400);
  });

  it('cross-site write is rejected with bad_origin (403)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/invitations',
      { Authorization: 'Bearer tok_admin', 'content-type': 'application/json', origin: 'https://evil.example' },
      { email: 'a@b.com' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('bad_origin');
  });

  it('lists, revokes, and resends invitations', async () => {
    const { app, env } = await setup();
    const created = await (await req(app, env, 'POST', '/api/rbac/invitations', ADMIN, { email: 'list@me.com' })).json();
    const list = await (await req(app, env, 'GET', '/api/rbac/invitations', ADMIN)).json();
    expect(list.invitations.some((i: any) => i.id === created.id)).toBe(true);

    const resent = await (await req(app, env, 'POST', `/api/rbac/invitations/${created.id}/resend`, ADMIN)).json();
    expect(resent.token).toBeTruthy();
    expect(resent.token).not.toBe(created.token); // token regenerated

    const rev = await req(app, env, 'POST', `/api/rbac/invitations/${created.id}/revoke`, ADMIN);
    expect(rev.status).toBe(200);
    const after = await (await req(app, env, 'GET', '/api/rbac/invitations?status=revoked', ADMIN)).json();
    expect(after.invitations.some((i: any) => i.id === created.id)).toBe(true);
  });
});

describe('admin-lifecycle — accept (public)', () => {
  it('GET preview returns valid+email for a pending token; false otherwise', async () => {
    const { app, env } = await setup();
    const { token } = await createInvitation(env, { email: 'preview@me.com', roleKey: 'operator', channel: 'email' });
    const ok = await (await app.request(`/api/rbac/invitations/accept?token=${token}`, {}, env)).json();
    expect(ok.valid).toBe(true);
    expect(ok.email).toBe('preview@me.com');
    expect(ok.roleName).toBeTruthy();

    const bad = await (await app.request('/api/rbac/invitations/accept?token=nope', {}, env)).json();
    expect(bad.valid).toBe(false);
  });

  it('accept creates an active account, assigns the role, and the engine resolves its perms', async () => {
    const { app, env, db } = await setup();
    const { token } = await createInvitation(env, { email: 'hire@me.com', roleKey: 'operator', channel: 'email' });
    const r = await req(app, env, 'POST', '/api/rbac/invitations/accept', J, { token, name: 'New Hire', password: 'sup3rsecret' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(false);
    expect(j.userId).toMatch(/^usr_/);

    const u: any = db.raw.prepare('SELECT status FROM users WHERE id = ?').get(j.userId);
    expect(u.status).toBe('active');
    const ur: any = db.raw.prepare('SELECT COUNT(*) n FROM user_roles WHERE user_id = ?').get(j.userId);
    expect(ur.n).toBe(1);
    // operator holds events:refresh — engine must resolve it through the assigned role.
    expect((await getEffectivePermissions(env, j.userId)).has('events:refresh')).toBe(true);
  });

  it('an expired invitation returns 410; a revoked one returns 400', async () => {
    const { app, env, db } = await setup();
    const exp = await createInvitation(env, { email: 'exp@me.com', channel: 'email' });
    db.raw.prepare('UPDATE invitations SET expires_ms = ? WHERE id = ?').run(Date.now() - 1000, exp.id);
    const er = await req(app, env, 'POST', '/api/rbac/invitations/accept', J, { token: exp.token, name: 'X', password: 'sup3rsecret' });
    expect(er.status).toBe(410);

    const rev = await createInvitation(env, { email: 'rev@me.com', channel: 'email' });
    db.raw.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").run(rev.id);
    const rr = await req(app, env, 'POST', '/api/rbac/invitations/accept', J, { token: rev.token, name: 'X', password: 'sup3rsecret' });
    expect(rr.status).toBe(400);
  });

  it('rejects a short password', async () => {
    const { app, env } = await setup();
    const { token } = await createInvitation(env, { email: 'shortpw@me.com', channel: 'email' });
    const r = await req(app, env, 'POST', '/api/rbac/invitations/accept', J, { token, name: 'X', password: 'short' });
    expect(r.status).toBe(400);
  });
});

describe('admin-lifecycle — approval workflow (U2)', () => {
  it('with approval required, accept lands pending; approve flips it active and engine resolves perms', async () => {
    const { app, env, db } = await setup();
    // org requires approval
    db.raw.prepare(
      `INSERT INTO feature_flags (org_id, module_key, enabled, updated_ms) VALUES ('org_sismo911','require_approval',1,?)`,
    ).run(Date.now());

    const { token } = await createInvitation(env, { email: 'pending@me.com', roleKey: 'operator', channel: 'email' });
    const acc = await (await req(app, env, 'POST', '/api/rbac/invitations/accept', J, { token, name: 'Pend', password: 'sup3rsecret' })).json();
    expect(acc.pending).toBe(true);
    const userId = acc.userId;
    expect((db.raw.prepare('SELECT status FROM users WHERE id = ?').get(userId) as any).status).toBe('pending');

    // appears in the approvals queue
    const queue = await (await req(app, env, 'GET', '/api/rbac/approvals', ADMIN)).json();
    expect(queue.approvals.some((a: any) => a.id === userId)).toBe(true);

    // citizen cannot approve
    expect((await req(app, env, 'POST', `/api/rbac/users/${userId}/approve`, CIT)).status).toBe(403);

    // admin approves → active, and the engine now resolves the operator role's perms
    const ap = await req(app, env, 'POST', `/api/rbac/users/${userId}/approve`, ADMIN);
    expect(ap.status).toBe(200);
    expect((db.raw.prepare('SELECT status FROM users WHERE id = ?').get(userId) as any).status).toBe('active');
    expect((await getEffectivePermissions(env, userId)).has('events:refresh')).toBe(true);
  });

  it('reject sets the account inactive', async () => {
    const { app, env, db } = await setup();
    db.raw.prepare(
      `INSERT INTO feature_flags (org_id, module_key, enabled, updated_ms) VALUES ('org_sismo911','require_approval',1,?)`,
    ).run(Date.now());
    const { token } = await createInvitation(env, { email: 'reject@me.com', channel: 'email' });
    const acc = await (await req(app, env, 'POST', '/api/rbac/invitations/accept', J, { token, name: 'R', password: 'sup3rsecret' })).json();
    const r = await req(app, env, 'POST', `/api/rbac/users/${acc.userId}/reject`, ADMIN, { reason: 'dup' });
    expect(r.status).toBe(200);
    expect((db.raw.prepare('SELECT status FROM users WHERE id = ?').get(acc.userId) as any).status).toBe('inactive');
  });
});

describe('admin-lifecycle — temporary roles (U4)', () => {
  it('a future-expiry temp role grants perms; a past-expiry one does not', async () => {
    const { app, env } = await setup();
    // future grant
    const ok = await req(app, env, 'POST', '/api/rbac/users/usr_cit/temp-roles', ADMIN, { roleKey: 'operator', expires_ms: Date.now() + 60_000 });
    expect(ok.status).toBe(200);
    expect((await getEffectivePermissions(env, 'usr_cit')).has('events:refresh')).toBe(true);

    // overwrite with a past expiry → engine drops it
    await req(app, env, 'POST', '/api/rbac/users/usr_cit/temp-roles', ADMIN, { roleKey: 'operator', expires_ms: Date.now() - 60_000 });
    expect((await getEffectivePermissions(env, 'usr_cit')).has('events:refresh')).toBe(false);
  });

  it('lists temp assignments with a computed expired flag (roles:read)', async () => {
    const { app, env } = await setup();
    await req(app, env, 'POST', '/api/rbac/users/usr_cit/temp-roles', ADMIN, { roleKey: 'operator', expires_ms: Date.now() + 60_000 });
    const list = await (await req(app, env, 'GET', '/api/rbac/users/usr_cit/temp-roles', ADMIN)).json();
    expect(list.assignments.length).toBe(1);
    expect(list.assignments[0].expired).toBe(false);
    expect(list.assignments[0].key).toBe('operator');
  });

  it('temp role validation: missing expires_ms → 400; unknown role → 404', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'POST', '/api/rbac/users/usr_cit/temp-roles', ADMIN, { roleKey: 'operator' })).status).toBe(400);
    expect((await req(app, env, 'POST', '/api/rbac/users/usr_cit/temp-roles', ADMIN, { roleKey: 'no_such_role', expires_ms: Date.now() + 1000 })).status).toBe(404);
  });

  it('DELETE removes only the temporary assignment and re-revokes perms', async () => {
    const { app, env, db } = await setup();
    const opId = roleId(db, 'operator');
    await req(app, env, 'POST', '/api/rbac/users/usr_cit/temp-roles', ADMIN, { roleKey: 'operator', expires_ms: Date.now() + 60_000 });
    expect((await getEffectivePermissions(env, 'usr_cit')).has('events:refresh')).toBe(true);
    const del = await req(app, env, 'DELETE', `/api/rbac/users/usr_cit/temp-roles/${opId}`, ADMIN);
    expect(del.status).toBe(200);
    expect((await getEffectivePermissions(env, 'usr_cit')).has('events:refresh')).toBe(false);
  });

  it('citizen cannot grant a temp role (roles:assign required)', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/users/usr_admin/temp-roles', CIT, { roleKey: 'operator', expires_ms: Date.now() + 1000 });
    expect(r.status).toBe(403);
  });
});
