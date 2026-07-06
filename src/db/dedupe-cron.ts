// SISMO911 — hourly scored-dedupe cron job (engine v2 over fresh rows).
// ---------------------------------------------------------------------------
// Complements the existing personas-dedupe-* drain rules (exact/photo/extid/
// phash/dhash — mechanical key collisions) with the LAYERED SCORING engine:
// corroborated fuzzy matches auto-merge, 70-89 pairs land in the operator
// review queue (dedupe_candidates), field conflicts are recorded, and a
// data-quality snapshot row is written every run.
//
// IDEMPOTENT BY CONSTRUCTION:
//   · watermark — only rows updated since the last successful run are scanned;
//   · UNIQUE(table_name,id_a,id_b) on dedupe_candidates + INSERT OR IGNORE —
//     a pair is queued/merged at most once, ever (meta.changes===0 → skip);
//   · merges reuse the canonical restorable path (merged_into +
//     personas_merge_log under run_id cron-dedupe-<ts>).
// Subrequest budget: ≤ ~15 D1 calls per tick (bounded groups + batched writes).

import type { Env } from '../types';
import { scorePair, pickKeeper, type DedupeRecord } from './dedupe';

const ACTIVE = `moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='') AND coalesce(protected,0)=0 AND name_norm IS NOT NULL AND name_norm<>''`;
const MAX_KEYS_PER_TICK = 150; // changed name_norm groups scanned per run
const MAX_GROUP_SIZE = 6; // bigger groups = namesake clouds → operators
const MAX_MERGES_PER_TICK = 15;

interface PersonaRow {
  id: string;
  nombre: string | null;
  name_norm: string;
  edad: number | null;
  contacto: string | null;
  ubicacion: string | null;
  origen: string | null;
  ext_id: string | null;
  estado: string | null;
  fallecido: number;
  hospitalizado: number;
  geo_estado: string | null;
  geo_municipio: string | null;
  updated_at: number | null;
}

function toRecord(r: PersonaRow): DedupeRecord {
  return {
    id: r.id,
    fullName: r.nombre,
    cedula: null,
    phone: r.contacto,
    email: null,
    age: r.edad,
    municipality: r.geo_municipio,
    state: r.geo_estado,
    familyPhone: null,
    lastSeenLocation: r.ubicacion,
    sourceName: r.origen,
    sourceRecordId: r.ext_id,
    status: r.fallecido ? 'fallecido' : r.hospitalizado ? 'hospitalizado' : r.estado,
    updatedMs: r.updated_at,
  };
}

export interface HourlyDedupeSummary {
  scanned: number;
  candidates: number;
  autoMerged: number;
  queuedReview: number;
  conflicts: number;
  watermark: number;
  skipped?: boolean;
}

