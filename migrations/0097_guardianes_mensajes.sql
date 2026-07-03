-- 0097_guardianes_mensajes.sql — Messages sent to the Guardianes founding ally
-- from its public profile page (/guardianes). The contact form posts here
-- (POST /api/guardianes/mensaje); messages are stored and emailed to Guardianes'
-- configured address (GUARDIANES_CONTACT_EMAIL) — falling back to ops relay.
-- Idempotent (CREATE ... IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS guardianes_mensajes (
  id          TEXT PRIMARY KEY,
  ref         TEXT NOT NULL,               -- human-facing reference, e.g. GUA-4F9C2A
  nombre      TEXT NOT NULL,
  email       TEXT NOT NULL,
  telefono    TEXT,
  organizacion TEXT,
  asunto      TEXT,                         -- reason: alianza | donacion | voluntariado | caso | prensa | otro
  mensaje     TEXT NOT NULL,
  estado      TEXT NOT NULL DEFAULT 'nuevo', -- nuevo | leido | respondido | archivado
  entregado   INTEGER NOT NULL DEFAULT 0,   -- 1 once forwarded by email
  ip_hash     TEXT,
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardianes_msg_created ON guardianes_mensajes (created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_guardianes_msg_estado  ON guardianes_mensajes (estado, created_ms DESC);
