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
