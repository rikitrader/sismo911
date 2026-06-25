-- Crowdfunding / donations sub-app.
--
--  • campaigns  — GoFundMe-style relief campaigns (public read; create gated below).
--  • donations  — one row per donation attempt; flips pending→paid via Crossmint webhook.
--  • users.*    — each signed-up user gets a Crossmint custodial (encrypted) wallet on Base.
--
-- Payment rail: Crossmint Headless Checkout (card → USDC settles to the merchant
-- wallet on Base). Donors need NO account — Crossmint auto-creates a custodial
-- wallet from the receipt email. Campaigns + the public ledger work with or
-- without Crossmint configured; only the "pay now" step is gated on the keys.

CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,            -- cmp_xxxxxxxx
  slug            TEXT NOT NULL UNIQUE,        -- url-safe handle
  title           TEXT NOT NULL,
  summary         TEXT,                        -- one-line pitch (cards)
  story           TEXT,                        -- full description (detail page)
  image_url       TEXT,                        -- hero image (https or /uploads)
  category        TEXT,                        -- rescate | salud | refugio | familia | reconstruccion | otro
  location        TEXT,                        -- estado / municipio
  goal_usd        REAL NOT NULL DEFAULT 0,     -- target (0 = open-ended)
  raised_usd      REAL NOT NULL DEFAULT 0,     -- sum of PAID donations (maintained by webhook/reconcile)
  donors_count    INTEGER NOT NULL DEFAULT 0,  -- count of PAID donations
  currency        TEXT NOT NULL DEFAULT 'USD',
  beneficiary     TEXT,                        -- who receives the funds
  organizer_user_id TEXT REFERENCES users(id), -- nullable (null = created by the SISMO911 org)
  organizer_name  TEXT,
  contact_email   TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- active | paused | closed | pending_review | rejected
  featured        INTEGER NOT NULL DEFAULT 0,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status   ON campaigns(status, featured DESC, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_organizer ON campaigns(organizer_user_id);

CREATE TABLE IF NOT EXISTS donations (
  id              TEXT PRIMARY KEY,            -- don_xxxxxxxx
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  amount_usd      REAL NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  donor_name      TEXT,                        -- displayed name (or null/Anónimo)
  donor_email     TEXT,                        -- receipt email (never shown publicly)
  message         TEXT,                        -- optional public note of support
  anonymous       INTEGER NOT NULL DEFAULT 0,  -- 1 = hide name in public ledger
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  provider        TEXT NOT NULL DEFAULT 'crossmint',
  order_id        TEXT,                        -- Crossmint orderId (unique once known)
  tx_id           TEXT,                        -- settlement tx hash
  wallet_address  TEXT,                        -- donor's custodial wallet (NFT receipt)
  ip              TEXT,                         -- abuse signal only; never displayed
  created_ms      INTEGER NOT NULL,
  paid_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id, status, created_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_order ON donations(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);

-- Per-user encrypted custodial wallet (Crossmint, Base/EVM). Keys are held +
-- encrypted by Crossmint; we only ever store the public address + locator.
ALTER TABLE users ADD COLUMN wallet_address    TEXT;
ALTER TABLE users ADD COLUMN wallet_locator    TEXT;
ALTER TABLE users ADD COLUMN wallet_chain      TEXT;
ALTER TABLE users ADD COLUMN wallet_created_ms INTEGER;

-- Seed: the platform's own flagship relief fund so the page is never empty.
INSERT OR IGNORE INTO campaigns
  (id, slug, title, summary, story, image_url, category, location,
   goal_usd, raised_usd, donors_count, currency, beneficiary,
   organizer_user_id, organizer_name, contact_email, status, featured, created_ms, updated_ms)
VALUES (
  'cmp_sismo911', 'fondo-respuesta-sismica',
  'Fondo de Respuesta Sísmica SISMO911',
  'Apoya la respuesta de emergencia ante sismos en Venezuela: rescate, refugio y reunificación familiar.',
  'SISMO911 coordina la respuesta ciudadana ante sismos en Venezuela. Tu donación financia equipos de rescate, refugios temporales, suministros médicos y la reunificación de familias separadas por el terremoto. El 100% de los fondos se destina a la ayuda directa, con un registro público y transparente de cada donativo.',
  '/og/og-default.png', 'rescate', 'Venezuela',
  50000, 0, 0, 'USD', 'Operaciones de emergencia SISMO911',
  NULL, 'SISMO911', 'ayuda@sismo911.com', 'active', 1,
  1750000000000, 1750000000000
);
