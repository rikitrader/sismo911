-- Native volunteer registry for the /voluntarios page. People who want to help
-- after the quake register here (name, contact, location, skills, availability).
-- moderation defaults to 'approved' (disaster response is time-critical) with
-- link/spam gating on submit; an operator can flag/hide later.
CREATE TABLE IF NOT EXISTS volunteers (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  contact_phone TEXT,
  email         TEXT,
  city          TEXT,
  state         TEXT,
  area          TEXT,
  skills        TEXT NOT NULL DEFAULT '[]',   -- JSON array of skill keys
  availability  TEXT,                         -- inmediata | dias | fines_de_semana | remoto
  has_vehicle   INTEGER NOT NULL DEFAULT 0,
  can_travel    INTEGER NOT NULL DEFAULT 0,
  experience    TEXT,
  notes         TEXT,
  moderation    TEXT NOT NULL DEFAULT 'approved',  -- approved | pending | rejected
  status        TEXT NOT NULL DEFAULT 'activo',    -- activo | inactivo
  ip            TEXT,
  created_at    TEXT,
  created_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_volunteers_created ON volunteers(created_ms DESC);
