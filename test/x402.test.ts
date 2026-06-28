import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  X402_VERSION,
  usdToAtomic,
  x402Network,
  x402Asset,
  buildRequirements,
  paymentRequiredBody,
  encodePaymentRequired,
  readPaymentPayload,
  isX402Configured,
  isX402Live,
  chainIdFromNetwork,
  extractAuthorization,
  validateAuthorization,
  authorizationHash,
  verifyPayment,
  settlePayment,
} from '../src/lib/x402';

// Base mainnet + Base Sepolia USDC contracts (CAIP-2 networks).
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const env = (over: any = {}) => ({ ...over }) as any;

// Decode a base64-JSON header value back to an object (ASCII payloads).
const decode = (s: string) => JSON.parse(atob(s));
const encode = (obj: unknown) => btoa(JSON.stringify(obj));

describe('x402: usdToAtomic (USDC has 6 decimals)', () => {
  it('1.5 → "1500000"', () => expect(usdToAtomic(1.5)).toBe('1500000'));
  it('0.001 → "1000"', () => expect(usdToAtomic(0.001)).toBe('1000'));
  it('1 → "1000000"', () => expect(usdToAtomic(1)).toBe('1000000'));
  it('rounds sub-atomic fractions to the nearest integer string', () => {
    expect(usdToAtomic(0.0000005)).toBe('1'); // 0.5 atomic → rounds up to 1
    expect(usdToAtomic(0.0000015)).toBe('2'); // 1.5 atomic → rounds up to 2
    expect(usdToAtomic(0.0000005)).not.toContain('.');
  });
});

describe('x402: x402Network (CAIP-2 resolution)', () => {
  it('respects an explicit X402_NETWORK (trimmed)', () => {
    expect(x402Network(env({ X402_NETWORK: '  eip155:8453  ' }))).toBe('eip155:8453');
  });
  it("derives eip155:8453 from CROSSMINT_CHAIN='base'", () => {
    expect(x402Network(env({ CROSSMINT_CHAIN: 'base' }))).toBe('eip155:8453');
  });
  it("derives eip155:84532 from CROSSMINT_CHAIN='base-sepolia'", () => {
    expect(x402Network(env({ CROSSMINT_CHAIN: 'base-sepolia' }))).toBe('eip155:84532');
  });
  it('defaults to eip155:8453 when nothing is set', () => {
    expect(x402Network(env())).toBe('eip155:8453');
  });
});

describe('x402: x402Asset (USDC contract per network)', () => {
  it('returns the Base mainnet USDC contract by default', () => {
    expect(x402Asset(env())).toBe(USDC_BASE);
  });
  it('returns the Base Sepolia USDC contract for the testnet', () => {
    expect(x402Asset(env({ CROSSMINT_CHAIN: 'base-sepolia' }))).toBe(USDC_BASE_SEPOLIA);
  });
  it('respects an X402_ASSET override (trimmed)', () => {
    expect(x402Asset(env({ X402_ASSET: '  0xdeadbeef  ' }))).toBe('0xdeadbeef');
  });
});

describe('x402: buildRequirements', () => {
  it('builds an "exact" requirement with the right network/asset + USDC extra', () => {
    const req = buildRequirements(env(), { payTo: '0xWallet', amount: '1500000' });
    expect(req.scheme).toBe('exact');
    expect(req.network).toBe('eip155:8453');
    expect(req.asset).toBe(USDC_BASE);
    expect(req.payTo).toBe('0xWallet');
    expect(req.amount).toBe('1500000');
    expect(req.maxTimeoutSeconds).toBe(300); // default window
    expect(req.extra).toEqual({ name: 'USD Coin', version: '2' });
  });
  it('honors an explicit network/asset/timeout override', () => {
    const req = buildRequirements(env(), {
      payTo: '0xW', amount: '1000', network: 'eip155:84532', asset: '0xcustom', maxTimeoutSeconds: 60,
    });
    expect(req.network).toBe('eip155:84532');
    expect(req.asset).toBe('0xcustom');
    expect(req.maxTimeoutSeconds).toBe(60);
    expect(req.extra).toEqual({ name: 'USDC', version: '2' }); // Sepolia USDC metadata
  });
});

describe('x402: paymentRequiredBody + encodePaymentRequired (round-trip)', () => {
  it('the encoded header base64-decodes back to the same x402 v2 body', () => {
    const requirements = [buildRequirements(env(), { payTo: '0xWallet', amount: '1500000' })];
    const body = paymentRequiredBody({ requirements, resourceUrl: 'https://sismo911.com/api/x' });
    const encoded = encodePaymentRequired(body);
    const round = decode(encoded);
    expect(round.x402Version).toBe(2);
    expect(round.x402Version).toBe(X402_VERSION);
    expect(round.accepts).toEqual(requirements);
    expect(round.resource.url).toBe('https://sismo911.com/api/x');
    expect(round.resource.mimeType).toBe('application/json'); // default
  });
});

