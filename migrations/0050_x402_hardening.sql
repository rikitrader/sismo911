-- x402 hardening: idempotency, ledger integrity, price versioning, replay
-- protection. Builds on 0048_x402_payments.sql. Source of truth:
-- https://github.com/xpaysh/awesome-x402
--
--  Fix 3 (idempotency)  — idempotency_key + uniqueness so a duplicate settlement
--                          POST returns the prior receipt instead of re-settling.
--  Fix 4 (ledger)        — record authorization_hash, chain_id, raw facilitator
--                          response, and the resource price version actually charged.
--  Fix 5 (price)         — version resource prices; receipts reference the exact
--                          price charged (already snapshotted on the payment row).
--  Fix 6 (replay)        — authorization_hash uniqueness blocks replays of the
--                          same EIP-3009 authorization (nonce is part of the hash).

-- ── Ledger integrity + idempotency + replay (x402_payments) ─────────────────
ALTER TABLE x402_payments ADD COLUMN authorization_hash    TEXT;     -- sha256(chainId,token,from,to,value,nonce) — unique per EIP-3009 auth
ALTER TABLE x402_payments ADD COLUMN chain_id              INTEGER;  -- numeric EVM chain id (e.g. 8453) derived from CAIP-2 network
ALTER TABLE x402_payments ADD COLUMN idempotency_key       TEXT;     -- client-supplied Idempotency-Key (optional)
ALTER TABLE x402_payments ADD COLUMN facilitator_response  TEXT;     -- raw verify+settle JSON for reconciliation/forensics
ALTER TABLE x402_payments ADD COLUMN resource_price_version INTEGER; -- the x402_resources.price_version charged

-- Replay protection: the same signed authorization can settle at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_pay_authhash
  ON x402_payments(authorization_hash) WHERE authorization_hash IS NOT NULL;
-- Idempotency: one receipt per (payee, client key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_pay_idem
  ON x402_payments(payee_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── Price immutability / versioning (x402_resources) ────────────────────────
-- Current price stays on the resource row; the version bumps on every price
-- change and the full history is appended to x402_resource_prices. Each payment
-- snapshots both the amount AND the version it was charged at, so historical
-- receipts never drift when a price later changes.
ALTER TABLE x402_resources ADD COLUMN price_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS x402_resource_prices (
  id           TEXT PRIMARY KEY,                -- rpx_xxxxxxxx
  resource_id  TEXT NOT NULL REFERENCES x402_resources(id),
  version      INTEGER NOT NULL,
  price_usd    REAL NOT NULL,
  created_ms   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_rp_res_ver ON x402_resource_prices(resource_id, version);

-- Seed v1 history for any resources created before versioning existed.
INSERT OR IGNORE INTO x402_resource_prices (id, resource_id, version, price_usd, created_ms)
SELECT 'rpx_' || substr(id, 5), id, 1, price_usd, created_ms FROM x402_resources;
