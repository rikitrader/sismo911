// SISMO911 — Telegram operator write command (/actualizar).
// ---------------------------------------------------------------------------
// Lets an authorized operator update an EXISTING missing-person case from chat.
//   /actualizar <ID> estado=localizado
//   /actualizar <ID> nota "Visto en el refugio de Catia La Mar"
//   /actualizar <ID> ubicacion "Caracas, Distrito Capital"
//   /actualizar <ID> contacto 0412-5551234
//   /actualizar <ID> edad 34
//   /actualizar <ID> nombre "Juan Pérez Gómez"
//   /actualizar <ID> aprobar      (executive/admin tier only — publishes a draft)
//   /actualizar <ID> rechazar     (executive/admin tier only — hides a draft)
//
// Authorization (enforced here AND at the route): any authorized operator
// (role !== 'public') may edit fields; only the executive tier (role === 'admin')
// may aprobar/rechazar. Only the `personas` registry is editable from chat; the
// public/hospital registries are read-only here. Every write is audited.

import type { Env } from '../types';
import type { ParsedCommand, UpdateField, ViewerRole } from './types';
import { getCaseById } from '../adapters/sismo911-api';
import { computeSearchFields } from '../lib/search-index';
import { uid } from '../lib/db';

// Missing-person lifecycle values a chat operator may set. Kept deliberately
// small — moderation is a separate action (aprobar/rechazar), not an estado.
const ESTADO_VALUES = new Set(['sin-contacto', 'localizado', 'aparecido', 'hospitalizado', 'fallecido']);
const ESTADO_ALIASES: Record<string, string> = {
  'sin-contacto': 'sin-contacto', sincontacto: 'sin-contacto', 'sin contacto': 'sin-contacto',
  localizado: 'localizado', localizada: 'localizado', encontrado: 'localizado', encontrada: 'localizado',
  aparecido: 'aparecido', aparecida: 'aparecido',
  hospitalizado: 'hospitalizado', hospitalizada: 'hospitalizado',
  fallecido: 'fallecido', fallecida: 'fallecido', muerto: 'fallecido', muerta: 'fallecido',
};

// Fields that require only operator tier vs the executive (admin) tier.
const EXECUTIVE_ONLY = new Set<UpdateField>(['aprobar', 'rechazar']);

export type UpdateResult =
  | { kind: 'update_ok'; field: UpdateField; caseId: string; name: string; summary: string }
  | { kind: 'update_forbidden'; reason: 'not_operator' | 'not_executive' }
  | { kind: 'update_bad_input'; reason: string }
  | { kind: 'update_not_found' }
  | { kind: 'update_not_editable' }
  | { kind: 'update_error' };

export interface UpdateCtx {
  role: ViewerRole;
  actor: string; // operator identity for the audit trail (e.g. tg:<id>)
  nowMs?: number;
}

/**
 * Apply an /actualizar command. Pure w.r.t. the DB it is handed (exported for
 * unit testing with a fake Env). Never throws — DB failures → 'update_error'.
 */
