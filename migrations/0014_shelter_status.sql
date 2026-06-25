-- Crowd-sourced shelter status. Anyone can report a shelter's operational state
-- (activo / lleno / cerrado); submissions enter moderation (status='pending') and
-- are shown on the map only once an operator approves. Operator-only status would
-- sit empty during the acute window, so this is intentionally crowd-sourced + moderated.
CREATE TABLE IF NOT EXISTS shelter_status (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  lat          REAL,
  lon          REAL,
  status       TEXT NOT NULL DEFAULT 'activo',   -- activo | lleno | cerrado
  capacity_note TEXT,
  moderation   TEXT NOT NULL DEFAULT 'pending',  -- pending | approved
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shelter_status_mod ON shelter_status (moderation, updated_ms);
