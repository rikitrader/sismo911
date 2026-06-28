import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock, type TestEnv } from './helpers/d1';
import { hashPassword, getUserFromRequest } from '../src/lib/auth';
import { createInvitation } from '../src/lib/invite';
import {
  getEffectivePermissions,
  hasPermission,
  bumpEpoch,
} from '../src/rbac/engine';
import {
  loadFieldPolicies,
  redactRow,
  redactRows,
  type FieldPolicy,
} from '../src/rbac/field-policy';
import { evaluateGate } from '../src/rbac/route-policy';
import { adminRbac } from '../src/routes/admin-rbac';
import { adminSessions } from '../src/routes/admin-sessions';
import { adminOrg } from '../src/routes/admin-org';
import { adminFlags } from '../src/routes/admin-flags';
import { adminLifecycle } from '../src/routes/admin-lifecycle';
import { adminImpersonation } from '../src/routes/admin-impersonation';
import { adminRolesIo } from '../src/routes/admin-roles-io';

// ---------------------------------------------------------------------------
// CAPSTONE RBAC SECURITY REGRESSION SUITE (Phase 2, Wave 3).
//
// Real better-sqlite3 D1 harness: the actual migration files are applied so the
// route handlers + engine run their real SQL (engine resolution, seeded
// catalog/roles, field policies, lifecycle/impersonation columns). TEST-ONLY —
// no src/migration changes. Each scenario uses DISTINCT seeded principals to
// avoid cross-talk and proves a concrete enforcement property.
//
// Full migration set so every column the engine + routes read exists.
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  'migrations/0004_auth.sql', // users + sessions (rank/unit/phone)
  'migrations/0002_ops.sql', // audit
  'migrations/0012_rate_buckets.sql', // rate_buckets (invite-accept rate limit)
  'migrations/0009_password_resets.sql',
  'migrations/0046_rbac_workforce.sql', // rbac tables + ALTER users/sessions + orgs/invitations/field_policies/security_events
  'migrations/0047_rbac_seed.sql', // permission catalog + system roles + field_policies seed
  'migrations/0050_mfa_sessions.sql', // mfa columns + session device cols
  'migrations/0050_suministros_areas.sql', // suministros area perms
  'migrations/0051_org_flags.sql', // org feature-flag scoping
  'migrations/0052_rbac_finegrained.sql', // fine-grained perms + user_roles.expires_ms
  'migrations/0053_lifecycle.sql', // invitations.phone/approved_by + approval_requests
  'migrations/0054_impersonation.sql', // sessions.impersonator_id + impersonation_log
];

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };

interface Ctx {
  db: D1Mock;
  env: TestEnv;
  app: Hono;
}

