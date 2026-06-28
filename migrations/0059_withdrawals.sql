-- Withdrawals / payout system. Two tables. details_json holds ONLY redacted
-- destination info (masked phone / cédula / account) — never plaintext secrets
-- or bank passwords. No real licensed payout provider is integrated, so manual
-- rails (Pago Móvil, bank, cash) default to pending_review and are never
-- auto-completed; an operator advances them.

CREATE TABLE IF NOT EXISTS withdrawal_methods (
  id           TEXT PRIMARY KEY,                 -- wm_xxxxxxxx
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,                    -- usdc | stripe | pago_movil | bank | cash
  label        TEXT NOT NULL,                    -- user-facing label
  details_json TEXT,                             -- REDACTED destination details (masked)
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_user ON withdrawal_methods(user_id);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id                   TEXT PRIMARY KEY,         -- wr_xxxxxxxx
  user_id              TEXT NOT NULL REFERENCES users(id),
  method_type          TEXT NOT NULL,            -- usdc | stripe | pago_movil | bank | cash
  amount_source        REAL NOT NULL,            -- requested amount in source currency
  source_currency      TEXT NOT NULL DEFAULT 'USDC',
  payout_currency      TEXT NOT NULL DEFAULT 'USD',
  exchange_rate        REAL,                     -- source→payout rate at request time (informational)
  fee_amount           REAL NOT NULL DEFAULT 0,
  net_amount           REAL NOT NULL,            -- source amount minus fee
  destination_summary  TEXT,                     -- short masked summary (e.g. "Pago Móvil ****1234")
  destination_details_json TEXT,                 -- REDACTED full destination (masked)
  status               TEXT NOT NULL DEFAULT 'pending_review',
                                                 -- draft|pending_review|processing|completed|failed|rejected|cancelled
  provider             TEXT,                     -- payout provider when one is integrated (NULL = manual)
  provider_reference   TEXT,                     -- provider txn id when completed
  idempotency_key      TEXT,                     -- per-user dedupe of double-submits
  risk_score           INTEGER NOT NULL DEFAULT 0,
  review_note          TEXT,                     -- operator note on approve/reject
  created_ms           INTEGER NOT NULL,
  updated_ms           INTEGER NOT NULL,
  completed_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wr_user ON withdrawal_requests(user_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_wr_status ON withdrawal_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wr_idem ON withdrawal_requests(user_id, idempotency_key);
