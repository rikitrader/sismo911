import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  isStripeConfigured, isStripeLive, encodeForm, verifyStripeWebhook,
} from '../src/lib/stripe';
import { computeBalance } from '../src/lib/withdrawals';
import { makeDb } from './helpers/d1';

// Web Crypto is available as `crypto` in Workers; Node exposes it as
// `node:crypto`.webcrypto. The lib uses the global `crypto`, so ensure it exists.
if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto as any;

const env = (over: Record<string, any> = {}) => ({ ...over }) as any;

describe('stripe gate', () => {
  it('isStripeConfigured needs a secret key', () => {
    expect(isStripeConfigured(env())).toBe(false);
    expect(isStripeConfigured(env({ STRIPE_SECRET_KEY: '  ' }))).toBe(false);
    expect(isStripeConfigured(env({ STRIPE_SECRET_KEY: 'sk_test_123' }))).toBe(true);
  });

  it('isStripeLive needs BOTH a key AND the flag on (two-key master gate)', () => {
    expect(isStripeLive(env({ STRIPE_SECRET_KEY: 'sk_test_123' }))).toBe(false);          // flag off
    expect(isStripeLive(env({ STRIPE_PAYMENTS_ENABLED: 'true' }))).toBe(false);             // no key
    expect(isStripeLive(env({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_PAYMENTS_ENABLED: 'true' }))).toBe(true);
    expect(isStripeLive(env({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_PAYMENTS_ENABLED: 'false' }))).toBe(false);
  });
});

describe('encodeForm (Stripe bracket notation)', () => {
  it('flattens nested objects + arrays the way Stripe expects', () => {
    const s = encodeForm({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 500 } }],
    });
    const p = new URLSearchParams(s);
    expect(p.get('mode')).toBe('payment');
    expect(p.get('line_items[0][quantity]')).toBe('1');
    expect(p.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('500');
  });
  it('skips null/undefined', () => {
    const p = new URLSearchParams(encodeForm({ a: 'x', b: null, c: undefined }));
    expect(p.get('a')).toBe('x');
    expect(p.has('b')).toBe(false);
    expect(p.has('c')).toBe(false);
  });
});

// Build a valid Stripe-Signature header for a payload (mirrors Stripe's scheme).
async function sign(secret: string, payload: string, t: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await (globalThis as any).crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await (globalThis as any).crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

describe('verifyStripeWebhook', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const nowMs = 1_700_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);

  it('accepts a valid signature within tolerance and returns the parsed event', async () => {
    const header = await sign(secret, payload, nowSec);
    const ev = await verifyStripeWebhook(secret, payload, header, { nowMs });
    expect(ev).not.toBeNull();
    expect(ev.type).toBe('checkout.session.completed');
  });

  it('rejects a tampered payload', async () => {
    const header = await sign(secret, payload, nowSec);
    const ev = await verifyStripeWebhook(secret, payload + ' ', header, { nowMs });
    expect(ev).toBeNull();
  });

  it('rejects the wrong secret', async () => {
    const header = await sign('whsec_other', payload, nowSec);
    const ev = await verifyStripeWebhook(secret, payload, header, { nowMs });
    expect(ev).toBeNull();
  });

  it('rejects a timestamp outside the tolerance window (replay)', async () => {
    const header = await sign(secret, payload, nowSec - 10_000);
    const ev = await verifyStripeWebhook(secret, payload, header, { nowMs, toleranceSec: 300 });
    expect(ev).toBeNull();
  });

  it('rejects a missing header or missing secret', async () => {
    expect(await verifyStripeWebhook(secret, payload, null, { nowMs })).toBeNull();
    expect(await verifyStripeWebhook('', payload, await sign(secret, payload, nowSec), { nowMs })).toBeNull();
  });
});

describe('computeBalance merges paid Stripe receipts', () => {
  it('adds paid stripe_payments to settled x402 (both USD) minus held withdrawals', async () => {
    // Minimal schema for exactly the three columns/tables computeBalance reads —
    // avoids cross-migration column deps (e.g. users.wallet_address).
    const db = makeDb([]);
    db.raw.exec(`
      CREATE TABLE x402_payments (id TEXT, payee_user_id TEXT, amount_usd REAL, status TEXT);
      CREATE TABLE stripe_payments (id TEXT, payee_user_id TEXT, amount_usd REAL, status TEXT);
      CREATE TABLE withdrawal_requests (id TEXT, user_id TEXT, net_amount REAL, status TEXT);
    `);
    const raw = db.raw;

    // $40 settled x402 + $60 paid Stripe = $100 gross; a $30 pending withdrawal holds.
    raw.prepare(`INSERT INTO x402_payments VALUES ('x1','u1',40,'settled')`).run();
    raw.prepare(`INSERT INTO stripe_payments VALUES ('s1','u1',60,'paid')`).run();
    // A 'pending' stripe row must NOT count.
    raw.prepare(`INSERT INTO stripe_payments VALUES ('s2','u1',999,'pending')`).run();
    raw.prepare(`INSERT INTO withdrawal_requests VALUES ('w1','u1',30,'pending_review')`).run();

    const bal = await computeBalance({ DB: db } as any, 'u1');
    expect(bal.gross_received_usd).toBe(100);
    expect(bal.committed_usd).toBe(30);
    expect(bal.available_usd).toBe(70);
  });
});
