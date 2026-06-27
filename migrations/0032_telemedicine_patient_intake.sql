-- Telemedicine v2 — expanded patient intake so the doctor has everything needed
-- to start the consult: identity (cédula), demographics (DOB/age/gender), and
-- location. Additive columns on telemed_appointments (one-time ALTER apply; the
-- columns are new so first apply is clean).
ALTER TABLE telemed_appointments ADD COLUMN patient_location TEXT;
ALTER TABLE telemed_appointments ADD COLUMN patient_cedula   TEXT;
ALTER TABLE telemed_appointments ADD COLUMN patient_dob      TEXT;     -- YYYY-MM-DD
ALTER TABLE telemed_appointments ADD COLUMN patient_gender   TEXT;     -- Femenino | Masculino | Otro | Prefiero no decir
ALTER TABLE telemed_appointments ADD COLUMN patient_age      INTEGER;  -- computed at booking from DOB
