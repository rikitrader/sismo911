-- SISMO911 — Live-seismic Telegram bot: auto-alert subscribers.
-- A chat (user DM, group, or channel) that ran /suscribir to receive automatic
-- alerts when a significant new quake lands. Public, non-PII (only a chat id).
CREATE TABLE IF NOT EXISTS sismos_bot_subs (
  chat_id   TEXT PRIMARY KEY,
  chat_type TEXT,
  added_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sismos_bot_subs_added ON sismos_bot_subs (added_ms);
