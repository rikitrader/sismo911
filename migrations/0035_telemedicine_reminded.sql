-- Telemedicine v2 — appointment reminder bookkeeping. One-time additive column.
ALTER TABLE telemed_appointments ADD COLUMN reminded_ms INTEGER;
