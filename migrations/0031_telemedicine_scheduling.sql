-- Telemedicine scheduling v2 — direct booking against doctor availability.
-- Replaces the patient "request queue" UX with a self-service flow:
--   specialty → doctor → appointment type → date → free slot → reason →
--   insurance (FREE consult) → confirmation, plus a 7-state status lifecycle.
-- Additive + fully idempotent (all CREATE TABLE/INDEX IF NOT EXISTS). The legacy
-- telemed_requests table is left intact (no longer used by the new UI).
-- All slot times are LOCAL to America/Caracas (fixed UTC-4, no DST since 2016);
-- start_ms/end_ms store the absolute UTC instant for sorting / ICS / now-checks.

-- Per-doctor scheduling preferences. Separate table (not ALTER) to stay idempotent.
CREATE TABLE IF NOT EXISTS telemed_doctor_prefs (
  doctor_id    TEXT PRIMARY KEY,                 -- telemed_doctors.id
  slot_minutes INTEGER NOT NULL DEFAULT 30,      -- slot granularity (step)
  accepting    INTEGER NOT NULL DEFAULT 1,       -- 1 = bookable, 0 = paused
  appt_types   TEXT NOT NULL DEFAULT '["video","followup","urgent","mental_health","refill"]',
  updated_ms   INTEGER
);

-- Recurring weekly availability windows (one row per window; many per weekday OK).
CREATE TABLE IF NOT EXISTS telemed_availability (
  id         TEXT PRIMARY KEY,                   -- av_...
  doctor_id  TEXT NOT NULL,
  weekday    INTEGER NOT NULL,                   -- 0=Sun .. 6=Sat (local Caracas)
  start_min  INTEGER NOT NULL,                   -- minutes from local midnight
  end_min    INTEGER NOT NULL,
  created_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telemed_av_doctor ON telemed_availability(doctor_id, weekday);

-- One-off blocked dates / time off (start_min/end_min NULL = whole day blocked).
CREATE TABLE IF NOT EXISTS telemed_blocks (
  id         TEXT PRIMARY KEY,                   -- blk_...
  doctor_id  TEXT NOT NULL,
  date       TEXT NOT NULL,                      -- YYYY-MM-DD (local)
  start_min  INTEGER,
  end_min    INTEGER,
  reason     TEXT,
  created_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telemed_blk_doctor ON telemed_blocks(doctor_id, date);

-- A booked appointment (the new core entity).
CREATE TABLE IF NOT EXISTS telemed_appointments (
  id                  TEXT PRIMARY KEY,          -- apt_...
  doctor_id           TEXT NOT NULL,
  patient_name        TEXT NOT NULL,
  patient_email       TEXT,
  patient_phone       TEXT,
  specialty           TEXT,
  appt_type           TEXT NOT NULL DEFAULT 'video',  -- video|followup|urgent|mental_health|refill
  reason              TEXT,                      -- intake reason / symptoms
  insurance_provider  TEXT,                      -- optional; consult is free
  insurance_member_id TEXT,
  date                TEXT NOT NULL,             -- YYYY-MM-DD (local Caracas)
  start_min           INTEGER NOT NULL,          -- local minutes from midnight
  end_min             INTEGER NOT NULL,
  start_ms            INTEGER NOT NULL,          -- absolute UTC ms
  end_ms              INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|checked_in|waiting_room|in_progress|completed|cancelled|no_show
  video_url           TEXT,                      -- Jitsi room
  preferred_lang      TEXT DEFAULT 'es',
  manage_token        TEXT NOT NULL,             -- patient secret to view/manage
  ip                  TEXT,
  created_at          TEXT,
  created_ms          INTEGER,
  updated_ms          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telemed_apt_doctor   ON telemed_appointments(doctor_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_telemed_apt_token    ON telemed_appointments(manage_token);
CREATE INDEX IF NOT EXISTS idx_telemed_apt_slotlock ON telemed_appointments(doctor_id, date, start_min);
CREATE INDEX IF NOT EXISTS idx_telemed_apt_status   ON telemed_appointments(status, start_ms);

-- Append-only status timeline (powers patient tracking + audit).
CREATE TABLE IF NOT EXISTS telemed_appt_status (
  id             TEXT PRIMARY KEY,               -- sh_...
  appointment_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  actor          TEXT,                           -- patient | doctor | system
  note           TEXT,
  at_ms          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemed_apt_status_appt ON telemed_appt_status(appointment_id, at_ms);
