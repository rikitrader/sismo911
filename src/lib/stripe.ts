import type { Env } from '../types';

// Stripe Checkout (receiving) + Stripe Connect (payouts) helpers.
//
// We call the Stripe REST API directly over fetch (no `stripe` npm SDK in the
// Worker bundle — it pulls Node crypto/http) and verify webhooks with Web
// Crypto HMAC-SHA256, exactly mirroring how x402 (src/lib/x402.ts) and the
// Crossmint/Svix webhook (src/routes/donations.ts) already work here.
//
// Everything is GATED: nothing advertises or accepts a Stripe payment unless a
// secret key is configured AND the STRIPE_PAYMENTS_ENABLED flag is on — the same
// two-key master gate as isX402Live. A partial config never goes live.
//
// NOTE (honesty / availability): Stripe does not onboard businesses based in
// Venezuela, so on a VE entity this stays inert by design. The code is correct
// and ready the moment a supported-country account + keys exist.

const STRIPE_API = 'https://api.stripe.com/v1';

function parseBool(v: unknown): boolean {
  return v === true || /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

/** A Stripe secret key is present (sk_live_… / sk_test_…). */
export function isStripeConfigured(env: Env): boolean {
  return Boolean((env.STRIPE_SECRET_KEY || '').trim());
}

/** Master gate: live only when a key is configured AND the feature flag is on. */
export function isStripeLive(env: Env): boolean {
  return isStripeConfigured(env) && parseBool(env.STRIPE_PAYMENTS_ENABLED);
}

export class StripeError extends Error {
  status: number;
  type?: string;
  constructor(message: string, status: number, type?: string) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
  }
}

// Stripe expects bracket-notation form encoding (e.g.
// line_items[0][price_data][unit_amount]=500). Flatten nested objects/arrays.
function appendForm(params: URLSearchParams, key: string, val: unknown): void {
  if (val === undefined || val === null) return;
  if (Array.isArray(val)) {
    val.forEach((v, i) => appendForm(params, `${key}[${i}]`, v));
  } else if (typeof val === 'object') {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      appendForm(params, `${key}[${k}]`, v);
    }
  } else {
    params.append(key, String(val));
  }
}

export function encodeForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) appendForm(params, k, v);
  return params.toString();
}

/** Authenticated Stripe REST call. Throws StripeError on a non-2xx response. */
export async function stripeApi(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<any> {
  const key = (env.STRIPE_SECRET_KEY || '').trim();
  if (!key) throw new StripeError('stripe_not_configured', 500);
  const headers: Record<string, string> = {
    'authorization': `Bearer ${key}`,
    'content-type': 'application/x-www-form-urlencoded',
    'stripe-version': '2024-06-20',
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const init: RequestInit = { method, headers };
  if (method === 'POST' && body) init.body = encodeForm(body);
  const res = await fetch(`${STRIPE_API}${path}`, init);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error || {};
    throw new StripeError(err.message || `stripe_http_${res.status}`, res.status, err.type);
  }
  return json;
}

// ── Checkout (receiving) ──────────────────────────────────────────────────────

export interface CheckoutArgs {
  amountUsd: number;          // human dollars; converted to cents here
  productName: string;
  description?: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId?: string; // our stripe_payments.id, for the webhook to find
  customerEmail?: string;
  metadata?: Record<string, string>;
}

/** Create a hosted Checkout Session (mode=payment). Returns { id, url }. */
export async function createCheckoutSession(env: Env, a: CheckoutArgs): Promise<{ id: string; url: string }> {
  const cents = Math.round(a.amountUsd * 100);
  if (!(cents >= 50)) throw new StripeError('amount_too_small', 400); // Stripe min ≈ $0.50
  const s = await stripeApi(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: a.successUrl,
    cancel_url: a.cancelUrl,
    client_reference_id: a.clientReferenceId,
    customer_email: a.customerEmail,
    metadata: a.metadata,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: { name: a.productName.slice(0, 250), description: (a.description || '').slice(0, 500) || undefined },
        },
      },
    ],
  });
  return { id: s.id, url: s.url };
}

export async function retrieveCheckoutSession(env: Env, id: string): Promise<any> {
  return stripeApi(env, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);
}

// ── Connect (payout destinations) ─────────────────────────────────────────────

/** Create an Express connected account for a user. */
export async function createConnectAccount(env: Env, opts: { email?: string; country?: string }): Promise<any> {
  return stripeApi(env, 'POST', '/accounts', {
    type: 'express',
    email: opts.email,
    country: opts.country || undefined,
    capabilities: { transfers: { requested: true } },
  });
}

/** Create an onboarding/refresh AccountLink the user clicks to complete KYC. */
export async function createAccountLink(env: Env, opts: { account: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }> {
  const l = await stripeApi(env, 'POST', '/account_links', {
    account: opts.account,
    refresh_url: opts.refreshUrl,
    return_url: opts.returnUrl,
    type: 'account_onboarding',
  });
  return { url: l.url };
}

export async function retrieveAccount(env: Env, id: string): Promise<any> {
  return stripeApi(env, 'GET', `/accounts/${encodeURIComponent(id)}`);
}

// ── Webhook signature verification (Web Crypto HMAC-SHA256) ────────────────────

/** Constant-time string compare (avoids leaking via early-exit timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Stripe `Stripe-Signature` header against the raw body, per
 * https://stripe.com/docs/webhooks/signatures. Header looks like
 * `t=1700000000,v1=hexsig[,v1=hexsig2]`. We HMAC-SHA256 `${t}.${payload}` with
 * the endpoint secret and constant-time compare to any provided v1, enforcing a
 * replay tolerance window. Returns the parsed event on success, else null.
 */
export async function verifyStripeWebhook(
  secret: string,
  payload: string,
  sigHeader: string | null | undefined,
  opts: { toleranceSec?: number; nowMs?: number } = {},
): Promise<any | null> {
  if (!secret || !sigHeader) return null;
  const tolerance = opts.toleranceSec ?? 300;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);

  let t = '';
  const sigs: string[] = [];
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = (v || '').trim();
    else if (k === 'v1') sigs.push((v || '').trim());
  }
  if (!t || !sigs.length) return null;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > tolerance) return null;

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${t}.${payload}`));
  const expected = toHex(mac);
  if (!sigs.some((s) => timingSafeEqual(s, expected))) return null;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
