-- Cobros production — enrich x402_resources so a payment link can be a full
-- DONATION campaign (fundraising goal + public campaign page) or a lightweight
-- INVOICE (named client + paid/unpaid status). Additive + idempotent-friendly:
-- every existing row keeps its current behaviour (all new columns nullable / 0).
--
-- Donation links:  price_usd = 0 (open amount; the payer names the amount) and
--                  goal_usd drives the /campana progress bar. raised is computed
--                  live from settled x402_payments, never stored here.
-- Invoice links:   price_usd = the amount due; invoice_status tracks pendiente →
--                  pagada (operator-marked, since lightweight invoices don't
--                  necessarily settle on-chain).

-- ── Donation / campaign fields ──────────────────────────────────────────────
ALTER TABLE x402_resources ADD COLUMN goal_usd        REAL;                        -- fundraising target (NULL = open-ended)
ALTER TABLE x402_resources ADD COLUMN campaign_blurb  TEXT;                         -- public campaign description (/campana)
ALTER TABLE x402_resources ADD COLUMN campaign_image  TEXT;                         -- optional hero image URL
ALTER TABLE x402_resources ADD COLUMN campaign_public INTEGER NOT NULL DEFAULT 0;   -- 1 = campaign page visible to the public

-- ── Invoice fields (lightweight) ────────────────────────────────────────────
ALTER TABLE x402_resources ADD COLUMN client_name    TEXT;                          -- who the invoice is billed to
ALTER TABLE x402_resources ADD COLUMN client_email   TEXT;                          -- optional client contact
ALTER TABLE x402_resources ADD COLUMN invoice_status TEXT;                          -- NULL for non-invoices; else pendiente | pagada | cancelada
ALTER TABLE x402_resources ADD COLUMN due_ms         INTEGER;                       -- optional invoice due date (epoch ms)
ALTER TABLE x402_resources ADD COLUMN paid_ms        INTEGER;                       -- when an invoice was marked pagada
