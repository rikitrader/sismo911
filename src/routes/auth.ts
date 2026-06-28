import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { hashPassword, verifyPassword, createSession, setSessionCookie, clearSession, getUserFromRequest, getSessionToken, IDLE_TTL_MS, isPrivilegedRole } from '../lib/auth';
import { rateLimit } from '../lib/security';
import { audit } from '../lib/audit';
import { sendEmail, randomToken, sha256hex, resetEmail, welcomeEmail, passwordChangedEmail, type EmailMsg } from '../lib/email';
import { createWalletForEmail, isCrossmintConfigured } from '../lib/crossmint';
import { x402Network, x402Asset } from '../lib/x402';
import { verifyTotp, matchBackupCode } from '../lib/totp';

export const auth = new Hono<{ Bindings: Env }>();

const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// Provision the user's Crossmint custodial (encrypted) wallet, then persist the
// public address. Fail-open: a Crossmint outage/misconfig must NEVER block signup
// or login. Users without a wallet get one lazily via POST /api/auth/wallet.
async function provisionWallet(env: Env, userId: string, email: string): Promise<void> {
  try {
    if (!isCrossmintConfigured(env)) return;
    const w = await createWalletForEmail(env, email);
    if (!w) return;
    // Same UPDATE registers the wallet as an x402 receiver: the address becomes
    // the payTo, with the configured network + USDC asset. This is the per-wallet
    // opt-in only — effective acceptance ALSO requires the runtime master gate
    // isX402Live() (facilitator configured + payments feature flag), enforced at
    // the pay endpoint + discovery, so a partially configured deploy never settles.
    await env.DB.prepare(
      `UPDATE users SET wallet_address = ?, wallet_locator = ?, wallet_chain = ?, wallet_created_ms = ?,
              x402_enabled = 1, x402_pay_to = ?, x402_network = ?, x402_asset = ?, x402_enabled_ms = ?
       WHERE id = ? AND wallet_address IS NULL`
    ).bind(w.address, w.locator, w.chain, Date.now(),
           w.address, x402Network(env), x402Asset(env), Date.now(), userId).run();
  } catch (e: any) {
    console.error('[auth] wallet provisioning failed:', e?.message ?? e);
  }
}

function fireWallet(c: any, userId: string, email: string) {
  const p = provisionWallet(c.env, userId, email);
  try { c.executionCtx.waitUntil(p); } catch { /* no ctx (tests) — fire and forget */ }
}

// Send without blocking the response (keeps timing uniform for no-enumeration).
function fireEmail(c: any, to: string, msg: EmailMsg) {
  const promise = sendEmail(c.env, to, msg);
  try { c.executionCtx.waitUntil(promise); } catch { /* no ctx (tests) — fire and forget */ }
}

// POST /api/auth/register — first user ever becomes admin; the rest are citizens.
auth.post('/register', async (c) => {
  const limited = await rateLimit(c.env, c, 'auth_register', 5, 300);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const email = (b?.email || '').trim().toLowerCase();
  if (!emailOk(email)) return c.json({ error: 'email_invalid' }, 400);
  if (!b?.password || b.password.length < 8) return c.json({ error: 'password_min_8' }, 400);
  if (!b?.name) return c.json({ error: 'name_required' }, 400);

  const exists = await c.env.DB.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first();
  if (exists) return c.json({ error: 'email_taken' }, 409);

  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<any>();
  const role = (count?.n ?? 0) === 0 ? 'admin' : 'citizen';
  if (role === 'admin') {
    const token = c.req.header('x-admin-bootstrap-token') || b?.bootstrapToken;
    if (!envTokenMatches(c.env.ADMIN_BOOTSTRAP_TOKEN, token)) return c.json({ error: 'bootstrap_token_required' }, 403);
  }

  const { hash, salt } = await hashPassword(b.password);
  const id = uid('usr');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO users (id,email,name,role,rank,unit,pw_hash,pw_salt,phone,created_ms,last_login_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, email, b.name, role, b.rank ?? null, b.unit ?? null, hash, salt, b.phone ?? null, now, now).run();

  const { token, expires } = await createSession(c.env, id, c.req.header('user-agent'));
  setSessionCookie(c, token);
  fireEmail(c, email, welcomeEmail(b.name));
  // Provision the user's encrypted custodial wallet (Crossmint, Base) in the
  // background — never blocks the signup response.
  fireWallet(c, id, email);
  return c.json({ ok: true, token, expires, user: { id, email, name: b.name, role } }, 201);
});

