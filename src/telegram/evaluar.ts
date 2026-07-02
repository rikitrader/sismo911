// SISMO911 — Telegram operator write command (/evaluar).
// ---------------------------------------------------------------------------
// Lets an authorized operator log a SIGNED Eng N1/2/3 evaluation-tracking event
// for a building from chat (field engineers report from the rubble, not a desk).
//   /evaluar "Bahía del mar" n1 en_curso Inspección exterior iniciada
//   /evaluar Tanaguarena n1 completada Marcado verde — habitable
//   /evaluar Costamar n2 Grieta diagonal en machón del nivel 3   (nota, sin estado)
//
// Same trust model as /actualizar: operator-only (role !== 'public'), audited,
// and the event is signed server-side (SHA-256 over the canonical payload) with
// the Telegram operator stamped as user identity — same trail as the web UI, so
// /edificio/:id (Evaluación), /console (Evaluaciones) and eval/verify all see it.

import type { Env } from '../types';
import type { ParsedCommand, ViewerRole } from './types';
import {
  summarizeEval, signEvent, levelOrderViolation, levelStatusMap, type EvalEventRow,
} from '../lib/building-eval';

export type EvaluarResult =
  | { kind: 'eval_ok'; buildingId: string; name: string; level: number; status: string | null; note: string | null; signature: string }
  | { kind: 'eval_forbidden' }
  | { kind: 'eval_bad_input'; reason: string }
  | { kind: 'eval_not_found'; query: string }
  | { kind: 'eval_ambiguous'; candidates: Array<{ id: string; name: string }> }
  | { kind: 'eval_order'; reason: string }
  | { kind: 'eval_error' };

export interface EvaluarCtx {
  role: ViewerRole;
  actor: string;      // audit/user identity, e.g. tg:<id>
  actorName: string;  // display name for signed_by / user_name
}

export async function resolveEvaluar(env: Env, cmd: ParsedCommand, ctx: EvaluarCtx): Promise<EvaluarResult> {
  if (ctx.role === 'public') return { kind: 'eval_forbidden' };
  const query = (cmd.evalQuery ?? '').trim();
  if (!query) return { kind: 'eval_bad_input', reason: 'falta_edificio' };
  if (!cmd.evalLevel || ![1, 2, 3].includes(cmd.evalLevel)) return { kind: 'eval_bad_input', reason: 'falta_nivel' };
  if (!cmd.evalStatus && !cmd.evalNote) return { kind: 'eval_bad_input', reason: 'falta_contenido' };
  try {
    // Resolve the building by name across both damage feeds (tv galleries win).
    const like = `%${query.replace(/[%_]/g, ' ').trim()}%`;
    let cands: Array<{ id: string; name: string }> = [];
    try {
      const r = await env.DB.prepare(
        `SELECT id, name FROM tv_buildings WHERE name LIKE ? COLLATE NOCASE ORDER BY tv_updated_at DESC LIMIT 6`,
      ).bind(like).all();
      cands = (r.results ?? []) as any[];
    } catch { cands = []; }
    if (!cands.length) {
      try {
        const r = await env.DB.prepare(
          `SELECT id, title AS name FROM sos_damage WHERE title LIKE ? COLLATE NOCASE
             AND category IN ('collapsed_building','damaged_building') ORDER BY created_at DESC LIMIT 6`,
        ).bind(like).all();
        cands = (r.results ?? []) as any[];
      } catch { cands = []; }
    }
    if (!cands.length) return { kind: 'eval_not_found', query };
    const exact = cands.find((c) => (c.name || '').toLowerCase() === query.toLowerCase());
    const target = cands.length === 1 ? cands[0] : exact;
    if (!target) return { kind: 'eval_ambiguous', candidates: cands.slice(0, 5) };

    // Workflow-order rule — same gate the web POST enforces.
    const rowsRes = await env.DB.prepare(
      `SELECT id, building_id, level, status, event_kind, voids_event_id, actor_name, created_at
         FROM building_eval_events WHERE building_id = ? ORDER BY created_at DESC, id DESC`,
    ).bind(target.id).all().catch(() => ({ results: [] as any[] }));
    const summary = summarizeEval((rowsRes.results ?? []) as unknown as EvalEventRow[]);
    const violation = levelOrderViolation(levelStatusMap(summary), cmd.evalLevel, cmd.evalStatus ?? null);
    if (violation) return { kind: 'eval_order', reason: violation };

    const createdAt = new Date().toISOString();
    const ev: EvalEventRow = {
      building_id: target.id, level: cmd.evalLevel, status: cmd.evalStatus ?? null,
      event_kind: cmd.evalStatus ? 'cambio_estado' : 'nota',
      note: cmd.evalNote ? cmd.evalNote.slice(0, 2000) : null,
      actor_name: ctx.actorName.slice(0, 120), actor_role: 'Operador Telegram',
      signed_by: ctx.actorName.slice(0, 120),
      user_id: ctx.actor, user_name: ctx.actorName.slice(0, 120),
      voids_event_id: null, created_at: createdAt,
    };
    const signature = await signEvent(ev);
    await env.DB.prepare(
      `INSERT INTO building_eval_events
         (building_id, level, status, event_kind, note, actor_name, actor_role, signed_by,
          user_id, user_name, voids_event_id, signature, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(ev.building_id, ev.level, ev.status, ev.event_kind, ev.note, ev.actor_name, ev.actor_role,
           ev.signed_by, ev.user_id, ev.user_name, null, signature, createdAt).run();
    return {
      kind: 'eval_ok', buildingId: target.id, name: target.name, level: cmd.evalLevel,
      status: cmd.evalStatus ?? null, note: cmd.evalNote ?? null, signature,
    };
  } catch {
    return { kind: 'eval_error' };
  }
}
