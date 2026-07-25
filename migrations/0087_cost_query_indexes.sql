-- 0087: covering indexes for high-volume public registry counters and feeds.
--
-- These predicates are used by public dashboard/list queries. Without a
-- composite covering index, D1 scans the full registry for every request.
-- Index maintenance is bounded to changed rows and is materially cheaper than
-- repeated multi-million-row scans.

CREATE INDEX IF NOT EXISTS idx_personas_public_status_cost
  ON personas(moderation, protected, estado, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_persons_public_status_cost
  ON persons(review, protected, status, updated_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_hospital_unmatched_status_cost
  ON hospital_patients(match_confidence, estado, updated_ms DESC, id DESC);
