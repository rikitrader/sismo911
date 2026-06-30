-- SUMINISTROS — Kits / BOM (bill of materials). A kit is a named bundle of
-- products+quantities (e.g. an IEHK first-aid kit). Cost and "buildable" count
-- are derived on read from component cost + on-hand; assembling a kit consumes
-- its components through the existing atomic movement ledger.
CREATE TABLE IF NOT EXISTS sum_kits (
  id           TEXT PRIMARY KEY,             -- kit_xxxxxxxx
  codigo       TEXT NOT NULL UNIQUE,         -- KIT-XXXXXX
  nombre       TEXT NOT NULL,
  categoria_id TEXT,
  descripcion  TEXT,
  activo       INTEGER NOT NULL DEFAULT 1,
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sum_kit_lineas (
  id          TEXT PRIMARY KEY,              -- kl_xxxxxxxx
  kit_id      TEXT NOT NULL,
  producto_id TEXT NOT NULL,
  cantidad    REAL NOT NULL,                 -- units of this product per 1 kit
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_kit_lineas_kit ON sum_kit_lineas(kit_id);
