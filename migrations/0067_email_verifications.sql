-- Email verification tokens (AUTH-01 → AUTH-02 flow from the transactional-email
-- catalog). Mirrors the password_resets shape: hashed, single-use, TTL'd token.
-- Advisory model — verifying marks users.email_verified=1 and sends the welcome
-- email, but an unverified user is NOT blocked from logging in (preserves current
-- live signup behavior). Idempotent (CREATE … IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS email_verifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_ms     INTEGER,
  created_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
