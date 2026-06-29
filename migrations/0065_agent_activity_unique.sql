-- Add a de-duplicated unique-persons estimate alongside the raw still_missing
-- total on each agent-activity row. The registries carry heavy cross-source
-- duplication; still_unique = distinct normalized-name count (an estimate — see
-- missingStats() in src/lib/agent-activity.ts). ADD COLUMN is not IF-NOT-EXISTS in
-- SQLite; the d1_migrations tracker guarantees this runs once.
ALTER TABLE agent_activity ADD COLUMN still_unique INTEGER NOT NULL DEFAULT 0;
