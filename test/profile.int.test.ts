import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { profile } from '../src/routes/profile';

// Profile Command Center API — auth, user-scoping, validation, no-secret-leak.
const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0009_password_resets.sql',
  'migrations/0016_donations.sql',      // wallet_address/chain/created_ms
  'migrations/0046_rbac_workforce.sql', // language, mfa_enabled, sessions.revoked_ms
  'migrations/0047_rbac_seed.sql',
  'migrations/0048_x402_payments.sql',  // x402_payments/x402_resources + x402_* user cols
  'migrations/0056_profile_fields.sql', // country, city, settings_json
];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  // must_change_pw/mfa_required (0049/0055) — getUserFromRequest selects them.
  for (const sql of [
    'ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN impersonator_id TEXT', // 0054 impersonation — getUserFromRequest selects it
  ]) db.raw.exec(sql);

  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/profile', profile);
  const now = Date.now();
  const pw = await hashPassword('pw');
  db.raw.prepare(
    `INSERT INTO users (id,email,name,role,phone,language,wallet_address,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run('usr_a', 'a@s.com', 'Ana Pérez', 'citizen', null, 'es', '0xABCDEF0000000000000000000000000000000001', pw.hash, pw.salt, 'active', now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`)
    .run('tok_a', 'usr_a', now + 86_400_000, now);
  return { db, env, app };
}

const AUTH = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_a' };

describe('profile API — auth + scope + validation', () => {
  it('GET /me without auth → 401', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/profile/me', {}, env);
    expect(r.status).toBe(401);
  });

  it('GET /me returns profile + wallet + x402 + no secrets', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/profile/me', { headers: { Cookie: 'sismo_session=tok_a' } }, env);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.profile.email).toBe('a@s.com');
    expect(d.profile.name).toBe('Ana Pérez');
    expect(d.profile.role).toBe('citizen');
    expect(d.wallet.has_wallet).toBe(true);
    expect(d.wallet.custody).toBe('crossmint');
    expect(typeof d.profile.completion).toBe('number');
    // never leak secrets
    const body = JSON.stringify(d);
    expect(body).not.toMatch(/pw_hash|pw_salt|wallet_locator|secret|private/i);
  });

  it('PATCH /me updates editable fields + persists', async () => {
    const { app, env, db } = await setup();
    const r = await app.request('/api/profile/me', {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ name: 'Ana M. Pérez', phone: '+58 412 1234567', country: 'Venezuela', city: 'Caracas', language: 'en' }),
    }, env);
    expect(r.status).toBe(200);
    const row: any = db.raw.prepare('SELECT name,phone,country,city,language FROM users WHERE id=?').get('usr_a');
    expect(row.name).toBe('Ana M. Pérez');
    expect(row.country).toBe('Venezuela');
    expect(row.city).toBe('Caracas');
    expect(row.language).toBe('en');
  });

  it('PATCH /me rejects invalid phone/language/empty name', async () => {
    const { app, env } = await setup();
    const bad = async (body: any) => (await app.request('/api/profile/me', { method: 'PATCH', headers: AUTH, body: JSON.stringify(body) }, env)).status;
    expect(await bad({ name: '' })).toBe(400);
    expect(await bad({ phone: 'not-a-phone!!' })).toBe(400);
    expect(await bad({ language: 'fr' })).toBe(400);
    expect(await bad({})).toBe(400); // nothing to update
  });

  it('PATCH /me cannot change email or role (ignored)', async () => {
    const { app, env, db } = await setup();
    const r = await app.request('/api/profile/me', {
      method: 'PATCH', headers: AUTH, body: JSON.stringify({ name: 'X', email: 'evil@x.com', role: 'admin' }),
    }, env);
    expect(r.status).toBe(200);
    const row: any = db.raw.prepare('SELECT email,role FROM users WHERE id=?').get('usr_a');
    expect(row.email).toBe('a@s.com'); // unchanged
    expect(row.role).toBe('citizen');  // unchanged
  });

  it('PATCH /me without auth → 401', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/profile/me', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://sismo911.com' }, body: '{"name":"x"}' }, env);
    expect(r.status).toBe(401);
  });
});
