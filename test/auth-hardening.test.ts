import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, RBAC_MIGRATIONS, type D1Mock } from './helpers/d1';
import { hashPassword, verifyPassword, passwordNeedsUpgrade } from '../src/lib/auth';
import { generateSecret, generateTotp, verifyTotpStep } from '../src/lib/totp';
import { auth } from '../src/routes/auth';
import { adminRbac } from '../src/routes/admin-rbac';

const J = { 'content-type': 'application/json', origin: 'https://sismo911.com' };

// ── L3: versioned PBKDF2 hashing with transparent legacy verify ─────────────
// NOTE: iterations are capped at 100k — the Cloudflare Workers runtime throws
// NotSupportedError for PBKDF2 above 100,000 (vitest's Node WebCrypto does NOT,
// which let the broken 600k value pass CI while it 500'd register + reset in prod).
describe('audit L3 — versioned password hashing', () => {
  it('hashPassword emits the v2$100000$ format and round-trips', async () => {
    const { hash, salt } = await hashPassword('s3cret');
    expect(hash.startsWith('v2$100000$')).toBe(true);
    // Workers cap: the recorded iteration count must never exceed 100k, or
    // deriveBits() throws at runtime (regression guard for the prod 500).
    expect(Number(hash.split('$')[1])).toBeLessThanOrEqual(100_000);
    expect(await verifyPassword('s3cret', hash, salt)).toBe(true);
    expect(await verifyPassword('wrong', hash, salt)).toBe(false);
  });
  it('still verifies a LEGACY bare 100k hash (back-compat)', async () => {
    // Reproduce an old-format hash: PBKDF2-SHA256 @100k, bare b64, separate salt.
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', enc.encode('legacypw'), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 100_000, hash: 'SHA-256' }, key, 256));
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    const legacyHash = b64(bits);
    expect(await verifyPassword('legacypw', legacyHash, b64(salt))).toBe(true);
    expect(passwordNeedsUpgrade(legacyHash)).toBe(true);
  });
  it('passwordNeedsUpgrade: legacy/under-cost → true, current → false', () => {
    expect(passwordNeedsUpgrade('rawb64hash')).toBe(true);   // legacy bare hash
    expect(passwordNeedsUpgrade('v2$50000$x')).toBe(true);   // below current cost
    expect(passwordNeedsUpgrade('v2$100000$x')).toBe(false); // current Workers cap
  });
});

// ── L1: TOTP step exposure for one-time enforcement ─────────────────────────
describe('audit L1 — verifyTotpStep', () => {
  it('returns the matched counter step and -1 for a bad code', async () => {
    const secret = generateSecret();
    const atMs = 1_700_000_000_000;
    const code = await generateTotp(secret, atMs);
    const step = await verifyTotpStep(secret, code, 1, atMs);
    expect(step).toBe(Math.floor(atMs / 1000 / 30));
    expect(await verifyTotpStep(secret, '000000', 1, atMs)).toBe(-1);
  });
});

// ── L1 + L2 at the login handler ────────────────────────────────────────────
async function loginSetup() {
  const db: D1Mock = makeDb(RBAC_MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/auth', auth);
  const secret = generateSecret();
  const { hash, salt } = await hashPassword('pw');
  db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,mfa_enabled,mfa_secret,mfa_last_step,mfa_fail_count,created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('u1', 'u@s.com', 'U', 'operator', hash, salt, 'active', 1, secret, 0, 0, Date.now());
  return { db, env, app, secret };
}
const login = (app: Hono, env: any, body: any) =>
  app.request('/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify(body) }, env);

describe('audit L1 — TOTP codes are one-time at login', () => {
  it('a valid code logs in once; replaying the same code is rejected', async () => {
    const { app, env, secret } = await loginSetup();
    const code = await generateTotp(secret);
    const r1 = await login(app, env, { email: 'u@s.com', password: 'pw', code });
    expect(r1.status).toBe(200);
    const r2 = await login(app, env, { email: 'u@s.com', password: 'pw', code });
    expect(r2.status).toBe(401); // same step already consumed → replay rejected
    expect((await r2.json()).error).toBe('mfa_invalid');
  });
});

describe('audit L2 — per-account MFA lockout', () => {
  it('5 consecutive bad codes lock the second factor (403 mfa_locked)', async () => {
    const { app, env } = await loginSetup();
    for (let i = 0; i < 5; i++) {
      const r = await login(app, env, { email: 'u@s.com', password: 'pw', code: '000000' });
      expect(r.status).toBe(401);
    }
    const locked = await login(app, env, { email: 'u@s.com', password: 'pw', code: '000000' });
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toBe('mfa_locked');
  });
});

// ── Legacy users.role reconcile on RBAC role assign/unassign ─────────────────
describe('audit follow-up — legacy users.role stays consistent with RBAC roles', () => {
  async function adminSetup() {
    const db: D1Mock = makeDb(RBAC_MIGRATIONS);
    db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
    db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
    db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
    const env = makeEnv(db);
    const app = new Hono();
    app.route('/api/rbac', adminRbac);
    const pw = await hashPassword('pw'); const now = Date.now();
    const ins = db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`);
    ins.run('u_super', 's@s.com', 'S', 'admin', pw.hash, pw.salt, 'active', now);
    ins.run('u_t', 't@s.com', 'T', 'citizen', pw.hash, pw.salt, 'active', now);
    db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('t_super', 'u_super', now + 86_400_000, now);
    return { db, env, app };
  }
  const roleKey = (db: D1Mock) => (db.raw.prepare(`SELECT id FROM rbac_roles WHERE key='super_admin'`).get() as any).id;

  it('assigning super_admin promotes legacy role to admin; unassigning demotes it', async () => {
    const { db, env, app } = await adminSetup();
    const sid = roleKey(db);
    const a = await app.request('/api/rbac/users/u_t/roles', { method: 'POST', headers: { Authorization: 'Bearer t_super', ...J }, body: JSON.stringify({ roleKey: 'super_admin' }) }, env);
    expect(a.status).toBe(200);
    expect((db.raw.prepare(`SELECT role FROM users WHERE id='u_t'`).get() as any).role).toBe('admin');
    const d = await app.request(`/api/rbac/users/u_t/roles/${sid}`, { method: 'DELETE', headers: { Authorization: 'Bearer t_super', ...J } }, env);
    expect(d.status).toBe(200);
    expect((db.raw.prepare(`SELECT role FROM users WHERE id='u_t'`).get() as any).role).toBe('citizen');
  });
});
