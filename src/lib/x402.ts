import type { Env } from '../types';

// x402 payment-receiving helpers (https://github.com/xpaysh/awesome-x402).
//
// We implement the x402 v2 wire protocol directly (no on-chain SDK in the
// Worker bundle) because verify + settle are plain HTTP POSTs to a facilitator,
// and we need a PER-USER `payTo` — the static `@x402/hono` middleware only
// supports one address per route. Flow:
//   1. payer GETs a gated resource with no payment   → 402 + PAYMENT-REQUIRED
//   2. payer signs an EIP-3009 authorization, retries → PAYMENT-SIGNATURE header
//   3. server POSTs facilitator /verify, then /settle → on-chain USDC transfer
//   4. server returns 200 + PAYMENT-RESPONSE (settlement receipt)
//
// The receiving address is the user's existing Crossmint custodial wallet on
// Base — we never mint a second wallet or touch private keys.

export const X402_VERSION = 2;

// Per-network USDC contract + EIP-712 domain (for the `extra` block the client
// needs to sign `transferWithAuthorization`).
const USDC: Record<string, { asset: string; name: string; version: string }> = {
  'eip155:8453':  { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' }, // Base mainnet
  'eip155:84532': { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC',     version: '2' }, // Base Sepolia
};

// Map the Crossmint chain label to a CAIP-2 network id.
const CHAIN_TO_CAIP2: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'base-mainnet': 'eip155:8453',
};

export interface PaymentRequirements {
  scheme: string;            // 'exact'
  network: string;           // CAIP-2
  amount: string;            // atomic units (USDC = 6 dp)
  asset: string;             // token contract
  payTo: string;             // receiving address
  maxTimeoutSeconds: number; // authorization validity window
  extra?: Record<string, unknown>;
}

export interface VerifyResult { isValid: boolean; payer?: string; invalidReason?: string }
export interface SettleResult { success: boolean; transactionHash?: string; status?: string; errorReason?: string }

/** The configured CAIP-2 network (X402_NETWORK overrides; else from CROSSMINT_CHAIN). */
export function x402Network(env: Env): string {
  if (env.X402_NETWORK) return env.X402_NETWORK.trim();
  const chain = (env.CROSSMINT_CHAIN || 'base').trim().toLowerCase();
  return CHAIN_TO_CAIP2[chain] || 'eip155:8453';
}

/** The token contract to charge in (X402_ASSET overrides; else USDC for the network). */
export function x402Asset(env: Env, network = x402Network(env)): string {
  return (env.X402_ASSET || USDC[network]?.asset || '').trim();
}

/** EIP-712 token metadata the payer needs to sign the transfer authorization. */
export function x402TokenExtra(network: string): Record<string, unknown> | undefined {
  const t = USDC[network];
  return t ? { name: t.name, version: t.version } : undefined;
}

/** True only when live verify/settle is wired (a facilitator is reachable). */
export function isX402Configured(env: Env): boolean {
  return Boolean(env.X402_FACILITATOR_URL && x402Asset(env));
}

/** USD (e.g. 1.5) → atomic USDC string ("1500000"); USDC has 6 decimals. */
export function usdToAtomic(usd: number): string {
  return String(Math.round(usd * 1_000_000));
}

/** Build the PaymentRequirements for a given receiving wallet + price. */
export function buildRequirements(
  env: Env,
  opts: { payTo: string; amount: string; network?: string; asset?: string; maxTimeoutSeconds?: number },
): PaymentRequirements {
  const network = (opts.network || x402Network(env)).trim();
  return {
    scheme: 'exact',
    network,
    amount: opts.amount,
    asset: (opts.asset || x402Asset(env, network)).trim(),
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 300,
    extra: x402TokenExtra(network),
  };
}

// ── base64 <-> JSON for the protocol headers (UTF-8 safe) ───────────────────
function b64encodeJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decodeJson<T = any>(s: string): T | null {
  try {
    const bin = atob(s.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch { return null; }
}

/** base64-encode any JSON object for a protocol header (e.g. PAYMENT-RESPONSE). */
export function encodeJsonB64(obj: unknown): string {
  return b64encodeJson(obj);
}

/** The JSON body / header value advertised in a 402 response. */
export function paymentRequiredBody(opts: {
  requirements: PaymentRequirements[];
  resourceUrl: string;
  description?: string;
  mimeType?: string;
  error?: string;
}) {
  return {
    x402Version: X402_VERSION,
    error: opts.error || 'PAYMENT-SIGNATURE header is required',
    resource: { url: opts.resourceUrl, description: opts.description, mimeType: opts.mimeType || 'application/json' },
    accepts: opts.requirements,
  };
}

/** base64 of the 402 body, for the `PAYMENT-REQUIRED` response header. */
export function encodePaymentRequired(body: ReturnType<typeof paymentRequiredBody>): string {
  return b64encodeJson(body);
}

/** Read + decode the payer's signed payload from PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). */
export function readPaymentPayload(headerGet: (name: string) => string | undefined | null): any | null {
  const raw = headerGet('payment-signature') || headerGet('x-payment');
  return raw ? b64decodeJson(raw) : null;
}

async function facilitatorPost<T>(env: Env, path: string, body: unknown): Promise<T | null> {
  if (!env.X402_FACILITATOR_URL) return null;
  const base = env.X402_FACILITATOR_URL.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.X402_FACILITATOR_API_KEY) headers['Authorization'] = `Bearer ${env.X402_FACILITATOR_API_KEY}`;
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) return { ...(data || {}), _httpError: `HTTP ${res.status}` } as T;
    return data as T;
  } catch (e: any) {
    console.error('[x402] facilitator request failed:', e?.message ?? e);
    return null;
  }
}

/** Ask the facilitator whether the signed authorization is valid (no chain write). */
export async function verifyPayment(env: Env, payload: unknown, requirements: PaymentRequirements): Promise<VerifyResult> {
  const data = await facilitatorPost<any>(env, '/verify', { paymentPayload: payload, paymentRequirements: requirements });
  if (!data) return { isValid: false, invalidReason: 'facilitator_unreachable' };
  return { isValid: Boolean(data.isValid), payer: data.payer, invalidReason: data.invalidReason || data._httpError };
}

/** Ask the facilitator to settle the transfer on-chain. Returns the tx hash. */
export async function settlePayment(env: Env, payload: unknown, requirements: PaymentRequirements): Promise<SettleResult> {
  const data = await facilitatorPost<any>(env, '/settle', { paymentPayload: payload, paymentRequirements: requirements });
  if (!data) return { success: false, errorReason: 'facilitator_unreachable' };
  const tx = data.transactionHash || data.transaction || data.txHash;
  const success = data.success === true || data.status === 'settled' || Boolean(tx);
  return { success, transactionHash: tx, status: data.status, errorReason: success ? undefined : (data.errorReason || data.invalidReason || data._httpError) };
}
