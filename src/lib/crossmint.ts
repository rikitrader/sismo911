import type { Env } from '../types';

// Crossmint integration for SISMO911 donations.
//
// Payment model: Headless Checkout. The server creates an Order (card → USDC,
// settling to the merchant wallet on Base); the browser mounts Crossmint's
// Embedded Checkout in "existing order mode" with the returned orderId +
// clientSecret. Donors need NO account — passing recipient.email makes Crossmint
// auto-create a custodial wallet and deliver an NFT receipt to it.
//
// Signed-up users get their own custodial (encrypted) wallet via the Wallets API.
// We never see or store private keys — Crossmint holds + encrypts them; we keep
// only the public address + owner locator.

const DONATION_SYMBOL = 'S911';

/** True only when the donation payment rail is fully wired. */
export function isCrossmintConfigured(env: Env): boolean {
  return Boolean(env.CROSSMINT_SERVER_KEY && env.CROSSMINT_COLLECTION_ID);
}

export function crossmintChain(env: Env): string {
  return (env.CROSSMINT_CHAIN || 'base').trim();
}

function crossmintBase(env: Env): string {
  const e = (env.CROSSMINT_ENV || 'production').trim().toLowerCase();
  return e === 'staging' ? 'https://staging.crossmint.com' : 'https://www.crossmint.com';
}

/** Public, browser-safe config for the donate page (no secrets). */
export function crossmintClientConfig(env: Env) {
  return {
    configured: isCrossmintConfigured(env),
    clientKey: env.CROSSMINT_CLIENT_KEY || '',
    env: (env.CROSSMINT_ENV || 'production').trim().toLowerCase(),
    chain: crossmintChain(env),
  };
}

async function api<T = any>(
  env: Env,
  path: string,
  init: { method: string; body?: unknown }
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const res = await fetch(`${crossmintBase(env)}${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': env.CROSSMINT_SERVER_KEY || '',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const error = (data && (data.message || data.error)) || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, status: res.status, data, error };
  }
  return { ok: true, status: res.status, data };
}

// ---- Wallets (per signed-up user; custodial, encrypted by Crossmint) ----

export interface WalletResult { address: string; locator: string; chain: string; }

/**
 * Create (or fetch) a custodial EVM smart wallet owned by an email. The
 * adminSigner is `api-key`, so the wallet is fully controlled server-side via
 * our Crossmint key — keys are held + encrypted by Crossmint, never by us.
 */
export async function createWalletForEmail(env: Env, email: string): Promise<WalletResult | null> {
  if (!env.CROSSMINT_SERVER_KEY) return null;
  const owner = `email:${email.trim().toLowerCase()}`;
  const r = await api(env, '/api/2025-06-09/wallets', {
    method: 'POST',
    body: {
      chainType: 'evm',
      type: 'smart',
      config: { adminSigner: { type: 'api-key' } },
      owner,
    },
  });
  if (!r.ok || !r.data?.address) {
    console.error('[crossmint] wallet create failed:', r.status, r.error);
    return null;
  }
  return { address: r.data.address, locator: r.data.owner || owner, chain: crossmintChain(env) };
}

// ---- Orders (one per donation; card → USDC to the merchant wallet) ----

export interface OrderResult { orderId: string; clientSecret: string; }

/**
 * Create a Headless Checkout order for a donation. `amountUsd` is the donor's
 * chosen amount — Crossmint charges card and settles USDC to the Collection's
 * configured recipient wallet on Base. The receipt email auto-creates a
 * custodial wallet for the (account-less) donor.
 */
export async function createDonationOrder(
  env: Env,
  opts: { amountUsd: number; email: string; campaignSlug: string; campaignTitle: string; donationId: string }
): Promise<{ ok: true; order: OrderResult } | { ok: false; error: string; status: number }> {
  if (!isCrossmintConfigured(env)) return { ok: false, error: 'not_configured', status: 503 };
  const email = opts.email.trim().toLowerCase();
  const total = opts.amountUsd.toFixed(2);
  const r = await api(env, '/api/2022-06-09/orders', {
    method: 'POST',
    body: {
      payment: { method: 'card', receiptEmail: email },
      recipient: { email },
      lineItems: [{
        collectionLocator: `crossmint:${env.CROSSMINT_COLLECTION_ID}`,
        callData: { totalPrice: total, quantity: 1 },
      }],
      locale: 'es-ES',
      metadata: {
        source: 'sismo911',
        campaign_slug: opts.campaignSlug,
        campaign_title: opts.campaignTitle,
        donation_id: opts.donationId,
      },
    },
  });
  if (!r.ok) return { ok: false, error: r.error || 'order_failed', status: r.status };
  // The Orders API returns either {order:{orderId,clientSecret}} or a flat shape.
  const o = r.data?.order ?? r.data ?? {};
  const orderId = o.orderId || o.id;
  const clientSecret = o.clientSecret;
  if (!orderId || !clientSecret) return { ok: false, error: 'order_missing_fields', status: 502 };
  return { ok: true, order: { orderId, clientSecret } };
}

/** Fetch an order — used to reconcile donation status if a webhook is missed. */
export async function getOrder(env: Env, orderId: string): Promise<any | null> {
  if (!env.CROSSMINT_SERVER_KEY) return null;
  const r = await api(env, `/api/2022-06-09/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
  return r.ok ? r.data : null;
}

/**
 * Map a Crossmint order/payment phase to our donation status.
 * phase: payment → pending; delivery/completed with paid payment → paid.
 */
export function orderToStatus(order: any): { status: 'pending' | 'paid' | 'failed'; txId?: string; wallet?: string } {
  const phase = order?.phase;
  const payStatus = order?.payment?.status;
  const line = Array.isArray(order?.lineItems) ? order.lineItems[0] : undefined;
  const txId = line?.delivery?.txId || undefined;
  const wallet = line?.delivery?.recipient?.walletAddress || line?.delivery?.recipient?.locator || undefined;
  if (payStatus === 'failed' || phase === 'failed') return { status: 'failed', txId, wallet };
  if (phase === 'completed' || phase === 'delivery' || payStatus === 'completed' || payStatus === 'paid') {
    return { status: 'paid', txId, wallet };
  }
  return { status: 'pending', txId, wallet };
}

// ---- Webhook signature verification (Svix scheme, HMAC-SHA256) ----

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/**
 * Verify a Crossmint (Svix) webhook signature. Signed content is
 * `${svix-id}.${svix-timestamp}.${rawBody}`; the key is the base64 part after
 * the `whsec_` prefix. `svix-signature` is a space-delimited list of
 * `v1,<base64sig>` (multiple allowed for key rotation) — any match passes.
 */
export async function verifyWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string
): Promise<boolean> {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const keyB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes: Uint8Array;
  try { keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0)); }
  catch { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const mac = b64(await crypto.subtle.sign('HMAC', key, enc.encode(signed)));
  const provided = headers.signature.split(' ').map((p) => p.split(',')[1]).filter(Boolean);
  // constant-time-ish compare against each provided signature
  for (const sig of provided) {
    if (sig.length === mac.length) {
      let diff = 0;
      for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ mac.charCodeAt(i);
      if (diff === 0) return true;
    }
  }
  return false;
}

export { DONATION_SYMBOL };
