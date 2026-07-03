-- 0096_alianza_solicitudes.sql — Alliance ("Alianza Humanitaria") partnership requests.
-- Public CTA page /alianza posts here (POST /api/alianza). No PII beyond what an
-- applicant voluntarily submits to become a partner; operator review is gated by
-- ops:console (GET /api/alianza/admin/*). Idempotent (CREATE ... IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS alianza_solicitudes (
  id            TEXT PRIMARY KEY,
  ref           TEXT NOT NULL,               -- human-facing reference, e.g. ALI-4F9C2A
  nombre        TEXT NOT NULL,               -- full name of the contact person
  organizacion  TEXT NOT NULL,               -- organization / company name
  tipo          TEXT NOT NULL,               -- partner type (empresa, ong, medico, ...)
  email         TEXT NOT NULL,
  telefono      TEXT,
  ubicacion     TEXT,                        -- país / ciudad
  area          TEXT,                        -- área de apoyo
  mensaje       TEXT,
  estado        TEXT NOT NULL DEFAULT 'nueva', -- nueva | revisando | aceptada | archivada
  ip_hash       TEXT,                        -- coarse abuse signal (hashed), never raw IP
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alianza_created ON alianza_solicitudes (created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_alianza_estado  ON alianza_solicitudes (estado, created_ms DESC);
