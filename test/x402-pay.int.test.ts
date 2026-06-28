import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { x402 } from '../src/routes/x402';
import { encodeJsonB64 } from '../src/lib/x402';

// ── Minimal D1 adapter over better-sqlite3 ──────────────────────────────────
// The repo's shared test/helpers/d1.ts adapter passes args positionally, which
// better-sqlite3 rejects for the `?1/?2/?3` NUMBERED placeholders (with reuse)
// that the x402 route + rate limiters use — D1 expands those, better-sqlite3
// does not. So this file ships its own adapter that rewrites `?N` → `?` in order
// of appearance (expanding reuse) exactly as D1 would, then binds positionally.
function expandNumbered(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args };
  const out: unknown[] = [];
  const newSql = sql.replace(/\?(\d+)/g, (_m, n: string) => {
    out.push(args[Number(n) - 1]);
    return '?';
  });
  return { sql: newSql, args: out };
}
class TestStmt {
  constructor(private raw: Database.Database, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new TestStmt(this.raw, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  async first<T = any>(): Promise<T | null> {
    const e = expandNumbered(this.sql, this.args);
    return (this.raw.prepare(e.sql).get(...(e.args as any[])) as T) ?? null;
  }
  async all<T = any>() {
    const e = expandNumbered(this.sql, this.args);
    return { results: this.raw.prepare(e.sql).all(...(e.args as any[])) as T[], success: true as const, meta: {} };
  }
  async run() {
    const e = expandNumbered(this.sql, this.args);
    const info = this.raw.prepare(e.sql).run(...(e.args as any[]));
    return { success: true as const, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
}
class D1Mock {
  constructor(public raw: Database.Database) {}
  prepare(sql: string) {
    return new TestStmt(this.raw, sql);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Route-level integration tests for the x402 receive/pay flow.
//
//   ALL /api/x402/pay/:userId/:slug
//     no header        → 402 + PAYMENT-REQUIRED
//     not live         → 503 payments_unavailable
//     signed + ok      → verify → settle → 200 + PAYMENT-RESPONSE (row → settled)
//     bad authz        → 402 invalid_authorization (no settle)
//     idempotent key   → prior receipt, facilitator NOT re-hit
//     replay (same sig)→ prior receipt (idempotent); (diff sig) → 409 (no leak)
//     transient settle → 402, then a retry on the SAME row → 200 (not bricked)
//
// Unlike the read-mostly donations stub, the pay flow INSERTs a payment row then
// reads back / mutates the SAME row (required → verified → settled, plus a
// re-SELECT by authorization_hash for replay/idempotency). So instead of a fake
// SQL router we run real SQL against an in-memory SQLite (the repo's D1Mock
// adapter, same as the flota *.int.test.ts) — the unique indexes on
// authorization_hash + (payee, idempotency_key) then enforce replay protection
// for free, exactly as production D1 would.
// ────────────────────────────────────────────────────────────────────────────

// Fixed test resource + payee (the pay route reads network/asset/payTo off the
// USER row via the resource→user JOIN).
const USER_ID = 'usr_1';
const SLUG = 'tip';
const PAY_TO = '0xPayTo0000000000000000000000000000000001';
const ASSET = '0xUSDC0000000000000000000000000000000002';
const NETWORK = 'eip155:8453';
const PRICE_USD = 1;
const AMOUNT = '1000000'; // usdToAtomic(1) — USDC has 6 decimals
const PAYER = '0xPayer000000000000000000000000000000abcd';

function buildDb(): D1Mock {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      wallet_address TEXT,
      x402_enabled INTEGER NOT NULL DEFAULT 0,
      x402_pay_to TEXT,
      x402_network TEXT,
      x402_asset TEXT
    );
    CREATE TABLE x402_resources (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      price_usd REAL NOT NULL,
      price_version INTEGER NOT NULL DEFAULT 1,
      mime_type TEXT NOT NULL DEFAULT 'application/json',
      active INTEGER NOT NULL DEFAULT 1,
      created_ms INTEGER NOT NULL,
      updated_ms INTEGER NOT NULL
    );
    CREATE TABLE x402_payments (
      id TEXT PRIMARY KEY,
      payee_user_id TEXT NOT NULL,
      resource_id TEXT,
      resource_url TEXT NOT NULL,
      description TEXT,
      scheme TEXT NOT NULL DEFAULT 'exact',
      network TEXT NOT NULL,
      chain_id INTEGER,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      amount_usd REAL,
      pay_to TEXT NOT NULL,
      payer TEXT,
      status TEXT NOT NULL DEFAULT 'required',
      facilitator TEXT,
      tx_hash TEXT,
      invalid_reason TEXT,
      payload_json TEXT,
      ip TEXT,
      authorization_hash TEXT,
      idempotency_key TEXT,
      facilitator_response TEXT,
      resource_price_version INTEGER,
      created_ms INTEGER NOT NULL,
      verified_ms INTEGER,
      settled_ms INTEGER
    );
    CREATE UNIQUE INDEX idx_x402_pay_authhash
      ON x402_payments(authorization_hash) WHERE authorization_hash IS NOT NULL;
    CREATE UNIQUE INDEX idx_x402_pay_idem
      ON x402_payments(payee_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE rate_buckets (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_ms INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, wallet_address, x402_enabled, x402_pay_to, x402_network, x402_asset)
     VALUES (?,?,?,?,?,?)`
  ).run(USER_ID, '0xWallet00000000000000000000000000000003', 1, PAY_TO, NETWORK, ASSET);
  db.prepare(
    `INSERT INTO x402_resources (id, user_id, slug, title, description, price_usd, price_version, mime_type, active, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run('res_1', USER_ID, SLUG, 'Propina', 'Apoya el rescate', PRICE_USD, 1, 'application/json', 1, now, now);
  return new D1Mock(db);
}

// ── Mock facilitator (global fetch) ──────────────────────────────────────────
// /verify → {isValid,payer}; /settle → {success,transactionHash}. Per-test
// overridable; records every call so we can assert the facilitator is (not) hit.
let verifyResult: { isValid: boolean; payer?: string; invalidReason?: string };
let settleResult: { success?: boolean; transactionHash?: string; errorReason?: string; status?: string };
let fetchCalls: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  verifyResult = { isValid: true, payer: PAYER };
  settleResult = { success: true, transactionHash: '0xtx' };
  fetchCalls = [];
  vi.stubGlobal('fetch', async (input: any) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.endsWith('/verify')) return json(verifyResult);
    if (url.endsWith('/settle')) return json(settleResult);
    return json({}, 200);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const facilitatorHits = () => fetchCalls.filter((u) => u.endsWith('/verify') || u.endsWith('/settle')).length;

// ── Env builders ─────────────────────────────────────────────────────────────
function liveEnv(db: D1Mock): any {
  return {
    DB: db,
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    X402_FACILITATOR_URL: 'https://facilitator.test',
    X402_PAYMENTS_ENABLED: 'true',
    X402_NETWORK: NETWORK,
    X402_ASSET: ASSET,
  };
}
function notLiveEnv(db: D1Mock): any {
  const e = liveEnv(db);
  delete e.X402_PAYMENTS_ENABLED; // configured but feature flag off → not live
  return e;
}

// ── Signed payload helpers (EIP-3009 authorization) ─────────────────────────
function makePayload(over: { auth?: Record<string, unknown>; signature?: string } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: PAYER,
    to: PAY_TO,
    value: AMOUNT,
    validAfter: '0',
    validBefore: String(nowSec + 3600),
    nonce: '0xnonce0000000000000000000000000000000000000000000000000000000001',
    ...over.auth,
  };
  return { payload: { authorization, signature: over.signature ?? '0xsignatureDEFAULT' } };
}

function payReq(env: any, headers: Record<string, string> = {}) {
  return x402.request(
    `/pay/${USER_ID}/${SLUG}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
    env,
  );
}
function signedReq(env: any, payload: unknown, extra: Record<string, string> = {}) {
  return payReq(env, { 'payment-signature': encodeJsonB64(payload), ...extra });
}

let db: D1Mock;
let env: any;
beforeEach(() => {
  db = buildDb();
  env = liveEnv(db);
});

const rowById = (id: string) => db.raw.prepare('SELECT * FROM x402_payments WHERE id=?').get(id) as any;

// ── Case 1: no payment header → 402 + PAYMENT-REQUIRED ──────────────────────
describe('x402 pay: no payment header', () => {
  it('returns 402 with a PAYMENT-REQUIRED header and accepts requirements', async () => {
    const res = await payReq(env);
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].payTo).toBe(PAY_TO);
    expect(body.accepts[0].amount).toBe(AMOUNT);
    // No ledger row written for an unsigned probe.
    const n = db.raw.prepare('SELECT COUNT(*) n FROM x402_payments').get() as any;
    expect(n.n).toBe(0);
    expect(facilitatorHits()).toBe(0);
  });
});

// ── Case 2: payments not live → 503 payments_unavailable ────────────────────
describe('x402 pay: not live', () => {
  it('returns 503 payments_unavailable when the feature flag is off', async () => {
    const res = await payReq(notLiveEnv(db));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('payments_unavailable');
  });
});

// ── Case 3: happy path → 200 paid + PAYMENT-RESPONSE, row settled ───────────
describe('x402 pay: happy path', () => {
  it('verifies + settles a valid payment and returns the receipt', async () => {
    const res = await signedReq(env, makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paid).toBe(true);
    expect(body.payment.payer).toBe(PAYER);
    expect(body.payment.tx).toBe('0xtx');
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    // facilitator hit exactly once each.
    expect(fetchCalls.filter((u) => u.endsWith('/verify')).length).toBe(1);
    expect(fetchCalls.filter((u) => u.endsWith('/settle')).length).toBe(1);
    // stored row reached terminal settled state with the tx hash.
    const row = rowById(body.payment.id);
    expect(row.status).toBe('settled');
    expect(row.tx_hash).toBe('0xtx');
    expect(row.payer).toBe(PAYER);
    expect(row.settled_ms).toBeGreaterThan(0);
  });
});

// ── Case 4: invalid authorization → 402 invalid_authorization, no settle ────
describe('x402 pay: invalid authorization', () => {
  it('recipient_mismatch when `to` is not the payTo', async () => {
    const res = await signedReq(env, makePayload({ auth: { to: '0xWrongRecipient00000000000000000000000099' } }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('invalid_authorization');
    expect(body.reason).toBe('recipient_mismatch');
    expect(facilitatorHits()).toBe(0);
    expect((db.raw.prepare('SELECT COUNT(*) n FROM x402_payments').get() as any).n).toBe(0);
  });

  it('amount_mismatch when `value` is not the atomic price', async () => {
    const res = await signedReq(env, makePayload({ auth: { value: '500000' } }));
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe('amount_mismatch');
    expect(facilitatorHits()).toBe(0);
  });

  it('authorization_expired when validBefore is in the past', async () => {
    const past = String(Math.floor(Date.now() / 1000) - 10);
    const res = await signedReq(env, makePayload({ auth: { validBefore: past } }));
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe('authorization_expired');
    expect(facilitatorHits()).toBe(0);
  });
});

// ── Case 5: idempotency key → prior receipt, facilitator not re-hit ─────────
describe('x402 pay: idempotency', () => {
  it('a repeated Idempotency-Key returns the prior receipt without re-settling', async () => {
    const payload = makePayload();
    const first = await signedReq(env, payload, { 'idempotency-key': 'idem-123' });
    expect(first.status).toBe(200);
    expect(facilitatorHits()).toBe(2); // one verify + one settle

    const second = await signedReq(env, payload, { 'idempotency-key': 'idem-123' });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.paid).toBe(true);
    expect(body.idempotent).toBe(true);
    expect(body.payment.tx).toBe('0xtx');
    // facilitator NOT called a second time.
    expect(facilitatorHits()).toBe(2);
    // exactly one ledger row.
    expect((db.raw.prepare('SELECT COUNT(*) n FROM x402_payments').get() as any).n).toBe(1);
  });
});

// ── Case 6: replay of the same authorization ────────────────────────────────
describe('x402 pay: replay protection', () => {
  it('same authorization + same signature → prior settled receipt (idempotent)', async () => {
    const payload = makePayload({ signature: '0xsigSAME' });
    const first = await signedReq(env, payload);
    expect(first.status).toBe(200);
    expect(facilitatorHits()).toBe(2);

    const second = await signedReq(env, payload);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.paid).toBe(true);
    expect(facilitatorHits()).toBe(2); // not re-settled
  });

  it('same authorization + different signature → 409 authorization_already_used (no receipt leak)', async () => {
    await signedReq(env, makePayload({ signature: '0xsigORIGINAL' })); // original payer settles
    const res = await signedReq(env, makePayload({ signature: '0xsigATTACKER' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('authorization_already_used');
    // no receipt disclosure: no tx / payer / payment block leaked.
    expect(JSON.stringify(body)).not.toContain('0xtx');
    expect(body.payment).toBeUndefined();
    expect(facilitatorHits()).toBe(2); // attacker re-request never reached the facilitator
  });
});

// ── Case 7: transient settle failure then a successful retry ────────────────
describe('x402 pay: transient settle failure then retry', () => {
  it('a failed settlement leaves the row re-attemptable; a retry settles it', async () => {
    const payload = makePayload();

    // 1st attempt: verify ok, settle fails transiently.
    settleResult = { success: false, errorReason: 'settlement_failed' };
    const first = await signedReq(env, payload);
    expect(first.status).toBe(402);
    expect((await first.json()).error).toBe('settlement_failed');
    const failedRow = db.raw.prepare('SELECT * FROM x402_payments').get() as any;
    expect(failedRow.status).toBe('failed');

    // 2nd attempt: same valid payload, settle now succeeds → 200 on the SAME row.
    settleResult = { success: true, transactionHash: '0xtx2' };
    const second = await signedReq(env, payload);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.paid).toBe(true);
    expect(body.payment.tx).toBe('0xtx2');
    // still a single ledger row — re-used, not bricked, not duplicated.
    expect((db.raw.prepare('SELECT COUNT(*) n FROM x402_payments').get() as any).n).toBe(1);
    expect((db.raw.prepare('SELECT status FROM x402_payments').get() as any).status).toBe('settled');
  });
});