async function setup(): Promise<Ctx> {
  const db = makeDb(MIGRATIONS);
  // getUserFromRequest selects these; not added by any migration in scope.
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);

  // Mount the RBAC surface exactly as index.ts does (adminLifecycle first so its
  // richer /invitations handlers win over adminRbac's).
  const app = new Hono();
  app.route('/api/rbac', adminLifecycle);
  app.route('/api/rbac', adminRbac);
  app.route('/api/rbac', adminSessions);
  app.route('/api/rbac', adminOrg);
  app.route('/api/rbac', adminFlags);
  app.route('/api/rbac', adminImpersonation);
  app.route('/api/rbac', adminRolesIo);
  // Probe route to exercise the REAL getUserFromRequest session resolver.
  app.get('/probe/whoami', async (c) => {
    const u = await getUserFromRequest(c.env, c).catch(() => null);
    return c.json({ id: u ? u.id : null });
  });

  const now = Date.now();
  const pw = await hashPassword('pw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,phone,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  // legacy admin → super_admin (god-mode)
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', '+58-000', pw.hash, pw.salt, 'active', now);
  ins.run('usr_admin2', 'admin2@s.com', 'Admin Two', 'admin', '+58-001', pw.hash, pw.salt, 'active', now);
  // citizen — no rbac roles, no perms
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', '+58-002', pw.hash, pw.salt, 'active', now);
  // impersonation target (non-admin)
  ins.run('usr_target', 'target@s.com', 'Target User', 'citizen', '+58-003', pw.hash, pw.salt, 'active', now);
  // narrowly-scoped user: holds ONLY flota:read via a custom role
  ins.run('usr_flota', 'flota@s.com', 'Flota Only', 'citizen', '+58-004', pw.hash, pw.salt, 'active', now);
  // session-lifecycle probes
  ins.run('usr_exp', 'exp@s.com', 'Expired Sess', 'citizen', '+58-005', pw.hash, pw.salt, 'active', now);
  ins.run('usr_rev', 'rev@s.com', 'Revoked Sess', 'citizen', '+58-006', pw.hash, pw.salt, 'active', now);
  // engine-level probes (no session needed)
  ins.run('usr_epoch', 'epoch@s.com', 'Epoch Flip', 'citizen', '+58-007', pw.hash, pw.salt, 'active', now);
  ins.run('usr_deny', 'deny@s.com', 'Deny Wins', 'citizen', '+58-008', pw.hash, pw.salt, 'active', now);
  ins.run('usr_temp', 'temp@s.com', 'Temp Role', 'citizen', '+58-009', pw.hash, pw.salt, 'active', now);

  const sess = db.raw.prepare(
    `INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`,
  );
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now);
  sess.run('tok_flota', 'usr_flota', now + 86_400_000, now);
  // expired (in the past) and revoked sessions
  sess.run('tok_exp', 'usr_exp', now - 1_000, now - 100_000);
  db.raw
    .prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms,revoked_ms) VALUES (?,?,?,?,?)`)
    .run('tok_rev', 'usr_rev', now + 86_400_000, now, now - 500);

  // A custom non-system role holding ONLY flota:read, assigned to usr_flota.
  db.raw
    .prepare(
      `INSERT INTO rbac_roles (id,org_id,key,name,inherits_json,is_system,created_ms) VALUES (?,?,?,?,?,?,?)`,
    )
    .run('role_flota_only', null, 'flota_only', 'Flota Only', '[]', 0, now);
  db.raw
    .prepare(`INSERT INTO role_permissions (role_id,perm_key,effect) VALUES (?,?,?)`)
    .run('role_flota_only', 'flota:read', 'allow');
  db.raw
    .prepare(`INSERT INTO user_roles (user_id,role_id,granted_ms) VALUES (?,?,?)`)
    .run('usr_flota', 'role_flota_only', now);

  return { db, env, app };
}

const ADMIN = { Authorization: 'Bearer tok_admin', ...J };
const CIT = { Authorization: 'Bearer tok_cit', ...J };
const FLOTA = { Authorization: 'Bearer tok_flota', ...J };

function req(app: Hono, env: any, method: string, path: string, headers?: any, body?: unknown) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env);
}

// ===========================================================================
// 1. UNAUTHORIZED API ACCESS
// ===========================================================================
describe('1 — unauthorized API access', () => {
  it('unauthenticated GET /users → 401', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/users');
    expect(r.status).toBe(401);
  });

  it('citizen (no roles) GET /users → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_cit' });
    expect(r.status).toBe(403);
  });

  it('unauthenticated write to a gated org endpoint → 401', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/orgs', J, { slug: 'x', name: 'X' });
    expect(r.status).toBe(401);
  });
});

// ===========================================================================
// 2. UNAUTHORIZED PAGE ACCESS (route-policy gate decisions)
// ===========================================================================
describe('2 — page/route gating via route-policy', () => {
  it("evaluateGate('/admin','GET') is a 'page' gate (login redirect, not open)", () => {
    expect(evaluateGate('/admin', 'GET').kind).toBe('page');
    expect(evaluateGate('/admin/x402', 'GET').kind).toBe('page');
  });

  it('gated APIs map to their fine-grained permission', () => {
    const flota = evaluateGate('/api/flota/units', 'GET');
    expect(flota).toEqual({ kind: 'perm', perm: 'flota:read' });
    const persons = evaluateGate('/api/persons/queue', 'GET');
    expect(persons).toEqual({ kind: 'perm', perm: 'persons:moderate' });
    const refresh = evaluateGate('/api/events/refresh', 'GET');
    expect(refresh).toEqual({ kind: 'perm', perm: 'events:refresh' });
    const adminWrite = evaluateGate('/api/contacts/123', 'POST');
    expect(adminWrite).toEqual({ kind: 'perm', perm: 'contacts:manage' });
  });

  it('public surfaces stay open', () => {
    expect(evaluateGate('/api/health', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/acopio/report', 'POST').kind).toBe('open'); // documented public exception
    // NOTE: '/console' is NOT gated by route-policy — it is gated separately in
    // index.ts via canEnterConsole()/serveConsole (login redirect to
    // /login?next=/console/). route-policy intentionally returns 'open' for it.
    expect(evaluateGate('/console', 'GET').kind).toBe('open');
  });
});

// ===========================================================================
// 3. PRIVILEGE-ESCALATION ATTEMPTS
// ===========================================================================
describe('3 — privilege escalation is rejected', () => {
  it('(a) citizen cannot grant ITSELF a role → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/users/usr_cit/roles', CIT, { roleKey: 'super_admin' });
    expect(r.status).toBe(403);
  });

  it('(a2) citizen cannot grant ITSELF a direct permission → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/users/usr_cit/permissions', CIT, { permKey: 'users:read' });
    expect(r.status).toBe(403);
  });

  it('(b) role import by a non-roles:create user → 403 (no rows written)', async () => {
    const { app, env, db } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/roles/import', CIT, {
      roles: [{ key: 'evil', name: 'Evil', perms: ['users:read'] }],
    });
    expect(r.status).toBe(403);
    const made = db.raw.prepare("SELECT 1 FROM rbac_roles WHERE key = 'evil'").get();
    expect(made).toBeUndefined();
  });

  it('(c) a user holding ONLY flota:read cannot reach users:* endpoints → 403', async () => {
    const { app, env } = await setup();
    // sanity: the narrow user CAN be authenticated and resolves only flota:read
    expect((await req(app, env, 'GET', '/api/rbac/users', FLOTA)).status).toBe(403); // needs users:read
    expect((await req(app, env, 'GET', '/api/rbac/users/usr_cit', FLOTA)).status).toBe(403);
    expect(
      (await req(app, env, 'POST', '/api/rbac/users', FLOTA, { email: 'z@z.com', name: 'Z' })).status,
    ).toBe(403); // needs users:create
    expect(
      (await req(app, env, 'POST', '/api/rbac/users/usr_cit/roles', FLOTA, { roleKey: 'operator' })).status,
    ).toBe(403); // needs roles:assign
  });

  it('(c2) engine confirms the narrow user holds flota:read and NOT users:read', async () => {
    const { env } = await setup();
    expect(await hasPermission(env, 'usr_flota', 'flota:read')).toBe(true);
    expect(await hasPermission(env, 'usr_flota', 'users:read')).toBe(false);
    expect(await hasPermission(env, 'usr_flota', 'users:create')).toBe(false);
  });

  it('(d) impersonation cannot target an admin → 403 cannot_impersonate_admin', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_admin2', ADMIN, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_admin');
  });

  it('(d2) impersonation cannot target SELF → 403 cannot_impersonate_self', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_admin', ADMIN, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_impersonate_self');
  });

  it('(d3) citizen lacking users:impersonate cannot impersonate → 403', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_target', CIT, {});
    expect(r.status).toBe(403);
  });
});

// ===========================================================================
// 4. CROSS-ORGANIZATION ISOLATION
// ===========================================================================
describe('4 — cross-organization isolation', () => {
  it('a department parent in a DIFFERENT org → 400 parent_cross_org', async () => {
    const { app, env } = await setup();
    // org B
    const orgB = await (await req(app, env, 'POST', '/api/rbac/orgs', ADMIN, { slug: 'orgb', name: 'Org B' })).json();
    expect(orgB.id).toMatch(/^org_/);
    // dept A under the seeded org_sismo911
    const deptA = await (
      await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { org_id: 'org_sismo911', name: 'Dept A' })
    ).json();
    expect(deptA.id).toMatch(/^dept_/);
    // dept under org B that points at dept A (a different org) → rejected
    const bad = await req(app, env, 'POST', '/api/rbac/departments', ADMIN, {
      org_id: orgB.id,
      name: 'Cross',
      parent_id: deptA.id,
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('parent_cross_org');
  });

  it('a team under a nonexistent org → 400 org_not_found', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/teams', ADMIN, { org_id: 'org_does_not_exist', name: 'Ghost' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('org_not_found');
  });

  it('a department under a nonexistent org → 400 org_not_found', async () => {
    const { app, env } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/departments', ADMIN, { org_id: 'org_nope', name: 'D' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('org_not_found');
  });
});

// ===========================================================================
// 5. FIELD-LEVEL ENFORCEMENT (server-side redaction)
// ===========================================================================
describe('5 — field-level enforcement (redactRow/redactRows)', () => {
  it('the seeded field policies exist (users.phone gated by users:read)', async () => {
    const { env } = await setup();
    const pols = await loadFieldPolicies(env, 'users');
    const phone = pols.find((p) => p.field === 'phone');
    expect(phone).toBeTruthy();
    expect(phone!.visibility).toBe('perm');
    expect(phone!.required_perm).toBe('users:read');
  });

  it('a caller WITHOUT users:read does not see users.phone; WITH it, does', async () => {
    const { env } = await setup();
    const pols = await loadFieldPolicies(env, 'users');
    const row = { id: 'u1', name: 'Ana', phone: '+58-123', emergency_contact: 'Bob' };

    const without = redactRow(row, pols, new Set<string>());
    expect('phone' in without).toBe(false);
    expect(without.name).toBe('Ana');

    const withRead = redactRow(row, pols, new Set(['users:read', 'users:update']));
    expect(withRead.phone).toBe('+58-123');
    expect(withRead.emergency_contact).toBe('Bob');
  });

  it('hidden fields are ALWAYS stripped, even with every permission', () => {
    const pols: FieldPolicy[] = [
      { resource: 'users', field: 'pw_hash', visibility: 'hidden', required_perm: null },
      { resource: 'users', field: 'phone', visibility: 'perm', required_perm: 'users:read' },
    ];
    const godPerms = new Set(['users:read', 'users:update', 'whatever']);
    const out = redactRow({ id: 'u', pw_hash: 'SECRET', phone: '+1', name: 'X' }, pols, godPerms);
    expect('pw_hash' in out).toBe(false); // hidden → stripped despite god perms
    expect(out.phone).toBe('+1'); // perm satisfied → kept
  });

  it('redactRows applies the policy across an array', async () => {
    const { env } = await setup();
    const pols = await loadFieldPolicies(env, 'users');
    const rows = [
      { id: 'a', phone: '1', name: 'A' },
      { id: 'b', phone: '2', name: 'B' },
    ];
    const redacted = redactRows(rows, pols, new Set<string>());
    expect(redacted.every((r) => !('phone' in r))).toBe(true);
  });
});

// ===========================================================================
// 6. IMPERSONATION AUDIT LOGGING
// ===========================================================================
describe('6 — impersonation writes a full audit trail', () => {
  it('start writes impersonation_log (started/expires) + a impersonate.start security event', async () => {
    const { app, env, db } = await setup();
    const r = await req(app, env, 'POST', '/api/rbac/impersonate/usr_target', ADMIN, { reason: 'ticket #7' });
    expect(r.status).toBe(200);

    const log: any = db.raw
      .prepare('SELECT * FROM impersonation_log WHERE admin_id = ? AND target_id = ?')
      .get('usr_admin', 'usr_target');
    expect(log).toBeTruthy();
    expect(log.started_ms).toBeGreaterThan(0);
    expect(log.expires_ms).toBeGreaterThan(log.started_ms);
    expect(log.ended_ms).toBeNull();
    expect(log.reason).toBe('ticket #7');

    const se: any = db.raw
      .prepare("SELECT * FROM security_events WHERE type = 'impersonate.start' AND target_id = ?")
      .get('usr_target');
    expect(se).toBeTruthy();
    expect(se.actor_id).toBe('usr_admin');
  });

  it('stop sets ended_ms and writes a impersonate.stop security event', async () => {
    const { app, env, db } = await setup();
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO sessions (token,user_id,expires_ms,created_ms,impersonator_id) VALUES (?,?,?,?,?)`,
      )
      .run('tok_imp', 'usr_target', now + 1_000_000, now, 'usr_admin');
    db.raw
      .prepare(
        `INSERT INTO impersonation_log (id,admin_id,target_id,reason,started_ms,expires_ms,ended_ms) VALUES (?,?,?,?,?,?,NULL)`,
      )
      .run('imp_stop', 'usr_admin', 'usr_target', null, now, now + 1_800_000);

    const r = await req(app, env, 'POST', '/api/rbac/impersonate/stop', {
      Authorization: 'Bearer tok_imp',
      'content-type': 'application/json',
      origin: 'https://sismo911.com',
      Cookie: 'sismo_admin_token=tok_admin',
    });
    expect(r.status).toBe(200);

    const log: any = db.raw.prepare("SELECT ended_ms FROM impersonation_log WHERE id = 'imp_stop'").get();
    expect(log.ended_ms).toBeGreaterThan(0);
    const se: any = db.raw
      .prepare("SELECT * FROM security_events WHERE type = 'impersonate.stop' AND target_id = 'usr_target'")
      .get();
    expect(se).toBeTruthy();
    // The stop is issued from the impersonated session, so actor_id is the
    // target; the admin is carried in detail_json (admin_id).
    expect(se.actor_id).toBe('usr_target');
    expect(JSON.parse(se.detail_json).admin_id).toBe('usr_admin');
  });
});

