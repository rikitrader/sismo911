-- Agent activity tracking — one row per poll/ingest cycle of an automated agent
-- (the cron pollers). Gives the CRM a continuous, operator-visible audit that the
-- system keeps working the missing-person backlog: what was polled, how much new
-- data arrived, how many name-matches it produced, and how many cases are STILL
-- unresolved ("aún sin localizar"). Per-CASE updates remain in person_events; this
-- is the global heartbeat/tracking feed.
CREATE TABLE IF NOT EXISTS agent_activity (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,                 -- poller id: pacientes-rvz | rav | familia | hospital-match …
  action        TEXT NOT NULL DEFAULT 'poll',  -- poll | match | ingest
  fetched       INTEGER NOT NULL DEFAULT 0,    -- rows seen upstream
  created       INTEGER NOT NULL DEFAULT 0,    -- new rows written
  updated       INTEGER NOT NULL DEFAULT 0,    -- rows refreshed
  matched       INTEGER NOT NULL DEFAULT 0,    -- name-matches → case leads this cycle
  still_missing INTEGER NOT NULL DEFAULT 0,    -- unresolved missing cases at this moment
  summary       TEXT NOT NULL DEFAULT '',      -- agent-narrated one-liner for the tracking feed
  ok            INTEGER NOT NULL DEFAULT 1,    -- 1 ok, 0 failed
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_source ON agent_activity(source, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_ts     ON agent_activity(created_ms DESC);
