-- 0085: bound hospital_patients_dupes growth.
-- Each 6h sync re-creates duplicate source rows with NEW random hp_ ids, so the old
-- INSERT-OR-IGNORE (keyed on the volatile id PK) never deduped them and the archive
-- grew ~2.5-3k every sync (7,331 → 14,014 observed). Keep ONE archived row per
-- logical duplicate (dedupe_key) and enforce it with a UNIQUE index so the existing
-- INSERT OR IGNORE in collapseHospitalDupes self-dedupes from now on.

-- One-time prune: keep the most-recent archived row per dedupe_key.
DELETE FROM hospital_patients_dupes
 WHERE dedupe_key IS NOT NULL
   AND rowid NOT IN (SELECT MAX(rowid) FROM hospital_patients_dupes WHERE dedupe_key IS NOT NULL GROUP BY dedupe_key);

-- Going forward: at most one archived row per logical duplicate identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hpd_dedupe_unq ON hospital_patients_dupes(dedupe_key);
