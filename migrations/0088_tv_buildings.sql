-- 0088_tv_buildings.sql — mirror of terremotovenezuela.com's `buildings` table.
--
-- Real, citizen-reported damaged buildings for the 24-jun-2026 quake, WITH photo
-- galleries + addresses. Ingested hourly from the public Supabase (publishable
-- key). Kept as a DISTINCT layer from the curated/OSM damage-scoring inventory —
-- these are field reports with photos, not modeled footprints. Dedupe by
-- construction: `id` is terremotovenezuela's uuid and every write is an UPSERT.
--
-- Idempotent: re-running is a no-op (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS tv_buildings (
  id                  TEXT PRIMARY KEY,           -- terremotovenezuela uuid
  name                TEXT NOT NULL DEFAULT '',
  address             TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL DEFAULT '',
  zone                TEXT NOT NULL DEFAULT '',
  lat                 REAL,
  lng                 REAL,
  damage_level        TEXT NOT NULL DEFAULT '',   -- total | severo | parcial
  status              TEXT NOT NULL DEFAULT '',   -- verificado | en_revision
  main_photo_url      TEXT,
  media_urls          TEXT,                        -- JSON array of photo/video URLs (the gallery)
  general_source      TEXT,
  notes               TEXT,
  has_missing_persons INTEGER NOT NULL DEFAULT 0,
  tv_created_at       TEXT,
  tv_updated_at       TEXT,
  pulled_at           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tv_buildings_status ON tv_buildings(status);
CREATE INDEX IF NOT EXISTS idx_tv_buildings_damage ON tv_buildings(damage_level);
CREATE INDEX IF NOT EXISTS idx_tv_buildings_updated ON tv_buildings(tv_updated_at);
