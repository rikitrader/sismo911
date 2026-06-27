-- 0028 — SUPER BANNER EMERGENCY PROFILES (GoFundMe-style spotlight + billboard).
--
-- A curated, ADMIN-ONLY emergency profile for a single person in urgent need
-- (medical, rescue, displaced, bereavement, reconstruction). Each profile has a
-- full bio, a photo gallery, an optional video, and a viral social-share CTA.
-- The /emergencia page rotates featured profiles "billboard / e-marketing" style.
--
-- Distinct from /personas (DESAPARECIDOS) and /casos (EXPEDIENTES): those are
-- citizen-reported + moderated registries. These are hand-curated spotlight
-- profiles that only operators/admins can create — there is NO public write path.
--
-- Idempotent (CREATE … IF NOT EXISTS). Safe under `npm run db:migrate:remote`.

CREATE TABLE IF NOT EXISTS emergency_profiles (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,          -- URL slug for /emergencia/:slug (shareable)
  name           TEXT NOT NULL,
  age            INTEGER,
  location       TEXT,                          -- ciudad / estado
  headline       TEXT,                          -- urgent one-liner (banner overline, <=160)
  bio            TEXT,                           -- full story (<=8000)
  need_type      TEXT NOT NULL DEFAULT 'otro',  -- medico | rescate | desplazado | duelo | reconstruccion | otro
  goal_amount    REAL,                           -- fundraising goal (optional)
  raised_amount  REAL NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'USD',
  campaign_id    TEXT,                           -- optional link to a campaigns row (donations)
  video_url      TEXT,                           -- YouTube / Vimeo / mp4
  hero_url       TEXT,                           -- banner hero image (external URL or /api/emergencia/photo/:id)
  contact        TEXT,                           -- public help/contact line
  cta_url        TEXT,                           -- primary CTA target (donate / WhatsApp / form)
  cta_label      TEXT,                           -- primary CTA label (e.g. "Donar ahora")
  status         TEXT NOT NULL DEFAULT 'active', -- active | paused | resolved | archived
  featured       INTEGER NOT NULL DEFAULT 1,     -- 1 = include in the billboard rotation
  priority       INTEGER NOT NULL DEFAULT 0,     -- higher = earlier in rotation / grid
  rotation_secs  INTEGER NOT NULL DEFAULT 8,     -- billboard dwell time for THIS profile
  views          INTEGER NOT NULL DEFAULT 0,
  shares         INTEGER NOT NULL DEFAULT 0,
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL,
  created_by     TEXT                            -- operator email
);
CREATE INDEX IF NOT EXISTS idx_emerg_status   ON emergency_profiles(status, featured, priority DESC, updated_ms DESC);
CREATE INDEX IF NOT EXISTS idx_emerg_slug      ON emergency_profiles(slug);

-- Photo gallery (R2-backed via the PERSON_PHOTOS bucket, key prefix 'emergencia/').
-- kind='hero' is the banner image; kind='gallery' are the rest. Served back via
-- GET /api/emergencia/photo/:id (falls back to an external URL when r2_key is null).
CREATE TABLE IF NOT EXISTS emergency_photos (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'gallery',  -- hero | gallery
  r2_key      TEXT,                              -- key in PERSON_PHOTOS R2 (null when url-only)
  url         TEXT,                              -- external image URL alternative
  caption     TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emerg_photos_profile ON emergency_photos(profile_id, sort ASC, created_ms ASC);
