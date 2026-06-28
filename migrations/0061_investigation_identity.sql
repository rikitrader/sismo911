-- Investigation CRM + identity verification for the missing-person case file.
-- Two tables. case_intel = curated/crowdsourced investigation leads (photos,
-- social profiles, links, public sightings, tips) per case. case_identity =
-- operator-only identity-verification records against Venezuelan institutions
-- (CNE/RIF/SAIME/IVSS). The cédula and cross-referenced result are NEVER public;
-- the public sees only a derived "identity verified" badge (see GET /:id/docket).
-- Idempotent: CREATE ... IF NOT EXISTS so re-runs are safe.

CREATE TABLE IF NOT EXISTS case_intel (
  id            TEXT PRIMARY KEY,                 -- intl_xxxxxxxx
  person_id     TEXT NOT NULL,                    -- persons.id OR fam-<personas.id> OR hosp-<id>
  type          TEXT NOT NULL DEFAULT 'link',     -- photo | social | link | sighting | tip | doc
  url           TEXT,                             -- external URL (photo / social profile / news)
  platform      TEXT,                             -- e.g. instagram | x | tiktok | facebook | news
  title         TEXT,                             -- short label
  detail        TEXT,                             -- free-text note (bounded in handler)
  lat           REAL,                             -- optional sighting coordinates
  lon           REAL,
  source        TEXT NOT NULL DEFAULT 'operator', -- operator | citizen
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | dismissed
  submitted_by  TEXT,                             -- operator email/id; NULL for anonymous tips
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_intel_person ON case_intel(person_id, status);
CREATE INDEX IF NOT EXISTS idx_case_intel_created ON case_intel(created_ms);

CREATE TABLE IF NOT EXISTS case_identity (
  id            TEXT PRIMARY KEY,                 -- idv_xxxxxxxx
  person_id     TEXT NOT NULL,                    -- persons.id OR fam-<personas.id> OR hosp-<id>
  cedula        TEXT,                             -- OPERATOR-ONLY. Never returned to the public.
  source        TEXT NOT NULL,                    -- cne | rif | saime | ivss | manual
  result        TEXT NOT NULL DEFAULT 'pending',  -- match | no_match | partial | unavailable | pending
  matched_name  TEXT,                             -- name returned by the institution (operator-only)
  detail_json   TEXT,                             -- e.g. CNE centro de votación / estado (operator-only)
  snapshot_r2   TEXT,                             -- R2 key of raw verification evidence (operator-only)
  verified_by   TEXT,                             -- operator email/id
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_identity_person ON case_identity(person_id, result);
