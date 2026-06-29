-- 0069_notifications.sql — in-app notifications for the Profile Command Center.
-- Idempotent (CREATE … IF NOT EXISTS). Rows are written by real events
-- (payment received, withdrawal status change, payment-link created, welcome)
-- via src/lib/notify.ts and read by the bell dropdown on /cuenta.
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,        -- payment_received | withdrawal_update | link_created | welcome | plan_interest | system
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,                 -- in-app destination, e.g. '#pagos' (a tab) or a URL
  read_ms     INTEGER,              -- NULL = unread
  created_ms  INTEGER NOT NULL
);

-- List a user's notifications newest-first.
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_ms DESC);
-- Fast unread-count for the badge.
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_ms);
