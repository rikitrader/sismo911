import type { Env } from '../types';

// Social-login (OAuth 2.0 authorization-code + PKCE) provider registry. New
// providers slot in by adding a PROVIDERS entry + the two env keys. Secrets are
// read from the Worker environment only (client secret = Worker Secret); nothing
// here is committed. The flow is fully server-side (no client SDK) so it needs no
// CSP relaxation — the only browser step is a top-level redirect to the provider.

export interface OAuthProvider {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  clientIdKey: keyof Env;
  clientSecretKey: keyof Env;
}

export const PROVIDERS: Record<string, OAuthProvider> = {
  google: {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    clientIdKey: 'OAUTH_GOOGLE_CLIENT_ID',
    clientSecretKey: 'OAUTH_GOOGLE_CLIENT_SECRET',
  },
};

export function getProvider(id: string): OAuthProvider | null {
  return PROVIDERS[id] ?? null;
}

export function providerCreds(env: Env, p: OAuthProvider): { clientId: string; clientSecret: string } | null {
  const clientId = (env as any)[p.clientIdKey];
  const clientSecret = (env as any)[p.clientSecretKey];
  if (!clientId || !clientSecret) return null;
  return { clientId: String(clientId), clientSecret: String(clientSecret) };
}

/** Which providers are fully configured (id+secret present) — drives the UI. */
export function configuredProviders(env: Env): string[] {
  return Object.values(PROVIDERS).filter((p) => providerCreds(env, p)).map((p) => p.id);
}

// ── PKCE + state helpers (Web Crypto) ────────────────────────────────────────
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

/** Only allow same-site, absolute-path redirects (never an external URL). */
export function sanitizeNext(next: unknown, fallback = '/cuenta'): string {
  const s = typeof next === 'string' ? next : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('://')) return fallback;
  return s.slice(0, 512);
}

export function buildAuthUrl(p: OAuthProvider, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(p.authUrl);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('access_type', 'online');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

export async function exchangeCode(
  p: OAuthProvider, creds: { clientId: string; clientSecret: string }, code: string, redirectUri: string, verifier: string,
): Promise<{ access_token?: string; id_token?: string } | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: creds.clientId, client_secret: creds.clientSecret, code_verifier: verifier,
  });
  const r = await fetch(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!r.ok) return null;
  return r.json().catch(() => null) as any;
}

export interface OAuthProfile { sub: string; email: string; email_verified: boolean; name: string; picture?: string }

export async function fetchUserInfo(p: OAuthProvider, accessToken: string): Promise<OAuthProfile | null> {
  const r = await fetch(p.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (!r.ok) return null;
  const u: any = await r.json().catch(() => null);
  if (!u?.email || !u?.sub) return null;
  return {
    sub: String(u.sub),
    email: String(u.email).trim().toLowerCase(),
    email_verified: u.email_verified === true || u.email_verified === 'true',
    name: String(u.name || u.given_name || u.email.split('@')[0]).slice(0, 120),
    picture: u.picture ? String(u.picture) : undefined,
  };
}
