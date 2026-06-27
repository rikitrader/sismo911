-- 0028 — self-hosted photo for citizen-created pet reports.
--
-- Citizen reports created in-app (POST /api/mascotas/report) can now upload a
-- photo binary, stored in the PERSON_PHOTOS R2 bucket and referenced by this
-- app-owned key. The RAV ingest UPSERT never sets photo_r2, so an uploaded photo
-- survives sync (golden rule). GET /api/mascotas/photo/:id serves it (falling
-- back to the external photo_url for RAV-sourced rows).
--
-- Apply on remote under the gmail OAuth session (ADD COLUMN is not idempotent).

ALTER TABLE rav_reports ADD COLUMN photo_r2 TEXT;
