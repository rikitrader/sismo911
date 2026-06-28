import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { hashPassword, createSession, setSessionCookie } from '../lib/auth';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/security';
import { isCrossmintConfigured, createWalletForEmail } from '../lib/crossmint';
import { x402Network, x402Asset } from '../lib/x402';
import {
  getProvider, providerCreds, configuredProviders, PROVIDERS,
  randomToken, pkceChallenge, buildAuthUrl, exchangeCode, fetchUserInfo, sanitizeNext,
} from '../lib/oauth';

// Social login (OAuth 2.0 auth-code + PKCE). Mounted at /api/auth/oauth.
// Public by design (the user isn't logged in yet). CSRF is handled by the signed
// one-time `state` stored in KV; only same-site `next` paths are honored.

export const oauth = new Hono<{ Bindings: Env }>();

const STATE_TTL = 600; // seconds
const stateKey = (s: string) => `oauth:state:${s}`;
const errRedirect = (c: any, code: string) => c.redirect(`/login?oauth_error=${encodeURIComponent(code)}`, 302);

function callbackUri(c: any, provider: string): string {
  return `${new URL(c.req.url).origin}/api/auth/oauth/${provider}/callback`;
}

// GET /api/auth/oauth/providers — which social buttons the login page should show.
oauth.get('/providers', (c) => c.json({ ok: true, providers: configuredProviders(c.env).map((id) => ({ id, label: PROVIDERS[id].label })) }));

// GET /api/auth/oauth/:provider/start — begin the flow (redirect to the provider).
oauth.get('/:provider/start', async (c) => {
  const limited = await rateLimit(c.env, c, 'oauth_start', 20, 300);
  if (limited) return limited;
  const provider = c.req.param('provider');
  const p = getProvider(provider);
  if (!p) return c.json({ error: 'provider_unknown' }, 404);
  const creds = providerCreds(c.env, p);
  if (!creds) return c.json({ error: 'provider_not_configured' }, 404);

  const next = sanitizeNext(c.req.query('next'));
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const redirectUri = callbackUri(c, provider);
  await c.env.CACHE.put(stateKey(state), JSON.stringify({ provider, next, verifier, redirectUri }), { expirationTtl: STATE_TTL });
  return c.redirect(buildAuthUrl(p, creds.clientId, redirectUri, state, challenge), 302);
});

// GET /api/auth/oauth/:provider/callback — provider returns here with ?code&state.
oauth.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  if (c.req.query('error')) return errRedirect(c, 'denied');
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return errRedirect(c, 'missing');

  // One-time state: load + immediately delete (replay-safe).
  const raw = await c.env.CACHE.get(stateKey(state));
  if (!raw) return errRedirect(c, 'state');
  await c.env.CACHE.delete(stateKey(state)).catch(() => {});
  let st: any; try { st = JSON.parse(raw); } catch { return errRedirect(c, 'state'); }
  if (st.provider !== provider) return errRedirect(c, 'state');

  const p = getProvider(provider);
  const creds = p ? providerCreds(c.env, p) : null;
  if (!p || !creds) return errRedirect(c, 'config');

  const tokens = await exchangeCode(p, creds, code, st.redirectUri, st.verifier);
  if (!tokens?.access_token) return errRedirect(c, 'token');
  const profile = await fetchUserInfo(p, tokens.access_token);
  if (!profile) return errRedirect(c, 'profile');
  // Auto-linking by email is only safe when the provider asserts verification.
  if (!profile.email_verified) return errRedirect(c, 'unverified');

  const now = Date.now();
  const existing: any = await c.env.DB.prepare(`SELECT id, role, oauth_provider FROM users WHERE email = ?`).bind(profile.email).first();

  let userId: string;
  if (existing) {
    userId = existing.id;
    // Link the federated identity if this account didn't have one, and stamp login.
    await c.env.DB.prepare(
      `UPDATE users SET last_login_ms = ?, email_verified = 1,
              oauth_provider = COALESCE(oauth_provider, ?), oauth_sub = COALESCE(oauth_sub, ?)
       WHERE id = ?`
    ).bind(now, provider, profile.sub, userId).run();
    await audit(c, 'auth.oauth.login', { provider, user_id: userId });
  } else {
    // New citizen account. OAuth users never auto-become admin (no bootstrap path).
    userId = uid('usr');
    const { hash, salt } = await hashPassword(randomToken(32)); // unusable password until a reset
    await c.env.DB.prepare(
      `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,oauth_provider,oauth_sub,email_verified,created_ms,last_login_ms)
       VALUES (?,?,?,?,?,?,?,?,1,?,?)`
    ).bind(userId, profile.email, profile.name, 'citizen', hash, salt, provider, profile.sub, now, now).run();
    await audit(c, 'auth.oauth.register', { provider, user_id: userId });
    fireWallet(c, userId, profile.email);
  }

  const { token } = await createSession(c.env, userId, c.req.header('user-agent'));
  setSessionCookie(c, token);
  return c.redirect(sanitizeNext(st.next), 302);
});

// Mirror auth.ts's background wallet provisioning (Crossmint, Base) without
// importing its private helper — never blocks the redirect.
function fireWallet(c: any, userId: string, email: string) {
  const p = (async () => {
    try {
      if (!isCrossmintConfigured(c.env)) return;
      const w = await createWalletForEmail(c.env, email);
      if (!w) return;
      await c.env.DB.prepare(
        `UPDATE users SET wallet_address = ?, wallet_locator = ?, wallet_chain = ?, wallet_created_ms = ?,
                x402_enabled = 1, x402_pay_to = ?, x402_network = ?, x402_asset = ?, x402_enabled_ms = ?
         WHERE id = ? AND wallet_address IS NULL`
      ).bind(w.address, w.locator, w.chain, Date.now(), w.address, x402Network(c.env), x402Asset(c.env), Date.now(), userId).run();
    } catch (e: any) { console.error('[oauth] wallet provisioning failed:', e?.message ?? e); }
  })();
  try { c.executionCtx.waitUntil(p); } catch { /* no ctx (tests) */ }
}
