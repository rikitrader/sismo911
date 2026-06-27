-- 0022 — true perceptual hash (dHash) for personas photos.
--
-- photo_phash is a byte-exact SHA-256 content hash: it only collapses IDENTICAL
-- files. A photo re-encoded/resized between sources (different bytes, same image)
-- slips through. photo_dhash is a 64-bit difference-hash (dHash) computed from a
-- 9x8 grayscale downscale — robust to recompression/resize/minor edits — so the
-- new `dhash` dedupe mode collapses visually-identical re-encodes too.
--
-- Workers can't decode JPEG, so dHash is computed locally (scripts/dhash-photos-
-- local.mjs, sharp) and written here; the Worker only GROUPs by it (pure SQL).
-- Stored as 16-char hex. Apply on remote under the gmail OAuth session.

ALTER TABLE personas ADD COLUMN photo_dhash TEXT;
CREATE INDEX IF NOT EXISTS idx_personas_dhash ON personas(photo_dhash);
