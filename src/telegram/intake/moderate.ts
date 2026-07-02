// SISMO911 — Telegram operator moderation of intake submissions BY ITK CODE.
// ---------------------------------------------------------------------------
// The intake bot answers every photo/PDF with a tracking code (ITK-XXXXXXXX) and
// alerts operators. This lets an ADMIN approve or reject that exact submission
// from chat using the code they already have — no need to look up the internal
// FAM-<id> case id:
//   /aprobar  ITK-6439A061   → publish the draft persona + verify its lead
//   /rechazar ITK-6439A061   → hide the draft persona + dismiss its lead
//
// Mirrors the console review actions (src/routes/admin-intake.ts approve/reject)
// exactly, so both surfaces stay consistent. Admin-tier only. Never throws.

import type { Env } from '../../types';
import type { ViewerRole } from '../types';

export type ModerationAction = 'approve' | 'reject';

export interface ModerationResult {
  kind: 'approved' | 'rejected' | 'forbidden' | 'not_found' | 'already' | 'error';
  code: string; // normalized display code (ITK-XXXXXXXX)
  name?: string | null;
}

/** Normalize a user-typed code into { display: 'ITK-XXXX', id: 'itk_xxxx' }.
 *  uid() is `${prefix}_${uuid.slice(0,8)}` (lowercase hex) and the public code is
 *  `ITK-${idWithoutPrefix.toUpperCase()}`, so the mapping round-trips exactly. */
export function normalizeItkCode(raw: string): { display: string; id: string } {
  const up = String(raw || '').toUpperCase();
  const m = up.match(/ITK[-_\s]?([A-Z0-9]+)/);
  const part = (m ? m[1] : up.replace(/[^A-Z0-9]/g, '').replace(/^ITK/, '')).slice(0, 32);
  return { display: `ITK-${part}`, id: `itk_${part.toLowerCase()}` };
}

interface SubRow {
  id: string;
  person_id: string | null;
  intel_id: string | null;
  outcome: string;
  name: string | null;
  mod: string | null;
}

/** Approve or reject an intake submission by its ITK code. Admin-tier only. */
export async function resolveIntakeModeration(
  env: Env,
  opts: { code: string; action: ModerationAction; role: ViewerRole; actor: string },
): Promise<ModerationResult> {
  const { display, id } = normalizeItkCode(opts.code);
  // Only the executive (admin) tier may publish/hide a case — same gate as the
  // console (requirePermission ops:console) and /actualizar aprobar/rechazar.
  if (opts.role !== 'admin') return { kind: 'forbidden', code: display };

  try {
    const row = await env.DB.prepare(
      `SELECT s.id, s.person_id, s.intel_id, s.outcome, p.nombre AS name, p.moderation AS mod
         FROM intake_submissions s
         LEFT JOIN personas p ON ('fam-' || p.id) = s.person_id
        WHERE s.id = ?`,
    )
      .bind(id)
      .first<SubRow>();
    if (!row) return { kind: 'not_found', code: display };

    const now = Date.now();

    if (opts.action === 'approve') {
      if (row.person_id?.startsWith('fam-')) {
        await env.DB.prepare(`UPDATE personas SET moderation='approved', updated_at=? WHERE id=? AND moderation<>'rejected'`)
          .bind(now, row.person_id.slice(4))
          .run();
      }
      if (row.intel_id) {
        await env.DB.prepare(`UPDATE case_intel SET status='verified', updated_ms=? WHERE id=?`).bind(now, row.intel_id).run();
      }
      await env.DB.prepare(`UPDATE intake_submissions SET outcome='approved', note=? WHERE id=?`)
        .bind(`Aprobado por ${opts.actor}`.slice(0, 200), id)
        .run();
      return { kind: 'approved', code: display, name: row.name };
    }

    // reject
    if (row.person_id?.startsWith('fam-') && row.mod === 'pending') {
      await env.DB.prepare(`UPDATE personas SET moderation='rejected', updated_at=? WHERE id=? AND moderation='pending'`)
        .bind(now, row.person_id.slice(4))
        .run();
    }
    if (row.intel_id) {
      await env.DB.prepare(`UPDATE case_intel SET status='dismissed', updated_ms=? WHERE id=?`).bind(now, row.intel_id).run();
    }
    await env.DB.prepare(`UPDATE intake_submissions SET outcome='rejected', note=? WHERE id=?`)
      .bind(`Rechazado por ${opts.actor}`.slice(0, 200), id)
      .run();
    return { kind: 'rejected', code: display, name: row.name };
  } catch {
    return { kind: 'error', code: display };
  }
}

/** Match an operator moderation command: /aprobar ITK-XXXX | /rechazar ITK-XXXX
 *  (tolerant of accents/typos: aprobar/aprobado/aprueba/aprovar, rechazar/rechaza/rechazado). */
export function parseModerationCommand(text: string): { action: ModerationAction; code: string } | null {
  const m = String(text || '').match(/^\s*\/?(aprob\w*|aprov\w*|aprueb\w*|rechaz\w*|rechac\w*)\s+(ITK[-_\s]?[A-Za-z0-9]+)/i);
  if (!m) return null;
  const action: ModerationAction = /^rech/i.test(m[1]) ? 'reject' : 'approve';
  return { action, code: m[2] };
}

/** Build the Spanish reply for a moderation result. */
export function buildModerationReply(r: ModerationResult): string {
  const who = r.name ? ` — ${r.name}` : '';
  switch (r.kind) {
    case 'approved':
      return `✅ ${r.code} aprobado y publicado${who}.`;
    case 'rejected':
      return `🚫 ${r.code} rechazado (oculto)${who}.`;
    case 'forbidden':
      return `⛔ Aprobar o rechazar un caso requiere nivel administrador.`;
    case 'not_found':
      return `No encontré ese envío (${r.code}). Verifica el código del recibo (ej: ITK-6439A061).`;
    default:
      return `Ocurrió un error al procesar ${r.code}. Intenta de nuevo.`;
  }
}
