-- FEMA/NIMS-style logistics subsystem for centros de acopio.
-- Layers a supply chain on top of the existing acopio catalog (acopio-data.json),
-- citizen submissions (acopio_submissions) and live status (acopio_status).
--
-- center_id is a FREE-TEXT id (NOT a foreign key) so it can reference either a
-- curated catalog id from /acopio-data.json OR an acopio_submissions id (uid 'acs…').
-- This mirrors acopio_status, which already keys on the same catalog id space.
--
-- Operator-gated writes (via ADMIN_WRITE_PREFIXES '/api/acopio' in src/index.ts);
-- all GET reads are public (command transparency).

-- ── Inventory: what each center physically holds, by commodity ──────────────
CREATE TABLE IF NOT EXISTS acopio_inventory (
  center_id   TEXT NOT NULL,            -- catalog id or acopio_submissions id
  commodity   TEXT NOT NULL,            -- commodity id from src/data/commodities.ts
  qty         REAL NOT NULL DEFAULT 0,  -- quantity on hand (in `unit`)
  unit        TEXT,                     -- l, kg, u, caja, etc. (defaults from taxonomy)
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (center_id, commodity)
);
CREATE INDEX IF NOT EXISTS idx_acopio_inv_commodity ON acopio_inventory(commodity);

-- ── Needs / requests: demand signal a center raises for a commodity ─────────
CREATE TABLE IF NOT EXISTS acopio_needs (
  id          TEXT PRIMARY KEY,         -- uid('nee')
  center_id   TEXT NOT NULL,
  commodity   TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,  -- quantity requested
  priority    INTEGER NOT NULL DEFAULT 2, -- 1 critico | 2 alto | 3 normal
  status      TEXT NOT NULL DEFAULT 'open', -- open | matched | fulfilled | cancelled
  note        TEXT,
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acopio_needs_status ON acopio_needs(status, priority);
CREATE INDEX IF NOT EXISTS idx_acopio_needs_center ON acopio_needs(center_id);

-- ── Shipments: a transfer of commodities from origin → destination ──────────
CREATE TABLE IF NOT EXISTS acopio_shipments (
  id          TEXT PRIMARY KEY,         -- uid('shp')
  origin_id   TEXT NOT NULL,
  dest_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'creado', -- creado | despachado | en_transito | entregado | confirmado | cancelado
  vehicle     TEXT,                     -- vehicle / convoy id
  driver      TEXT,                     -- responsible person
  eta_ms      INTEGER,                  -- estimated arrival
  note        TEXT,
  created_by  TEXT,                     -- operator email/id
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acopio_shp_status ON acopio_shipments(status, updated_ms);

-- ── Manifest: line items carried by a shipment ──────────────────────────────
CREATE TABLE IF NOT EXISTS acopio_shipment_items (
  shipment_id TEXT NOT NULL,
  commodity   TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  unit        TEXT,
  PRIMARY KEY (shipment_id, commodity)
);

-- ── Chain of custody: append-only event log per shipment ────────────────────
CREATE TABLE IF NOT EXISTS acopio_custody (
  id          TEXT PRIMARY KEY,         -- uid('cus')
  shipment_id TEXT NOT NULL,
  event       TEXT NOT NULL,            -- creado | cargado | despachado | en_transito | entregado | confirmado | incidencia
  actor       TEXT,                     -- who recorded it
  lat         REAL,
  lon         REAL,
  note        TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acopio_custody_shp ON acopio_custody(shipment_id, at_ms);
