import { describe, it, expect } from 'vitest';
import { makeDb, makeEnv, RBAC_MIGRATIONS, type D1Mock } from './helpers/d1';
import { app } from '../src/index';

// Regression: the /console shell gate must distinguish UNAUTHENTICATED from
// AUTHENTICATED-BUT-UNAUTHORIZED. Redirecting a logged-in user who lacks a
// console-read capability to /login caused an infinite redirect loop — login.html
// auto-redirects any authenticated session back to ?next (=/console/), so the
// browser bounced /console/ ↔ /login until ERR_TOO_MANY_REDIRECTS (a blank error
// page). An authorized user must therefore get a 403 "sin acceso" page, NOT a
// /login redirect. (Same trap already fixed for the suministros '/' route.)

function setup() {
  const db: D1Mock = makeDb(RBAC_MIGRATIONS);
  // Columns getUserFromRequest selects that live outside the canonical RBAC set.
  for (const sql of [
    'ALTER TABLE users ADD COLUMN wallet_address TEXT',
    'ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0',
  ]) db.raw.exec(sql);

  const now = Date.now();
  const ins = db.raw.prepare(`INSERT INTO users (id,email,name,role,status,pw_hash,pw_salt,created_ms) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run('usr_cit', 'cit@s.com', 'Citizen No-Perms', 'citizen', 'active', 'x', 'x', now);
  ins.run('usr_adm', 'adm@s.com', 'Admin', 'admin', 'active', 'x', 'x', now);
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now);
  sess.run('tok_adm', 'usr_adm', now + 86_400_000, now);

  // ASSETS stub that mirrors Cloudflare's html_handling="auto-trailing-slash":
  // a request for '*/index.html' is 307-redirected to its clean directory URL.
  // This is what turned serveAsset('/console/index.html') into an infinite loop,
  // so the stub must reproduce it or the regression can't be caught.
  const env: any = makeEnv(db);
  env.ASSETS = {
    fetch: async (req: Request) => {
      const p = new URL(req.url).pathname;
      if (p.endsWith('/index.html')) {
        return new Response(null, { status: 307, headers: { location: p.replace(/index\.html$/, '') } });
      }
      return new Response(`asset:${p}`, { status: 200 });
    },
  };
  return { env };
}

const cookie = (tok: string) => ({ headers: { Cookie: `sismo_session=${tok}` } });

describe('/console shell gate', () => {
  it('UNAUTHENTICATED → 302 redirect to /login', async () => {
    const { env } = setup();
    const res = await app.request('https://sismo911.com/console/', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=/console/');
  });

  it('AUTHENTICATED but UNAUTHORIZED → 403 sin-acceso, NOT a /login redirect (no loop)', async () => {
    const { env } = setup();
    const res = await app.request('https://sismo911.com/console/', cookie('tok_cit'), env);
    expect(res.status).toBe(403);
    // The whole point: it must NOT bounce back to /login (that was the loop).
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('/sin-acceso');
  });

  it('AUTHORIZED admin → 200 console shell, NOT a 307 index.html→dir redirect (no loop)', async () => {
    const { env } = setup();
    const res = await app.request('https://sismo911.com/console/', cookie('tok_adm'), env);
    // Must serve the index asset directly. If serveConsole fetched
    // '/console/index.html', the auto-trailing-slash Assets layer would 307 it
    // back to '/console/' and loop forever — so assert a real 200, no redirect.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toBe('asset:/console/');
  });
});
