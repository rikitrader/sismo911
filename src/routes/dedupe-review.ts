// SISMO911 — operator review of dedupe candidates + critical conflicts.
// ---------------------------------------------------------------------------
// The data-integrity pipeline (engine v2 + hourly cron + cleanup script) queues
// uncertain pairs in `dedupe_candidates` (decision='review') and field-level
// contradictions in `dedupe_conflicts` (severity='critical' = alive-vs-deceased,
// NEVER auto-resolved). This route serves the console page that lets a human
// work those queues: side-by-side persona compare → merge (canonical,
// restorable via personas_merge_log) or reject; conflicts → resolve with a note.
// Mounted at /api/admin/dedupe; every endpoint ops:console-gated.

import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission, currentUser } from '../rbac/middleware';
import { audit } from '../lib/audit';

export const dedupeReview = new Hono<{ Bindings: Env }>();

const PERSONA_COLS = `id, nombre, edad, contacto, ubicacion, origen, ext_id, estado,
  coalesce(fallecido,0) AS fallecido, coalesce(hospitalizado,0) AS hospitalizado,
  foto_r2, moderation, merged_into, updated_at`;

interface PersonaRow {
  id: string;
  nombre: string | null;
  edad: number | null;
  contacto: string | null;
  ubicacion: string | null;
  origen: string | null;
  ext_id: string | null;
  estado: string | null;
  fallecido: number;
  hospitalizado: number;
  foto_r2: string | null;
  moderation: string | null;
  merged_into: string | null;
  updated_at: number | null;
}

async function personasById(env: Env, ids: string[]): Promise<Map<string, PersonaRow>> {
  const out = new Map<string, PersonaRow>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = [...new Set(ids.slice(i, i + 80))];
    const ph = slice.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT ${PERSONA_COLS} FROM personas WHERE id IN (${ph})`)
      .bind(...slice)
      .all<PersonaRow>();
    for (const r of results ?? []) out.set(r.id, r);
  }
  return out;
}

/** GET /candidates — review queue with both personas joined for compare. */
dedupeReview.get('/candidates', requirePermission('ops:console'), async (c) => {
  const decision = c.req.query('decision') ?? 'review';
  const table = c.req.query('table') ?? 'personas';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25), 1), 100);
  const cursor = Number(c.req.query('cursor') ?? 0);

  const { results } = await c.env.DB.prepare(
    `SELECT id, run_id, table_name, id_a, id_b, score, signals, decision, decided_by, decided_ms, created_ms
       FROM dedupe_candidates
      WHERE decision = ? AND table_name = ? ${cursor ? 'AND created_ms < ?' : ''}
      ORDER BY score DESC, created_ms DESC
      LIMIT ?`,
  )
    .bind(...(cursor ? [decision, table, cursor, limit] : [decision, table, limit]))
    .all<{ id: string; run_id: string; table_name: string; id_a: string; id_b: string; score: number; signals: string; decision: string; created_ms: number }>();

  const rows = results ?? [];
  const personas = table === 'personas' ? await personasById(c.env, rows.flatMap((r) => [r.id_a, r.id_b])) : new Map<string, PersonaRow>();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM dedupe_candidates WHERE decision=? AND table_name=?`)
    .bind(decision, table)
    .first<{ c: number }>();

  return c.json({
    total: total?.c ?? 0,
    nextCursor: rows.length === limit ? rows[rows.length - 1].created_ms : null,
    candidates: rows.map((r) => ({
      ...r,
      signals: JSON.parse(r.signals || '[]') as string[],
      a: personas.get(r.id_a) ?? null,
      b: personas.get(r.id_b) ?? null,
    })),
  });
});

