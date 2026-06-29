import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { profile } from '../src/routes/profile';
import { publicProfile } from '../src/routes/public-profile';
import { adminRbac } from '../src/routes/admin-rbac';
import { paymentReceivedEmail } from '../src/lib/email';
import { notify } from '../src/lib/notify';

// Backs the cuenta.html "Privacidad y seguridad" toggles: each sec_* setting now
// has a real, tested backend effect. (Notifications use the system from #457.)
const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',            // audit table
  'migrations/0009_password_resets.sql',
  'migrations/0016_donations.sql',
  'migrations/0046_rbac_workforce.sql',
  'migrations/0047_rbac_seed.sql',
  'migrations/0052_rbac_finegrained.sql',
  'migrations/0048_x402_payments.sql',
  'migrations/0050_x402_hardening.sql',
  'migrations/0056_profile_fields.sql', // settings_json
  'migrations/0057_payment_links.sql',
  'migrations/0058_accounting.sql',
  'migrations/0059_withdrawals.sql',
  'migrations/0069_notifications.sql',  // #457 notifications table
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  for (const sql of [
    'ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN impersonator_id TEXT',
  ]) db.raw.exec(sql);

  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/profile', profile);
  app.route('/api/u', publicProfile);
  app.route('/api/rbac', adminRbac);

  const now = Date.now();
  const pw = await hashPassword('correct-horse');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,phone,language,wallet_address,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run('usr_a', 'a@s.com', 'Ana', 'citizen', null, 'es', '0xABC0000000000000000000000000000000000001', pw.hash, pw.salt, 'active', now);
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', null, 'es', null, pw.hash, pw.salt, 'active', now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_a', 'usr_a', now + 86_400_000, now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_admin', 'usr_admin', now + 86_400_000, now);
  return { db, env, app };
}

const A = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_a' };
const ADMIN = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_admin' };
const setSettings = (db: D1Mock, id: string, obj: any) =>
  db.raw.prepare(`UPDATE users SET settings_json=? WHERE id=?`).run(JSON.stringify(obj), id);

describe('cuenta security toggles — real backend effects', () => {
  it('sec_public_page=false hides the public profile', async () => {
    const { db, env, app } = await setup();
    let r = await app.request('/api/u/usr_a', {}, env);
    expect((await r.json() as any).public).toBe(true);     // default = public
    setSettings(db, 'usr_a', { sec_public_page: false });
    r = await app.request('/api/u/usr_a', {}, env);
    expect((await r.json() as any).public).toBe(false);
  });

  it('email is hidden by default, shown only when sec_hide_email===false', async () => {
    const { db, env, app } = await setup();
    let j = await (await app.request('/api/u/usr_a', {}, env)).json() as any;
    expect(j.profile.email).toBe(null);                    // default hidden
    setSettings(db, 'usr_a', { sec_hide_email: false });
    j = await (await app.request('/api/u/usr_a', {}, env)).json() as any;
    expect(j.profile.email).toBe('a@s.com');               // explicit opt-in shows
  });

  it('notify() (sec_receipt_notifs path) writes a notification row', async () => {
    const { db, env } = await setup();
    await notify(env, 'usr_a', { type: 'payment_received', title: 'Pago recibido', body: 'Recibiste $5.00 USDC.', link: '#pagos' });
    const row: any = db.raw.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=?`).get('usr_a');
    expect(row.n).toBe(1);
  });

  it('sec_require_login gates withdrawals until /confirm with the right password', async () => {
    const { db, env, app } = await setup();
    setSettings(db, 'usr_a', { sec_require_login: true });
    let r = await app.request('/api/profile/withdrawals', { method: 'POST', headers: A, body: '{}' }, env);
    expect(r.status).toBe(403);
    expect((await r.json() as any).error).toBe('step_up_required');
    r = await app.request('/api/profile/confirm', { method: 'POST', headers: A, body: JSON.stringify({ password: 'nope' }) }, env);
    expect(r.status).toBe(401);
    r = await app.request('/api/profile/confirm', { method: 'POST', headers: A, body: JSON.stringify({ password: 'correct-horse' }) }, env);
    expect(r.status).toBe(200);
    r = await app.request('/api/profile/withdrawals', { method: 'POST', headers: A, body: '{}' }, env);
    expect((await r.json() as any).error).not.toBe('step_up_required');
  });

  it('admin audit view respects the user sec_audit_visibility opt-in', async () => {
    const { db, env, app } = await setup();
    let j = await (await app.request('/api/rbac/users/usr_a/audit', { headers: ADMIN }, env)).json() as any;
    expect(j.opted_in).toBe(false); expect(j.items.length).toBe(0);
    setSettings(db, 'usr_a', { sec_audit_visibility: true });
    db.raw.prepare(`INSERT INTO audit (id,actor,action,detail,created_ms) VALUES (?,?,?,?,?)`)
      .run('aud_1', 'a@s.com', 'profile.settings.update', '{}', Date.now());
    j = await (await app.request('/api/rbac/users/usr_a/audit', { headers: ADMIN }, env)).json() as any;
    expect(j.opted_in).toBe(true); expect(j.items.length).toBe(1);
  });

  it('paymentReceivedEmail renders a USDC receipt (sec_payment_emails path)', () => {
    const m = paymentReceivedEmail({ name: 'Ana', amountUsd: 5, description: 'Donación', txHash: '0xdeadbeefcafe1234', network: 'Base', manageUrl: 'https://sismo911.com/cuenta' });
    expect(m.subject).toContain('5.00');
    expect(m.html).toContain('Pago recibido');
    expect(m.text).toContain('USDC');
  });
});
