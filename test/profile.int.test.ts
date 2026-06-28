import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { profile } from '../src/routes/profile';
import { adminWithdrawals } from '../src/routes/admin-withdrawals';

// Profile Command Center API — auth, user-scoping, validation, no-secret-leak.
const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0009_password_resets.sql',
  'migrations/0016_donations.sql',      // wallet_address/chain/created_ms
  'migrations/0046_rbac_workforce.sql', // language, mfa_enabled, sessions.revoked_ms
  'migrations/0047_rbac_seed.sql',
  'migrations/0052_rbac_finegrained.sql', // perm_epoch / expires_ms the rbac engine queries
  'migrations/0048_x402_payments.sql',  // x402_payments/x402_resources + x402_* user cols
  'migrations/0050_x402_hardening.sql', // x402_resources.price_version + price history
  'migrations/0056_profile_fields.sql', // country, city, settings_json
  'migrations/0057_payment_links.sql',  // x402_resources kind/currency/archived_ms
  'migrations/0058_accounting.sql',     // x402_payments tax_category/notes/reconciled
  'migrations/0059_withdrawals.sql',    // withdrawal_methods + withdrawal_requests
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

describe('profile API — payment-settings + payments summary (W2)', () => {
  it('PATCH /payment-settings merges only whitelisted booleans; persists', async () => {
    const { app, env, db } = await setup();
    const r = await app.request('/api/profile/payment-settings', {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ receive_payments: true, hide_balance: true, NOT_A_KEY: true }),
    }, env);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.settings.receive_payments).toBe(true);
    expect(d.settings.hide_balance).toBe(true);
    expect(d.settings.NOT_A_KEY).toBeUndefined();
    const row: any = db.raw.prepare('SELECT settings_json FROM users WHERE id=?').get('usr_a');
    expect(JSON.parse(row.settings_json).receive_payments).toBe(true);
  });
  it('PATCH /payment-settings rejects non-boolean + unauth', async () => {
    const { app, env } = await setup();
    const r1 = await app.request('/api/profile/payment-settings', { method: 'PATCH', headers: AUTH, body: JSON.stringify({ receive_payments: 'yes' }) }, env);
    expect(r1.status).toBe(400);
    const r2 = await app.request('/api/profile/payment-settings', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://sismo911.com' }, body: '{"receive_payments":true}' }, env);
    expect(r2.status).toBe(401);
  });
  it('GET /payments/summary aggregates the x402 ledger; 401 unauth', async () => {
    const { app, env, db } = await setup();
    const now = Date.now();
    db.raw.prepare(`INSERT INTO x402_resources (id,user_id,slug,title,price_usd,mime_type,active,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('res_1', 'usr_a', 'svc', 'Servicio', 5, 'application/json', 1, now, now);
    const ins = db.raw.prepare(`INSERT INTO x402_payments (id,payee_user_id,resource_id,resource_url,network,asset,amount,amount_usd,pay_to,status,created_ms,settled_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('p1', 'usr_a', 'res_1', '/x', 'eip155:8453', 'usdc', '5000000', 5, '0xabc', 'settled', now, now);
    ins.run('p2', 'usr_a', 'res_1', '/x', 'eip155:8453', 'usdc', '3000000', 3, '0xabc', 'settled', now, now);
    ins.run('p3', 'usr_a', 'res_1', '/x', 'eip155:8453', 'usdc', '1000000', 1, '0xabc', 'failed', now, null);

    const r = await app.request('/api/profile/payments/summary', { headers: { Cookie: 'sismo_session=tok_a' } }, env);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.summary.count).toBe(2);
    expect(d.summary.total_received_usd).toBe(8);
    expect(d.summary.avg_usd).toBe(4);
    expect(d.summary.failed_count).toBe(1);
    expect(d.summary.active_links).toBe(1);
    expect(d.by_status.settled.n).toBe(2);
    expect(d.top_links[0].title).toBe('Servicio');
    const un = await app.request('/api/profile/payments/summary', {}, env);
    expect(un.status).toBe(401);
  });
});

