-- Social/web disaster-signal monitor. Hourly cron ingests keyword hits from
-- GDELT (news/web), Reddit, Telegram public channels, and Apify actors
-- (TikTok/Instagram/X) into this table; /danos-estructurales reads it live and
-- the row set is mirrored hourly into a Google Sheet.
CREATE TABLE IF NOT EXISTS social_signals (
  id          TEXT PRIMARY KEY,   -- stable hash of the source url / native id
  platform    TEXT NOT NULL,      -- gdelt | reddit | telegram | tiktok | instagram | x
  severity    TEXT NOT NULL DEFAULT 'info',  -- critical | alert | info
  city        TEXT,               -- matched Venezuelan city, if any
  tags        TEXT,               -- comma-joined matched keywords/hashtags
  title       TEXT,
  text        TEXT,
  author      TEXT,
  lang        TEXT,
  url         TEXT,
  score       INTEGER DEFAULT 0,  -- engagement metric when available
  posted_ms   INTEGER,            -- original post time
  ingested_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_time     ON social_signals(posted_ms DESC);
CREATE INDEX IF NOT EXISTS idx_signals_severity ON social_signals(severity);
CREATE INDEX IF NOT EXISTS idx_signals_platform ON social_signals(platform);
CREATE INDEX IF NOT EXISTS idx_signals_city     ON social_signals(city);
