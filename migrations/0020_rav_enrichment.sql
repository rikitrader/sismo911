-- 0020 — redayudavenezuela.com (RAV) enrichment.
--
-- RAV is a SECOND citizen missing-persons aggregator (public Supabase REST API,
-- ~53k rows) on top of the theempire source we already ingest into `personas`.
-- This migration adds provenance + tags + photo-analysis + sync stamps to
-- `personas`, and two new tables for RAV's other datasets (official casualty
-- stats + verified news), so we can ingest/depurar/dedupe all three with proper
-- dates and zero duplicates.
--
-- Apply per-statement on remote under the gmail OAuth session
-- (`unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` first) — the D1 migration
-- tracker is drifted, so do NOT `migrations apply --remote`. ADD COLUMN
-- statements are individually idempotent-by-intent (skip any that already exist).

-- --- personas: provenance, tags, photo analysis, sync stamps ----------------
ALTER TABLE personas ADD COLUMN origen        TEXT;                       -- e.g. 'theempire' | 'rav:terremotovenezuela.app' | 'rav:comunidad'
ALTER TABLE personas ADD COLUMN ext_id        TEXT;                       -- the upstream source's own id
ALTER TABLE personas ADD COLUMN tags          TEXT NOT NULL DEFAULT '[]'; -- JSON array of derived tags
ALTER TABLE personas ADD COLUMN synced_at     TEXT;                       -- upstream sync stamp (ISO)
ALTER TABLE personas ADD COLUMN photo_phash   TEXT;                       -- perceptual (dHash) of foto, for image dedupe
ALTER TABLE personas ADD COLUMN photo_caption TEXT;                       -- Workers AI vision description
ALTER TABLE personas ADD COLUMN photo_flags   TEXT NOT NULL DEFAULT '[]'; -- JSON array: non_person | placeholder | low_quality | person

CREATE INDEX IF NOT EXISTS idx_personas_origen ON personas(origen);
CREATE INDEX IF NOT EXISTS idx_personas_phash  ON personas(photo_phash);

-- --- official_stats: live casualty counter (single row, id=1) ---------------
CREATE TABLE IF NOT EXISTS official_stats (
  id            INTEGER PRIMARY KEY,
  fallecidos    INTEGER,
  heridos       INTEGER,
  refugiados    INTEGER,
  desaparecidos INTEGER,
  source        TEXT,
  origen        TEXT NOT NULL DEFAULT 'rav',
  updated_at    TEXT,
  pulled_at     TEXT
);

-- --- verified_info: curated/verified news items ----------------------------
CREATE TABLE IF NOT EXISTS verified_info (
  id           TEXT PRIMARY KEY,            -- RAV uuid (UPSERT key → no dupes by construction)
  source       TEXT,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  url          TEXT,
  topic        TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  published_at TEXT,
  origen       TEXT NOT NULL DEFAULT 'rav',
  synced_at    TEXT,
  pulled_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_verified_published ON verified_info(published_at DESC);
-- Cross-source title dedupe (same story from two outlets): a UNIQUE index on the
-- normalized title would reject legitimately distinct items, so dedupe is done in
-- code (ingestRavVerified) keeping the earliest-published per lower(title).
