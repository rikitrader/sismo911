-- 0028_ingestion_gatekeeper.sql
-- DB Ingestion Gatekeeper (src/security/*) — audit-trail tables.
--
-- The gate validates EVERY public write at the door (rate-limit → turnstile →
-- schema → spam-score → metadata-clean → file-scan → dedupe) and records the
-- outcome here. The existing `audit` table (migration 0002) stays for operator
-- actions; these three tables are the ingestion ledger:
--   rejected_ingestions — everything the gate blocked (+ reason code, score)
--   clean_ingestions    — everything the gate passed (correlation id ↔ written row)
--   ingest_dedupe       — payload/file content hashes seen, for replay/dup detection
--
-- Idempotent (CREATE … IF NOT EXISTS) so re-running migrations is safe.

-- Blocked submissions. We DO NOT store the raw rejected payload verbatim by
-- default (it may itself be an XSS/abuse string); `sample` is a truncated,
-- already-normalized excerpt for triage. `reason` is a stable machine code
-- (see REASON_CODES in src/security/ingestion-gate.ts), `detail` is human text.
CREATE TABLE IF NOT EXISTS rejected_ingestions (
  id             TEXT PRIMARY KEY,         -- uid('rej')
  correlation_id TEXT NOT NULL,            -- ties to the request + structured log line
  surface        TEXT NOT NULL,            -- 'contact' | 'photo' | 'persona' | 'map_report' | 'api'
  reason         TEXT NOT NULL,            -- machine reason code (e.g. 'spam_score', 'bad_magic_bytes')
  detail         TEXT,                     -- human-readable explanation (internal only)
  score          INTEGER,                  -- spam score at rejection (nullable)
  ip             TEXT,                     -- cf-connecting-ip
  asn            INTEGER,                  -- cf.asn when available
  country        TEXT,                     -- cf.country
  user_agent     TEXT,
  payload_hash   TEXT,                     -- sha-256 of the normalized payload (replay detection)
  sample         TEXT,                     -- truncated normalized excerpt for triage (<=512 chars)
  created_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rejected_created ON rejected_ingestions (created_ms);
CREATE INDEX IF NOT EXISTS idx_rejected_reason  ON rejected_ingestions (reason);
CREATE INDEX IF NOT EXISTS idx_rejected_ip      ON rejected_ingestions (ip);

-- Accepted submissions. One row per write that passed the gate, linking the
-- correlation id to the destination table + row id, so any clean row is fully
-- traceable back to the request that produced it.
CREATE TABLE IF NOT EXISTS clean_ingestions (
  id             TEXT PRIMARY KEY,         -- uid('cln')
  correlation_id TEXT NOT NULL,
  surface        TEXT NOT NULL,
  dest_table     TEXT,                     -- D1 table the row was written to
  dest_id        TEXT,                     -- primary key of the written row
  r2_key         TEXT,                     -- R2 object key when a file was stored
  score          INTEGER NOT NULL DEFAULT 0,
  ip             TEXT,
  country        TEXT,
  payload_hash   TEXT,
  created_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clean_created     ON clean_ingestions (created_ms);
CREATE INDEX IF NOT EXISTS idx_clean_correlation ON clean_ingestions (correlation_id);

-- Content-hash ledger for dedupe + replay detection. `hash` is sha-256 of either
-- the normalized JSON payload or the uploaded file bytes; `kind` distinguishes
-- them. UNIQUE(hash) makes "have we seen this exact content before?" a single
-- indexed lookup — the gate treats a repeat within the replay window as spam.
CREATE TABLE IF NOT EXISTS ingest_dedupe (
  hash        TEXT PRIMARY KEY,            -- sha-256 hex
  kind        TEXT NOT NULL,              -- 'payload' | 'file'
  surface     TEXT,
  hits        INTEGER NOT NULL DEFAULT 1, -- how many times this content was submitted
  first_ms    INTEGER NOT NULL,
  last_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedupe_last ON ingest_dedupe (last_ms);
