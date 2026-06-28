-- x402 payment receiving. Source of truth: https://github.com/xpaysh/awesome-x402
--
-- Every signed-up user already gets a Crossmint custodial wallet on Base
-- (migration 0016 + src/routes/auth.ts). x402 turns that SAME address into an
-- HTTP-native receiver: a payer signs an EIP-3009 `transferWithAuthorization`
-- (gasless USDC transfer), the server returns HTTP 402 with the requirements,
-- and a facilitator verifies + settles the transfer on-chain (~2s on Base).
--
-- We do NOT mint a second wallet — we reuse `users.wallet_address` as the x402
-- `payTo`. This migration only adds the *capability flags* + the *ledger* that
-- record what each wallet is allowed to charge and what it has received.
--
--  • users.x402_*      — per-account receive capability, flipped ON at signup.
--  • x402_resources    — optional priced endpoints a user offers (price list).
--  • x402_payments     — one row per payment attempt; required→verified→settled.

-- ── 1. Per-user receive capability ──────────────────────────────────────────
-- x402_enabled = 1 means "this wallet can receive x402 payments". pay_to defaults
-- to wallet_address; network/asset are NULL → the app resolves env defaults at
-- runtime (X402_NETWORK / USDC for the configured chain) so this stays
-- env-agnostic and a chain switch needs no data backfill.
ALTER TABLE users ADD COLUMN x402_enabled    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN x402_pay_to     TEXT;     -- receiving address (EVM); defaults to wallet_address
ALTER TABLE users ADD COLUMN x402_network    TEXT;     -- CAIP-2, e.g. eip155:8453 (Base) — NULL = env default
ALTER TABLE users ADD COLUMN x402_asset      TEXT;     -- token contract (USDC) — NULL = env default
ALTER TABLE users ADD COLUMN x402_enabled_ms INTEGER;  -- when receiving was switched on

-- Backfill: any existing user that already holds a custodial wallet is
-- receive-enabled retroactively (parity with new signups). New columns resolve
-- network/asset from env until the user customizes them.
UPDATE users
   SET x402_enabled = 1,
       x402_pay_to  = wallet_address,
       x402_enabled_ms = (strftime('%s','now') * 1000)
 WHERE wallet_address IS NOT NULL AND x402_enabled = 0;

-- ── 2. Priced resources a user offers (the "all features" price list) ───────
-- Lets a user charge for named resources (an API path, a download, a service).
-- The pay endpoint resolves slug → resource → payee wallet → price. Without a
-- row, the generic pay endpoint can still take an ad-hoc ?amount= from the owner.
CREATE TABLE IF NOT EXISTS x402_resources (
  id            TEXT PRIMARY KEY,                 -- res_xxxxxxxx
  user_id       TEXT NOT NULL REFERENCES users(id),
  slug          TEXT NOT NULL,                    -- url-safe handle, unique per user
  title         TEXT NOT NULL,
  description   TEXT,
  price_usd     REAL NOT NULL,                    -- human price; converted to atomic USDC at request time
  mime_type     TEXT NOT NULL DEFAULT 'application/json',
  active        INTEGER NOT NULL DEFAULT 1,       -- 0 = stop accepting payments for this resource
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_res_owner_slug ON x402_resources(user_id, slug);
CREATE INDEX IF NOT EXISTS idx_x402_res_user ON x402_resources(user_id, active);

-- ── 3. Payments ledger ──────────────────────────────────────────────────────
-- One row per payment attempt against a payee's wallet. Lifecycle:
--   required  — 402 returned, awaiting a signed PAYMENT-SIGNATURE
--   verified  — facilitator /verify said the signature/authorization is valid
--   settled   — facilitator /settle landed the transfer on-chain (tx_hash set)
--   failed    — verify or settle rejected it (invalid_reason set)
--   expired   — authorization window (maxTimeoutSeconds) elapsed unpaid
CREATE TABLE IF NOT EXISTS x402_payments (
  id             TEXT PRIMARY KEY,                -- x4p_xxxxxxxx
  payee_user_id  TEXT NOT NULL REFERENCES users(id),
  resource_id    TEXT REFERENCES x402_resources(id),  -- NULL for ad-hoc amounts
  resource_url   TEXT NOT NULL,                   -- the gated resource URL
  description    TEXT,
  scheme         TEXT NOT NULL DEFAULT 'exact',   -- x402 payment scheme
  network        TEXT NOT NULL,                   -- CAIP-2 (e.g. eip155:8453)
  asset          TEXT NOT NULL,                   -- token contract (USDC)
  amount         TEXT NOT NULL,                   -- atomic units as string (USDC = 6 dp)
  amount_usd     REAL,                            -- display convenience
  pay_to         TEXT NOT NULL,                   -- receiving address
  payer          TEXT,                            -- payer address (from /verify)
  status         TEXT NOT NULL DEFAULT 'required',-- required|verified|settled|failed|expired
  facilitator    TEXT,                            -- facilitator URL used
  tx_hash        TEXT,                            -- settlement transaction hash
  invalid_reason TEXT,                            -- failure detail
  payload_json   TEXT,                            -- raw PaymentPayload (audit/forensics)
  ip             TEXT,                            -- abuse signal only; never displayed
  created_ms     INTEGER NOT NULL,
  verified_ms    INTEGER,
  settled_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x402_pay_payee  ON x402_payments(payee_user_id, status, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_x402_pay_status ON x402_payments(status, created_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_pay_tx ON x402_payments(tx_hash) WHERE tx_hash IS NOT NULL;