// ===========================================================================
// 7. EXPIRED / REVOKED INVITATIONS
// ===========================================================================
describe('7 — expired & revoked invitations are rejected', () => {
  it('a past-expiry invitation: preview valid:false AND accept → 410', async () => {
    const { app, env, db } = await setup();
    const inv = await createInvitation(env, { email: 'exp-inv@me.com', channel: 'email' });
    db.raw.prepare('UPDATE invitations SET expires_ms = ? WHERE id = ?').run(Date.now() - 1000, inv.id);

    const preview = await (await app.request(`/api/rbac/invitations/accept?token=${inv.token}`, {}, env)).json();
    expect(preview.valid).toBe(false);

    const acc = await req(app, env, 'POST', '/api/rbac/invitations/accept', J, {
      token: inv.token,
      name: 'X',
      password: 'sup3rsecret',
    });
    expect(acc.status).toBe(410); // 4xx — rejected
  });

  it('a revoked invitation: accept → 400', async () => {
    const { app, env, db } = await setup();
    const inv = await createInvitation(env, { email: 'rev-inv@me.com', channel: 'email' });
    db.raw.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").run(inv.id);

    const acc = await req(app, env, 'POST', '/api/rbac/invitations/accept', J, {
      token: inv.token,
      name: 'X',
      password: 'sup3rsecret',
    });
    expect(acc.status).toBe(400); // 4xx — rejected
  });
});

