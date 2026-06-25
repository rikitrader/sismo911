-- SISMO911 — anti-duplicate GATE.
-- UNIQUE expression indexes that make the database itself reject duplicate
-- inserts on natural keys for the curated REFERENCE tables. Apply only AFTER
-- running scripts/d1-dedupe.mjs --apply (a UNIQUE index fails to build while
-- duplicates still exist).
--
-- Apply:
--   unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
--   npx wrangler d1 execute sismo911 --remote --file=scripts/d1-dedupe-gate.sql
--
-- NOTE: intentionally NOT gating persons / sos_alerts / checkins / damage_reports.
-- Those are life-safety records where two near-identical entries can be legitimately
-- distinct people/events; a hard UNIQUE constraint there could silently drop a real
-- report. De-dup them manually via the script with --include-sensitive after review.

CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_nat
  ON contacts (agency, category, COALESCE(region, ''), COALESCE(phone, ''));

CREATE UNIQUE INDEX IF NOT EXISTS ux_comms_nat
  ON comms_channels (name, COALESCE(band, ''), COALESCE(frequency, ''));

CREATE UNIQUE INDEX IF NOT EXISTS ux_resources_nat
  ON resources (kind, label, COALESCE(region, ''));

-- Prevent the same uploaded image from creating two damage rows (duplicate pics).
CREATE UNIQUE INDEX IF NOT EXISTS ux_damage_photo
  ON damage_reports (photo_key);
