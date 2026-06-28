-- Payment Command Center — enrich x402_resources so a "payment link" can record
-- its provider kind + display currency, and be soft-archived (never hard-deleted,
-- since x402_payments.resource_id references it). Additive + idempotent-ish:
-- existing rows default to the live x402/USDC provider.
ALTER TABLE x402_resources ADD COLUMN kind TEXT NOT NULL DEFAULT 'x402';     -- x402 | stripe | donation | invoice
ALTER TABLE x402_resources ADD COLUMN currency TEXT NOT NULL DEFAULT 'USDC'; -- display currency
ALTER TABLE x402_resources ADD COLUMN archived_ms INTEGER;                   -- soft-archive timestamp (NULL = active list)
