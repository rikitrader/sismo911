-- Atomic rate-limit buckets. D1/SQLite gives us a single-statement atomic
-- increment (INSERT ... ON CONFLICT DO UPDATE ... RETURNING), which the KV
-- limiter cannot (read-then-write race) and which KV also can't sustain on a
-- hot key (~1 write/s/key → 429). Used by burstLimit() for abuse-prone public
-- write endpoints. Life-safety endpoints (SOS, check-ins) never use this.
CREATE TABLE IF NOT EXISTS rate_buckets (
  key      TEXT PRIMARY KEY,   -- "<name>:<ip>"
  count    INTEGER NOT NULL,
  reset_ms INTEGER NOT NULL    -- epoch ms when the window resets
);
CREATE INDEX IF NOT EXISTS idx_rate_buckets_reset ON rate_buckets (reset_ms);