describe('x402: readPaymentPayload', () => {
  it('returns null when neither header is present', () => {
    expect(readPaymentPayload(() => null)).toBeNull();
    expect(readPaymentPayload(() => undefined)).toBeNull();
  });
  it('decodes a base64-JSON payload from payment-signature (v2)', () => {
    const payload = { scheme: 'exact', signature: '0xsig', authorization: { from: '0xA' } };
    const got = readPaymentPayload((n) => (n === 'payment-signature' ? encode(payload) : null));
    expect(got).toEqual(payload);
  });
  it('falls back to x-payment (v1) when payment-signature is absent', () => {
    const payload = { scheme: 'exact', v: 1 };
    const got = readPaymentPayload((n) => (n === 'x-payment' ? encode(payload) : null));
    expect(got).toEqual(payload);
  });
  it('returns null on a malformed (non-base64-JSON) header', () => {
    expect(readPaymentPayload((n) => (n === 'payment-signature' ? '@@not-base64@@' : null))).toBeNull();
  });
});

describe('x402: isX402Configured', () => {
  it('false without a facilitator URL', () => {
    expect(isX402Configured(env())).toBe(false);
  });
  it('true once a facilitator URL is set (default asset present)', () => {
    expect(isX402Configured(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com' }))).toBe(true);
  });
});

// verify/settle hit the facilitator over HTTP — exercised against a mocked fetch,
// matching the safeFetch SSRF tests in security-regression.test.ts.
describe('x402: verifyPayment / settlePayment (mocked facilitator)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const facilitatorEnv = env({ X402_FACILITATOR_URL: 'https://facilitator.example.com' });
  const reqs = () => buildRequirements(facilitatorEnv, { payTo: '0xWallet', amount: '1000' });
  const jsonRes = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  it('verifyPayment returns isValid + payer on a 200 from /verify', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { isValid: true, payer: '0xPayer' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await verifyPayment(facilitatorEnv, { sig: '0x' }, reqs());
    expect(r.isValid).toBe(true);
    expect(r.payer).toBe('0xPayer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://facilitator.example.com/verify');
  });

  it('verifyPayment reports facilitator_unreachable when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const r = await verifyPayment(facilitatorEnv, {}, reqs());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('facilitator_unreachable');
  });

  it('settlePayment returns the tx hash on a successful settle', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { success: true, transactionHash: '0xtx', status: 'settled' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await settlePayment(facilitatorEnv, {}, reqs());
    expect(r.success).toBe(true);
    expect(r.transactionHash).toBe('0xtx');
    expect(fetchMock.mock.calls[0][0]).toBe('https://facilitator.example.com/settle');
  });

  it('settlePayment reports facilitator_unreachable when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const r = await settlePayment(facilitatorEnv, {}, reqs());
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe('facilitator_unreachable');
  });
});

