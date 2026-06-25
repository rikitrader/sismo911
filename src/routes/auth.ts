import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { hashPassword, verifyPassword, createSession, setSessionCookie, clearSession, getUserFromRequest } from '../lib/auth';
import { rateLimit } from '../lib/security';
import { audit } from '../lib/audit';
import { sendEmail, randomToken, sha256hex, resetEmail, welcomeEmail, passwordChangedEmail, type EmailMsg } from '../lib/email';

export const auth = new Hono<{ Bindings: Env }>();

const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

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
  return c.json({ ok: true, token, expires, user: { id, email, name: b.name, role } }, 201);
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
  if (!row || !(await verifyPassword(b?.password || '', row.pw_hash, row.pw_salt))) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  await c.env.DB.prepare(`UPDATE users SET last_login_ms = ? WHERE id = ?`).bind(Date.now(), row.id).run();
  const { token, expires } = await createSession(c.env, row.id, c.req.header('user-agent'));
  setSessionCookie(c, token);
  return c.json({ ok: true, token, expires, user: { id: row.id, email: row.email, name: row.name, role: row.role, rank: row.rank, unit: row.unit } });
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
