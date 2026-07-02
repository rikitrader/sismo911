-- 0093: Engineering-evaluation layer for the building forensic dossier (/edificio/:id).
-- PM-style pipeline of ATC-20-inspired evaluation levels per building:
--   Nivel 1 = Evaluación Rápida (rapid exterior triage)
--   Nivel 2 = Evaluación Detallada (detailed interior/exterior assessment)
--   Nivel 3 = Evaluación de Ingeniería (full engineering evaluation)
-- Each row is a SIGNED tracking event: the server computes a SHA-256 signature
-- over the canonical payload at insert time, making the trail tamper-evident.
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS building_eval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id TEXT NOT NULL,                     -- tv_buildings.id or sos_damage.id
  level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  status TEXT CHECK (status IN ('pendiente','en_curso','completada','bloqueada')),
  event_kind TEXT NOT NULL DEFAULT 'nota',       -- inicio|inspeccion|hallazgo|documento|cambio_estado|firma|nota
  note TEXT,
  actor_name TEXT,                               -- who performed/recorded it
  actor_role TEXT,                               -- e.g. Ing. Estructural / PM / Protección Civil
  signed_by TEXT,                                -- signatory (may differ from actor)
  signature TEXT NOT NULL,                       -- SHA-256 hex over the canonical payload (tamper-evident)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bee_building ON building_eval_events (building_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bee_level ON building_eval_events (building_id, level);