export async function resolveUpdate(env: Env, cmd: ParsedCommand, ctx: UpdateCtx): Promise<UpdateResult> {
  const field = cmd.updateField;
  const caseId = (cmd.caseId || '').trim();
  const now = ctx.nowMs ?? Date.now();

  // --- validation -----------------------------------------------------------
  if (!caseId) return { kind: 'update_bad_input', reason: 'missing_id' };
  if (!field) return { kind: 'update_bad_input', reason: 'unknown_field' };

  // --- authorization --------------------------------------------------------
  if (ctx.role === 'public') return { kind: 'update_forbidden', reason: 'not_operator' };
  if (EXECUTIVE_ONLY.has(field) && ctx.role !== 'admin') return { kind: 'update_forbidden', reason: 'not_executive' };

  // Value required for every edit except contacto (may be cleared) and the
  // no-value moderation actions (aprobar/rechazar).
  const value = (cmd.updateValue || '').trim();
  const needsValue = !EXECUTIVE_ONLY.has(field) && field !== 'contacto';
  if (needsValue && !value) return { kind: 'update_bad_input', reason: 'missing_value' };

  try {
    const rec = await getCaseById(env, caseId);
    if (!rec) return { kind: 'update_not_found' };
    if (rec.registry !== 'personas') return { kind: 'update_not_editable' };
    const id = rec.internalId;
    const name = rec.fullName || caseId;

    switch (field) {
      case 'estado': {
        const norm = ESTADO_ALIASES[value.toLowerCase()] ?? (ESTADO_VALUES.has(value.toLowerCase()) ? value.toLowerCase() : null);
        if (!norm) return { kind: 'update_bad_input', reason: 'bad_estado' };
        await env.DB.prepare(`UPDATE personas SET estado=?, updated_at=? WHERE id=?`).bind(norm, now, id).run();
        return ok(field, rec.caseId, name, `estado → ${norm}`);
      }
      case 'ubicacion': {
        const sf = computeSearchFields(name, value);
        await env.DB.prepare(`UPDATE personas SET ubicacion=?, geo_estado=?, geo_municipio=?, updated_at=? WHERE id=?`)
          .bind(value.slice(0, 200), sf.geo_estado, sf.geo_municipio, now, id)
          .run();
        return ok(field, rec.caseId, name, `ubicación → ${value.slice(0, 200)}`);
      }
      case 'contacto': {
        await env.DB.prepare(`UPDATE personas SET contacto=?, updated_at=? WHERE id=?`).bind(value.slice(0, 160), now, id).run();
        return ok(field, rec.caseId, name, `contacto actualizado`);
      }
      case 'edad': {
        const n = parseInt(value.replace(/\D/g, ''), 10);
        if (!Number.isFinite(n) || n <= 0 || n >= 130) return { kind: 'update_bad_input', reason: 'bad_edad' };
        await env.DB.prepare(`UPDATE personas SET edad=?, updated_at=? WHERE id=?`).bind(n, now, id).run();
        return ok(field, rec.caseId, name, `edad → ${n}`);
      }
      case 'nombre': {
        const nn = value.slice(0, 120);
        const sf = computeSearchFields(nn, rec.generalLocation ?? '');
        await env.DB.prepare(`UPDATE personas SET nombre=?, name_norm=?, updated_at=? WHERE id=?`).bind(nn, sf.name_norm, now, id).run();
        return ok(field, rec.caseId, nn, `nombre → ${nn}`);
      }
      case 'nota': {
        const intelId = uid('intl');
        await env.DB.prepare(
          `INSERT INTO case_intel (id, person_id, type, url, platform, title, detail, lat, lon, source, status, submitted_by, created_ms, updated_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(intelId, `fam-${id}`, 'tip', null, 'telegram', 'Nota de operador (Telegram)', value.slice(0, 2000), null, null, 'operator', 'verified', ctx.actor, now, now)
          .run();
        return ok(field, rec.caseId, name, `nota agregada`);
      }
      case 'aprobar': {
        await env.DB.prepare(`UPDATE personas SET moderation='approved', updated_at=? WHERE id=? AND moderation<>'rejected'`).bind(now, id).run();
        return ok(field, rec.caseId, name, `caso aprobado (publicado)`);
      }
      case 'rechazar': {
        await env.DB.prepare(`UPDATE personas SET moderation='rejected', updated_at=? WHERE id=?`).bind(now, id).run();
        return ok(field, rec.caseId, name, `caso rechazado (oculto)`);
      }
      default:
        return { kind: 'update_bad_input', reason: 'unknown_field' };
    }
  } catch {
    return { kind: 'update_error' };
  }
}

function ok(field: UpdateField, caseId: string, name: string, summary: string): UpdateResult {
  return { kind: 'update_ok', field, caseId, name, summary };
}
