-- Manual override row for the /panorama "Balance oficial del gobierno" block.
-- fallecidos/heridos auto-update from the canonical casualties pipeline
-- (casualty_reports ai_extract via getCanonicalCasualties); this single row
-- covers the fields we do NOT track (rescatadas/damnificadas/campamentos/
-- estimación ONU) plus the corte label, and lets an operator hard-override
-- any figure when a new government parte lands. NULL field = no override.
-- Idempotent; written via POST /api/panorama/balance (damage:moderate).

CREATE TABLE IF NOT EXISTS panorama_balance (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  corte             TEXT,      -- e.g. '1 de julio de 2026'
  fallecidos        INTEGER,   -- manual override (beats canonical when set)
  heridos           INTEGER,
  rescatadas        INTEGER,
  damnificadas      INTEGER,
  campamentos       INTEGER,
  desaparecidos_onu TEXT,      -- free-form, e.g. '50.000+'
  fuente            TEXT,
  updated_ms        INTEGER NOT NULL
);
