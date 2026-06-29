import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock, RBAC_MIGRATIONS } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { adminRbac } from '../src/routes/admin-rbac';
import { app as worker } from '../src/index';

// --- POST /api/csp-report — persistence + dedup (the REAL index.ts handler) ---
describe('POST /api/csp-report persistence', () => {
  const report = {
    'csp-report': {
      'document-uri': 'https://sismo911.com/familia',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'inline',
      'source-file': 'https://sismo911.com/familia',
      'line-number': 42,
      'column-number': 7,
    },
  };
  const mkReq = () =>
    new Request('https://sismo911.com/api/csp-report', {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report', 'user-agent': 'UA/test' },
      body: JSON.stringify(report),
    });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

  it('persists a violation, then DEDUPS by signature and bumps count', async () => {
    const db = makeDb(['migrations/0066_csp_reports.sql']);
    const env = makeEnv(db);
    let r = await worker.fetch(mkReq(), env as any, ctx);
    expect(r.status).toBe(204);
    r = await worker.fetch(mkReq(), env as any, ctx);
    expect(r.status).toBe(204);

    const rows = db.raw.prepare('SELECT * FROM csp_reports').all() as any[];
    expect(rows.length).toBe(1); // deduped → one row, not two
    expect(rows[0].count).toBe(2); // hit count bumped
    expect(rows[0].violated_directive).toBe('script-src-elem');
    expect(rows[0].blocked_uri).toBe('inline');
    expect(rows[0].source_file).toBe('https://sismo911.com/familia');
    expect(rows[0].line_no).toBe(42);
    expect(rows[0].col_no).toBe(7);
    expect(rows[0].user_agent).toBe('UA/test');
  });

  it('never throws / always 204 even when csp_reports table is absent', async () => {
    const db = makeDb([]); // no csp_reports table
    const env = makeEnv(db);
    const r = await worker.fetch(mkReq(), env as any, ctx);
    expect(r.status).toBe(204); // reporting must never break the page
  });
});

// --- GET /api/rbac/csp-violations — gated review endpoint ---
async function setup() {
  const db: D1Mock = makeDb([...RBAC_MIGRATIONS, 'migrations/0066_csp_reports.sql']);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/rbac', adminRbac);
  const now = Date.now();
  const a = await hashPassword('adminpw');
  const ct = await hashPassword('citpw');
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', a.hash, a.salt, 'active', now);
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', ct.hash, ct.salt, 'active', now);
  const sess = db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`);
  sess.run('tok_admin', 'usr_admin', now + 86_400_000, now);
  sess.run('tok_cit', 'usr_cit', now + 86_400_000, now);
  db.raw.prepare(
    `INSERT INTO csp_reports (sig,document_uri,violated_directive,blocked_uri,source_file,line_no,col_no,count,first_seen,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('sig1', 'https://sismo911.com/blog', 'script-src-elem', 'inline', 'https://sismo911.com/blog', 9, 1, 5, now, now);
  return { db, env, app };
}

describe('GET /api/rbac/csp-violations — gating + data', () => {
  it('unauthenticated → 401', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/csp-violations', {}, env);
    expect(r.status).toBe(401);
  });

  it('citizen without security:read → 403', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/csp-violations', { headers: { Authorization: 'Bearer tok_cit' } }, env);
    expect(r.status).toBe(403);
  });

  it('admin → 200 with violations + totals', async () => {
    const { app, env } = await setup();
    const r = await app.request('/api/rbac/csp-violations', { headers: { Authorization: 'Bearer tok_admin' } }, env);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.totals.distinct_violations).toBe(1);
    expect(j.totals.total_hits).toBe(5);
    expect(j.violations[0].violated_directive).toBe('script-src-elem');
    expect(j.violations[0].count).toBe(5);
  });
});
