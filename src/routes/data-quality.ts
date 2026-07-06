// SISMO911 — admin data-quality metrics (dashboard support).
// ---------------------------------------------------------------------------
// GET /api/admin/data-quality — ops:console-gated snapshot of the data-
// integrity pipeline: table totals, duplicate candidates, auto-merges, the
// human review queue, conflicts, last ingest/dedupe/db-map times, failure
// counts and per-source reliability. Read-only; numbers come straight from
// the 0098 bookkeeping tables + personas registry.

import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission } from '../rbac/middleware';

export const dataQuality = new Hono<{ Bindings: Env }>();

dataQuality.get('/', requirePermission('ops:console'), async (c) => {
  const db = c.env.DB;
  const one = async <T>(sql: string): Promise<T | null> => (await db.prepare(sql).first<T>()) ?? null;
  const all = async <T>(sql: string): Promise<T[]> => ((await db.prepare(sql).all<T>()).results ?? []) as T[];

  const [totals, candidates, conflictsOpen, lastDedupe, lastMap, lastCleanup, ingestBySource, missingIdentity, mergedTotal] = await Promise.all([
    all<{ t: string; c: number }>(
      `SELECT 'personas' AS t, COUNT(*) AS c FROM personas UNION ALL SELECT 'personas_activas', COUNT(*) FROM personas WHERE moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='') UNION ALL SELECT 'hospital_patients', COUNT(*) FROM hospital_patients UNION ALL SELECT 'intake_submissions', COUNT(*) FROM intake_submissions`,
    ),
    all<{ decision: string; c: number }>(`SELECT decision, COUNT(*) AS c FROM dedupe_candidates GROUP BY decision`),
    one<{ c: number; critical: number }>(`SELECT COUNT(*) AS c, SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) AS critical FROM dedupe_conflicts WHERE resolved=0`),
    one<{ created_ms: number; auto_merged: number; queued_review: number; status: string }>(
      `SELECT created_ms, auto_merged, queued_review, status FROM dedupe_runs ORDER BY created_ms DESC LIMIT 1`,
    ),
    one<{ created_ms: number }>(`SELECT created_ms FROM audit WHERE action='db_map_generated' ORDER BY created_ms DESC LIMIT 1`),
    one<{ metrics: string; created_ms: number }>(`SELECT metrics, created_ms FROM data_quality_reports WHERE kind='cleanup' ORDER BY created_ms DESC LIMIT 1`),
    all<{ source_name: string; runs: number; ok_runs: number; last_ms: number; errors: number }>(
      `SELECT source_name, COUNT(*) AS runs, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_runs, MAX(created_ms) AS last_ms, SUM(errors) AS errors FROM ingest_runs GROUP BY source_name`,
    ),
    one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM personas WHERE moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='') AND (name_norm IS NULL OR name_norm='') `,
    ),
    one<{ c: number }>(`SELECT COUNT(*) AS c FROM personas WHERE merged_into IS NOT NULL AND trim(merged_into)<>''`),
  ]);

  const failedDedupeRuns = await one<{ c: number }>(`SELECT COUNT(*) AS c FROM dedupe_runs WHERE status='error' AND created_ms > ${Date.now() - 7 * 86400000}`);

  return c.json({
    generated_ms: Date.now(),
    totals: Object.fromEntries(totals.map((r) => [r.t, r.c])),
    dedupe: {
      candidates: Object.fromEntries(candidates.map((r) => [r.decision, r.c])),
      review_queue: candidates.find((r) => r.decision === 'review')?.c ?? 0,
      merged_records_total: mergedTotal?.c ?? 0,
      open_conflicts: conflictsOpen?.c ?? 0,
      critical_conflicts: conflictsOpen?.critical ?? 0,
      last_run: lastDedupe,
      failed_runs_7d: failedDedupeRuns?.c ?? 0,
      last_cleanup: lastCleanup ? { at_ms: lastCleanup.created_ms, ...JSON.parse(lastCleanup.metrics || '{}') } : null,
    },
    ingest: {
      sources: ingestBySource.map((s) => ({ ...s, reliability: s.runs ? Math.round((100 * s.ok_runs) / s.runs) : null })),
    },
    freshness: {
      db_map_ms: lastMap?.created_ms ?? null,
      db_map_stale: !lastMap || Date.now() - lastMap.created_ms > 24 * 3600 * 1000,
    },
    identity: {
      personas_missing_name_norm: missingIdentity?.c ?? 0,
    },
  });
});