// ── Fix 2: the master live gate (facilitator configured AND flag on) ─────────
describe('x402: isX402Live (master gate)', () => {
  it('false when no facilitator is configured (flag irrelevant)', () => {
    expect(isX402Live(env())).toBe(false);
    expect(isX402Live(env({ X402_PAYMENTS_ENABLED: 'true' }))).toBe(false);
  });
  it('false when a facilitator is set but the flag is unset', () => {
    expect(isX402Live(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com' }))).toBe(false);
  });
  it('false when a facilitator is set but the flag is falsey', () => {
    expect(isX402Live(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com', X402_PAYMENTS_ENABLED: 'false' }))).toBe(false);
    expect(isX402Live(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com', X402_PAYMENTS_ENABLED: '0' }))).toBe(false);
    expect(isX402Live(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com', X402_PAYMENTS_ENABLED: 'no' }))).toBe(false);
  });
  it('true only when BOTH the facilitator URL and the flag are set', () => {
    expect(isX402Live(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com', X402_PAYMENTS_ENABLED: 'true' }))).toBe(true);
  });
  it('accepts 1 / yes / on (case-insensitively) as the enabled flag', () => {
    const live = (v: string) => isX402Live(env({ X402_FACILITATOR_URL: 'https://facilitator.example.com', X402_PAYMENTS_ENABLED: v }));
    expect(live('1')).toBe(true);
    expect(live('yes')).toBe(true);
    expect(live('on')).toBe(true);
    expect(live('TRUE')).toBe(true);
    expect(live('YES')).toBe(true);
    expect(live('On')).toBe(true);
  });
});

describe('x402: chainIdFromNetwork', () => {
  it("maps 'eip155:8453' → 8453 (Base mainnet)", () => {
    expect(chainIdFromNetwork('eip155:8453')).toBe(8453);
  });
  it("maps 'eip155:84532' → 84532 (Base Sepolia)", () => {
    expect(chainIdFromNetwork('eip155:84532')).toBe(84532);
  });
  it('returns null for a non-EVM (solana) network', () => {
    expect(chainIdFromNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBeNull();
  });
  it('returns null for an empty string', () => {
    expect(chainIdFromNetwork('')).toBeNull();
  });
});

describe('x402: extractAuthorization', () => {
  it('pulls the authorization from payload.payload.authorization (v2 shape)', () => {
    const auth = { from: '0xA', to: '0xB', value: '1000', nonce: '0x01' };
    expect(extractAuthorization({ payload: { authorization: auth } })).toEqual(auth);
  });
  it('falls back to a top-level payload.authorization', () => {
    const auth = { from: '0xA', to: '0xB' };
    expect(extractAuthorization({ authorization: auth })).toEqual(auth);
  });
  it('prefers payload.payload.authorization over the top-level one', () => {
    const nested = { from: '0xNESTED' };
    const top = { from: '0xTOP' };
    expect(extractAuthorization({ payload: { authorization: nested }, authorization: top })).toEqual(nested);
  });
  it('returns null when no authorization is present', () => {
    expect(extractAuthorization({ payload: {} })).toBeNull();
    expect(extractAuthorization({})).toBeNull();
    expect(extractAuthorization(null)).toBeNull();
  });
  it('returns null when the authorization is not an object', () => {
    expect(extractAuthorization({ authorization: 'not-an-object' })).toBeNull();
    expect(extractAuthorization({ payload: { authorization: 42 } })).toBeNull();
  });
});

// ── Fix 6: validate the signed authorization against our requirements ────────
describe('x402: validateAuthorization', () => {
  const now = 1_000_000;
  const requirements = buildRequirements(env(), { payTo: '0xWallet', amount: '1500000' });
  const goodAuth = () => ({
    from: '0xPayer', to: '0xWallet', value: '1500000', nonce: '0xabc',
    validAfter: now - 100, validBefore: now + 100,
  });

  it('ok when recipient, amount, nonce, and validity window all match', () => {
    expect(validateAuthorization(goodAuth(), requirements, now)).toEqual({ ok: true });
  });
  it('matches the recipient case-insensitively', () => {
    const auth = { ...goodAuth(), to: '0xWALLET' };
    expect(validateAuthorization(auth, requirements, now)).toEqual({ ok: true });
  });
  it("reason 'missing_authorization' when auth is null", () => {
    expect(validateAuthorization(null, requirements, now)).toEqual({ ok: false, reason: 'missing_authorization' });
  });
  it("reason 'recipient_mismatch' when `to` is the wrong wallet", () => {
    const auth = { ...goodAuth(), to: '0xAttacker' };
    expect(validateAuthorization(auth, requirements, now)).toEqual({ ok: false, reason: 'recipient_mismatch' });
  });
  it("reason 'amount_mismatch' when `value` differs from the required amount", () => {
    const auth = { ...goodAuth(), value: '1' };
    expect(validateAuthorization(auth, requirements, now)).toEqual({ ok: false, reason: 'amount_mismatch' });
  });
  it("reason 'missing_nonce' when no nonce is present", () => {
    const auth = { ...goodAuth(), nonce: undefined };
    expect(validateAuthorization(auth, requirements, now)).toEqual({ ok: false, reason: 'missing_nonce' });
  });
  it("reason 'authorization_expired' when validBefore <= now", () => {
    const auth = { ...goodAuth(), validBefore: now };
    expect(validateAuthorization(auth, requirements, now)).toEqual({ ok: false, reason: 'authorization_expired' });
  });
  it("reason 'authorization_not_yet_valid' when validAfter > now", () => {
    const auth = { ...goodAuth(), validAfter: now + 1 };
    expect(validateAuthorization(auth, requirements, now)).toEqual({ ok: false, reason: 'authorization_not_yet_valid' });
  });
});

// ── Fix 6: stable replay-protection hash over the authorization ──────────────
describe('x402: authorizationHash (replay protection)', () => {
  const network = 'eip155:8453';
  const asset = USDC_BASE;
  const auth = () => ({ from: '0xPayer', to: '0xWallet', value: '1500000', nonce: '0xabc' });

  it('returns a 64-char lowercase hex sha256 string', async () => {
    const h = await authorizationHash(auth(), network, asset);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is stable: identical inputs produce the same hash', async () => {
    const [a, b] = await Promise.all([
      authorizationHash(auth(), network, asset),
      authorizationHash(auth(), network, asset),
    ]);
    expect(a).toBe(b);
  });
  it('differs when the nonce changes (replay with a new nonce is distinct)', async () => {
    const a = await authorizationHash(auth(), network, asset);
    const b = await authorizationHash({ ...auth(), nonce: '0xdef' }, network, asset);
    expect(a).not.toBe(b);
  });
  it('is case-insensitive on from/to/token (same hash regardless of input case)', async () => {
    const lower = await authorizationHash(
      { from: '0xpayer', to: '0xwallet', value: '1500000', nonce: '0xabc' },
      network, asset.toLowerCase(),
    );
    const upper = await authorizationHash(
      { from: '0xPAYER', to: '0xWALLET', value: '1500000', nonce: '0xabc' },
      network, asset.toUpperCase(),
    );
    expect(lower).toBe(upper);
  });
});
