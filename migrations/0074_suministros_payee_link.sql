-- SUMINISTROS payee link — connect a proveedor / factura to a SISMO911 user
-- whose x402 wallet RECEIVES the payment, so a supplier invoice can mint a real
-- x402 payment link (USDC over HTTP, settled on-chain) instead of a manual
-- estado flip. Reuses the existing x402 receive stack (users.x402_*,
-- x402_resources kind='invoice', x402_payments) — no new payment infra.
--
-- Additive + idempotent-safe: every existing row keeps its behaviour (all new
-- columns are nullable / default NULL). SQLite has no `ADD COLUMN IF NOT EXISTS`,
-- so a re-run errors on the duplicate column — matching this repo's other ALTER
-- migrations (0070_cobros_donation_invoice.sql); the d1_migrations tracker guards
-- against re-application in production.

-- Which user's wallet collects payment for this supplier (FK users(id), nullable).
ALTER TABLE sum_proveedores ADD COLUMN payee_user_id    TEXT;

-- Per-invoice payee override (falls back to the proveedor's payee_user_id).
ALTER TABLE sum_facturas    ADD COLUMN payee_user_id    TEXT;
-- The x402_resources row this invoice generated its pay-link from (NULL = none yet).
ALTER TABLE sum_facturas    ADD COLUMN x402_resource_id TEXT;
-- Its slug (= lower(codigo), e.g. 'fac-para0001') — the public pay path segment.
ALTER TABLE sum_facturas    ADD COLUMN x402_slug        TEXT;
