-- Stripe Checkout (receiving) + Stripe Connect (payouts). Fiat card rail, kept
-- SEPARATE from x402_payments because that ledger is crypto-shaped (network /
-- asset / pay_to / tx_hash are NOT NULL and meaningless for a card charge). A
-- Stripe receipt is its own honest record; balance/accounting UNION the two.
--
-- Honesty rule (matches the rest of the platform): a row is only ever 'paid'
-- when the verified Stripe webhook (checkout.session.completed) says so — we
-- never optimistically mark a payment settled. Connect payouts stay on the
-- existing MANUAL operator rail (withdrawal_requests.pending_review); the
-- connected account is only the verified destination, never an auto-transfer.
--
-- Additive + idempotent (CREATE … IF NOT EXISTS): re-running is a no-op.

-- ── 1. Stripe receipts (fiat card payments into the platform account) ─────────
CREATE TABLE IF NOT EXISTS stripe_payments (
  id              TEXT PRIMARY KEY,                 -- stp_xxxxxxxx
  payee_user_id   TEXT NOT NULL REFERENCES users(id),
  resource_id     TEXT REFERENCES x402_resources(id),  -- the payment link (NULL for ad-hoc)
  session_id      TEXT,                             -- Stripe Checkout Session id (cs_…)
  payment_intent  TEXT,                             -- Stripe PaymentIntent id (pi_…)
  amount_usd      REAL NOT NULL,                    -- charge amount in USD (display + ledger)
  currency        TEXT NOT NULL DEFAULT 'USD',
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed | refunded
  payer_email     TEXT,                             -- from the Checkout Session (customer email)
  description     TEXT,
  tax_category    TEXT,                             -- accounting (mirrors x402_payments)
  notes           TEXT,
  reconciled      INTEGER NOT NULL DEFAULT 0,
  reconciled_ms   INTEGER,
  created_ms      INTEGER NOT NULL,
  paid_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stripe_pay_payee  ON stripe_payments(payee_user_id, status, created_ms DESC);
-- Idempotent webhook: one settled row per Checkout Session (dedupes redelivery).
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_pay_session ON stripe_payments(session_id) WHERE session_id IS NOT NULL;

-- ── 2. Stripe Connect accounts (verified payout destinations) ─────────────────
CREATE TABLE IF NOT EXISTS stripe_accounts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id),
  account_id        TEXT NOT NULL,                  -- Stripe connected account id (acct_…)
  charges_enabled   INTEGER NOT NULL DEFAULT 0,
  payouts_enabled   INTEGER NOT NULL DEFAULT 0,     -- a stripe withdrawal is only allowed when this is 1
  details_submitted INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | active | restricted
  country           TEXT,
  created_ms        INTEGER NOT NULL,
  updated_ms        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_acct_acct ON stripe_accounts(account_id);