// POST /api/auth/wallet — lazily provision (or return) the caller's custodial
// wallet. Idempotent: safe for users created before wallets existed, or when
// signup-time provisioning failed. Requires a logged-in session.
auth.post('/wallet', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  if (me.wallet_address) return c.json({ ok: true, wallet: { address: me.wallet_address, chain: c.env.CROSSMINT_CHAIN || 'base' } });
  if (!isCrossmintConfigured(c.env)) return c.json({ error: 'wallet_not_configured' }, 503);
  const w = await createWalletForEmail(c.env, me.email);
  if (!w) return c.json({ error: 'wallet_create_failed' }, 502);
  await c.env.DB.prepare(
    `UPDATE users SET wallet_address = ?, wallet_locator = ?, wallet_chain = ?, wallet_created_ms = ?,
            x402_enabled = 1, x402_pay_to = ?, x402_network = ?, x402_asset = ?, x402_enabled_ms = ?
     WHERE id = ? AND wallet_address IS NULL`
  ).bind(w.address, w.locator, w.chain, Date.now(),
         w.address, x402Network(c.env), x402Asset(c.env), Date.now(), me.id).run();
  await audit(c, 'wallet.create', { user_id: me.id });
  return c.json({ ok: true, wallet: { address: w.address, chain: w.chain, x402: { enabled: true, payTo: w.address, network: x402Network(c.env) } } });
});

