import { describe, it, expect } from 'vitest';
import {
  isCrossmintConfigured, crossmintClientConfig, crossmintChain,
  orderToStatus, verifyWebhook, createDonationOrder,
} from '../src/lib/crossmint';
import { donations } from '../src/routes/donations';

// ---- a tiny in-memory D1 stub: routes by SQL substring ----
function makeDB(opts: { campaign?: any; list?: any[] } = {}) {
  const campaign = 'campaign' in opts ? opts.campaign : { id: 'cmp_1', slug: 'x', title: 'Test', status: 'active' };
  const list = opts.list ?? [{ id: 'cmp_1', slug: 'x', title: 'Test', goal_usd: 100, raised_usd: 0, donors_count: 0 }];
  const result = (sql: string, kind: 'first' | 'all' | 'run') => {
    if (kind === 'run') return { success: true, meta: { changes: 1 } };
    if (/FROM campaigns WHERE slug = \?/.test(sql)) return kind === 'first' ? campaign : { results: [campaign] };
    if (/FROM campaigns WHERE/.test(sql)) return kind === 'all' ? { results: list } : list[0];
    if (/FROM donations WHERE campaign_id/.test(sql)) return kind === 'all' ? { results: [] } : null;
    if (/SUM\(amount_usd\)/.test(sql)) return { raised: 0, donors: 0 };
    return kind === 'all' ? { results: [] } : null;
  };
  const stmt = (sql: string) => ({
    bind: (..._a: any[]) => ({
      first: async () => result(sql, 'first'),
      all: async () => result(sql, 'all'),
      run: async () => result(sql, 'run'),
    }),
    first: async () => result(sql, 'first'),
    all: async () => result(sql, 'all'),
    run: async () => result(sql, 'run'),
  });
  return { prepare: (sql: string) => stmt(sql) } as any;
}
const fakeKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } } as any;
};
const baseEnv = (over: any = {}) => ({ DB: makeDB(over.dbOpts), CACHE: fakeKv(), ...over });
const configuredEnv = (over: any = {}) => baseEnv({
  CROSSMINT_SERVER_KEY: 'sk_staging_test', CROSSMINT_CLIENT_KEY: 'ck_staging_test',
  CROSSMINT_COLLECTION_ID: 'col_1', CROSSMINT_ENV: 'staging', CROSSMINT_CHAIN: 'base', ...over,
});

// ===================================================================
describe('crossmint: config detection', () => {
  it('is unconfigured without server key + collection', () => {
    expect(isCrossmintConfigured({} as any)).toBe(false);
    expect(isCrossmintConfigured({ CROSSMINT_SERVER_KEY: 'sk' } as any)).toBe(false);
  });
  it('is configured with both', () => {
    expect(isCrossmintConfigured({ CROSSMINT_SERVER_KEY: 'sk', CROSSMINT_COLLECTION_ID: 'c' } as any)).toBe(true);
  });
  it('client config never leaks the server key', () => {
    const cfg = crossmintClientConfig({ CROSSMINT_SERVER_KEY: 'sk_secret', CROSSMINT_CLIENT_KEY: 'ck_pub', CROSSMINT_COLLECTION_ID: 'c' } as any);
    expect(cfg.configured).toBe(true);
    expect(cfg.clientKey).toBe('ck_pub');
    expect(JSON.stringify(cfg)).not.toContain('sk_secret');
  });
  it('defaults chain to base', () => {
    expect(crossmintChain({} as any)).toBe('base');
  });
});

describe('crossmint: order status mapping', () => {
  it('payment phase → pending', () => {
    expect(orderToStatus({ phase: 'payment' }).status).toBe('pending');
  });
  it('completed phase → paid (+ tx/wallet)', () => {
    const m = orderToStatus({ phase: 'completed', lineItems: [{ delivery: { txId: '0xabc', recipient: { walletAddress: '0xwal' } } }] });
    expect(m.status).toBe('paid'); expect(m.txId).toBe('0xabc'); expect(m.wallet).toBe('0xwal');
  });
  it('failed payment → failed', () => {
    expect(orderToStatus({ phase: 'payment', payment: { status: 'failed' } }).status).toBe('failed');
  });
});

describe('crossmint: webhook signature (Svix HMAC-SHA256)', () => {
  it('accepts a correct signature and rejects a wrong one', async () => {
    const id = 'msg_1', ts = '1700000000', body = '{"hello":"world"}';
    const keyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const secret = 'whsec_' + btoa(String.fromCharCode(...keyBytes));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)))));
    const ok = await verifyWebhook(secret, { id, timestamp: ts, signature: `v1,${sig}` }, body);
    expect(ok).toBe(true);
    const bad = await verifyWebhook(secret, { id, timestamp: ts, signature: 'v1,AAAA' }, body);
    expect(bad).toBe(false);
    const missing = await verifyWebhook(secret, { id: null, timestamp: ts, signature: `v1,${sig}` }, body);
    expect(missing).toBe(false);
  });
});

describe('crossmint: createDonationOrder gating', () => {
  it('refuses when not configured (no network)', async () => {
    const r = await createDonationOrder({} as any, { amountUsd: 10, email: 'a@b.com', campaignSlug: 'x', campaignTitle: 'X', donationId: 'don_1' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toBe('not_configured'); expect(r.status).toBe(503); }
  });
});

// ===================================================================
describe('donations route: anonymous donate', () => {
  const post = (env: any, body: any) => donations.request('/campaigns/x/donate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, env);

  it('503 payments_not_configured when Crossmint absent', async () => {
    const res = await post(baseEnv(), { amount: 25, email: 'a@b.com' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('payments_not_configured');
  });
  it('400 on invalid amount', async () => {
    const res = await post(configuredEnv(), { amount: 0, email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('amount_invalid');
  });
  it('400 on invalid email', async () => {
    const res = await post(configuredEnv(), { amount: 25, email: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('email_invalid');
  });
  it('404 when campaign missing', async () => {
    const res = await post(baseEnv({ dbOpts: { campaign: null } }), { amount: 25, email: 'a@b.com' });
    expect(res.status).toBe(404);
  });
  it('409 when campaign not active', async () => {
    const res = await post(baseEnv({ dbOpts: { campaign: { id: 'c', slug: 'x', title: 'T', status: 'closed' } } }), { amount: 25, email: 'a@b.com' });
    expect(res.status).toBe(409);
  });
});

describe('donations route: reads + auth', () => {
  it('GET /campaigns lists campaigns', async () => {
    const res = await donations.request('/campaigns', {}, baseEnv());
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(Array.isArray(d.campaigns)).toBe(true);
    expect(d.campaigns.length).toBeGreaterThan(0);
  });
  it('GET /donations/config exposes only browser-safe fields', async () => {
    const res = await donations.request('/donations/config', {}, configuredEnv());
    const d = await res.json();
    expect(d.configured).toBe(true);
    expect(d.clientKey).toBe('ck_staging_test');
    expect(JSON.stringify(d)).not.toContain('sk_staging_test');
  });
  it('POST /campaigns requires login', async () => {
    const res = await donations.request('/campaigns', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Nueva campaña', goal_usd: 100 }),
    }, baseEnv());
    expect(res.status).toBe(401);
  });
});
