-- 0057 — Evidence Photo Gallery.
--
-- Turns the existing case_attachments store into an evidence-grade item record
-- (the spec's `evidence_items`) WITHOUT building a parallel CRM — per the project
-- rule "one system for all cases". Adds chain-of-custody, non-destructive
-- annotations, pinned comments, and signed expiring share links as satellite
-- tables keyed by attachment_id (federated person_id: persons.id | fam-* | hosp-*).
--
-- Apply on REMOTE under the gmail OAuth session, ONE statement at a time
-- (ADD COLUMN is not idempotent — skip a statement if the column already exists).
-- Run wrangler from a dir with NO .env so the icloud token doesn't shadow OAuth:
--   wrangler d1 execute sismo911 --remote --file migrations/0057_evidence_gallery.sql --env-file /dev/null

-- ── Evidence-grade columns on case_attachments (= evidence_items) ───────────────
ALTER TABLE case_attachments ADD COLUMN original_sha256 TEXT;                       -- hex sha-256 of the immutable original
ALTER TABLE case_attachments ADD COLUMN status          TEXT NOT NULL DEFAULT 'draft'; -- draft|reviewed|verified|disputed|archived
ALTER TABLE case_attachments ADD COLUMN tags            TEXT;                       -- JSON array of strings
ALTER TABLE case_attachments ADD COLUMN width           INTEGER;
ALTER TABLE case_attachments ADD COLUMN height          INTEGER;
ALTER TABLE case_attachments ADD COLUMN thumb_r2_key    TEXT;                       -- reserved (thumbs are CSS-rendered from the original today)
ALTER TABLE case_attachments ADD COLUMN updated_ms      INTEGER;
ALTER TABLE case_attachments ADD COLUMN deleted_ms      INTEGER;                    -- soft delete (NULL = live)

CREATE INDEX IF NOT EXISTS idx_case_att_status  ON case_attachments(person_id, status, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_case_att_sha256  ON case_attachments(original_sha256);

-- ── Non-destructive annotation overlay (never mutates the original file) ────────
CREATE TABLE IF NOT EXISTS evidence_annotations (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,                 -- case_attachments.id
  person_id     TEXT NOT NULL,                 -- federated case key (denormalized for cheap scoping)
  shape         TEXT NOT NULL,                 -- freehand|line|arrow|rect|ellipse|text|highlight|redact|sticker
  data          TEXT NOT NULL,                 -- JSON: {points|x,y,w,h}, color, stroke, text, sticker, all coords normalized 0..1
  created_by    TEXT,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL,
  deleted_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ev_annot_att ON evidence_annotations(attachment_id, created_ms);

-- ── Comments / evidence notes (general, internal, or pinned to image coords) ────
CREATE TABLE IF NOT EXISTS evidence_comments (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  body          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'general', -- general|internal|pin
  x             REAL,                            -- normalized 0..1 pin position (kind=pin)
  y             REAL,
  author        TEXT,
  created_ms    INTEGER NOT NULL,
  deleted_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ev_comment_att ON evidence_comments(attachment_id, created_ms);

-- ── Chain of custody: append-only log of every action on an evidence item ───────
CREATE TABLE IF NOT EXISTS evidence_chain_of_custody (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  event         TEXT NOT NULL,                 -- uploaded|viewed|annotated|annotation_deleted|commented|status_change|printed|shared|share_revoked|share_viewed|downloaded|deleted|restored
  detail        TEXT,                          -- JSON
  actor         TEXT,
  actor_role    TEXT,
  ip            TEXT,
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_coc_att ON evidence_chain_of_custody(attachment_id, created_ms);

-- ── Signed, expiring share links (serve a pre-baked redacted/watermarked copy) ──
-- The private original is NEVER exposed publicly: at share time the operator's
-- browser bakes a redacted + watermarked composite to a canvas and uploads THAT;
-- the public route only ever serves the composite (no EXIF — canvas re-encode).
CREATE TABLE IF NOT EXISTS evidence_share_links (
  id            TEXT PRIMARY KEY,              -- public id (also the R2 asset suffix)
  token_hash    TEXT NOT NULL,                 -- sha-256 of the secret token (secret shown to operator once)
  attachment_id TEXT,                          -- single-item share (NULL for a bundle)
  person_id     TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'item',  -- item|bundle|viral
  share_r2_key  TEXT,                          -- baked composite in PERSON_PHOTOS
  content_type  TEXT,
  title         TEXT,
  caption       TEXT,
  redacted      INTEGER NOT NULL DEFAULT 1,
  watermark     INTEGER NOT NULL DEFAULT 1,
  expires_ms    INTEGER NOT NULL,
  view_count    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_ms    INTEGER NOT NULL,
  revoked_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ev_share_token  ON evidence_share_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_ev_share_person ON evidence_share_links(person_id, created_ms DESC);
