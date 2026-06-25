-- Citizen-proposed collection centers ("centros de acopio").
-- The curated national catalog lives in /acopio-data.json; this table holds
-- centers reported/created by the public via /acopio, entering a moderation
-- queue. Approved rows surface on the public map through /api/acopio/centers;
-- operators review the queue from /admin (Acopio tab).
CREATE TABLE IF NOT EXISTS acopio_submissions (
  id          TEXT PRIMARY KEY,       -- uid('acs')
  nombre      TEXT NOT NULL,          -- center name
  tipo        TEXT NOT NULL,          -- centro_acopio | universidad | estadio | polideportivo | hospital | proteccion_civil | bomberos | otro
  estado      TEXT,                   -- entidad federal
  ciudad      TEXT,
  dir         TEXT,                   -- street address / reference
  lat         REAL,
  lon         REAL,
  contacto    TEXT,                   -- phone / WhatsApp (operator-only; not published)
  reporter    TEXT,                   -- submitter name (optional)
  note        TEXT,                   -- needs, capacity, hours, etc.
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acopio_sub_status ON acopio_submissions(status, created_ms);
