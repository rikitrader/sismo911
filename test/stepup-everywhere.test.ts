import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { profile } from '../src/routes/profile';
import { adminRbac } from '../src/routes/admin-rbac';

// Step-up is enforced on EVERY sensitive mutation (not just withdrawals) when the
// acting user has enabled sec_require_login.
const MIGRATIONS = [
  'migrations/0004_auth.sql', 'migrations/0002_ops.sql', 'migrations/0009_password_resets.sql',
  'migrations/0016_donations.sql', 'migrations/0046_rbac_workforce.sql', 'migrations/0047_rbac_seed.sql',
  'migrations/0052_rbac_finegrained.sql', 'migrations/0048_x402_payments.sql', 'migrations/0050_x402_hardening.sql',
  'migrations/0056_profile_fields.sql', 'migrations/0057_payment_links.sql', 'migrations/0058_accounting.sql',
  'migrations/0059_withdrawals.sql', 'migrations/0069_notifications.sql',
];

async function setup(opts: { adminStepUp?: boolean; userStepUp?: boolean } = {}) {
  const db: D1Mock = makeDb(MIGRATIONS);
  for (const sql of [
    'ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN impersonator_id TEXT',
  ]) db.raw.exec(sql);
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/profile', profile);
  app.route('/api/rbac', adminRbac);
  const now = Date.now();
  const pw = await hashPassword('pw12345');
  const ins = db.raw.prepare(`INSERT INTO users (id,email,name,role,phone,language,wallet_address,pw_hash,pw_salt,status,settings_json,created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('usr_a', 'a@s.com', 'Ana', 'citizen', null, 'es', '0x01', pw.hash, pw.salt, 'active', opts.userStepUp ? '{"sec_require_login":true}' : null, now);
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', null, 'es', null, pw.hash, pw.salt, 'active', opts.adminStepUp ? '{"sec_require_login":true}' : null, now);
  ins.run('usr_t', 't@s.com', 'Target', 'citizen', null, 'es', null, pw.hash, pw.salt, 'active', null, now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_a', 'usr_a', now + 9e8, now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_admin', 'usr_admin', now + 9e8, now);
  return { db, env, app };
}
const A = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_a' };
const ADMIN = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_admin' };
const err = async (r: Response) => { try { return (await r.json() as any)?.error; } catch { return null; } };

describe('step-up enforced on all sensitive actions', () => {
  it('self-service mutations are gated when sec_require_login is on', async () => {
    const { app, env } = await setup({ userStepUp: true });
    for (const [m, p] of [['PATCH', '/api/profile/payment-settings'], ['POST', '/api/profile/withdrawal-methods'], ['POST', '/api/profile/payment-links']] as const) {
      const r = await app.request(p, { method: m, headers: A, body: '{}' }, env);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await err(r), `${m} ${p}`).toBe('step_up_required');
    }
  });

  it('NOT gated when sec_require_login is off', async () => {
    const { app, env } = await setup({ userStepUp: false });
    const r = await app.request('/api/profile/withdrawal-methods', { method: 'POST', headers: A, body: '{}' }, env);
    expect(await err(r)).not.toBe('step_up_required'); // proceeds to validation (type_invalid)
  });

  it('/confirm clears the gate, then the mutation proceeds', async () => {
    const { app, env } = await setup({ userStepUp: true });
    let r = await app.request('/api/profile/payment-links', { method: 'POST', headers: A, body: '{}' }, env);
    expect(await err(r)).toBe('step_up_required');
    r = await app.request('/api/profile/confirm', { method: 'POST', headers: A, body: JSON.stringify({ password: 'pw12345' }) }, env);
    expect(r.status).toBe(200);
    r = await app.request('/api/profile/payment-links', { method: 'POST', headers: A, body: '{}' }, env);
    expect(await err(r)).not.toBe('step_up_required'); // now validation (title_required)
  });

  it('admin RBAC mutations are gated for an admin with sec_require_login', async () => {
    const { app, env } = await setup({ adminStepUp: true });
    let r = await app.request('/api/rbac/users/usr_t/suspend', { method: 'POST', headers: ADMIN, body: '{}' }, env);
    expect(r.status).toBe(403); expect(await err(r)).toBe('step_up_required');
    // confirm, then suspend proceeds
    await app.request('/api/profile/confirm', { method: 'POST', headers: ADMIN, body: JSON.stringify({ password: 'pw12345' }) }, env);
    r = await app.request('/api/rbac/users/usr_t/suspend', { method: 'POST', headers: ADMIN, body: '{}' }, env);
    expect(await err(r)).not.toBe('step_up_required');
  });

  it('emergency lock (/lock) is NOT gated — break-glass stays fast', async () => {
    const { app, env } = await setup({ adminStepUp: true });
    const r = await app.request('/api/rbac/users/usr_t/lock', { method: 'POST', headers: ADMIN, body: '{}' }, env);
    expect(await err(r)).not.toBe('step_up_required');
  });
});
