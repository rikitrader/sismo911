-- Password reset tokens (hashed). Single-use, time-limited.
CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the emailed token
  expires_ms  INTEGER NOT NULL,
  used_ms     INTEGER,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_user ON password_resets(user_id);
