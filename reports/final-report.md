# SISMO911 — Data-Integrity Pipeline: Final Report (2026-07-05)

Mission: audit every API, map the database before external ingest, gate ingest,
clean existing duplicates safely, run hourly automated dedupe, expose metrics.
Executed as 9 shipped increments (PRs #648–#657), all live in production.

## 1. Files created

- `src/lib/ocr-normalize.ts` — OCR repair/flag (No-Fabrication: repair age units only, flag names)
- `scripts/api-audit.ts` · `scripts/db-map.ts` · `scripts/pre-ingest-gate.ts` · `scripts/dedupe-existing.ts` · `scripts/data-quality-report.ts`
- `src/db/dedupe.ts` (layered scoring engine) · `src/db/dedupe-cron.ts` (hourly job)
- `src/ingest/adapters/{types,civis}.ts` (canonical contract + reference adapter)
- `src/ingest/civis-pipeline.ts` (4 CIVIS jobs → 1 sequential seat + dedupe pass)
- `src/routes/data-quality.ts` (`GET /api/admin/data-quality`, ops:console)
- `migrations/0098_data_integrity.sql` (dedupe_runs/candidates/conflicts, ingest_runs/errors, data_quality_reports)
- Tests: ocr-normalize (19) · db-map (4) · dedupe-engine (16) · dedupe-cron (4) · ingest-adapters (5) · civis-pipeline (3) · data-quality-route (2)

## 2. Files modified

`src/telegram/intake/{types,extract,text-roster,roster,persist}.ts` (OCR flags),
`src/cron.ts` + `test/cron.test.ts` (dedupe-engine-hourly seat; CIVIS consolidation),
`src/index.ts` (data-quality mount), `package.json` (scripts below).

## 3. API issues found and fixed

`api-audit` probed **186 public GET endpoints against production: 0 failures**
(765 routes inventoried, 694 under /api, every one classified — default-deny
enforced by the existing coverage test). Nothing to fix.

## 4. Database schema map

`reports/db-map.md` (+ local db-map.json): **182 tables · 432,367 rows** ·
20 duplicate-prone · 33 ingest-blocked (person-identity tables: adapter+gate only).
Freshness stamped to `audit` (`db_map_generated`); the gate fails when >24 h old.

## 5–7. Duplicates: found / merged / review

Full sweep (38,519 groups, 97,311 rows pulled):

| | personas | hospital_patients | aid_orgs |
|---|---|---|---|
| candidate pairs | 48,626 | 87 | 9 |
| auto-safe | 22,369* | 87 (queued, not merged v1) | 9 (queued) |
| review queue | 26,257 | — | — |
| critical conflicts | 36 (alive-vs-deceased — humans only) | — | — |

*Execute run `dedupe-existing-1783304975078` (user-approved): **22,679 merge
operations journaled → 19,190 distinct records merged** (overlap = triangle
pairs sharing a loser), **26,683 queued for operator review**. Active personas:
133,601 → **114,458**. Verified live: cross-source clones gone from /familia
search, keepers intact.

## 8. Hourly dedupe

`dedupe-engine-hourly` in the `:30` cron group (no new trigger — account is at
the 5-cap). Watermark-incremental, ≤15 auto-merges/tick, UNIQUE(pair) makes
re-merging structurally impossible. Consolidated `civis-pipeline` (:45) ends
every CIVIS ingest tick with the same dedupe pass.

## 9–10. Dry-run / execute how-to

```
npm run db:map                 # refresh schema map (<24 h required by the gate)
npm run db:backup              # wrangler d1 export → backups/ (required before ANY execute)
npm run db:dedupe:dry-run      # sweep + report, zero writes
npm run db:dedupe:execute      # backup-gated; auto-safe merges only
npm run ingest:check|dry-run|execute -- --source=<name> [--file=batch.json]
npm run api:audit              # route inventory + live probe
npm run data:quality           # metrics snapshot (CLI mirror of the admin endpoint)
npm run test:data-integrity    # the pipeline's test files
```
Execute paths print “Production write detected …” and refuse without a <24 h backup.

## 11. Rollback

- Cleanup merges: `bun scripts/merge-duplicates.ts --restore=dedupe-existing-1783304975078 --apply`
  (row-level journal in `personas_merge_log`; losers were never deleted) — plus
  the full SQL export `backups/sismo911-20260705-*.sql` (289 MB).
- Hourly-job merges: same restore by `run_id cron-dedupe-<ts>`.
- Gated ingest: rows land `moderation='pending'` — reject in the operator queue.

## 12. Remaining risks / follow-ups

- 26,683-pair operator review queue needs UI (tracked).
- 36 critical alive-vs-deceased conflicts pending human resolution.
- hospital_patients/aid_orgs merges are queue-only (v1).
- RAV-family cron consolidation pending (same PipelineStage pattern).
- No `ingest_approved_<source>` flag is enabled yet — the gate fails closed for
  every external source until an admin flips one (by design).
