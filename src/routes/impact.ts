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
//   total = medical_consults. When 0, the UI shows "—" ("aún sin datos verificados").
//
// WHY missing-persons "located" is NOT counted (yet): the `personas` table is an
//   IMPORT from an external dataset (desaparecidos-vzla). Its `estado` AND
//   `localizado_nota` fields were backfilled by that import, so they do NOT prove
//   SISMO911 facilitated the location — counting them FABRICATED impact (a live
//   value of 12,422 → 2,810 came entirely from imported rows). The platform does
//   record genuine locations (operator docket events), but separating those
//   cleanly from imported state needs an explicit provenance signal (e.g. a
//   launch-date cutoff or a `helped_via_platform` marker). Until that exists this
//   component is DEFERRED, not faked. See the vault follow-up. No hardcoded/demo
//   numbers anywhere — the value is purely the count of real platform records.
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
  const persons_located_safe = 0; // DEFERRED: imported-registry provenance unclear (see header).
  const total = medical_consults + persons_located_safe;
  return c.json({
    ok: true,
    total, // REAL count from platform records; the UI renders "—" when total === 0
    breakdown: { medical_consults, persons_located_safe },
    definition:
      'Personas con un resultado que SISMO911 facilitó de forma verificable: por ahora, ' +
      'consultas de telemedicina completadas en la plataforma. Excluye datos importados/' +
      'históricos y estimaciones de planificación. El conteo de personas localizadas se ' +
      'incorporará cuando exista una señal de origen confiable en la plataforma.',
    as_of: Date.now(),
  });
});
