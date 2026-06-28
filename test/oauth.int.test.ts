import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { oauth } from '../src/routes/oauth';

// Social login (OAuth) — provider gating, the redirect/state handshake, and the
// find-or-create on callback (with the provider HTTP calls mocked).
const MIGRATIONS = ['migrations/0004_auth.sql', 'migrations/0002_ops.sql', 'migrations/0060_oauth.sql'];

function setup(configured = true) {
  const db: D1Mock = makeDb(MIGRATIONS);
  const env: any = makeEnv(db);
  if (configured) { env.OAUTH_GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com'; env.OAUTH_GOOGLE_CLIENT_SECRET = 'csecret'; }
  const app = new Hono();
  app.route('/api/auth/oauth', oauth);
  return { db, env, app };
}

afterEach(() => vi.unstubAllGlobals());

describe('oauth — providers + start gating', () => {
  it('providers empty when unconfigured, lists google when configured', async () => {
    const off = setup(false);
    expect((await (await off.app.request('/api/auth/oauth/providers', {}, off.env)).json() as any).providers).toEqual([]);
    const on = setup(true);
    const d: any = await (await on.app.request('/api/auth/oauth/providers', {}, on.env)).json();
    expect(d.providers).toEqual([{ id: 'google', label: 'Google' }]);
  });

  it('start → 404 unknown provider / not configured; 302 to Google when configured', async () => {
    expect((await setup(true).app.request('/api/auth/oauth/bogus/start', {}, setup(true).env)).status).toBe(404);
    const off = setup(false);
    expect((await off.app.request('/api/auth/oauth/google/start', {}, off.env)).status).toBe(404);
    const on = setup(true);
    const r = await on.app.request('https://sismo911.com/api/auth/oauth/google/start?next=/cuenta', {}, on.env);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.host).toBe('accounts.google.com');
    expect(loc.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://sismo911.com/api/auth/oauth/google/callback');
    // state persisted in KV
    const state = loc.searchParams.get('state')!;
    expect(await on.env.CACHE.get('oauth:state:' + state)).toBeTruthy();
  });
});

function mockProviderFetch(profile: any) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at', id_token: 'it' }), { status: 200 });
    if (String(url).includes('userinfo')) return new Response(JSON.stringify(profile), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
}
async function seedState(env: any, state: string, next = '/cuenta') {
  await env.CACHE.put('oauth:state:' + state, JSON.stringify({ provider: 'google', next, verifier: 'verif', redirectUri: 'https://sismo911.com/api/auth/oauth/google/callback' }));
}

describe('oauth — callback find-or-create', () => {
  it('missing/invalid state → redirect to /login?oauth_error', async () => {
    const { app, env } = setup(true);
    const r = await app.request('https://sismo911.com/api/auth/oauth/google/callback?code=x&state=nope', {}, env);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/login?oauth_error=state');
  });

  it('unverified email → oauth_error=unverified, no user created', async () => {
    const { app, env, db } = setup(true);
    await seedState(env, 's1');
    mockProviderFetch({ sub: 'g1', email: 'x@s.com', email_verified: false, name: 'X' });
    const r = await app.request('https://sismo911.com/api/auth/oauth/google/callback?code=c&state=s1', {}, env);
    expect(r.headers.get('location')).toContain('oauth_error=unverified');
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n).toBe(0);
  });

  it('new verified user → creates citizen + session cookie + redirect to next', async () => {
    const { app, env, db } = setup(true);
    await seedState(env, 's2', '/cuenta');
    mockProviderFetch({ sub: 'g2', email: 'new@s.com', email_verified: true, name: 'Nuevo' });
    const r = await app.request('https://sismo911.com/api/auth/oauth/google/callback?code=c&state=s2', {}, env);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/cuenta');
    expect(r.headers.get('set-cookie') || '').toMatch(/sismo_session=/);
    const u: any = db.raw.prepare('SELECT role, oauth_provider, email_verified FROM users WHERE email=?').get('new@s.com');
    expect(u.role).toBe('citizen');           // OAuth users are never auto-admin
    expect(u.oauth_provider).toBe('google');
    expect(u.email_verified).toBe(1);
    // state is one-time (consumed)
    expect(await env.CACHE.get('oauth:state:s2')).toBeFalsy();
  });

  it('existing email → logs in, links identity, no duplicate user', async () => {
    const { app, env, db } = setup(true);
    db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,created_ms) VALUES (?,?,?,?,?,?,?)`)
      .run('usr_x', 'me@s.com', 'Yo', 'citizen', 'h', 's', Date.now());
    await seedState(env, 's3');
    mockProviderFetch({ sub: 'g3', email: 'me@s.com', email_verified: true, name: 'Yo Google' });
    const r = await app.request('https://sismo911.com/api/auth/oauth/google/callback?code=c&state=s3', {}, env);
    expect(r.status).toBe(302);
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n).toBe(1); // no dup
    const u: any = db.raw.prepare('SELECT oauth_provider FROM users WHERE email=?').get('me@s.com');
    expect(u.oauth_provider).toBe('google'); // identity linked
  });

  it('provider denial → oauth_error=denied', async () => {
    const { app, env } = setup(true);
    const r = await app.request('https://sismo911.com/api/auth/oauth/google/callback?error=access_denied', {}, env);
    expect(r.headers.get('location')).toContain('oauth_error=denied');
  });
});
