-- Telemedicine v2 — doctor clinical workspace: consult history/notes, a small
-- consult checklist, and an informational prescription ("récipe / indicación
-- médica") record. Notes + prescriptions are APPEND-ONLY = the audit trail
-- (nothing is edited/deleted; revisions are new rows). All idempotent.

-- Mutable per-consult summary + checklist (the plan the patient sees).
CREATE TABLE IF NOT EXISTS telemed_consults (
  appointment_id TEXT PRIMARY KEY,
  summary    TEXT,                 -- indicaciones / plan (visible to patient)
  checklist  TEXT,                 -- JSON booleans (receta_emitida, requiere_seguimiento, referido_presencial)
  updated_ms INTEGER,
  updated_by TEXT
);

-- Append-only clinical history / notes (doctor-only) — the audit trail.
CREATE TABLE IF NOT EXISTS telemed_consult_notes (
  id             TEXT PRIMARY KEY,   -- cn_...
  appointment_id TEXT NOT NULL,
  doctor_id      TEXT,
  body           TEXT NOT NULL,
  at_ms          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemed_cnotes ON telemed_consult_notes(appointment_id, at_ms);

-- Append-only prescriptions / indicaciones (each issuance is a trail entry).
CREATE TABLE IF NOT EXISTS telemed_prescriptions (
  id             TEXT PRIMARY KEY,   -- rx_...
  appointment_id TEXT NOT NULL,
  doctor_id      TEXT,
  items          TEXT NOT NULL,      -- JSON array [{med,dose,freq,duration,notes}]
  notes          TEXT,
  issued_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemed_rx ON telemed_prescriptions(appointment_id, issued_ms);