export async function runHourlyDedupe(env: Env): Promise<HourlyDedupeSummary> {
  const now = Date.now();
  const runId = `cron-dedupe-${now.toString(36)}`;

  const wmRow = await env.DB.prepare(`SELECT COALESCE(MAX(watermark_ms), 0) AS wm FROM dedupe_runs WHERE source='cron' AND table_name='personas' AND status='ok'`).first<{ wm: number }>();
  const watermark = Number(wmRow?.wm ?? 0);

  try {
    // 1. name_norm keys touched since the watermark (bounded).
    const changed = await env.DB.prepare(
      `SELECT name_norm AS k FROM personas WHERE ${ACTIVE} AND updated_at > ? GROUP BY name_norm LIMIT ${MAX_KEYS_PER_TICK}`,
    )
      .bind(watermark)
      .all<{ k: string }>();
    const keys = (changed.results ?? []).map((r) => r.k);
    if (!keys.length) {
      await recordRun(env, runId, now, watermark, { scanned: 0, candidates: 0, autoMerged: 0, queuedReview: 0, conflicts: 0, watermark: now });
      return { scanned: 0, candidates: 0, autoMerged: 0, queuedReview: 0, conflicts: 0, watermark: now, skipped: true };
    }

    // 2. Full groups for those keys (chunked IN lists).
    const rows: PersonaRow[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const slice = keys.slice(i, i + 50);
      const ph = slice.map(() => '?').join(',');
      const res = await env.DB.prepare(
        `SELECT id, nombre, name_norm, edad, contacto, ubicacion, origen, ext_id, estado, coalesce(fallecido,0) AS fallecido, coalesce(hospitalizado,0) AS hospitalizado, geo_estado, geo_municipio, updated_at FROM personas WHERE ${ACTIVE} AND name_norm IN (${ph})`,
      )
        .bind(...slice)
        .all<PersonaRow>();
      rows.push(...(res.results ?? []));
    }

    // 3. Score pairs inside each group.
    const byKey = new Map<string, PersonaRow[]>();
    for (const r of rows) {
      const arr = byKey.get(r.name_norm) ?? [];
      arr.push(r);
      byKey.set(r.name_norm, arr);
    }
    const candStmts: D1PreparedStatement[] = [];
    const pairMeta: Array<{ keeper: string; loser: string; auto: boolean; conflicts: ReturnType<typeof scorePair>['conflicts']; candId: string }> = [];
    for (const group of byKey.values()) {
      if (group.length < 2 || group.length > MAX_GROUP_SIZE) continue;
      for (let x = 0; x < group.length; x++) {
        for (let y = x + 1; y < group.length; y++) {
          const a = toRecord(group[x]);
          const b = toRecord(group[y]);
          const s = scorePair(a, b);
          if (s.decision === 'ignore') continue;
          const [idA, idB] = a.id <= b.id ? [a.id, b.id] : [b.id, a.id];
          const candId = `ddc_${idA}_${idB}`.slice(0, 60);
          const { keeper, loser } = pickKeeper(a, b);
          candStmts.push(
            env.DB.prepare(
              `INSERT OR IGNORE INTO dedupe_candidates (id, run_id, table_name, id_a, id_b, score, signals, decision, decided_by, decided_ms, created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            ).bind(candId, runId, 'personas', idA, idB, s.score, JSON.stringify(s.signals), s.decision === 'auto_merge' ? 'merged' : 'review', 'engine', now, now),
          );
          pairMeta.push({ keeper: keeper.id, loser: loser.id, auto: s.decision === 'auto_merge', conflicts: s.conflicts, candId });
        }
      }
    }

    // 4. Insert candidates; meta.changes tells us which pairs are NEW.
    let autoMerged = 0;
    let queuedReview = 0;
    let conflicts = 0;
    if (candStmts.length) {
      const results = await env.DB.batch(candStmts);
      const mergeStmts: D1PreparedStatement[] = [];
      for (let i = 0; i < results.length; i++) {
        const isNew = Number(results[i]?.meta?.changes ?? 0) > 0;
        if (!isNew) continue; // pair seen in a prior run — never re-merge/re-queue
        const p = pairMeta[i];
        for (const c of p.conflicts) {
          conflicts++;
          mergeStmts.push(
            env.DB.prepare(`INSERT OR IGNORE INTO dedupe_conflicts (id, candidate_id, field, value_a, value_b, severity, created_ms) VALUES (?,?,?,?,?,?,?)`).bind(
              `ddx_${p.candId}_${c.field}`.slice(0, 60), p.candId, c.field, c.valueA, c.valueB, c.severity, now,
            ),
          );
        }
        if (p.auto && autoMerged < MAX_MERGES_PER_TICK) {
          autoMerged++;
          mergeStmts.push(
            env.DB.prepare(
              `INSERT INTO personas_merge_log (run_id,ts,mode,role,keep_id,loser_id,prev_moderation,prev_merged_into,keeper_before) SELECT ?,?,?,?,?,id,moderation,merged_into,NULL FROM personas WHERE id=?`,
            ).bind(runId, now, 'engine-cron', 'loser', p.keeper, p.loser),
            env.DB.prepare(`UPDATE personas SET merged_into=?, moderation='rejected', updated_at=? WHERE id=? AND (merged_into IS NULL OR trim(merged_into)='')`).bind(p.keeper, now, p.loser),
          );
        } else if (!p.auto) {
          queuedReview++;
        }
      }
      if (mergeStmts.length) await env.DB.batch(mergeStmts);
    }

    const summary: HourlyDedupeSummary = { scanned: rows.length, candidates: candStmts.length, autoMerged, queuedReview, conflicts, watermark: now };
    await recordRun(env, runId, now, watermark, summary);
    return summary;
  } catch (e) {
    await env.DB.prepare(
      `INSERT INTO dedupe_runs (id, source, table_name, watermark_ms, scanned, candidates, auto_merged, queued_review, conflicts, status, error, created_ms) VALUES (?,?,?,?,0,0,0,0,0,'error',?,?)`,
    )
      .bind(`ddr_${now.toString(36)}`, 'cron', 'personas', watermark, String((e as Error)?.message ?? e).slice(0, 300), now)
      .run()
      .catch(() => {});
    throw e; // cron harness records the failure + alerting path picks it up
  }
}

async function recordRun(env: Env, runId: string, now: number, prevWatermark: number, s: HourlyDedupeSummary): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dedupe_runs (id, source, table_name, watermark_ms, scanned, candidates, auto_merged, queued_review, conflicts, status, created_ms) VALUES (?,?,?,?,?,?,?,?,?, 'ok', ?)`,
    ).bind(`ddr_${now.toString(36)}`, 'cron', 'personas', s.watermark, s.scanned, s.candidates, s.autoMerged, s.queuedReview, s.conflicts, now),
    env.DB.prepare(`INSERT INTO data_quality_reports (id, kind, metrics, created_ms) VALUES (?,?,?,?)`).bind(
      `dqr_${now.toString(36)}`, 'hourly_dedupe', JSON.stringify({ runId, prevWatermark, ...s }), now,
    ),
  ]);
}
