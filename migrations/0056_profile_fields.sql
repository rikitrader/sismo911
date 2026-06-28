-- Profile Command Center — extra citizen profile fields + a JSON settings blob
-- for the payment/visibility/security toggles (kept as one column so adding new
-- toggles needs no schema change). All additive; existing rows default to NULL.
ALTER TABLE users ADD COLUMN country TEXT;
ALTER TABLE users ADD COLUMN city TEXT;
ALTER TABLE users ADD COLUMN settings_json TEXT;  -- profile/payment/visibility/security toggles (JSON object)
