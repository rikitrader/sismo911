-- MFA backup codes + enrollment timestamp, session device/last-seen metadata,
-- and a trusted-devices registry. Additive + idempotent (one ADD COLUMN per
-- statement, constant defaults — D1/SQLite requirement). The migration tracker
-- prevents re-runs, so bare ADD COLUMN is safe.

-- Backup recovery codes (JSON array of sha256(code)) + when MFA was enrolled.
ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT;
ALTER TABLE users ADD COLUMN mfa_enrolled_ms  INTEGER;

-- Human-friendly device label parsed from the UA + last-seen heartbeat.
ALTER TABLE sessions ADD COLUMN device_label TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_ms INTEGER;

-- Devices a user has explicitly trusted (skip MFA / remember-this-device).
CREATE TABLE IF NOT EXISTS trusted_devices (
  id           TEXT PRIMARY KEY,                  -- td_xxxxxxxx
  user_id      TEXT,
  label        TEXT,
  ua           TEXT,
  ip           TEXT,
  created_ms   INTEGER,
  last_seen_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);