// POST /api/auth/forgot-password — always returns ok (no user enumeration).
auth.post('/forgot-password', async (c) => {
  const limited = await rateLimit(c.env, c, 'auth_forgot', 5, 600);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const email = (b?.email || '').trim().toLowerCase();
  if (emailOk(email)) {
    const user: any = await c.env.DB.prepare(`SELECT id, name, email FROM users WHERE email = ?`).bind(email).first();
    if (user) {
      const raw = randomToken();
      const now = Date.now();
      await c.env.DB.prepare(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_ms, used_ms, created_ms) VALUES (?,?,?,?,?,?)`
      ).bind(uid('rst'), user.id, await sha256hex(raw), now + 60 * 60 * 1000, null, now).run();
      const base = c.env.PUBLIC_BASE_URL || 'https://sismo911.com';
      fireEmail(c, user.email, resetEmail(user.name, `${base}/restablecer?token=${raw}`));
      await audit(c, 'auth.forgot', { email });
    }
  }
  return c.json({ ok: true });
});

// POST /api/auth/reset-password — consume token, set new password, kill sessions.
auth.post('/reset-password', async (c) => {
  const limited = await rateLimit(c.env, c, 'auth_reset', 10, 600);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const token = (b?.token || '').trim();
  const password = b?.password || '';
  if (!token) return c.json({ error: 'token_required' }, 400);
  if (password.length < 8) return c.json({ error: 'password_min_8' }, 400);
  const now = Date.now();
  const row: any = await c.env.DB.prepare(
    `SELECT pr.id AS rid, pr.user_id, u.email, u.name
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ? AND pr.used_ms IS NULL AND pr.expires_ms > ?`
  ).bind(await sha256hex(token), now).first();
  if (!row) return c.json({ error: 'token_invalid_or_expired' }, 400);

  const { hash, salt } = await hashPassword(password);
  await c.env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?`).bind(hash, salt, row.user_id).run();
  // Burn every outstanding reset token + all sessions for this user.
  await c.env.DB.prepare(`UPDATE password_resets SET used_ms = ? WHERE user_id = ? AND used_ms IS NULL`).bind(now, row.user_id).run();
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.user_id).run();
  fireEmail(c, row.email, passwordChangedEmail(row.name));
  await audit(c, 'auth.reset', { user_id: row.user_id });
  return c.json({ ok: true });
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const limited = await rateLimit(c.env, c, 'auth_login', 10, 300);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const email = (b?.email || '').trim().toLowerCase();
  const row: any = await c.env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const ua = c.req.header('user-agent') ?? null;
  if (!row || !(await verifyPassword(b?.password || '', row.pw_hash, row.pw_salt))) {
    // Record the failed attempt (login_history) — wrapped so logging never breaks login.
    try {
      await c.env.DB.prepare(
        `INSERT INTO login_history (id, user_id, email, ip, ua, ok, reason, created_ms) VALUES (?,?,?,?,?,?,?,?)`
      ).bind(uid('lh'), row?.id ?? null, email, ip, ua, 0, 'invalid_credentials', Date.now()).run();
    } catch { /* ignore */ }
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  // MFA second factor — only enforced when this user has enabled it (non-MFA
  // logins fall straight through, byte-identical). Accepts a TOTP code or a
  // one-time backup code in the SAME request body; absent ⇒ 401 mfa_required
  // (no session), present-but-wrong ⇒ 401 mfa_invalid.
  if (Number(row.mfa_enabled) === 1) {
    const code = typeof b?.code === 'string' ? b.code.trim() : '';
    if (!code) return c.json({ error: 'mfa_required' }, 401);
    let mfaOk = row.mfa_secret ? await verifyTotp(row.mfa_secret, code) : false;
    if (!mfaOk && row.mfa_backup_codes) {
      let backups: string[] = [];
      try { backups = JSON.parse(row.mfa_backup_codes || '[]'); } catch { backups = []; }
      const idx = await matchBackupCode(code, backups);
      if (idx >= 0) {
        mfaOk = true;
        backups.splice(idx, 1); // backup codes are one-time use
        await c.env.DB.prepare(`UPDATE users SET mfa_backup_codes = ? WHERE id = ?`)
          .bind(JSON.stringify(backups), row.id).run();
      }
    }
    if (!mfaOk) return c.json({ error: 'mfa_invalid' }, 401);
  }
  await c.env.DB.prepare(`UPDATE users SET last_login_ms = ?, last_ip = ? WHERE id = ?`).bind(Date.now(), ip, row.id).run();
  // Record the successful login (login_history) — wrapped so logging never breaks login.
  try {
    await c.env.DB.prepare(
      `INSERT INTO login_history (id, user_id, email, ip, ua, ok, reason, created_ms) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(uid('lh'), row.id, email, ip, ua, 1, null, Date.now()).run();
  } catch { /* ignore */ }
  // Privileged (operator/admin) sessions get the short sliding idle window;
  // citizens keep the long absolute TTL.
  const { token, expires } = await createSession(
    c.env, row.id, c.req.header('user-agent'),
    isPrivilegedRole(row.role) ? IDLE_TTL_MS : undefined,
  );
  setSessionCookie(c, token);
  return c.json({ ok: true, token, expires, must_change_pw: row.must_change_pw ?? 0, user: { id: row.id, email: row.email, name: row.name, role: row.role, rank: row.rank, unit: row.unit, must_change_pw: row.must_change_pw ?? 0 } });
});

function envTokenMatches(expected: string | undefined, got: unknown): boolean {
  if (!expected || typeof got !== 'string') return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(got);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// POST /api/auth/logout
auth.post('/logout', async (c) => {
  await clearSession(c.env, c);
  return c.json({ ok: true });
});

// POST /api/auth/change-password — authenticated self-service password change.
// Clears the forced-rotation flag (must_change_pw) and burns every OTHER session
// for the user. Required after first login for provisioned operator accounts: the
// gate blocks all writes until this succeeds.
auth.post('/change-password', async (c) => {
  const limited = await rateLimit(c.env, c, 'auth_change_pw', 10, 600);
  if (limited) return limited;
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  const current = typeof b?.current_password === 'string' ? b.current_password : '';
  const next = typeof b?.new_password === 'string' ? b.new_password : '';
  if (next.length < 10) return c.json({ error: 'weak_password', hint: 'mínimo 10 caracteres' }, 400);
  const row: any = await c.env.DB.prepare(`SELECT pw_hash, pw_salt FROM users WHERE id = ?`).bind(me.id).first();
  if (!row || !(await verifyPassword(current, row.pw_hash, row.pw_salt))) {
    return c.json({ error: 'invalid_current_password' }, 403);
  }
  if (await verifyPassword(next, row.pw_hash, row.pw_salt)) {
    return c.json({ error: 'same_password', hint: 'usa una contraseña distinta a la temporal' }, 400);
  }
  const { hash, salt } = await hashPassword(next);
  await c.env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, must_change_pw = 0 WHERE id = ?`)
    .bind(hash, salt, me.id).run();
  // Invalidate every OTHER session for this user (keep the current one).
  const tok = getSessionToken(c) ?? '';
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token <> ?`).bind(me.id, tok).run();
  await audit(c, 'auth.change_password', { user_id: me.id });
  fireEmail(c, me.email, passwordChangedEmail(me.name));
  return c.json({ ok: true });
});

// GET /api/auth/me
auth.get('/me', async (c) => {
  const user = await getUserFromRequest(c.env, c);
  if (!user) return c.json({ authenticated: false }, 200);
  return c.json({ authenticated: true, user });
});

// ---- Admin: user management ----
auth.get('/users', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (me?.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT id,email,name,role,rank,unit,created_ms,last_login_ms FROM users ORDER BY created_ms DESC LIMIT 500`
  ).all();
  return c.json({ users: results ?? [] });
});

auth.patch('/users/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (me?.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  if (!['citizen', 'operator', 'admin'].includes(b.role)) return c.json({ error: 'bad_role' }, 400);
  await c.env.DB.prepare(`UPDATE users SET role = ?, rank = COALESCE(?,rank), unit = COALESCE(?,unit) WHERE id = ?`)
    .bind(b.role, b.rank ?? null, b.unit ?? null, c.req.param('id')).run();
  await audit(c, 'users.role_update', { id: c.req.param('id'), role: b.role });
  return c.json({ ok: true });
});
