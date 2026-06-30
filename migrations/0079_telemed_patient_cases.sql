-- Telemedicina ↔ Casos bridge: register every patient once, and follow up every
-- consult as a trackable MEDICAL CASE — all inside the single sismo911 D1 (so the
-- "medical DB" is now relationally attached to the public cases DB; there is no
-- separate database, the link is by foreign keys + a small case layer).
--
-- WHY: until now telemed_appointments / telemed_requests carried denormalized
-- patient fields (name, cédula, email…) with NO persistent patient identity and
-- NO connection to the /casos investigation system. This migration adds:
--   patients              — the patient master record (deduped by cédula)
--   telemed_*.patient_id  — every consult links to its patient
--   patient_cases         — one followable medical case per patient (lifecycle)
--   patient_case_events   — append-only follow-up timeline (the audit trail)
-- and an optional person_id link so a medical case can attach to a public case
-- file (persons.id | fam-<personas.id> | hosp-<rav_reports.id>).
--
-- Idempotent: CREATE … IF NOT EXISTS throughout. The three ALTERs add brand-new
-- columns (clean on first apply; re-runs error and are skipped by the tracker).

-- ── Patient master registry ────────────────────────────────────────────────
-- One row per real patient. Dedup key = normalized cédula when present, else the
-- service layer falls back to email / phone. person_id optionally bridges the
-- patient to a public case file (operator action).
CREATE TABLE IF NOT EXISTS patients (
  id          TEXT PRIMARY KEY,          -- pat_...
  cedula      TEXT,                       -- normalized digits (dedup key when set)
  full_name   TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  dob         TEXT,                       -- YYYY-MM-DD
  gender      TEXT,                       -- Femenino | Masculino | Otro | Prefiero no decir
  state       TEXT,                       -- VE state
  city        TEXT,
  person_id   TEXT,                       -- public-case link: persons.id | fam-<id> | hosp-<id>
  notes       TEXT,
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
-- One patient per cédula. Partial unique index → multiple NULL/'' cédulas allowed
-- (anonymous intakes), but a real cédula can never duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_cedula ON patients(cedula) WHERE cedula IS NOT NULL AND cedula <> '';
CREATE INDEX IF NOT EXISTS idx_patients_email  ON patients(email);
CREATE INDEX IF NOT EXISTS idx_patients_phone  ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_person ON patients(person_id);

-- ── Link consults to their patient ─────────────────────────────────────────
ALTER TABLE telemed_appointments ADD COLUMN patient_id TEXT;
ALTER TABLE telemed_requests     ADD COLUMN patient_id TEXT;
CREATE INDEX IF NOT EXISTS idx_telemed_appt_patient ON telemed_appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_telemed_req_patient  ON telemed_requests(patient_id);

-- ── Followable medical case ────────────────────────────────────────────────
-- The case that "follows up" a patient across consults. A patient has at most one
-- OPEN case at a time (non-terminal status); new consults reuse / reopen it.
-- Statuses (Spanish, mirroring the rest of the app):
--   abierto | en_consulta | seguimiento | resuelto | cancelado
CREATE TABLE IF NOT EXISTS patient_cases (
  id                     TEXT PRIMARY KEY,                 -- mcase_...
  patient_id             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'abierto',
  priority               TEXT NOT NULL DEFAULT 'normal',   -- baja | normal | alta | critica
  specialty              TEXT,
  assigned_doctor_id     TEXT,                             -- telemed_doctors.id
  opening_appointment_id TEXT,                             -- consult that opened it
  person_id              TEXT,                             -- public-case link (mirrors patients.person_id)
  summary                TEXT,                             -- latest clinical summary (operator/doctor only)
  opened_ms              INTEGER NOT NULL,
  updated_ms             INTEGER NOT NULL,
  last_activity_ms       INTEGER NOT NULL,
  closed_ms              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_patient_cases_patient ON patient_cases(patient_id, opened_ms DESC);
CREATE INDEX IF NOT EXISTS idx_patient_cases_status  ON patient_cases(status, last_activity_ms DESC);
CREATE INDEX IF NOT EXISTS idx_patient_cases_doctor  ON patient_cases(assigned_doctor_id, status);
CREATE INDEX IF NOT EXISTS idx_patient_cases_person  ON patient_cases(person_id);

-- ── Append-only follow-up timeline (the audit trail) ───────────────────────
-- Every meaningful step is a row; nothing is edited or deleted.
--   booked | checked_in | consult_started | completed | no_show | cancelled
--   note_added | rx_issued | followup_needed | linked_person | unlinked_person
--   status_change | reopened | resolved
CREATE TABLE IF NOT EXISTS patient_case_events (
  id             TEXT PRIMARY KEY,        -- pce_...
  case_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  appointment_id TEXT,
  detail         TEXT,
  actor          TEXT,                     -- doctor id | operator email | 'system'
  at_ms          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patient_case_events ON patient_case_events(case_id, at_ms DESC);