describe('profile API — payment links CRUD + access control (W3)', () => {
  async function setupTwo() {
    const s = await setup();
    const now = Date.now();
    const pw = await hashPassword('pw');
    s.db.raw.prepare(`INSERT INTO users (id,email,name,role,language,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('usr_b', 'b@s.com', 'Beto', 'citizen', 'es', pw.hash, pw.salt, 'active', now);
    s.db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_b', 'usr_b', now + 86_400_000, now);
    return s;
  }
  const AUTH_B = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_b' };

  it('POST creates a link (auto-slug, 201) + GET lists it with counts', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/profile/payment-links', { method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'Asesoría Legal', amount: 25 }) }, env);
    expect(r.status).toBe(201);
    const d: any = await r.json();
    expect(d.link.slug).toBe('asesoria-legal');
    expect(d.link.kind).toBe('x402');
    expect(d.link.payUrl).toContain('/api/x402/pay/usr_a/asesoria-legal');
    const g: any = await (await app.request('/api/profile/payment-links', { headers: { Cookie: 'sismo_session=tok_a' } }, env)).json();
    expect(g.links.length).toBe(1);
    expect(g.links[0].paid_count).toBe(0);
    expect(g.links[0].revenue_usd).toBe(0);
  });

  it('POST validates title + price; rejects bad', async () => {
    const { app, env } = await setup();
    const bad = async (b: any) => (await app.request('/api/profile/payment-links', { method: 'POST', headers: AUTH, body: JSON.stringify(b) }, env)).status;
    expect(await bad({ amount: 5 })).toBe(400);                 // no title
    expect(await bad({ title: 'X', amount: -1 })).toBe(400);    // negative price
    expect(await bad({ title: 'X', amount: 'abc' })).toBe(400); // NaN price
  });

  it('PATCH toggles active + DELETE soft-archives (history preserved)', async () => {
    const { app, env, db } = await setup();
    const c: any = await (await app.request('/api/profile/payment-links', { method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'Donativo', amount: 10, kind: 'donation' }) }, env)).json();
    const id = c.link.id;
    const p = await app.request(`/api/profile/payment-links/${id}`, { method: 'PATCH', headers: AUTH, body: JSON.stringify({ active: false }) }, env);
    expect(p.status).toBe(200);
    expect(db.raw.prepare('SELECT active FROM x402_resources WHERE id=?').get(id)).toMatchObject({ active: 0 });
    const del = await app.request(`/api/profile/payment-links/${id}`, { method: 'DELETE', headers: AUTH }, env);
    expect(del.status).toBe(200);
    const row: any = db.raw.prepare('SELECT archived_ms FROM x402_resources WHERE id=?').get(id);
    expect(row.archived_ms).toBeTruthy(); // soft-archived, row still exists
    // default GET excludes archived
    const g: any = await (await app.request('/api/profile/payment-links', { headers: { Cookie: 'sismo_session=tok_a' } }, env)).json();
    expect(g.links.length).toBe(0);
  });

  it('access control: user B cannot PATCH/DELETE user A link (404)', async () => {
    const { app, env } = await setupTwo();
    const c: any = await (await app.request('/api/profile/payment-links', { method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'Privado A', amount: 5 }) }, env)).json();
    const id = c.link.id;
    expect((await app.request(`/api/profile/payment-links/${id}`, { method: 'PATCH', headers: AUTH_B, body: '{"active":false}' }, env)).status).toBe(404);
    expect((await app.request(`/api/profile/payment-links/${id}`, { method: 'DELETE', headers: AUTH_B }, env)).status).toBe(404);
  });

  it('all payment-link routes require auth (401)', async () => {
    const { app, env } = await setup();
    expect((await app.request('/api/profile/payment-links', {}, env)).status).toBe(401);
    expect((await app.request('/api/profile/payment-links', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://sismo911.com' }, body: '{"title":"x","amount":1}' }, env)).status).toBe(401);
  });
});

describe('profile API — accounting ledger (W4)', () => {
  function seedPayments(db: any, userId: string) {
    const now = Date.now();
    const ins = db.raw.prepare(`INSERT INTO x402_payments (id,payee_user_id,resource_url,network,asset,amount,amount_usd,pay_to,payer,status,tx_hash,created_ms,settled_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('pa', userId, '/x', 'eip155:8453', 'usdc', '6000000', 6, '0xto', '0xpayer1', 'settled', '0xhash1', now, now);
    ins.run('pb', userId, '/x', 'eip155:8453', 'usdc', '4000000', 4, '0xto', '0xpayer2', 'settled', '0xhash2', now, now);
    ins.run('pc', userId, '/x', 'eip155:8453', 'usdc', '2000000', 2, '0xto', '0xpayer3', 'failed', null, now, null);
    return 'pa';
  }

  it('GET ledger returns rows + KPIs (gross/net/reconciled); 401 unauth', async () => {
    const { app, env, db } = await setup();
    seedPayments(db, 'usr_a');
    expect((await app.request('/api/profile/accounting/ledger', {}, env)).status).toBe(401);
    const r = await app.request('/api/profile/accounting/ledger', { headers: { Cookie: 'sismo_session=tok_a' } }, env);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.rows.length).toBe(3);                 // includes the failed one
    expect(d.kpis.count).toBe(2);                  // settled only
    expect(d.kpis.gross_usd).toBe(10);
    expect(d.kpis.fees_usd).toBe(0);
    expect(d.kpis.net_usd).toBe(10);
    expect(d.kpis.unreconciled_usd).toBe(10);      // nothing reconciled yet
    expect(JSON.stringify(d)).not.toMatch(/pw_hash|pw_salt|private/i);
  });

  it('PATCH sets tax_category + notes + reconciled; updates KPIs', async () => {
    const { app, env, db } = await setup();
    seedPayments(db, 'usr_a');
    const p = await app.request('/api/profile/accounting/ledger/pa', { method: 'PATCH', headers: AUTH, body: JSON.stringify({ tax_category: 'servicio', notes: 'cliente X', reconciled: true }) }, env);
    expect(p.status).toBe(200);
    const row: any = db.raw.prepare('SELECT tax_category,notes,reconciled,reconciled_ms FROM x402_payments WHERE id=?').get('pa');
    expect(row.tax_category).toBe('servicio');
    expect(row.notes).toBe('cliente X');
    expect(row.reconciled).toBe(1);
    expect(row.reconciled_ms).toBeTruthy();
    const d: any = await (await app.request('/api/profile/accounting/ledger', { headers: { Cookie: 'sismo_session=tok_a' } }, env)).json();
    expect(d.kpis.reconciled_usd).toBe(6);
    expect(d.kpis.unreconciled_usd).toBe(4);
  });

  it('PATCH rejects bad tax_category / non-boolean reconciled', async () => {
    const { app, env, db } = await setup();
    seedPayments(db, 'usr_a');
    expect((await app.request('/api/profile/accounting/ledger/pa', { method: 'PATCH', headers: AUTH, body: '{"tax_category":"nope"}' }, env)).status).toBe(400);
    expect((await app.request('/api/profile/accounting/ledger/pa', { method: 'PATCH', headers: AUTH, body: '{"reconciled":"yes"}' }, env)).status).toBe(400);
  });

  it('access control: cannot PATCH another user payment (404); unauth 401', async () => {
    const { app, env, db } = await setup();
    seedPayments(db, 'usr_a');
    const now = Date.now();
    const pw = await hashPassword('pw');
    db.raw.prepare(`INSERT INTO users (id,email,name,role,language,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`).run('usr_c', 'c@s.com', 'Caro', 'citizen', 'es', pw.hash, pw.salt, 'active', now);
    db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_c', 'usr_c', now + 86_400_000, now);
    const AUTH_C = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_c' };
    expect((await app.request('/api/profile/accounting/ledger/pa', { method: 'PATCH', headers: AUTH_C, body: '{"reconciled":true}' }, env)).status).toBe(404);
    expect((await app.request('/api/profile/accounting/ledger/pa', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://sismo911.com' }, body: '{"reconciled":true}' }, env)).status).toBe(401);
  });
});

let _balSeq = 0;
function seedBalance(db: any, userId: string, usd: number) {
  const now = Date.now();
  db.raw.prepare(`INSERT INTO x402_payments (id,payee_user_id,resource_url,network,asset,amount,amount_usd,pay_to,status,created_ms,settled_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('bal_' + userId + '_' + (++_balSeq), userId, '/x', 'eip155:8453', 'usdc', String(usd * 1e6), usd, '0xto', 'settled', now, now);
}
const PAGO_MOVIL = { method_type: 'pago_movil', amount_source: 30, destination: { bank_name: 'Banesco', bank_code: '0134', phone: '04141234567', id_number: 'V12345678', holder_name: 'Ana Pérez' } };

describe('profile API — withdrawals (W5)', () => {
  it('POST pago_movil → 201 pending_review, masked destination (no raw phone)', async () => {
    const { app, env, db } = await setup();
    seedBalance(db, 'usr_a', 100);
    const r = await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify(PAGO_MOVIL) }, env);
    expect(r.status).toBe(201);
    const d: any = await r.json();
    expect(d.request.status).toBe('pending_review');         // manual rail never auto-completes
    expect(d.request.destination_summary).toContain('****4567');
    const stored: any = db.raw.prepare('SELECT destination_details_json FROM withdrawal_requests WHERE id=?').get(d.request.id);
    expect(stored.destination_details_json).not.toContain('04141234567'); // raw phone never stored
    expect(stored.destination_details_json).toContain('4567');            // last4 only
  });

  it('balance holds the request amount; insufficient balance rejected', async () => {
    const { app, env, db } = await setup();
    seedBalance(db, 'usr_a', 100);
    await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify({ ...PAGO_MOVIL, amount_source: 70 }) }, env);
    const g: any = await (await app.request('/api/profile/withdrawals', { headers: { Cookie: 'sismo_session=tok_a' } }, env)).json();
    expect(g.balance.available_usd).toBe(30);                 // 100 - 70 held
    const over = await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify({ ...PAGO_MOVIL, amount_source: 50 }) }, env);
    expect(over.status).toBe(400);
    expect((await over.json()).error).toBe('insufficient_balance');
  });

  it('validates method + amount + per-tx + stripe-unavailable', async () => {
    const { app, env, db } = await setup();
    seedBalance(db, 'usr_a', 100000);
    const bad = async (b: any) => (await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify(b) }, env));
    expect((await bad({ method_type: 'bogus', amount_source: 5 })).status).toBe(400);
    expect((await bad({ method_type: 'stripe', amount_source: 5 })).status).toBe(400);
    expect((await bad({ method_type: 'usdc', amount_source: 0 })).status).toBe(400);
    expect((await (await bad({ method_type: 'usdc', amount_source: 99999, destination: { address: '0xabc' } })).json()).error).toBe('over_per_tx_limit');
  });

  it('idempotency: same key returns the same request, only one row', async () => {
    const { app, env, db } = await setup();
    seedBalance(db, 'usr_a', 100);
    const body = JSON.stringify({ ...PAGO_MOVIL, idempotency_key: 'abc-123' });
    const r1: any = await (await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body }, env)).json();
    const r2res = await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body }, env);
    const r2: any = await r2res.json();
    expect(r2.idempotent).toBe(true);
    expect(r2.request.id).toBe(r1.request.id);
    const cnt: any = db.raw.prepare('SELECT COUNT(*) AS n FROM withdrawal_requests WHERE user_id=?').get('usr_a');
    expect(cnt.n).toBe(1);
  });

  it('over daily limit rejected', async () => {
    const { app, env, db } = await setup();
    seedBalance(db, 'usr_a', 100000);
    await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify({ method_type: 'usdc', amount_source: 5000, destination: { address: '0xabc' } }) }, env);
    const over = await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify({ method_type: 'usdc', amount_source: 1, destination: { address: '0xabc' } }) }, env);
    expect((await over.json()).error).toBe('over_daily_limit');
  });

  it('cancel pending_review → cancelled; processing not cancellable; access-control', async () => {
    const { app, env, db } = await setup();
    seedBalance(db, 'usr_a', 100);
    const c: any = await (await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify(PAGO_MOVIL) }, env)).json();
    const id = c.request.id;
    expect((await app.request(`/api/profile/withdrawals/${id}/cancel`, { method: 'PATCH', headers: AUTH }, env)).status).toBe(200);
    expect(db.raw.prepare('SELECT status FROM withdrawal_requests WHERE id=?').get(id)).toMatchObject({ status: 'cancelled' });
    // another user can't cancel mine
    const pw = await hashPassword('pw'); const now = Date.now();
    db.raw.prepare(`INSERT INTO users (id,email,name,role,language,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`).run('usr_d', 'd@s.com', 'D', 'citizen', 'es', pw.hash, pw.salt, 'active', now);
    db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_d', 'usr_d', now + 86_400_000, now);
    seedBalance(db, 'usr_a', 50);
    const c2: any = await (await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify({ ...PAGO_MOVIL, amount_source: 10 }) }, env)).json();
    expect((await app.request(`/api/profile/withdrawals/${c2.request.id}/cancel`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_d' } }, env)).status).toBe(404);
    // processing can't be cancelled
    db.raw.prepare(`UPDATE withdrawal_requests SET status='processing' WHERE id=?`).run(c2.request.id);
    expect((await app.request(`/api/profile/withdrawals/${c2.request.id}/cancel`, { method: 'PATCH', headers: AUTH }, env)).status).toBe(409);
  });

  it('all withdrawal routes require auth (401)', async () => {
    const { app, env } = await setup();
    expect((await app.request('/api/profile/withdrawals', {}, env)).status).toBe(401);
    expect((await app.request('/api/profile/withdrawals', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://sismo911.com' }, body: '{}' }, env)).status).toBe(401);
  });
});

describe('admin withdrawals — operator review transitions (W5)', () => {
  async function setupAdmin() {
    const s = await setup();
    const app = new Hono();
    app.route('/api/profile', profile);
    app.route('/api/admin/withdrawals', adminWithdrawals);
    const now = Date.now();
    const pw = await hashPassword('pw');
    // operator (legacy role + explicit user_roles → ops:console)
    s.db.raw.prepare(`INSERT INTO users (id,email,name,role,language,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?,?)`).run('op1', 'op@s.com', 'Op', 'operator', 'es', pw.hash, pw.salt, 'active', now);
    s.db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`).run('tok_op', 'op1', now + 86_400_000, now);
    try { s.db.raw.prepare(`INSERT INTO user_roles (user_id, role_id, granted_ms) VALUES (?,?,?)`).run('op1', 'role_operator', now); } catch { /* schema variant */ }
    seedBalance(s.db, 'usr_a', 100);
    const c: any = await (await app.request('/api/profile/withdrawals', { method: 'POST', headers: AUTH, body: JSON.stringify(PAGO_MOVIL) }, s.env)).json();
    return { ...s, app, wrId: c.request.id };
  }
  const OP = { 'content-type': 'application/json', origin: 'https://sismo911.com', Cookie: 'sismo_session=tok_op' };

  it('operator approves (pending_review→processing) then mark-completed', async () => {
    const { app, env, db, wrId } = await setupAdmin();
    const q = await app.request('/api/admin/withdrawals?status=pending_review', { headers: { Cookie: 'sismo_session=tok_op' } }, env);
    expect(q.status).toBe(200);
    expect((await app.request(`/api/admin/withdrawals/${wrId}/approve`, { method: 'PATCH', headers: OP }, env)).status).toBe(200);
    expect(db.raw.prepare('SELECT status FROM withdrawal_requests WHERE id=?').get(wrId)).toMatchObject({ status: 'processing' });
    expect((await app.request(`/api/admin/withdrawals/${wrId}/mark-completed`, { method: 'PATCH', headers: OP, body: '{"provider_reference":"VES-998"}' }, env)).status).toBe(200);
    const row: any = db.raw.prepare('SELECT status, provider_reference, completed_ms FROM withdrawal_requests WHERE id=?').get(wrId);
    expect(row.status).toBe('completed');
    expect(row.provider_reference).toBe('VES-998');
    expect(row.completed_ms).toBeTruthy();
  });

  it('reject sets rejected + note; bad transition 409; non-operator forbidden', async () => {
    const { app, env, db, wrId } = await setupAdmin();
    expect((await app.request(`/api/admin/withdrawals/${wrId}/reject`, { method: 'PATCH', headers: OP, body: '{"note":"datos incompletos"}' }, env)).status).toBe(200);
    expect(db.raw.prepare('SELECT status, review_note FROM withdrawal_requests WHERE id=?').get(wrId)).toMatchObject({ status: 'rejected', review_note: 'datos incompletos' });
    // can't approve a rejected one
    expect((await app.request(`/api/admin/withdrawals/${wrId}/approve`, { method: 'PATCH', headers: OP }, env)).status).toBe(409);
    // a plain citizen cannot review
    const forbidden = await app.request('/api/admin/withdrawals', { headers: { Cookie: 'sismo_session=tok_a' } }, env);
    expect([401, 403]).toContain(forbidden.status);
  });
});
