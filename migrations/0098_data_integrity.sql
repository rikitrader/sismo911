-- Data-integrity pipeline tables (plan Increment 3).
-- Idempotent: CREATE IF NOT EXISTS only — safe to re-run.
--
-- NOTE ON ALIASES: there is deliberately NO record_aliases table. The personas
-- registry already carries its alias/rollback record: a merged loser keeps its
-- row with merged_into=<keeper> + moderation='rejected', and every scripted
-- merge is journaled in personas_merge_log (restorable). These tables add the
-- run/candidate/conflict/report bookkeeping around that existing machinery.

-- One row per dedupe engine run (cron tick or script invocation).
CREATE TABLE IF NOT EXISTS dedupe_runs (
  id            TEXT PRIMARY KEY,            -- ddr_<ts36>
  source        TEXT NOT NULL,               -- 'cron' | 'script' | 'ingest-gate'
  table_name    TEXT NOT NULL,               -- table swept (personas, hospital_patients, …)
  watermark_ms  INTEGER,                     -- rows updated_at/created_at <= this were considered
  scanned       INTEGER NOT NULL DEFAULT 0,
  candidates    INTEGER NOT NULL DEFAULT 0,
  auto_merged   INTEGER NOT NULL DEFAULT 0,
  queued_review INTEGER NOT NULL DEFAULT 0,
  conflicts     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ok',  -- ok | error
  error         TEXT,
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedupe_runs_created ON dedupe_runs(created_ms DESC);

-- Every scored pair ≥ the review threshold. UNIQUE(pair) is the idempotency
-- guarantee: a pair is scored/queued/merged at most once, ever.
CREATE TABLE IF NOT EXISTS dedupe_candidates (
  id           TEXT PRIMARY KEY,             -- ddc_<hash>
  run_id       TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  id_a         TEXT NOT NULL,                -- lexicographically smaller id
  id_b         TEXT NOT NULL,
  score        INTEGER NOT NULL,             -- 0..300 layered score
  signals      TEXT NOT NULL DEFAULT '[]',   -- JSON: which rules fired
  decision     TEXT NOT NULL DEFAULT 'review', -- auto_merge | review | ignored | merged | rejected
  decided_by   TEXT,                         -- 'engine' | operator email
  decided_ms   INTEGER,
  created_ms   INTEGER NOT NULL,
  UNIQUE (table_name, id_a, id_b)
);
CREATE INDEX IF NOT EXISTS idx_dedupe_candidates_decision ON dedupe_candidates(decision, table_name);

-- Field-level conflicts found while considering a merge (e.g. one record says
-- localizada, the other fallecida). NEVER auto-resolved — human review only.
CREATE TABLE IF NOT EXISTS dedupe_conflicts (
  id           TEXT PRIMARY KEY,             -- ddx_<ts36>
  candidate_id TEXT NOT NULL,
  field        TEXT NOT NULL,
  value_a      TEXT,
  value_b      TEXT,
  severity     TEXT NOT NULL DEFAULT 'review', -- review | critical (alive-vs-deceased)
  resolved     INTEGER NOT NULL DEFAULT 0,
  resolved_by  TEXT,
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedupe_conflicts_open ON dedupe_conflicts(resolved, severity);

-- One row per external-ingest run (any source) — the pre-ingest gate writes
-- 'gated' rows, adapters write 'ok'/'error' rows.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id           TEXT PRIMARY KEY,             -- igr_<ts36>
  source_name  TEXT NOT NULL,
  status       TEXT NOT NULL,                -- gated | dry_run | ok | error | blocked
  fetched      INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  skipped_dup  INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,                         -- JSON free-form
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_source ON ingest_runs(source_name, created_ms DESC);

CREATE TABLE IF NOT EXISTS ingest_errors (
  id          TEXT PRIMARY KEY,              -- ige_<ts36>
  run_id      TEXT NOT NULL,
  source_name TEXT NOT NULL,
  record_ref  TEXT,                          -- upstream id / url of the failing record
  error       TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_errors_run ON ingest_errors(run_id);

-- Periodic data-quality snapshots (hourly job + db:map stamp target).
CREATE TABLE IF NOT EXISTS data_quality_reports (
  id            TEXT PRIMARY KEY,            -- dqr_<ts36>
  kind          TEXT NOT NULL,               -- hourly_dedupe | db_map | cleanup | manual
  metrics       TEXT NOT NULL DEFAULT '{}',  -- JSON metrics blob
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dqr_kind ON data_quality_reports(kind, created_ms DESC);
