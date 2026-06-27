-- Telemedicine: doctors anywhere in the world accept medical-help requests for
-- people in Venezuela. Two tables:
--   telemed_doctors  — self-registered physicians (panel_token gates their panel)
--   telemed_requests — patient/relative intake; a doctor claims → schedules a
--                      video consult (Jitsi) → marks completed.
-- moderation defaults to 'approved' (disaster response is time-critical) with
-- link/spam gating on submit; an operator can flag/hide later.

CREATE TABLE IF NOT EXISTS telemed_doctors (
  id           TEXT PRIMARY KEY,          -- doc_...
  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  country      TEXT,                       -- where the doctor is (worldwide)
  specialty    TEXT,                       -- general | pediatria | cardiologia | ...
  license_no   TEXT,                       -- self-reported medical license
  languages    TEXT NOT NULL DEFAULT '[]', -- JSON array (es,en,pt,...)
  bio          TEXT,
  panel_token  TEXT,                       -- secret to access the doctor panel
  verified     INTEGER NOT NULL DEFAULT 0, -- operator-verified credentials
  moderation   TEXT NOT NULL DEFAULT 'approved',  -- approved | pending | rejected
  status       TEXT NOT NULL DEFAULT 'activo',    -- activo | inactivo
  ip           TEXT,
  created_at   TEXT,
  created_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telemed_doctors_created ON telemed_doctors(created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemed_doctors_email   ON telemed_doctors(email);

CREATE TABLE IF NOT EXISTS telemed_requests (
  id               TEXT PRIMARY KEY,       -- req_...
  patient_name     TEXT NOT NULL,
  patient_email    TEXT,
  patient_phone    TEXT,
  requester_country TEXT,                  -- where the person submitting is (worldwide)
  patient_state    TEXT,                   -- VE state where the patient is
  patient_city     TEXT,
  specialty        TEXT,                   -- specialty needed
  urgency          TEXT NOT NULL DEFAULT 'normal',  -- baja | normal | alta | critica
  preferred_lang   TEXT DEFAULT 'es',
  description       TEXT,                   -- symptoms / situation
  status           TEXT NOT NULL DEFAULT 'open',  -- open | claimed | scheduled | completed | cancelled
  doctor_id        TEXT,                   -- telemed_doctors.id once claimed
  scheduled_start_ms INTEGER,
  scheduled_end_ms   INTEGER,
  video_url        TEXT,                   -- Jitsi room once scheduled
  manage_token     TEXT,                   -- patient's secret to view status
  ip               TEXT,
  created_at       TEXT,
  created_ms       INTEGER,
  updated_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telemed_req_status   ON telemed_requests(status, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemed_req_doctor   ON telemed_requests(doctor_id, scheduled_start_ms);
CREATE INDEX IF NOT EXISTS idx_telemed_req_schedule ON telemed_requests(scheduled_start_ms);
