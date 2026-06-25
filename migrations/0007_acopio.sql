-- Live operational status for acopio centers, hospitals, Protección Civil & Bomberos.
-- The catalog itself lives in /acopio-data.json (single source); this table only
-- stores operator-set status overrides keyed by the catalog's stable id.
-- Default (no row) = "operativo".
CREATE TABLE IF NOT EXISTS acopio_status (
  id          TEXT PRIMARY KEY,       -- matches id in /acopio-data.json
  status      TEXT NOT NULL,          -- operativo | saturado | cerrado
  note        TEXT,                   -- optional operator note (cupo, daños, contacto)
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acopio_status ON acopio_status(status);
