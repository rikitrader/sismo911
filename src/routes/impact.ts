import { Hono } from 'hono';
import type { Env } from '../types';

// ── Impact metrics — REAL, auditable, never demo/fabricated ──────────────────
//
// "Persona ayudada" CONTRACT:
//   A distinct person who received an outcome we can PROVE SISMO911 delivered.
//   Counted ONLY from records with unambiguous platform provenance:
//     • medical_consults = completed telemedicine consultations
//                          (telemed_requests.status = 'completed') — a SISMO911-
//                          native service; every completed request is a real
//                          person attended through the platform.
//     • persons_located_safe = distinct people an OPERATOR confirmed located/found
//                          THROUGH the platform, recorded in the person_events
//                          docket with source='operator' (kind='status_change',
//                          status_to IN localizado|aparecido, review='approved').
//   total = medical_consults + persons_located_safe. When 0, the UI shows "—".
//
// PROVENANCE (the anti-fabrication crux): the `personas` table is an IMPORT from an
//   external dataset (desaparecidos-vzla), so its estado/localizado_nota are NOT
//   proof SISMO911 helped (counting them gave a fabricated 12,422 → 2,810). The
//   ONLY import-free signal is the docket's source='operator' events: the import
//   created NO person_events, citizen reports use source='citizen', hospital
//   ingestion uses source='hospital'. So source='operator' located events =
//   genuinely operator-confirmed platform locations. Both operator flows now write
//   one (persons.ts status change + familia.ts /localizar). No hardcoded/demo
//   numbers — the value is purely the count of real platform records.
//
// Public, read-only, NO PII (counts only). Mounted at /api/impact.
export const impact = new Hono<{ Bindings: Env }>();

// Count helper: a missing table (partial schema) contributes 0 and NEVER throws —
// so a component degrades to 0 rather than fabricating or 500ing.
async function count(env: Env, sql: string, binds: unknown[] = []): Promise<number> {
  try {
    const r: any = await env.DB.prepare(sql).bind(...binds).first();
    const n = Number(r?.n);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

// GET /api/impact/personas-ayudadas — the auditable "people helped" total.
impact.get('/personas-ayudadas', async (c) => {
  const medical_consults = await count(
    c.env,
    `SELECT COUNT(*) AS n FROM telemed_requests WHERE status = 'completed'`,
  );
  // Distinct people an operator confirmed located through the platform docket.
  // source='operator' is the import-free discriminator (see header).
  const persons_located_safe = await count(
    c.env,
    `SELECT COUNT(DISTINCT person_id) AS n FROM person_events
       WHERE kind = 'status_change' AND status_to IN ('localizado','aparecido')
         AND source = 'operator' AND review = 'approved'`,
  );
  const total = medical_consults + persons_located_safe;
  return c.json({
    ok: true,
    total, // REAL count from platform records; the UI renders "—" when total === 0
    breakdown: { medical_consults, persons_located_safe },
    definition:
      'Personas con un resultado que SISMO911 facilitó de forma verificable: consultas de ' +
      'telemedicina completadas + personas que un operador confirmó como localizadas a través ' +
      'del registro de la plataforma (eventos source=operator). Excluye datos importados/' +
      'históricos y estimaciones de planificación. Solo registros reales de la plataforma.',
    as_of: Date.now(),
  });
});
