-- 0070_username_unique.sql — enforce unique vanity handles for public pay links.
-- The users.username column already exists (0046) but was unused. This adds a
-- UNIQUE index so /u/<handle> resolves to exactly one account. SQLite unique
-- indexes permit multiple NULLs, so existing handle-less users are unaffected.
-- Idempotent: IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
