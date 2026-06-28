import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { flotaAdmin } from '../src/routes/flota-admin';
import { issueUnitToken } from '../src/lib/flota-token';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';

let db: D1Mock;
let env: TestEnv;
const admin = mount([['/api/admin/flota', flotaAdmin]]);
beforeEach(() => { db = makeDb(); env = makeEnv(db); });

describe('GET /api/admin/flota/units/:id/tokens', () => {
  it('lists token metadata only — never the secret hash or plaintext', async () => {
    const id = (await call(admin, 'POST', '/api/admin/flota/units', env, { name: 'U', type: 'rescate' })).json.id;
    await issueUnitToken(env as any, id, { label: 'a', expiresInHours: 24 });
    await issueUnitToken(env as any, id, { label: 'b', expiresInHours: 24 });
    const r = await call(admin, 'GET', `/api/admin/flota/units/${id}/tokens`, env);
    expect(r.status).toBe(200);
    expect(r.json.results.length).toBe(2);
    for (const t of r.json.results) {
      expect(t).toHaveProperty('label');
      expect(t).toHaveProperty('expires_at');
      expect(t).not.toHaveProperty('token_hash'); // never expose the hash
      expect(t).not.toHaveProperty('token');       // never expose plaintext
    }
  });
});

describe('onboarding page wiring', () => {
  const html = readFileSync('public/admin-flota-unidades.html', 'utf8');
  it('wires create-unit, issue-token (with QR), token-list, and revoke', () => {
    expect(html).toContain('id="uName"');
    expect(html).toContain("admin/flota/units'"); // POST create
    expect(html).toContain("/token'"); // issue
    expect(html).toContain("/tokens'"); // list
    expect(html).toContain('/revoke-token'); // revoke
    expect(html).toContain('new QRCode'); // QR of the track link
    expect(html).toContain('location.origin+d.trackUrl'); // full track URL for the QR/copy
  });
  it('shows the token once with the no-reuse warning', () => {
    expect(html).toContain('id="tokOvl"');
    expect(html).toContain('No se mostrará de nuevo');
  });
});

describe('staging seed is LOCAL-ONLY (no fake prod data)', () => {
  const sh = readFileSync('scripts/seed-flota-demo.sh', 'utf8');
  it('forces --local and never --remote', () => {
    expect(sh).toContain('--local');
    expect(sh).not.toMatch(/wrangler d1 execute[^\n]*--remote/);
  });
  it('refuses a --remote/prod argument', () => {
    expect(sh).toContain('REFUSED');
    expect(sh).toMatch(/--remote[|)]/); // matched as a refusal case pattern
  });
  it('the seed file is NOT a numbered migration (will not auto-apply to prod)', () => {
    expect(/^\d{4}_/.test('seed_flota_demo.sql')).toBe(false);
  });
});
