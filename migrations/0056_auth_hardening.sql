-- 0056_auth_hardening.sql — security-audit low-severity hardening (L1 + L2).
-- L1 (TOTP one-time): mfa_last_step records the last consumed TOTP counter step so
--   a still-valid code can't be replayed.
-- L2 (per-account MFA lockout): mfa_fail_count + mfa_locked_until give an
--   account-level backoff independent of the per-IP rate limiter.
-- Additive + idempotent (the tracker runs each ADD COLUMN once).
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_fail_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until INTEGER;

-- Audit M1 cleanup: donations.amount is an INTENTIONALLY PUBLIC crowdfunding total
-- (raised amounts are displayed to everyone). A donations:read field policy there
-- would wrongly hide it if the redaction layer were ever wired to donations — drop
-- the mismatched seed row.
DELETE FROM field_policies WHERE id = 'fp_004';
