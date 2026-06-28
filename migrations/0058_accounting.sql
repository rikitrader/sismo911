-- Accounting — per-payment bookkeeping fields on the x402 ledger so a citizen can
-- categorize, annotate, and reconcile each received payment. All additive.
ALTER TABLE x402_payments ADD COLUMN tax_category TEXT;                       -- free-form / preset tax bucket
ALTER TABLE x402_payments ADD COLUMN notes TEXT;                             -- private bookkeeping note
ALTER TABLE x402_payments ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0;  -- 0 = open, 1 = reconciled
ALTER TABLE x402_payments ADD COLUMN reconciled_ms INTEGER;                  -- when marked reconciled
