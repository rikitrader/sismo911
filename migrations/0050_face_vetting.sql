-- 0050 — face-recognition vetting for the desaparecidos (personas) registry.
--
-- The string/byte dedupe modes (exact / photo-URL / SHA-256 phash / dHash) all
-- miss the most common real duplicate: the SAME PERSON submitted several times
-- with a different name spelling, a typo'd age, a re-cropped or redaction-barred
-- photo, and free-text location — none of which are byte- or string-equal. The
-- only invariant across those records is the FACE.
--
-- photo_face_vec = a 512-d ArcFace embedding (InsightFace buffalo_l) of the
-- primary face, L2-normalised, stored as base64 of 512 little-endian float32s
-- (2048 bytes → ~2.7KB base64). Workers can't decode JPEG or run ONNX, so the
-- embedding is computed locally (scripts/face-embed-local.py) and written here;
-- the Worker only does cosine math / GROUPs (handled by scripts/face-cluster.mjs).
--   face_count    — faces detected (0 = sentinel-only, >1 = ambiguous, review)
--   face_det_score— detector confidence of the primary face (0..1)
--   merged_into   — when an operator merges a duplicate, the LOSER row points at
--                   the keeper's id and its moderation flips off 'approved' (so
--                   every public query, which filters moderation='approved',
--                   hides it automatically). Reversible + auditable; the face
--                   vector and R2 photo are preserved, never destroyed.
--
-- A non-decodable/faceless photo stores a unique sentinel ('noface:<id>' /
-- 'dead:<id>') so the backfill never re-selects it and it can't form a false
-- face cluster (a shared sentinel would collapse every failure into one group).

ALTER TABLE personas ADD COLUMN photo_face_vec  TEXT;
ALTER TABLE personas ADD COLUMN face_count      INTEGER;
ALTER TABLE personas ADD COLUMN face_det_score  REAL;
ALTER TABLE personas ADD COLUMN merged_into     TEXT;

-- Partial-ish helper: rows that still need an embedding (NULL vec) are the
-- backfill queue; rows with a real vector feed the clusterer.
CREATE INDEX IF NOT EXISTS idx_personas_face_vec ON personas(photo_face_vec);
CREATE INDEX IF NOT EXISTS idx_personas_merged   ON personas(merged_into);

-- Review queue. One row per (cluster, persona). A cluster is a set of personas
-- whose faces match above threshold; an operator vets it and merges or dismisses.
-- status: pending (awaiting review) | merged (resolved, loser merged_into anchor)
--         | dismissed (confirmed DIFFERENT people — namesakes/siblings/look-alikes)
-- anchor=1 marks the suggested keeper (most complete record). The clusterer only
-- ever rewrites 'pending' rows; 'merged'/'dismissed' decisions are sticky so an
-- operator's verdict is never re-surfaced.
CREATE TABLE IF NOT EXISTS dup_cluster (
  cluster_id   TEXT    NOT NULL,
  persona_id   TEXT    NOT NULL,
  score        REAL    NOT NULL DEFAULT 0,   -- cosine sim to the cluster anchor
  method       TEXT    NOT NULL DEFAULT 'face',
  anchor       INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  reviewed_at  INTEGER,
  reviewed_by  TEXT,
  PRIMARY KEY (cluster_id, persona_id)
);
CREATE INDEX IF NOT EXISTS idx_dup_cluster_status  ON dup_cluster(status, cluster_id);
CREATE INDEX IF NOT EXISTS idx_dup_cluster_persona ON dup_cluster(persona_id);
