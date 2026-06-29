-- Minor-protection gate: an operator "protect" flag that drops a missing-person
-- case to responder-only (suppressed from every PUBLIC surface). Used alongside
-- the computed minor rules in src/lib/minor-protect.ts (noindex + locality-only
-- location + auto-suppress on resolved). Plain ADD COLUMN (mirrors 0062/0066) —
-- applied once by the honest migrations tracker.
ALTER TABLE personas ADD COLUMN protected INTEGER NOT NULL DEFAULT 0; -- 1 = operator-protected, responder-only
ALTER TABLE persons  ADD COLUMN protected INTEGER NOT NULL DEFAULT 0; -- 1 = operator-protected, responder-only