/** POST /candidates/:id/merge {keeper} — canonical restorable merge. */
dedupeReview.post('/candidates/:id/merge', requirePermission('ops:console'), async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { keeper?: string };
  const cand = await c.env.DB.prepare(`SELECT id, table_name, id_a, id_b, decision FROM dedupe_candidates WHERE id=?`)
    .bind(id)
    .first<{ id: string; table_name: string; id_a: string; id_b: string; decision: string }>();
  if (!cand) return c.json({ error: 'not_found' }, 404);
  if (cand.table_name !== 'personas') return c.json({ error: 'unsupported_table', hint: 'Solo personas se fusiona desde la consola (v1).' }, 400);
  if (cand.decision !== 'review') return c.json({ error: 'already_decided', decision: cand.decision }, 409);
  const keeper = body.keeper === cand.id_a ? cand.id_a : body.keeper === cand.id_b ? cand.id_b : null;
  if (!keeper) return c.json({ error: 'bad_keeper', hint: 'keeper debe ser id_a o id_b' }, 400);
  const loser = keeper === cand.id_a ? cand.id_b : cand.id_a;

  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';
  const now = Date.now();
  const runId = `op-review-${now.toString(36)}`;

  // Mirrors scripts/merge-duplicates.ts: journal → photo inherit → hide loser.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS personas_merge_log (run_id TEXT, ts INTEGER, mode TEXT, role TEXT, keep_id TEXT, loser_id TEXT, prev_moderation TEXT, prev_merged_into TEXT, keeper_before TEXT)`,
    ),
    c.env.DB.prepare(
      `INSERT INTO personas_merge_log (run_id,ts,mode,role,keep_id,loser_id,prev_moderation,prev_merged_into,keeper_before)
       SELECT ?, ?, 'operator', 'loser', ?, id, moderation, merged_into, NULL FROM personas WHERE id=?`,
    ).bind(runId, now, keeper, loser),
    c.env.DB.prepare(
      `UPDATE personas SET foto=coalesce(nullif(foto,''),(SELECT foto FROM personas WHERE id=?)),
                           foto_r2=coalesce(foto_r2,(SELECT foto_r2 FROM personas WHERE id=?))
        WHERE id=? AND (foto_r2 IS NULL OR trim(coalesce(foto,''))='')`,
    ).bind(loser, loser, keeper),
    c.env.DB.prepare(`UPDATE personas SET merged_into=?, moderation='rejected', updated_at=? WHERE id=? AND (merged_into IS NULL OR trim(merged_into)='')`).bind(keeper, now, loser),
    c.env.DB.prepare(`UPDATE dedupe_candidates SET decision='merged', decided_by=?, decided_ms=? WHERE id=?`).bind(who, now, id),
  ]);

  await audit(c, 'dedupe.review.merge', { candidate: id, keeper, loser, runId });
  return c.json({ ok: true, keeper, loser, runId });
});

/** POST /candidates/:id/reject — distinct people; keep both. */
dedupeReview.post('/candidates/:id/reject', requirePermission('ops:console'), async (c) => {
  const id = c.req.param('id');
  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';
  const res = await c.env.DB.prepare(`UPDATE dedupe_candidates SET decision='rejected', decided_by=?, decided_ms=? WHERE id=? AND decision='review'`)
    .bind(who, Date.now(), id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found_or_decided' }, 409);
  await audit(c, 'dedupe.review.reject', { candidate: id });
  return c.json({ ok: true });
});

/** GET /conflicts — open field conflicts (critical first) with persona context. */
dedupeReview.get('/conflicts', requirePermission('ops:console'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT x.id, x.candidate_id, x.field, x.value_a, x.value_b, x.severity, x.created_ms,
            d.id_a, d.id_b, d.table_name, d.score
       FROM dedupe_conflicts x
       LEFT JOIN dedupe_candidates d ON d.id = x.candidate_id
      WHERE x.resolved = 0
      ORDER BY CASE x.severity WHEN 'critical' THEN 0 ELSE 1 END, x.created_ms DESC
      LIMIT 200`,
  ).all<{ id: string; candidate_id: string; field: string; value_a: string; value_b: string; severity: string; created_ms: number; id_a: string | null; id_b: string | null; table_name: string | null; score: number | null }>();

  const rows = results ?? [];
  const personas = await personasById(c.env, rows.flatMap((r) => [r.id_a, r.id_b]).filter((x): x is string => !!x));
  return c.json({
    conflicts: rows.map((r) => ({ ...r, a: r.id_a ? (personas.get(r.id_a) ?? null) : null, b: r.id_b ? (personas.get(r.id_b) ?? null) : null })),
  });
});

/** POST /conflicts/:id/resolve — human reviewed; record who. */
dedupeReview.post('/conflicts/:id/resolve', requirePermission('ops:console'), async (c) => {
  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';
  const res = await c.env.DB.prepare(`UPDATE dedupe_conflicts SET resolved=1, resolved_by=? WHERE id=? AND resolved=0`).bind(who, c.req.param('id')).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found_or_resolved' }, 409);
  await audit(c, 'dedupe.review.conflict_resolve', { conflict: c.req.param('id') });
  return c.json({ ok: true });
});

/** GET /stats — queue badges. */
dedupeReview.get('/stats', requirePermission('ops:console'), async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM dedupe_candidates WHERE decision='review') AS review,
            (SELECT COUNT(*) FROM dedupe_candidates WHERE decision='merged') AS merged,
            (SELECT COUNT(*) FROM dedupe_candidates WHERE decision='rejected') AS rejected,
            (SELECT COUNT(*) FROM dedupe_conflicts WHERE resolved=0) AS conflicts,
            (SELECT COUNT(*) FROM dedupe_conflicts WHERE resolved=0 AND severity='critical') AS critical`,
  ).first();
  return c.json(row ?? {});
});
