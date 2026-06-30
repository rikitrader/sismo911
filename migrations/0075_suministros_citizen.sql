-- SUMINISTROS — citizen enrollment + supply requests. Lets a logged-in CITIZEN
-- (beneficiario / coordinador de refugio / líder comunitario / organización)
-- apply ONE-TIME for access to the Suministros division; an operator approves the
-- application in the /console SPA; once approved the citizen can file supply
-- requests (alimentos/agua/medicinas/…) and track each request's status.
--
-- Separate from the operator-facing sum_* inventory tables: these two tables are
-- the CITIZEN-side intake + request log, not the warehouse ledger. Fully additive
-- and idempotent (CREATE … IF NOT EXISTS), so re-running the migration is a no-op.

-- One enrollment application per user (UNIQUE on user_id). status drives the page:
-- pendiente → "en revisión"; aprobada → dashboard; rechazada → re-apply.
CREATE TABLE IF NOT EXISTS sum_citizen_enrollments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  nombre      TEXT NOT NULL DEFAULT '',
  cedula      TEXT NOT NULL DEFAULT '',
  contacto    TEXT NOT NULL DEFAULT '',
  ubicacion   TEXT NOT NULL DEFAULT '',
  tipo        TEXT NOT NULL DEFAULT 'beneficiario', -- beneficiario|coordinador_refugio|lider_comunitario|organizacion
  personas    INTEGER NOT NULL DEFAULT 1,
  necesidad   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente|aprobada|rechazada
  review_note TEXT,
  reviewer    TEXT,
  created_ms  INTEGER NOT NULL,
  reviewed_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sum_cit_enr_user ON sum_citizen_enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_sum_cit_enr_status ON sum_citizen_enrollments(status, created_ms DESC);

-- A supply request filed by an APPROVED citizen. status tracks fulfillment.
CREATE TABLE IF NOT EXISTS sum_citizen_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tipo        TEXT NOT NULL,                        -- alimentos|agua|medicinas|higiene|abrigo|otro
  cantidad    INTEGER NOT NULL DEFAULT 1,
  urgencia    TEXT NOT NULL DEFAULT 'normal',       -- baja|normal|alta
  descripcion TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente|aprobada|en_camino|entregada|rechazada
  note        TEXT,
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_cit_req_user ON sum_citizen_requests(user_id, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sum_cit_req_status ON sum_citizen_requests(status, created_ms DESC);