// ===========================================================================
// 8. EXPIRED / REVOKED SESSIONS
// ===========================================================================
describe('8 — expired & revoked sessions do not authenticate', () => {
  it('getUserFromRequest returns null for an EXPIRED session', async () => {
    const { app, env } = await setup();
    const r = await app.request('/probe/whoami', { headers: { Authorization: 'Bearer tok_exp' } }, env);
    expect((await r.json()).id).toBeNull();
  });

  it('getUserFromRequest returns null for a REVOKED session', async () => {
    const { app, env } = await setup();
    const r = await app.request('/probe/whoami', { headers: { Authorization: 'Bearer tok_rev' } }, env);
    expect((await r.json()).id).toBeNull();
  });

  it('control: a valid session resolves the user', async () => {
    const { app, env } = await setup();
    const r = await app.request('/probe/whoami', { headers: { Authorization: 'Bearer tok_cit' } }, env);
    expect((await r.json()).id).toBe('usr_cit');
  });

  it('expired/revoked sessions are also rejected by a gated route (401)', async () => {
    const { app, env } = await setup();
    expect((await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_exp' })).status).toBe(401);
    expect((await req(app, env, 'GET', '/api/rbac/users', { Authorization: 'Bearer tok_rev' })).status).toBe(401);
  });
});

// ===========================================================================
// 9. REVOKED PERMISSIONS TAKE EFFECT IMMEDIATELY (epoch invalidation)
// ===========================================================================
describe('9 — permission changes invalidate the cache on bumpEpoch', () => {
  it('allow → deny flips after removing the role + bumpEpoch (no stale KV)', async () => {
    const { env, db } = await setup();
    const now = Date.now();
    db.raw
      .prepare('INSERT INTO user_roles (user_id,role_id,granted_ms) VALUES (?,?,?)')
      .run('usr_epoch', 'role_operator', now);
    // first resolution caches at epoch N
    expect((await getEffectivePermissions(env, 'usr_epoch')).has('events:refresh')).toBe(true);

    // remove the role + bump epoch → next lookup must recompute, not serve stale KV
    db.raw.prepare("DELETE FROM user_roles WHERE user_id = 'usr_epoch'").run();
    await bumpEpoch(env, 'usr_epoch');
    expect((await getEffectivePermissions(env, 'usr_epoch')).has('events:refresh')).toBe(false);
  });

  it('a user-level DENY overrides a role-granted allow', async () => {
    const { env, db } = await setup();
    const now = Date.now();
    db.raw
      .prepare('INSERT INTO user_roles (user_id,role_id,granted_ms) VALUES (?,?,?)')
      .run('usr_deny', 'role_operator', now);
    expect((await getEffectivePermissions(env, 'usr_deny')).has('events:refresh')).toBe(true);

    db.raw
      .prepare('INSERT INTO user_permissions (user_id,perm_key,effect,granted_ms) VALUES (?,?,?,?)')
      .run('usr_deny', 'events:refresh', 'deny', now);
    await bumpEpoch(env, 'usr_deny');
    expect((await getEffectivePermissions(env, 'usr_deny')).has('events:refresh')).toBe(false);
  });
});

// ===========================================================================
// 10. TEMPORARY-ROLE EXPIRY
// ===========================================================================
describe('10 — temporary role expiry', () => {
  it('a past-expiry user_roles row grants nothing; a future one grants', async () => {
    const { env, db } = await setup();
    const now = Date.now();

    // future expiry → role active
    db.raw
      .prepare('INSERT INTO user_roles (user_id,role_id,granted_ms,expires_ms) VALUES (?,?,?,?)')
      .run('usr_temp', 'role_operator', now, now + 3_600_000);
    expect((await getEffectivePermissions(env, 'usr_temp')).has('events:refresh')).toBe(true);

    // flip to a past expiry + bump → role no longer counts
    db.raw.prepare("UPDATE user_roles SET expires_ms = ? WHERE user_id = 'usr_temp'").run(now - 1000);
    await bumpEpoch(env, 'usr_temp');
    expect((await getEffectivePermissions(env, 'usr_temp')).has('events:refresh')).toBe(false);
  });
});
