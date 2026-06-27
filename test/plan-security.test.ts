import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plan } from '../src/routes/plan';

const env = (extra: Record<string, unknown> = {}) => ({
  PLAN_INVITE_CODES: 'ALPHA-ONE',
  CACHE: {
    get: async () => null,
    put: async () => undefined,
  },
  ...extra,
}) as any;

describe('/plan invite gate security', () => {
  it('does not ship production invite codes in wrangler config', () => {
    const wrangler = readFileSync('wrangler.toml', 'utf8');
    expect(wrangler).not.toMatch(/PLAN_INVITE_CODES\s*=/);
    expect(wrangler).not.toContain('SISMO911-INVEST');
    expect(wrangler).not.toContain('RELIEF-2026');
    expect(wrangler).not.toContain('TERREMOTO-VIP');
  });

  it('fails closed instead of minting access cookies with a fallback secret', async () => {
    const res = await plan.request('/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'ALPHA-ONE' }).toString(),
    }, env());

    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('PLAN_SECRET no está definido');
  });

  it('rejects old public invite codes when no secret or KV invite matches', async () => {
    const res = await plan.request('/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'SISMO911-INVEST' }).toString(),
    }, env({ PLAN_SECRET: 'test-secret-that-is-not-in-wrangler', PLAN_INVITE_CODES: '' }));

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Código no válido');
  });

  it('accepts KV invite records without master invite codes', async () => {
    const kvEnv = env({
      PLAN_SECRET: 'test-secret-that-is-not-in-wrangler',
      PLAN_INVITE_CODES: '',
      CACHE: {
        get: async (key: string) => (key === 'plan:invite:KV-ONE' ? '{}' : null),
        put: async () => undefined,
      },
    });

    const unlock = await plan.request('/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'KV-ONE' }).toString(),
    }, kvEnv);

    expect(unlock.status).toBe(302);
    expect(unlock.headers.get('set-cookie')).toContain('plan_access=');
  });

  it('mints and validates an invite cookie only when PLAN_SECRET is configured', async () => {
    const secureEnv = env({ PLAN_SECRET: 'test-secret-that-is-not-in-wrangler' });
    const unlock = await plan.request('/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'ALPHA-ONE' }).toString(),
    }, secureEnv);

    expect(unlock.status).toBe(302);
    const cookie = unlock.headers.get('set-cookie') || '';
    expect(cookie).toContain('plan_access=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');

    const page = await plan.request('/', { headers: { cookie } }, secureEnv);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('SISMO911');
  });
});
