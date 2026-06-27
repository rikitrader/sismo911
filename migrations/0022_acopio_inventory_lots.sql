-- OpenBoxes-inspired lot controls for emergency logistics.
-- Tracks expiring stock, bin/location labels, and quarantine/damaged inventory
-- without changing the fast aggregate acopio_inventory table used for matching.

CREATE TABLE IF NOT EXISTS acopio_inventory_lots (
  id             TEXT PRIMARY KEY,         -- uid('lot')
  center_id      TEXT NOT NULL,
  commodity      TEXT NOT NULL,
  qty            REAL NOT NULL DEFAULT 0,
  unit           TEXT,
  lot_number     TEXT,
  expiration_ms  INTEGER,
  bin_location   TEXT,
  condition      TEXT NOT NULL DEFAULT 'usable', -- usable | quarantine | expired | damaged
  source         TEXT,
  updated_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acopio_lots_center ON acopio_inventory_lots(center_id, commodity);
CREATE INDEX IF NOT EXISTS idx_acopio_lots_expiry ON acopio_inventory_lots(expiration_ms);
CREATE INDEX IF NOT EXISTS idx_acopio_lots_condition ON acopio_inventory_lots(condition);
